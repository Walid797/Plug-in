// One-click print presets: size + rule profile → white background (local AI,
// validated) → face-based crop → conservative light fix → print sheet. Every
// step reports what really happened; nothing is marked done unless it worked.
import { getState, updateEdit, updateSheet, updateSettings, recordHistory, startTask, uid, setSection, openDialog, toast, logEvent } from './store.js';
import { getPersonMask, hasMask, getFace, maskForegroundFraction, originalAvailable, getPreview, gatherAssets } from './media.js';
import { renderPhoto } from '../render/renderPhoto.js';
import { findQuickPreset, quickSheetPatch, presetCapacity, quickFields, normalizeQuickPreset, QUICK_PRESETS, presetAdjust, presetFaceParams } from '../core/quickpresets.js';
import { autoExposureDelta, suggestCrop, QUALITY_THRESHOLDS } from '../core/idphoto.js';
import { isFrameInside } from '../core/crop.js';
import { faceEllipse } from '../core/faceengine.js';
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

async function replaceBackground(photo, aiState, preset) {
  const color = preset.bgColor;
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
    bg: { ...ed.bg, enabled: true, mode: 'color', color, modelId },
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
      // colour-grading engine values from the template (face & skin / lighting engines are armed after the face analysis)
      const grade = presetAdjust(preset);
      if (grade) updateEdit(id, (ed) => ({ ...ed, adjust: grade }), { history: false });
      updateEdit(id, (ed) => ({ ...ed, face: { ...presetFaceParams(preset), skin: { ...presetFaceParams(preset).skin, enabled: false }, light: { ...presetFaceParams(preset).light, enabled: false }, ellipse: null } }), { history: false });

      step(0, 'تغییر پس‌زمینه');
      if (preset.whiteBg && aiState.segOk) {
        try { r.bg = await replaceBackground(photo, aiState, preset); } catch (err) { console.error(err); r.bg = 'failed'; r.bgError = err?.code || 'FAILED'; }
      }
      if (task.signal.aborted) { cancelled = true; r.cancelled = true; break; }

      step(2, 'تحلیل چهره و کادر');
      if (aiState.faceOk && (preset.autoCrop || preset.autoLight || preset.skinOn || preset.lightOn)) {
        try {
          const f = await analyzeFace(getState().photos[id]);
          r.faces = f.faceCount;
          if (f.faceCount) {
            if (preset.autoCrop) {
              const crop = suggestionFor(getState().photos[id]);
              if (crop) { updateEdit(id, { crop }, { history: false }); r.crop = 'ok'; } else r.crop = 'failed';
            }
            if (preset.autoCrop && preset.cropShoulders) {
              const sh = await fitShoulders(id, getFace(id).metrics);
              r.shoulders = sh.status;
            }
            const delta = preset.autoLight ? autoExposureDelta(getFace(id)?.stats?.meanL) : 0;
            if (delta) {
              updateEdit(id, (ed) => ({ ...ed, adjust: { ...ed.adjust, exposure: Math.max(-100, Math.min(100, (ed.adjust.exposure || 0) + delta)) } }), { history: false });
              r.light = delta;
              await analyzeFace(getState().photos[id]).catch(() => null); // refresh stats for the checklist
            }
            // arm the face & skin / lighting engines on this face
            if (preset.skinOn || preset.lightOn) {
              const fp = presetFaceParams(preset);
              updateEdit(id, (ed) => ({ ...ed, face: { ...fp, ellipse: faceEllipse(getFace(id).metrics, photo.width, photo.height) } }), { history: false });
              r.engine = await engineReport(id).catch(() => null);
            }
            const { shoulderStatsFor } = await import('../ai/face.js');
            const stats = await shoulderStatsFor(getState().photos[id]).catch(() => null);
            const q = currentQuality(getState().photos[id], stats ? { shoulderFrac: stats.frac, shoulderSides: stats } : {}) || [];
            r.issues = q.filter((x) => x.level === 'warn' || x.level === 'error');
          } else if (preset.autoCrop) r.crop = 'noface';
        } catch (err) { console.error(err); r.crop = 'failed'; r.cropError = err?.code || 'FAILED'; }
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
