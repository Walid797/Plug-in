// Runtime media management: originals, previews, thumbnails, masks and other
// assets needed to render a photo. Memory-bounded; everything is local.
import { getState, setState, updatePhoto, bumpRev, uid, defaultEdit, toast, openDialog, updateSettings, logEvent } from './store.js';
import {
  validateImageFile, decodeImage, downscale, canvasToBlob, DrawableCache, LIMITS, workingPixelLimit, makeCanvas,
} from '../platform/image.js';
import { putBlob, getBlob, deleteBlob } from '../storage/db.js';
import { importErrorText, storageErrorText } from '../i18n/fa.js';
import { importedBaseName } from '../core/filenames.js';
import { findPhoto } from '../core/presets.js';
import { alphaCanvasFromBytes, applyStrokes, cloneCanvas } from '../render/renderPhoto.js';
import { plausibleMask } from '../core/mask.js';
import { runTask } from '../platform/worker.js';
import { getTemplate } from '../assets/suits.js';

const originals = new Map(); // origKey -> Blob (session)
const previews = new DrawableCache(6); // photoId -> {image,width,height}
const thumbs = new Map(); // photoId -> objectURL
const masks = new Map(); // photoId -> { raw:{bytes,w,h}, refined: canvas, refineKey, final: canvas, finalKey }
const clothesMasks = new Map(); // photoId -> { raw, final, finalKey }
const faces = new Map(); // photoId -> analysis result (memory only, never persisted)
const bgImages = new Map(); // key -> {image,width,height}
const patches = new Map(); // key -> drawable
const templates = new Map(); // templateId -> {image, meta}

export const getFace = (id) => faces.get(id) || null;
export const setFace = (id, v) => { if (v) faces.set(id, v); else faces.delete(id); bumpRev(id); };
export const thumbUrl = (id) => thumbs.get(id) || null;
/** True when the original can be read (this session's memory or local storage). */
export const originalAvailable = (p) => !!p && (originals.has(p.origKey) || !!p.hasOriginal);

export function releasePhotoMedia(id) {
  previews.delete(id);
  const t = thumbs.get(id);
  if (t) { URL.revokeObjectURL(t); thumbs.delete(id); }
  masks.delete(id); clothesMasks.delete(id); faces.delete(id);
}

export function releaseAllMedia() {
  previews.clear();
  for (const u of thumbs.values()) URL.revokeObjectURL(u);
  thumbs.clear(); masks.clear(); clothesMasks.clear(); faces.clear(); originals.clear(); bgImages.clear(); patches.clear();
}

async function makeThumb(drawable, w, h) {
  const c = downscale(drawable, w, h, LIMITS.thumbMax);
  return canvasToBlob(c, 'image/jpeg', 0.85);
}

/** Get the original blob (session memory first, then local storage). */
export async function getOriginal(photo) {
  if (!photo?.origKey) return null;
  if (originals.has(photo.origKey)) return originals.get(photo.origKey);
  if (!photo.hasOriginal) return null;
  const b = await getBlob(photo.origKey).catch(() => null);
  if (b) originals.set(photo.origKey, b);
  return b;
}

/** Preview drawable (≤ previewMax px) for editing and AI. */
export async function getPreview(photo) {
  const hit = previews.get(photo.id);
  if (hit) return hit;
  const blob = await getOriginal(photo);
  if (!blob) return null;
  const caps = getState().caps;
  const dec = await decodeImage(blob, { maxPixels: workingPixelLimit(caps), expected: { displayWidth: photo.width, displayHeight: photo.height } });
  const small = downscale(dec.image, dec.width, dec.height, LIMITS.previewMax);
  if (dec.image.close) dec.image.close();
  const entry = { image: small, width: small.width, height: small.height };
  previews.set(photo.id, entry);
  return entry;
}

/** Full working-resolution drawable for export. Caller must release with .close/size 0. */
export async function getWorking(photo) {
  const blob = await getOriginal(photo);
  if (!blob) return null;
  const caps = getState().caps;
  return decodeImage(blob, { maxPixels: workingPixelLimit(caps), expected: { displayWidth: photo.width, displayHeight: photo.height } });
}

async function ensureThumb(photo, drawable) {
  if (thumbs.has(photo.id)) return;
  let blob = photo.thumb || null;
  if (!blob && drawable) blob = await makeThumb(drawable.image, drawable.width, drawable.height);
  if (blob) thumbs.set(photo.id, URL.createObjectURL(blob));
}

export async function restoreThumbs(photos) {
  for (const p of photos) {
    if (p.thumb && !thumbs.has(p.id)) thumbs.set(p.id, URL.createObjectURL(p.thumb));
  }
}

async function askRetain() {
  const s = getState().settings;
  if (s.retainOriginals === 'always') return true;
  if (s.retainOriginals === 'never') return false;
  if (getState().storage.mode === 'memory') return false;
  const r = await openDialog('retain', {});
  if (!r) return false;
  if (r.remember) updateSettings({ retainOriginals: r.keep ? 'always' : 'never' });
  return !!r.keep;
}

let retainThisSession = null;

/**
 * Import files into the current project. Validates each file, decodes safely,
 * keeps the original byte-for-byte, and reports problems in Persian.
 */
export async function importFiles(fileList, { replaceId = null } = {}) {
  const s = getState();
  if (!s.project) return [];
  const files = [...fileList];
  if (!files.length) return [];
  if (retainThisSession == null || s.settings.retainOriginals === 'ask') {
    if (retainThisSession == null) retainThisSession = await askRetain();
  }
  if (s.settings.retainOriginals === 'always') retainThisSession = true;
  if (s.settings.retainOriginals === 'never') retainThisSession = false;
  const keep = retainThisSession;
  const added = [];
  const errors = [];
  const preset = findPhoto(s.settings.defaultPhotoId) || findPhoto('3x4');
  for (const file of files) {
    try {
      const v = await validateImageFile(file, s.caps);
      if (!v.ok) { errors.push(importErrorText(v.code, v.extra)); continue; }
      const blob = file.slice(0, file.size, v.mime);
      let dec;
      try {
        dec = await decodeImage(blob, { maxPixels: workingPixelLimit(s.caps), expected: v.probe });
      } catch (e) {
        errors.push(importErrorText(e.code === 'MEMORY' ? 'MEMORY' : 'DECODE', { name: file.name }));
        continue;
      }
      const width = v.probe.displayWidth || dec.width;
      const height = v.probe.displayHeight || dec.height;
      const small = downscale(dec.image, dec.width, dec.height, LIMITS.previewMax);
      const thumb = await makeThumb(small, small.width, small.height);
      if (dec.image.close) dec.image.close();
      const origKey = uid('orig');
      originals.set(origKey, blob);
      let stored = false;
      if (keep) {
        try { await putBlob(origKey, blob); stored = true; } catch (e) { toast(storageErrorText(e), 'error', 8000); }
      }
      if (replaceId && getState().photos[replaceId]) {
        const old = getState().photos[replaceId];
        releasePhotoMedia(replaceId);
        updatePhoto(replaceId, (p) => ({
          ...p, name: importedBaseName(file.name), fileName: file.name, mime: v.mime, size: file.size, width, height,
          origKey, hasOriginal: stored, thumb, maskKey: null, clothesKey: null,
          edit: { ...p.edit, crop: p.edit.crop, bg: { ...p.edit.bg, enabled: false, strokes: [] }, clothes: { ...p.edit.clothes, patch: null } },
        }));
        previews.set(replaceId, { image: small, width: small.width, height: small.height });
        thumbs.set(replaceId, URL.createObjectURL(thumb));
        bumpRev(replaceId);
        if (old.origKey && !isOrigShared(old.origKey, replaceId)) deleteBlob(old.origKey).catch(() => {});
        added.push(replaceId);
        logEvent('replace', file.name);
        break;
      }
      const id = uid('ph');
      const photo = {
        id, projectId: s.project.id, name: importedBaseName(file.name), fileName: file.name, mime: v.mime,
        size: file.size, width, height, addedAt: Date.now(), origKey, hasOriginal: stored, thumb,
        maskKey: null, clothesKey: null,
        edit: defaultEdit(preset.widthMm, preset.heightMm, preset.id),
      };
      previews.set(id, { image: small, width: small.width, height: small.height });
      thumbs.set(id, URL.createObjectURL(thumb));
      setState((st) => ({
        ...st,
        photos: { ...st.photos, [id]: photo },
        project: { ...st.project, photoIds: [...st.project.photoIds, id] },
        selectedPhotoId: st.selectedPhotoId || id,
      }));
      added.push(id);
      logEvent('import', file.name);
    } catch (e) {
      errors.push(importErrorText('DECODE', { name: file.name }));
      console.error(e);
    }
  }
  if (errors.length) toast(errors.join('\n'), 'error', 10000);
  if (added.length && !replaceId) toast(`${added.length.toLocaleString('fa-AF')} عکس وارد شد.`, 'success');
  return added;
}

function isOrigShared(origKey, exceptId) {
  return Object.values(getState().photos).some((p) => p.id !== exceptId && p.origKey === origKey);
}

export function duplicatePhoto(id) {
  const s = getState();
  const p = s.photos[id];
  if (!p) return null;
  const nid = uid('ph');
  const copy = { ...structuredClone({ ...p, thumb: null }), id: nid, thumb: p.thumb, name: `${p.name}-کاپی`, addedAt: Date.now() };
  const idx = s.project.photoIds.indexOf(id);
  const ids = [...s.project.photoIds];
  ids.splice(idx + 1, 0, nid);
  setState((st) => ({ ...st, photos: { ...st.photos, [nid]: copy }, project: { ...st.project, photoIds: ids }, selectedPhotoId: nid }));
  const pv = previews.get(id);
  if (pv) previews.set(nid, { ...pv, image: cloneCanvas(pv.image) });
  if (p.thumb) thumbs.set(nid, URL.createObjectURL(p.thumb));
  const m = masks.get(id);
  if (m) masks.set(nid, { ...m, final: null, finalKey: null });
  const cm = clothesMasks.get(id);
  if (cm) clothesMasks.set(nid, { ...cm, final: null, finalKey: null });
  logEvent('duplicate', p.name);
  return nid;
}

export async function removePhoto(id) {
  const s = getState();
  const p = s.photos[id];
  if (!p) return;
  const ids = s.project.photoIds.filter((x) => x !== id);
  const photos = { ...s.photos };
  delete photos[id];
  const items = s.project.sheet.items.filter((it) => it.photoId !== id);
  setState((st) => ({
    ...st, photos,
    project: { ...st.project, photoIds: ids, sheet: { ...st.project.sheet, items } },
    selectedPhotoId: st.selectedPhotoId === id ? ids[0] || null : st.selectedPhotoId,
  }));
  releasePhotoMedia(id);
  const { deletePhotoRecord } = await import('./persist.js');
  await deletePhotoRecord(p, !isOrigShared(p.origKey, id));
  logEvent('remove', p.name);
}

export function movePhoto(id, delta) {
  setState((s) => {
    const ids = [...s.project.photoIds];
    const i = ids.indexOf(id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= ids.length) return s;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    return { ...s, project: { ...s.project, photoIds: ids } };
  });
}

export function movePhotoTo(id, index) {
  setState((s) => {
    const ids = s.project.photoIds.filter((x) => x !== id);
    ids.splice(Math.max(0, Math.min(ids.length, index)), 0, id);
    return { ...s, project: { ...s.project, photoIds: ids } };
  });
}

/* ------------------------------------------------------------------ masks */

async function blobToBytes(blob) {
  const dec = await decodeImage(blob, {});
  const c = makeCanvas(dec.width, dec.height);
  const cx = c.getContext('2d', { willReadFrequently: true });
  cx.drawImage(dec.image, 0, 0);
  if (dec.image.close) dec.image.close();
  const d = cx.getImageData(0, 0, dec.width, dec.height).data;
  const bytes = new Uint8ClampedArray(dec.width * dec.height);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = d[i * 4];
  return { bytes, w: dec.width, h: dec.height };
}

async function bytesToPngBlob(bytes, w, h) {
  const c = makeCanvas(w, h);
  const cx = c.getContext('2d');
  const img = cx.createImageData(w, h);
  for (let i = 0; i < w * h; i += 1) { const v = bytes[i]; img.data[i * 4] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255; }
  cx.putImageData(img, 0, 0);
  return canvasToBlob(c, 'image/png');
}

/** Store a raw model mask (Uint8, source-aligned) for a photo. kind: 'person'|'clothes' */
export async function setRawMask(photoId, kind, bytes, w, h) {
  const store = kind === 'clothes' ? clothesMasks : masks;
  store.set(photoId, { raw: { bytes, w, h }, refined: null, refineKey: null, final: null, finalKey: null });
  const key = `${kind === 'clothes' ? 'clothes' : 'mask'}:${photoId}`;
  try { await putBlob(key, await bytesToPngBlob(bytes, w, h)); } catch (e) { toast(storageErrorText(e), 'error'); }
  updatePhoto(photoId, (p) => ({ ...p, [kind === 'clothes' ? 'clothesKey' : 'maskKey']: key }));
  bumpRev(photoId);
}

/** Share of a mask canvas (alpha = person) that is foreground, or null. */
export function maskForegroundFraction(canvas) {
  if (!canvas) return null;
  const cx = canvas.getContext('2d', { willReadFrequently: true });
  const d = cx.getImageData(0, 0, canvas.width, canvas.height).data;
  let fg = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] >= 128) fg += 1;
  return fg / (d.length / 4);
}

export function hasMask(photo, kind = 'person') {
  return !!(kind === 'clothes' ? (clothesMasks.get(photo.id) || photo.clothesKey) : (masks.get(photo.id) || photo.maskKey));
}

async function loadRaw(photo, kind) {
  const store = kind === 'clothes' ? clothesMasks : masks;
  let m = store.get(photo.id);
  if (m) return m;
  const key = kind === 'clothes' ? photo.clothesKey : photo.maskKey;
  if (!key) return null;
  const blob = await getBlob(key).catch(() => null);
  if (!blob) return null;
  m = { raw: await blobToBytes(blob), refined: null, refineKey: null, final: null, finalKey: null };
  if (kind === 'person' && !plausibleMask(m.raw.bytes)) {
    // A mask saved by an earlier, failed run (e.g. empty GPU output): discard it
    // instead of silently showing the original photo as "background removed".
    await deleteBlob(key).catch(() => {});
    updatePhoto(photo.id, (p) => ({ ...p, maskKey: null, edit: { ...p.edit, bg: { ...p.edit.bg, enabled: false } } }));
    bumpRev(photo.id);
    toast(`ماسک پس‌زمینهٔ ذخیره‌شده برای «${photo.name}» نامعتبر بود و کنار گذاشته شد. دوباره «حذف پس‌زمینه» را بزنید.`, 'warn', 10000);
    return null;
  }
  store.set(photo.id, m);
  return m;
}

/** Person mask canvas (alpha = foreground) at preview resolution, refined + strokes applied. */
export async function getPersonMask(photo) {
  const m = await loadRaw(photo, 'person');
  if (!m) return null;
  const pv = await getPreview(photo);
  if (!pv) return null;
  const refine = photo.edit.bg.refine || {};
  const refineKey = JSON.stringify([refine, pv.width, pv.height]);
  if (m.refineKey !== refineKey) {
    const gc = makeCanvas(pv.width, pv.height);
    const gx = gc.getContext('2d', { willReadFrequently: true });
    gx.drawImage(pv.image, 0, 0);
    const guide = gx.getImageData(0, 0, pv.width, pv.height).data;
    const { alpha } = await runTask('refineMask', {
      mask: m.raw.bytes, mw: m.raw.w, mh: m.raw.h, guide, w: pv.width, h: pv.height,
      opts: { edgeAware: refine.edgeAware !== false, shift: refine.shift || 0, softness: refine.softness ?? 0.4, feather: refine.feather || 0 },
    });
    m.refined = alphaCanvasFromBytes(alpha, pv.width, pv.height);
    m.refineKey = refineKey;
    m.finalKey = null;
  }
  const strokes = photo.edit.bg.strokes || [];
  const finalKey = `${refineKey}|${strokes.length}|${strokes.length ? strokes[strokes.length - 1].points.length : 0}`;
  if (m.finalKey !== finalKey) {
    m.final = applyStrokes(cloneCanvas(m.refined), strokes);
    m.finalKey = finalKey;
  }
  return m.final;
}

/** Clothing mask canvas (alpha = clothing region) with user strokes applied. */
export async function getClothesMask(photo) {
  const m = await loadRaw(photo, 'clothes');
  const strokes = photo.edit.clothes.recolor.strokes || [];
  const pv = await getPreview(photo);
  if (!pv) return null;
  if (!m && !strokes.length) return null;
  const finalKey = `${m ? 'm' : 'none'}|${strokes.length}|${strokes.length ? strokes[strokes.length - 1].points.length : 0}`;
  const holder = m || { final: null, finalKey: null };
  if (holder.finalKey !== finalKey) {
    let base;
    if (m) {
      base = alphaCanvasFromBytes(m.raw.bytes, m.raw.w, m.raw.h);
      if (m.raw.w !== pv.width) {
        const c = makeCanvas(pv.width, pv.height);
        c.getContext('2d').drawImage(base, 0, 0, pv.width, pv.height);
        base = c;
      }
    } else {
      base = makeCanvas(pv.width, pv.height);
    }
    holder.final = applyStrokes(base, strokes);
    holder.finalKey = finalKey;
    if (!m) clothesMasks.set(photo.id, { raw: null, ...holder });
  }
  return holder.final;
}

export async function clearMask(photoId, kind = 'person') {
  const store = kind === 'clothes' ? clothesMasks : masks;
  store.delete(photoId);
  const p = getState().photos[photoId];
  const key = kind === 'clothes' ? p?.clothesKey : p?.maskKey;
  if (key) await deleteBlob(key).catch(() => {});
  updatePhoto(photoId, (ph) => ({ ...ph, [kind === 'clothes' ? 'clothesKey' : 'maskKey']: null }));
  bumpRev(photoId);
}

/* ------------------------------------------------------------- other assets */

export async function setBackgroundImage(photoId, file) {
  const caps = getState().caps;
  const v = await validateImageFile(file, caps);
  if (!v.ok) { toast(importErrorText(v.code, v.extra), 'error'); return false; }
  const dec = await decodeImage(file, { maxPixels: 8_000_000, expected: v.probe });
  const key = uid('bgimg');
  const small = downscale(dec.image, dec.width, dec.height, 3000);
  if (dec.image.close) dec.image.close();
  bgImages.set(key, small);
  try { await putBlob(key, await canvasToBlob(small, 'image/jpeg', 0.92)); } catch (e) { toast(storageErrorText(e), 'error'); }
  return key;
}

async function getBgImage(key) {
  if (!key) return null;
  if (bgImages.has(key)) return bgImages.get(key);
  const blob = await getBlob(key).catch(() => null);
  if (!blob) return null;
  const dec = await decodeImage(blob, {});
  bgImages.set(key, dec.image);
  return dec.image;
}

export async function setPatch(photoId, blob, rect) {
  const key = uid('patch');
  const dec = await decodeImage(blob, {});
  patches.set(key, dec.image);
  try { await putBlob(key, blob); } catch (e) { toast(storageErrorText(e), 'error'); }
  return { key, ...rect };
}

async function getPatch(patch) {
  if (!patch?.key) return null;
  if (patches.has(patch.key)) return patches.get(patch.key);
  const blob = await getBlob(patch.key).catch(() => null);
  if (!blob) return null;
  const dec = await decodeImage(blob, {});
  patches.set(patch.key, dec.image);
  return dec.image;
}

async function getTemplateAsset(id) {
  if (!id) return null;
  if (templates.has(id)) return templates.get(id);
  const t = await getTemplate(id);
  if (t) templates.set(id, t);
  return t;
}

export function registerUserTemplate(id, entry) { templates.set(id, entry); }

/** Everything renderPhoto needs, for a given source drawable. */
export async function gatherAssets(photo, src) {
  const e = photo.edit;
  const [mask, clothesMask, bgImage, tpl, patch] = await Promise.all([
    e.bg.enabled ? getPersonMask(photo) : null,
    (e.clothes.recolor.enabled || e.clothes.overlay?.enabled) ? getClothesMask(photo) : null,
    e.bg.enabled && e.bg.mode === 'image' ? getBgImage(e.bg.imageKey) : null,
    e.clothes.overlay.enabled ? getTemplateAsset(e.clothes.overlay.templateId) : null,
    e.clothes.patch ? getPatch(e.clothes.patch) : null,
  ]);
  return { src, mask, clothesMask, bgImage, template: tpl?.image || null, templateMeta: tpl?.meta || null, patch };
}
