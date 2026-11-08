// Face analysis with the local Face Landmarker. Landmarks stay in memory only.
import { getFaceLandmarker } from './runtime.js';
import { getPreview, getPersonMask, setFace, getFace } from '../state/media.js';
import { faceMetrics, crownFromMask, faceRegionStats, assessQuality, evaluateCrop, suggestCrop, genericProfile } from '../core/idphoto.js';
import { findProfile } from '../core/presets.js';
import { applyAdjustments } from '../core/adjust.js';
import { defaultCrop } from '../core/crop.js';
import { outputInfo } from '../render/export.js';
import { makeCanvas } from '../platform/image.js';
import { getState } from '../state/store.js';

function maskSampler(maskCanvas, srcW, srcH) {
  const cx = maskCanvas.getContext('2d', { willReadFrequently: true });
  const d = cx.getImageData(0, 0, maskCanvas.width, maskCanvas.height).data;
  const sx = maskCanvas.width / srcW; const sy = maskCanvas.height / srcH;
  return (x, y) => {
    const ix = Math.min(maskCanvas.width - 1, Math.max(0, Math.round(x * sx)));
    const iy = Math.min(maskCanvas.height - 1, Math.max(0, Math.round(y * sy)));
    return d[(iy * maskCanvas.width + ix) * 4 + 3] / 255;
  };
}

/** Detect faces and compute metrics in ORIGINAL pixel coordinates. */
export async function analyzeFace(photo) {
  const pv = await getPreview(photo);
  if (!pv) throw Object.assign(new Error('NO_ORIGINAL'), { code: 'NO_ORIGINAL' });
  const lmk = await getFaceLandmarker();
  const res = lmk.detect(pv.image);
  const faces = res.faceLandmarks || [];
  if (!faces.length) {
    const r = { faceCount: 0, landmarks: null, metrics: null, at: Date.now() };
    setFace(photo.id, r);
    return r;
  }
  // choose the largest face
  const area = (lm) => {
    const xs = lm.map((p) => p.x); const ys = lm.map((p) => p.y);
    return (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
  };
  const lm = faces.slice().sort((a, b) => area(b) - area(a))[0];
  let metrics = faceMetrics(lm, photo.width, photo.height);
  let crownSource = 'estimate';
  if (photo.maskKey) {
    try {
      const mask = await getPersonMask(photo);
      if (mask) {
        const crownV = crownFromMask(metrics, maskSampler(mask, photo.width, photo.height), photo.width, photo.height);
        if (crownV != null && crownV < metrics.foreheadV) {
          metrics = faceMetrics(lm, photo.width, photo.height, { crownV });
          crownSource = 'mask';
        }
      }
    } catch { /* keep estimate */ }
  }
  const stats = regionStats(pv, metrics, photo);
  const r = { faceCount: faces.length, landmarks: lm, metrics, crownSource, stats, at: Date.now() };
  setFace(photo.id, r);
  return r;
}

function regionStats(pv, m, photo) {
  const k = pv.width / photo.width;
  const b = m.bbox;
  const pad = 0.05;
  const x = Math.max(0, (b.x - b.w * pad) * k); const y = Math.max(0, (b.y - b.h * pad) * k);
  const w = Math.min(pv.width - x, b.w * (1 + 2 * pad) * k); const h = Math.min(pv.height - y, b.h * (1 + 2 * pad) * k);
  if (w < 4 || h < 4) return null;
  const S = 160;
  const c = makeCanvas(S, S);
  const cx = c.getContext('2d', { willReadFrequently: true });
  cx.drawImage(pv.image, x, y, w, h, 0, 0, S, S);
  const img = cx.getImageData(0, 0, S, S);
  applyAdjustments(img.data, S, S, photo.edit.adjust);
  return faceRegionStats(img.data, S, S);
}

export function profileFor(photo) {
  const s = getState();
  const e = photo.edit;
  const p = e.profileId ? findProfile(e.profileId, s.settings.customProfiles) : null;
  if (p && Math.abs(p.widthMm - e.widthMm) < 0.01 && Math.abs(p.heightMm - e.heightMm) < 0.01) return p;
  return genericProfile(e.widthMm, e.heightMm);
}

/** Quality checklist for the photo's current crop. */
export function currentQuality(photo) {
  const f = getFace(photo.id);
  if (!f) return null;
  if (!f.faceCount) return assessQuality({ faceCount: 0 });
  const e = photo.edit;
  const profile = profileFor(photo);
  const crop = e.crop || defaultCrop(photo.width, photo.height, e.widthMm / e.heightMm);
  const evaluation = evaluateCrop(f.metrics, crop, e.widthMm, e.heightMm, photo.width, photo.height);
  const info = outputInfo(photo, getState().project?.sheet?.dpi || getState().settings.defaultDpi);
  return assessQuality({ metrics: f.metrics, evaluation, profile, stats: f.stats, faceCount: f.faceCount, effectiveDpi: info.effectiveDpi });
}

export function suggestionFor(photo) {
  const f = getFace(photo.id);
  if (!f?.metrics) return null;
  return suggestCrop(f.metrics, profileFor(photo), photo.width, photo.height);
}
