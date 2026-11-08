// One-click print presets: size + rule profile → white background (local AI,
// validated) → face-based crop → conservative light fix → print sheet. Every
// step reports what really happened; nothing is marked done unless it worked.
import { getState, updateEdit, updateSheet, updateSettings, recordHistory, startTask, uid, setSection, openDialog, toast, logEvent } from './store.js';
import { getPersonMask, hasMask, getFace, maskForegroundFraction, originalAvailable } from './media.js';
import { findQuickPreset, quickSheetPatch, presetCapacity, quickFields, normalizeQuickPreset, QUICK_PRESETS } from '../core/quickpresets.js';
import { autoExposureDelta } from '../core/idphoto.js';
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

async function replaceBackground(photo, aiState, color) {
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
    bg: { ...ed.bg, enabled: true, mode: 'color', color, modelId, decontaminate: true, shadow: { ...ed.bg.shadow, enabled: false } },
    aiEdited: true,
  }), { history: false });
  return reused ? 'reused' : 'ok';
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

      step(0, 'تغییر پس‌زمینه');
      if (preset.whiteBg && aiState.segOk) {
        try { r.bg = await replaceBackground(photo, aiState, preset.bgColor); } catch (err) { console.error(err); r.bg = 'failed'; r.bgError = err?.code || 'FAILED'; }
      }
      if (task.signal.aborted) { cancelled = true; r.cancelled = true; break; }

      step(2, 'تحلیل چهره و کادر');
      if (aiState.faceOk && (preset.autoCrop || preset.autoLight)) {
        try {
          const f = await analyzeFace(getState().photos[id]);
          r.faces = f.faceCount;
          if (f.faceCount) {
            if (preset.autoCrop) {
              const crop = suggestionFor(getState().photos[id]);
              if (crop) { updateEdit(id, { crop }, { history: false }); r.crop = 'ok'; } else r.crop = 'failed';
            }
            const delta = preset.autoLight ? autoExposureDelta(getFace(id)?.stats?.meanL) : 0;
            if (delta) {
              updateEdit(id, (ed) => ({ ...ed, adjust: { ...ed.adjust, exposure: Math.max(-100, Math.min(100, (ed.adjust.exposure || 0) + delta)) } }), { history: false });
              r.light = delta;
              await analyzeFace(getState().photos[id]).catch(() => null); // refresh stats for the checklist
            }
            const q = currentQuality(getState().photos[id]) || [];
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
