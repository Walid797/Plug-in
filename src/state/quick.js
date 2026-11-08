// One-click print presets: size + rule profile → white background (local AI,
// validated) → face-based crop → conservative light fix → print sheet. Every
// step reports what really happened; nothing is marked done unless it worked.
import { getState, updateEdit, updateSheet, updateSettings, recordHistory, startTask, uid, setSection, openDialog, toast, logEvent } from './store.js';
import { getPersonMask, hasMask, getFace, maskForegroundFraction, originalAvailable, getPreview, gatherAssets } from './media.js';
import { renderPhoto } from '../render/renderPhoto.js';
import { findQuickPreset, quickSheetPatch, presetCapacity, quickFields, normalizeQuickPreset, QUICK_PRESETS, presetAdjustFor, gradeStrength, detailStrength, presetFaceParams } from '../core/quickpresets.js';
import { MAX_EVEN_GAIN } from '../core/faceengine.js';
import { autoExposureDelta, exposureTowardTarget, suggestCrop, backgroundWhiteness, faceProtectZones, QUALITY_THRESHOLDS } from '../core/idphoto.js';
import { isFrameInside } from '../core/crop.js';
import { faceEllipse } from '../core/faceengine.js';
import { makeCanvas } from '../platform/image.js';
import { ADJUSTMENT_DEFAULTS } from '../core/adjust.js';
import { aiAvailability } from '../platform/capabilities.js';
import { formatNumber } from '../core/digits.js';

const READY = ['available', 'ready'];
let running = false;

export function isQuickRunning() { return running; }

/** What the local AI can do right now (for the UI and the pipeline). */
export async function quickAiState(s = getState()) {
  const ai = s.caps ? aiAvailability(s.caps) : { ok: false, reason: '' };
  const { chooseSegModel } = await import('../ai/segment.js');
  const segId = chooseSegModel();
  const segOk = ai.ok && READY.includes(s.models[segId]?.status);
  const faceOk = ai.ok && READY.includes(s.models['face-landmarker']?.status);
  return { ai, segId, segOk, faceOk };
}

/** Edge clean-up and shadow settings of a preset, as a background-edit patch. */
export function presetBgPatch(preset) {
  return {
    refine: { edgeAware: preset.edgeAware, shift: preset.edgeShift / 100, softness: preset.edgeSoftness / 100, feather: preset.edgeFeather },
    decontaminate: preset.decontaminate,
    shadow: { enabled: preset.shadow, opacity: preset.shadowOpacity, blurMm: preset.shadowBlur, offsetXmm: preset.shadowX, offsetYmm: preset.shadowY },
  };
}

/** True when the photo's own background is already clean white (and the template wants white). */
async function backgroundAlreadyWhite(photo) {
  const pv = await getPreview(photo);
  if (!pv) return false;
  const w = 120; const h = Math.max(1, Math.round((120 * pv.height) / pv.width));
  const c = makeCanvas(w, h); const cx = c.getContext('2d', { willReadFrequently: true });
  cx.drawImage(pv.image, 0, 0, w, h);
  return backgroundWhiteness(cx.getImageData(0, 0, w, h).data, w, h).white;
}

async function replaceBackground(photo, aiState, preset) {
  const color = preset.bgColor;
  if (/^#f{6}$/i.test(color) && await backgroundAlreadyWhite(photo).catch(() => false)) {
    // nothing to replace: keep every fine hair strand of the original
    updateEdit(photo.id, (ed) => ({ ...ed, bg: { ...ed.bg, enabled: false, color: '#ffffff', whiteSnap: true } }), { history: false });
    return 'white';
  }
  // edge settings go in first: the plausibility check below measures the FINAL (refined) mask
  updateEdit(photo.id, (ed) => ({ ...ed, bg: { ...ed.bg, ...presetBgPatch(preset), refine: { ...ed.bg.refine, ...presetBgPatch(preset).refine }, shadow: { ...ed.bg.shadow, ...presetBgPatch(preset).shadow } } }), { history: false });
  const { segmentPhoto } = await import('../ai/segment.js');
  let fresh = getState().photos[photo.id];
  let reused = false;
  let modelId = fresh.edit.bg.modelId || aiState.segId;
  // An existing, plausible person mask is reused (same original image).
  if (hasMask(fresh, 'person')) {
    const frac = maskForegroundFraction(await getPersonMask(fresh).catch(() => null));
    reused = frac != null && frac >= 0.01 && frac <= 0.99;
  }
  if (!reused) {
    const r = await segmentPhoto(fresh, { modelId: aiState.segId });
    modelId = r.modelId;
    fresh = getState().photos[photo.id];
    const frac = maskForegroundFraction(await getPersonMask(fresh));
    if (frac == null || frac < 0.01 || frac > 0.99) throw Object.assign(new Error('SEG_EMPTY'), { code: 'SEG_EMPTY' });
  }
  updateEdit(photo.id, (ed) => ({
    ...ed,
    bg: { ...ed.bg, enabled: true, mode: 'color', color, modelId, whiteSnap: false },
    aiEdited: true,
  }), { history: false });
  return reused ? 'reused' : 'ok';
}

/**
 * Crop engine, shoulders: when the person's shoulders are cut off at the bottom, widen the frame
 * as far as the head-size rule allows (head at its minimum), and keep that only if it really shows more.
 */
async function fitShoulders(id, metrics) {
  const { shoulderStatsFor, profileFor } = await import('../ai/face.js');
  const photo = getState().photos[id];
  const before = await shoulderStatsFor(photo);
  if (!before) return { status: 'nomask', before: null, after: null };
  if (before.frac >= QUALITY_THRESHOLDS.shoulderMinFrac) return { status: 'ok', before, after: before };
  const profile = profileFor(photo);
  const cand = suggestCrop(metrics, { ...profile, headHeight: { ...profile.headHeight, target: profile.headHeight.min } }, photo.width, photo.height);
  if (!isFrameInside(cand, photo.width, photo.height, photo.edit.widthMm / photo.edit.heightMm)) return { status: 'limited', before, after: before };
  const after = await shoulderStatsFor(photo, cand);
  if (after && after.frac > before.frac + 0.03) {
    updateEdit(id, { crop: cand }, { history: false });
    return { status: 'widened', before, after };
  }
  return { status: 'limited', before, after: before };
}

/** What the face & skin / lighting engines really did for a photo (a small render with a report). */
/** Skin brightness (0..255) the reference portrait ends at; a face brighter than this is trimmed back. */
const SKIN_TARGET_Y = 186;
const srgbToLinear = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

async function engineReport(id) {
  const photo = getState().photos[id];
  const pv = await getPreview(photo);
  if (!pv) return null;
  const assets = await gatherAssets(photo, pv);
  const e = photo.edit; const w = 240; const h = Math.round((w * e.heightMm) / e.widthMm);
  const rep = {};
  renderPhoto(e, assets, w, h, { faceReport: rep, pxPerMm: w / e.widthMm, frameWidthPx: w });
  return rep;
}

/**
 * Run a quick preset on photos and prepare the print sheet.
 * @returns {Promise<{results:object[], cancelled:boolean}|null>}
 */
export async function runQuickPreset(presetId, photoIds, { openReady = true } = {}) {
  const s0 = getState();
  const preset = findQuickPreset(presetId, s0.settings);
  const papers = s0.settings.paperPresets || [];
  const ids = (photoIds || []).filter((id) => s0.photos[id]);
  if (!preset || !s0.project) return null;
  if (!ids.length) { toast('عکسی برای این قالب انتخاب نشده است.', 'warn'); return null; }
  if (running) { toast('یک قالب در حال اجراست؛ لطفاً صبر کنید.', 'warn'); return null; }
  running = true;
  const aiState = await quickAiState(s0);
  const { analyzeFace, suggestionFor, currentQuality } = await import('../ai/face.js');
  const task = startTask(`قالب «${preset.nameFa}»…`, { cancellable: true });
  const results = [];
  let cancelled = false;
  try {
    for (let i = 0; i < ids.length; i += 1) {
      if (task.signal.aborted) { cancelled = true; break; }
      const id = ids[i];
      const photo = getState().photos[id];
      const r = { id, name: photo.name, bg: preset.whiteBg ? 'skipped' : 'off', crop: preset.autoCrop ? 'skipped' : 'off', light: 0, faces: 0, issues: [], error: null, bgError: null };
      results.push(r);
      const step = (k, label) => task.update((i + k / 4) / ids.length, `${formatNumber(i + 1)} از ${formatNumber(ids.length)} — ${label}`);
      if (!originalAvailable(photo)) { r.error = 'NO_ORIGINAL'; continue; }
      recordHistory({ type: 'edit', photoId: id }); // one undo step per photo for the whole preset
      updateEdit(id, { widthMm: preset.widthMm, heightMm: preset.heightMm, sizeId: preset.photoId, profileId: preset.profileId }, { history: false });
      // the colour-grading values are applied after the face brightness is measured on the neutral photo
      // (adaptive strength); until then the photo's own adjustments are cleared
      if (preset.grade) updateEdit(id, (ed) => ({ ...ed, adjust: { ...ADJUSTMENT_DEFAULTS } }), { history: false });
      updateEdit(id, (ed) => ({ ...ed, face: { ...presetFaceParams(preset), skin: { ...presetFaceParams(preset).skin, enabled: false }, light: { ...presetFaceParams(preset).light, enabled: false }, ellipse: null, fixes: ed.face?.fixes } }), { history: false });

      step(0, 'تغییر پس‌زمینه');
      if (preset.whiteBg && aiState.segOk) {
        try { r.bg = await replaceBackground(photo, aiState, preset); } catch (err) { console.error(err); r.bg = 'failed'; r.bgError = err?.code || 'FAILED'; r.bgErrorInfo = { message: String(err?.message || ''), name: String(err?.name || '') }; }
      }
      if (task.signal.aborted) { cancelled = true; r.cancelled = true; break; }

      step(2, 'تحلیل چهره و کادر');
      if (aiState.faceOk && (preset.autoCrop || preset.autoLight || preset.skinOn || preset.lightOn)) {
        try {
          const f = await analyzeFace(getState().photos[id]);
          r.faces = f.faceCount;
          if (preset.grade) {
            // measured on the neutral photo: strength 1 for a dark face, 0 for one as bright as the reference
            const strength = f.faceCount ? gradeStrength(f.stats?.meanL) : 1;
            const grade = presetAdjustFor(preset, f.faceCount ? f.stats?.meanL : null, f.faceCount ? f.stats?.sharpness : null);
            updateEdit(id, (ed) => ({ ...ed, adjust: grade }), { history: false });
            r.gradeStrength = preset.gradeAdaptive ? strength : 1;
            r.detailStrength = preset.gradeAdaptive && f.faceCount ? detailStrength(f.stats?.sharpness) : 1;
            if (f.faceCount) await analyzeFace(getState().photos[id]).catch(() => null); // stats now include the grade
          }
          if (f.faceCount) {
            if (preset.autoCrop) {
              const crop = suggestionFor(getState().photos[id]);
              if (crop) { updateEdit(id, { crop }, { history: false }); r.crop = 'ok'; } else r.crop = 'failed';
            }
            if (preset.autoCrop && preset.cropShoulders) {
              const sh = await fitShoulders(id, getFace(id).metrics);
              r.shoulders = sh.status;
            }
            const meanNow = getFace(id)?.stats?.meanL;
            const delta = preset.autoLight ? (autoExposureDelta(meanNow) || exposureTowardTarget(meanNow)) : 0;
            if (delta) {
              // brightening goes to the mid-tones and lights (skin, shirt), sparing the darks (hair, jacket, brows);
              // a face that is too bright is toned down with the ordinary exposure
              updateEdit(id, (ed) => ({ ...ed, adjust: delta > 0 ? { ...ed.adjust, lift: Math.min(100, (ed.adjust.lift || 0) + delta) } : { ...ed.adjust, exposure: Math.max(-100, (ed.adjust.exposure || 0) + delta) } }), { history: false });
              r.light = delta;
              await analyzeFace(getState().photos[id]).catch(() => null); // refresh stats for the checklist
            }
            // arm the face & skin / lighting engines on this face
            if (preset.skinOn || preset.lightOn) {
              const fp = presetFaceParams(preset);
              updateEdit(id, (ed) => ({ ...ed, face: { ...fp, fixes: ed.face?.fixes, ellipse: faceEllipse(getFace(id).metrics, photo.width, photo.height), protect: faceProtectZones(getFace(id).landmarks, photo.width, photo.height) } }), { history: false });
              r.engine = await engineReport(id).catch(() => null);
              // the brightening is steered by the whole-face mean, which a beard, glasses or dark hair pull down: so a face with
              // dark parts can end up too bright. The skin itself is measured after the engines and trimmed back to the reference level.
              for (let k = 0; k < 2 && r.engine?.lumaAfter > SKIN_TARGET_Y + 5; k += 1) {
                const ev = Math.log2(srgbToLinear(SKIN_TARGET_Y / 255) / srgbToLinear(r.engine.lumaAfter / 255));
                const trim = Math.round((ev / 2) * 100); // negative slider units
                updateEdit(id, (ed) => {
                  const lift = ed.adjust.lift || 0;
                  const fromLift = Math.min(lift, -trim);
                  return { ...ed, adjust: { ...ed.adjust, lift: lift - fromLift, exposure: Math.max(-100, (ed.adjust.exposure || 0) + (trim + fromLift)) } };
                }, { history: false });
                r.trimmed = (r.trimmed || 0) + trim;
                r.engine = await engineReport(id).catch(() => r.engine);
              }
            }
            const { shoulderStatsFor } = await import('../ai/face.js');
            const stats = await shoulderStatsFor(getState().photos[id]).catch(() => null);
            const q = currentQuality(getState().photos[id], stats ? { shoulderFrac: stats.frac, shoulderSides: stats } : {}) || [];
            r.issues = q.filter((x) => x.level === 'warn' || x.level === 'error');
            // the quality check measures the photo before the lighting engine; when the engine evened the two sides completely
            // (its correction was not at the limit) the "one side darker" warning no longer applies
            const eg = r.engine?.evenGain;
            if (preset.lightOn && preset.lightEven && eg && (eg[0] !== 1 || eg[1] !== 1)) {
              const clipped = Math.abs(eg[0] - 1) >= MAX_EVEN_GAIN - 1e-3 || Math.abs(eg[1] - 1) >= MAX_EVEN_GAIN - 1e-3;
              r.sidesEvened = { left: eg[0], right: eg[1], clipped };
              if (!clipped) r.issues = r.issues.filter((x) => x.code !== 'LIGHT_BALANCE');
            }
            // how much the head was straightened (the frame is turned by the measured tilt of the eye line)
            const rot = getState().photos[id].edit.crop?.rotation;
            if (preset.autoCrop && Number.isFinite(rot)) r.straightened = rot;
          } else if (preset.autoCrop) r.crop = 'noface';
        } catch (err) { console.error(err); r.crop = 'failed'; r.cropError = err?.code || 'FAILED'; }
      }
      // no face measurement (model unavailable, no face, or an error): the table's values apply in full
      if (preset.grade && r.gradeStrength === undefined) {
        const grade = presetAdjustFor(preset, null);
        updateEdit(id, (ed) => ({ ...ed, adjust: grade }), { history: false });
        r.gradeStrength = 1;
      }
    }
    const done = results.filter((r) => !r.error).map((r) => r.id);
    if (done.length) {
      updateSheet((sh) => ({ ...sh, ...quickSheetPatch(preset, done, uid, papers) }));
      logEvent('quick-preset', `${preset.id} × ${done.length}`);
    }
  } finally {
    task.done();
    running = false;
  }
  setSection('print');
  const summary = { presetId, results, cancelled, aiState: { segOk: aiState.segOk, faceOk: aiState.faceOk, reason: aiState.ai.reason }, capacity: presetCapacity(preset, papers).capacity };
  if (openReady && results.some((r) => !r.error)) {
    const action = await openDialog('quickready', summary);
    if (action === 'print' || action === 'pdf') {
      const sheet = await import('../print/sheet.js');
      if (action === 'pdf') await sheet.runPdfExport(); else await sheet.runPrint();
    }
  } else if (results.length && results.every((r) => r.error)) {
    toast('عکس اصلی هیچ‌یک از عکس‌ها در دسترس نیست؛ آن‌ها را دوباره انتخاب کنید.', 'error', 9000);
  }
  return summary;
}

/* ------------------------------------------------ editing the presets */

/**
 * Save a preset from the editor. Built-ins store an override (resettable);
 * the user's own presets are inserted or updated. Returns the saved id.
 */
export function saveQuickPreset(draft) {
  const p = normalizeQuickPreset(draft);
  const fields = quickFields(p);
  if (p.builtin && QUICK_PRESETS.some((b) => b.id === p.id)) {
    updateSettings((s) => ({ quickOverrides: { ...(s.quickOverrides || {}), [p.id]: fields } }));
    return p.id;
  }
  const id = p.id && !QUICK_PRESETS.some((b) => b.id === p.id) ? p.id : uid('qp');
  updateSettings((s) => {
    const list = s.quickPresets || [];
    const next = { id, ...fields };
    return { quickPresets: list.some((x) => x.id === id) ? list.map((x) => (x.id === id ? next : x)) : [...list, next] };
  });
  return id;
}

/** Save a copy as a new user preset (never overwrites the original). */
export function saveQuickPresetAsNew(draft, nameFa) {
  return saveQuickPreset({ ...draft, id: '', builtin: false, nameFa: nameFa || draft.nameFa });
}

/** Back to factory settings for a built-in preset. */
export function resetQuickPreset(id) {
  updateSettings((s) => {
    const o = { ...(s.quickOverrides || {}) };
    delete o[id];
    return { quickOverrides: o };
  });
}

export function deleteQuickPreset(id) {
  updateSettings((s) => ({ quickPresets: (s.quickPresets || []).filter((x) => x.id !== id) }));
}

/** Open the editor dialog. mode: 'edit' an existing preset or create a 'new' one (optionally based on another). */
export function editQuickPreset(presetId, mode = 'edit') {
  return openDialog('quickedit', { presetId, mode });
}
