// AI enhancement of a photo, fully on this device: relight (baked in) → ×4 upscaling of a small source
// (Real-ESRGAN) → face restoration (GFPGAN, blended by a strength the user controls). The result is stored as the
// photo's "enhanced version": a picture with the same framing as the original that the normal render pipeline then
// uses as its source. The original file is never changed and stays available.
import { getState, updateEdit } from '../state/store.js';
import { getFace, getOriginal, getPreview, relightBaked, getClassMasks, getRelight, setEnhanced, clearEnhanced, invalidatePreview } from '../state/media.js';
import { getOnnxModel, disposeModel } from './runtime.js';
import { decodeImage, makeCanvas, canvasToBlob, workingPixelLimit } from '../platform/image.js';
import { applyRelight } from '../core/relight.js';
import { fivePoints, similarityFit, FACE_TEMPLATE, FACE_SIZE, featherWeight, restoreShare, upscalePlan, tilePlan, maskBounds, toPlanar, fromPlanar, mergeFaceDetail } from '../core/enhance.js';
import { skinProfile, findBlemishes, healBlemishes, skinPlan, evenLightField, applyGainField } from '../core/skinprofile.js';
import { drawThrough } from '../render/renderPhoto.js';
import { multiplyMatrix, invertMatrix } from '../core/crop.js';

const READY = ['available', 'ready'];
const ctx2d = (c) => c.getContext('2d', { willReadFrequently: true });

/** Which enhancement models can be used right now. */
export function enhanceAvailability(s = getState()) {
  return { restore: READY.includes(s.models.gfpgan?.status), upscale: READY.includes(s.models.realesr?.status) };
}

const aborted = (signal) => { if (signal?.aborted) throw Object.assign(new Error('CANCELLED'), { code: 'CANCELLED' }); };

/**
 * Build and store the enhanced version of a photo whose face has been analysed.
 * @param {object} photo
 * @param {{strength?:number, upscale?:boolean, restore?:boolean, onProgress?:(p:number,label:string)=>void, signal?:AbortSignal}} [opt] strength 0..100 of the face restoration
 * @returns {Promise<object>} report: { srcW, srcH, outW, outH, scale, relit, restored, share, upscaleMs, restoreMs, tiles }
 */
export async function enhancePhoto(photo, opt = {}) {
  const { strength = 80, upscale = true, restore = true, onProgress = () => {}, signal } = opt;
  const av = enhanceAvailability();
  const lm = getFace(photo.id)?.landmarks;
  if (!lm) throw Object.assign(new Error('NO_FACE'), { code: 'NO_FACE' });
  if (!(upscale && av.upscale) && !restore) throw Object.assign(new Error('MODEL_MISSING'), { code: 'MODEL_MISSING' });
  const blob = await getOriginal(photo, { raw: true });
  if (!blob) throw Object.assign(new Error('NO_ORIGINAL'), { code: 'NO_ORIGINAL' });
  onProgress(0.02, 'خواندن عکس اصلی');
  const dec = await decodeImage(blob, { maxPixels: workingPixelLimit(getState().caps), expected: { displayWidth: photo.width, displayHeight: photo.height } });
  let w = dec.width; let h = dec.height;
  let c = makeCanvas(w, h); let cx = ctx2d(c);
  cx.drawImage(dec.image, 0, 0, w, h);
  if (dec.image.close) dec.image.close();
  const report = { srcW: w, srcH: h, relit: false, restored: false, scale: 1, share: 0, tiles: 0 };

  // 1. relight on the photo's own pixels, so the models below see (and rebuild detail on) an evenly lit face
  const rl = photo.edit.face?.relight?.enabled ? await getRelight(photo) : null;
  if (rl) {
    const img = cx.getImageData(0, 0, w, h);
    const r = applyRelight(img.data, w, h, rl.packed, multiplyMatrix(rl.W, [rl.refW / w, 0, 0, rl.refH / h, 0, 0]), { strength: (photo.edit.face.relight.strength ?? 100) / 100 });
    if (r.applied) { cx.putImageData(img, 0, 0); report.relit = true; }
  }
  aborted(signal);

  // 2. upscaling of a small source (only the person's region goes through the model; the rest is resampled smoothly)
  const faceW0 = Math.hypot((lm[454].x - lm[234].x) * w, (lm[454].y - lm[234].y) * h);
  const plan = upscale && av.upscale ? upscalePlan(w, h, faceW0) : { scale: 1, outW: w, outH: h };
  if (plan.scale > 1) {
    onProgress(0.06, 'آماده‌سازی مدل بزرگ‌نمایی');
    const { ort, session } = await getOnnxModel('realesr');
    const t0 = performance.now();
    const big = makeCanvas(w * 4, h * 4); const bx = ctx2d(big);
    bx.imageSmoothingEnabled = true; bx.imageSmoothingQuality = 'high';
    bx.drawImage(c, 0, 0, w * 4, h * 4);
    const cls = getClassMasks(photo.id);
    const tiles = tilePlan(w, h, cls ? maskBounds(cls.person, cls.w, cls.h, w, h) : null);
    for (let i = 0; i < tiles.length; i += 1) {
      aborted(signal);
      const t = tiles[i];
      const d = cx.getImageData(t.sx, t.sy, t.sw, t.sh).data;
      const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', toPlanar(d, t.sw, t.sh), [1, 3, t.sh, t.sw]) });
      const o = out[session.outputNames[0]];
      const ow = t.sw * 4; const oh = t.sh * 4;
      if (o.data.length !== 3 * ow * oh) throw Object.assign(new Error('BAD_OUTPUT'), { code: 'BAD_OUTPUT' });
      const img = bx.createImageData(ow, oh);
      fromPlanar(o.data, ow, oh, img.data);
      // only the tile's core is written; its padding was context
      bx.putImageData(img, t.sx * 4, t.sy * 4, (t.cx - t.sx) * 4, (t.cy - t.sy) * 4, t.cw * 4, t.ch * 4);
      onProgress(0.08 + 0.52 * ((i + 1) / tiles.length), `بزرگ‌نمایی ${i + 1} از ${tiles.length}`);
    }
    report.tiles = tiles.length; report.upscaleMs = Math.round(performance.now() - t0);
    if (plan.outW !== w * 4 || plan.outH !== h * 4) {
      const c2 = makeCanvas(plan.outW, plan.outH);
      drawThrough(ctx2d(c2), big, w * 4, h * 4, [plan.outW / (w * 4), 0, 0, plan.outH / (h * 4), 0, 0], plan.outW, plan.outH);
      c = c2; big.width = 0; big.height = 0;
    } else c = big;
    cx = ctx2d(c); w = plan.outW; h = plan.outH; report.scale = plan.scale;
  }
  aborted(signal);

  // 3. the face, on the aligned face square: the skin is measured (tone, blemishes) and a plan is made for this very
  // face; blemishes are covered with the clean skin around them; then the restoration model (when installed) rebuilds
  // the face on that clean base, and its new skin and detail are blended back with a soft edge.
  if (restore) {
    const useModel = av.restore;
    let ort = null; let session = null;
    if (useModel) { onProgress(0.62, 'آماده‌سازی مدل بازسازی چهره'); ({ ort, session } = await getOnnxModel('gfpgan')); }
    aborted(signal);
    const A = similarityFit(fivePoints(lm, w, h), FACE_TEMPLATE);
    const inv = A ? invertMatrix(A) : null;
    if (A && inv) {
      onProgress(0.68, 'تحلیل پوست و پاک‌کردن لکه‌ها');
      const t0 = performance.now();
      const fc = makeCanvas(FACE_SIZE, FACE_SIZE); const fx = ctx2d(fc);
      fx.fillStyle = 'rgb(135,133,132)'; fx.fillRect(0, 0, FACE_SIZE, FACE_SIZE);
      drawThrough(fx, c, w, h, A, FACE_SIZE, FACE_SIZE);
      let fd = fx.getImageData(0, 0, FACE_SIZE, FACE_SIZE);
      let profile = skinProfile(fd.data, FACE_SIZE);
      // light on the skin evened out, by as much as this face needs; applied to the photo's own pixels at full
      // resolution (the field is smooth), then the face is read again
      if (profile) {
        const ev = evenLightField(fd.data, profile);
        report.light = { uneven: ev.uneven, amount: ev.amount };
        if (ev.gain) {
          const img = cx.getImageData(0, 0, w, h);
          applyGainField(img.data, w, h, ev.gain, FACE_SIZE, A);
          cx.putImageData(img, 0, 0);
          fx.fillStyle = 'rgb(135,133,132)'; fx.fillRect(0, 0, FACE_SIZE, FACE_SIZE);
          drawThrough(fx, c, w, h, A, FACE_SIZE, FACE_SIZE);
          fd = fx.getImageData(0, 0, FACE_SIZE, FACE_SIZE);
          profile = skinProfile(fd.data, FACE_SIZE) || profile;
          report.light.unevenAfter = evenLightField(fd.data, profile).uneven;
        }
      }
      const found = profile ? findBlemishes(fd.data, profile, { moles: true }) : null;
      const plan = profile ? skinPlan(profile, { faceWidthPx: faceW0, strength: strength / 100, blemishArea: found.area }) : null;
      const healed = found?.count ? healBlemishes(fd.data, profile, found) : fd.data;
      if (profile) { report.skin = publicProfile(profile); report.plan = plan; report.blemishes = { count: found.count, kept: found.kept, area: found.area }; }
      let merged = healed; let share = 0;
      if (useModel) {
        onProgress(0.72, 'بازسازی پوست و جزئیات چهره');
        const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', toPlanar(healed, FACE_SIZE, FACE_SIZE, -1, 1), [1, 3, FACE_SIZE, FACE_SIZE]) });
        const o = out[session.outputNames[0]];
        if (o.data.length !== 3 * FACE_SIZE * FACE_SIZE) throw Object.assign(new Error('BAD_OUTPUT'), { code: 'BAD_OUTPUT' });
        const faceW = Math.hypot((lm[454].x - lm[234].x) * w, (lm[454].y - lm[234].y) * h);
        share = restoreShare(faceW, plan ? plan.restoreStrength : strength / 100);
        const model = new Uint8ClampedArray(FACE_SIZE * FACE_SIZE * 4);
        fromPlanar(o.data, FACE_SIZE, FACE_SIZE, model, -1, 1);
        // the photo keeps its light and the person's own skin tone; the skin itself and all fine detail are the model's
        merged = mergeFaceDetail(healed, model, FACE_SIZE, plan ? { skin: profile.regenMask, regen: plan.regen, sigmaSkin: plan.sigmaSkin, chromaEven: plan.chromaEven, midKeep: plan.midKeep } : {});
      } else if (plan && plan.regen > 0) {
        // no restoration model: the skin is still evened out and smoothed from the photo's own pixels
        const faceW = Math.hypot((lm[454].x - lm[234].x) * w, (lm[454].y - lm[234].y) * h);
        share = restoreShare(faceW, plan.restoreStrength);
        merged = mergeFaceDetail(healed, healed, FACE_SIZE, { skin: profile.regenMask, regen: plan.regen, sigmaSkin: plan.sigmaSkin, chromaEven: plan.chromaEven, midKeep: plan.midKeep, chromaDetail: 0 });
      }
      if (share > 0 || found?.count) {
        // rebuilt face at its share; healed blemishes at full weight (a large face keeps its own pixels everywhere else)
        const res = fx.createImageData(FACE_SIZE, FACE_SIZE); const rd = res.data; const hm = found?.count ? found.mask : null;
        for (let y = 0, j = 0; y < FACE_SIZE; y += 1) {
          for (let x = 0; x < FACE_SIZE; x += 1, j += 1) {
            const i = j * 4; const hw = hm ? (1 - share) * hm[j] : 0; const tot = share + hw;
            if (tot <= 0) { rd[i + 3] = 0; continue; }
            rd[i] = (share * merged[i] + hw * healed[i]) / tot; rd[i + 1] = (share * merged[i + 1] + hw * healed[i + 1]) / tot; rd[i + 2] = (share * merged[i + 2] + hw * healed[i + 2]) / tot;
            rd[i + 3] = Math.round(255 * featherWeight(x, y) * tot);
          }
        }
        fx.clearRect(0, 0, FACE_SIZE, FACE_SIZE);
        fx.putImageData(res, 0, 0);
        cx.save();
        cx.imageSmoothingEnabled = true; cx.imageSmoothingQuality = 'high';
        cx.setTransform(inv[0], inv[1], inv[2], inv[3], inv[4], inv[5]);
        cx.drawImage(fc, 0, 0);
        cx.restore();
        report.restored = useModel; report.smoothed = share > 0; report.healed = found?.count || 0; report.share = share; report.restoreMs = Math.round(performance.now() - t0);
      }
    }
  }
  aborted(signal);
  onProgress(0.94, 'ذخیرهٔ نسخهٔ بهبودیافته');
  const outBlob = await canvasToBlob(c, 'image/jpeg', 0.95);
  report.outW = w; report.outH = h;
  await setEnhanced(photo.id, outBlob, { width: w, height: h, relit: report.relit, relitStrength: report.relit ? (photo.edit.face.relight.strength ?? 100) : 0, strength, scale: report.scale, restored: report.restored });
  updateEdit(photo.id, (ed) => ({ ...ed, enhance: { enabled: true, strength } }), { history: false });
  invalidatePreview(photo.id);
  c.width = 0; c.height = 0;
  onProgress(1, 'انجام شد');
  return report;
}

const publicProfile = (p) => ({ spanL: p.spanL, p5: p.p5, p95: p.p95, lipRedness: p.lipRedness, socketRatio: p.socketRatio, redPatches: p.redPatches, L: p.L, a: p.a, b: p.b, chroma: p.chroma, hue: p.hue, ita: p.ita, tone: p.tone, luma: p.luma, skinToSclera: p.skinToSclera, skinFraction: p.skinFraction, noise: p.noise });

/**
 * Skin profile and plan of a photo without building an enhanced version (used when the enhancement is switched off):
 * measured on the relit preview.
 * @returns {Promise<{skin:object, plan:object, blemishes:object}|null>}
 */
export async function measureSkin(photo, strength = 75) {
  const lm = getFace(photo.id)?.landmarks;
  const pv = lm ? await getPreview(photo) : null;
  if (!pv) return null;
  const w = pv.width; const h = pv.height;
  const c = makeCanvas(w, h); const cx = ctx2d(c);
  cx.drawImage(pv.image, 0, 0, w, h);
  const rl = photo.edit.face?.relight?.enabled && !relightBaked(photo) ? await getRelight(photo) : null;
  if (rl) {
    const img = cx.getImageData(0, 0, w, h);
    if (applyRelight(img.data, w, h, rl.packed, multiplyMatrix(rl.W, [rl.refW / w, 0, 0, rl.refH / h, 0, 0]), { strength: (photo.edit.face.relight.strength ?? 100) / 100 }).applied) cx.putImageData(img, 0, 0);
  }
  const A = similarityFit(fivePoints(lm, w, h), FACE_TEMPLATE);
  if (!A) return null;
  const fc = makeCanvas(FACE_SIZE, FACE_SIZE); const fx = ctx2d(fc);
  fx.fillStyle = 'rgb(135,133,132)'; fx.fillRect(0, 0, FACE_SIZE, FACE_SIZE);
  drawThrough(fx, c, w, h, A, FACE_SIZE, FACE_SIZE);
  const fd = fx.getImageData(0, 0, FACE_SIZE, FACE_SIZE);
  c.width = 0; c.height = 0;
  const profile = skinProfile(fd.data, FACE_SIZE);
  if (!profile) return null;
  const found = findBlemishes(fd.data, profile, { moles: true });
  const faceW = Math.hypot((lm[454].x - lm[234].x) * photo.width, (lm[454].y - lm[234].y) * photo.height);
  return { skin: publicProfile(profile), plan: skinPlan(profile, { faceWidthPx: faceW, strength: strength / 100, blemishArea: found.area }), blemishes: { count: found.count, kept: found.kept, area: found.area } };
}

/** Switch the enhanced version on or off for rendering (it stays stored either way). */
export function setEnhanceEnabled(photoId, enabled) {
  updateEdit(photoId, (ed) => ({ ...ed, enhance: { ...(ed.enhance || {}), enabled } }));
  invalidatePreview(photoId);
}

/** Free the memory of the enhancement models (the face model alone holds several hundred megabytes). */
export function releaseEnhanceModels() { disposeModel('gfpgan'); disposeModel('realesr'); }

export { clearEnhanced };
