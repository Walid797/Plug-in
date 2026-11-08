// Single rendering pipeline used for the editor preview, print preview and the
// final export — so what you see is what is printed.
//
// Order: source → (AI clothing patch) → clothing recolour → tone/colour
// adjustments (+sharpen) → background replacement (mask, edge clean-up, shadow)
// → clothing template overlay.

import { cropMatrix, invertMatrix, applyMatrix, multiplyMatrix, defaultCrop } from '../core/crop.js';
import { applyAdjustments, isNeutral, snapNearWhite } from '../core/adjust.js';
import { decontaminate, recolorRegion, boxFilter } from '../core/mask.js';
import { applyFaceEngine, ellipseToOutput, skinProbability } from '../core/faceengine.js';
import { makeCanvas } from '../platform/image.js';

export const FULL_FRAME = Object.freeze({ cx: 0.5, cy: 0.5, cw: 1, rotation: 0 });

export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return [255, 255, 255];
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function ctx2d(c) {
  return c.getContext('2d', { willReadFrequently: true });
}

/**
 * Intermediate sizes for stepwise 2× downscaling of a rw×rh region so that the
 * final draw scales by ≥ 0.5 (good quality, no aliasing). Always terminates.
 * @returns {Array<[number, number]>}
 */
export function halvingPlan(scale, rw, rh) {
  const steps = [];
  let cw = rw; let ch = rh;
  while (scale * (rw / cw) < 0.5 && cw > 2 && ch > 2 && steps.length < 24) {
    cw = Math.max(1, Math.round(cw / 2)); ch = Math.max(1, Math.round(ch / 2));
    steps.push([cw, ch]);
  }
  return steps;
}

/** Draw `image` (srcW×srcH) through matrix M with stepwise downscaling for quality. */
export function drawThrough(ctx, image, srcW, srcH, M, outW, outH) {
  const scale = Math.hypot(M[0], M[1]);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  if (scale >= 0.5) {
    ctx.setTransform(M[0], M[1], M[2], M[3], M[4], M[5]);
    ctx.drawImage(image, 0, 0, srcW, srcH);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return;
  }
  const inv = invertMatrix(M);
  const pts = [[0, 0], [outW, 0], [outW, outH], [0, outH]].map(([x, y]) => applyMatrix(inv, x, y));
  const rx0 = Math.max(0, Math.floor(Math.min(...pts.map((p) => p.x)) - 2));
  const ry0 = Math.max(0, Math.floor(Math.min(...pts.map((p) => p.y)) - 2));
  const rx1 = Math.min(srcW, Math.ceil(Math.max(...pts.map((p) => p.x)) + 2));
  const ry1 = Math.min(srcH, Math.ceil(Math.max(...pts.map((p) => p.y)) + 2));
  const rw = rx1 - rx0; const rh = ry1 - ry0;
  if (rw <= 0 || rh <= 0) return;
  const plan = halvingPlan(scale, rw, rh);
  if (!plan.length) {
    ctx.setTransform(M[0], M[1], M[2], M[3], M[4], M[5]);
    ctx.drawImage(image, 0, 0, srcW, srcH);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return;
  }
  let cur = image; let first = true;
  let kx = 1; let ky = 1;
  for (const [nw, nh] of plan) {
    const c = makeCanvas(nw, nh);
    const cx = c.getContext('2d');
    cx.imageSmoothingEnabled = true; cx.imageSmoothingQuality = 'high';
    if (first) cx.drawImage(cur, rx0, ry0, rw, rh, 0, 0, nw, nh);
    else cx.drawImage(cur, 0, 0, cur.width, cur.height, 0, 0, nw, nh);
    first = false;
    cur = c; kx = nw / rw; ky = nh / rh;
  }
  const T = multiplyMatrix(M, [1 / kx, 0, 0, 1 / ky, rx0, ry0]);
  ctx.setTransform(T[0], T[1], T[2], T[3], T[4], T[5]);
  ctx.drawImage(cur, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

/** Alpha (0..1) of a source-space mask canvas, resampled into output space. */
export function maskInOutput(maskCanvas, srcW, srcH, M, outW, outH) {
  const c = makeCanvas(outW, outH);
  const cx = ctx2d(c);
  const S = [srcW / maskCanvas.width, 0, 0, srcH / maskCanvas.height, 0, 0];
  const T = multiplyMatrix(M, S);
  cx.imageSmoothingEnabled = true; cx.imageSmoothingQuality = 'high';
  cx.setTransform(T[0], T[1], T[2], T[3], T[4], T[5]);
  cx.drawImage(maskCanvas, 0, 0);
  const d = cx.getImageData(0, 0, outW, outH).data;
  const a = new Float32Array(outW * outH);
  for (let i = 0; i < a.length; i += 1) a[i] = d[i * 4 + 3] / 255;
  return a;
}

function drawCover(ctx, img, w, h) {
  const s = Math.max(w / img.width, h / img.height);
  const dw = img.width * s; const dh = img.height * s;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

/**
 * @param {object} edit photo.edit
 * @param {{src:{image,width,height}, mask?, clothesMask?, bgImage?, template?, templateMeta?, patch?}} assets
 * @param {number} outW @param {number} outH output pixel size
 * @param {{crop?, before?:boolean, transparent?:boolean, pxPerMm?:number, frameWidthPx?:number, skipOverlay?:boolean}} [opts]
 */
export function renderPhoto(edit, assets, outW, outH, opts = {}) {
  const { src } = assets;
  const before = !!opts.before;
  const crop = opts.crop || edit.crop || defaultCrop(src.width, src.height, outW / outH);
  const M = cropMatrix(crop, src.width, src.height, outW, outH);
  const out = makeCanvas(outW, outH);
  const octx = ctx2d(out);
  const fg = makeCanvas(outW, outH);
  const fctx = ctx2d(fg);
  drawThrough(fctx, src.image, src.width, src.height, M, outW, outH);

  const clothes = edit.clothes || {};
  if (!before && clothes.patch && assets.patch) {
    const p = clothes.patch;
    const PM = multiplyMatrix(M, [p.w * src.width / assets.patch.width, 0, 0, p.h * src.height / assets.patch.height, p.x * src.width, p.y * src.height]);
    fctx.setTransform(PM[0], PM[1], PM[2], PM[3], PM[4], PM[5]);
    fctx.drawImage(assets.patch, 0, 0);
    fctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  const recolorOn = !before && clothes.recolor?.enabled && assets.clothesMask;
  const bgOn = !before && edit.bg?.enabled && assets.mask;
  const adjustOn = !before && !isNeutral(edit.adjust);
  const face = edit.face;
  const snapWhite = !before && !!edit.bg?.whiteSnap && !edit.bg?.enabled;
  const faceOn = !before && !!(face?.ellipse && (face.skin?.enabled || face.light?.enabled));
  const frameWidthPx = opts.frameWidthPx || outW;
  const pxPerMm = opts.pxPerMm || outW / (edit.widthMm || 30);

  if (recolorOn || bgOn || adjustOn || faceOn || snapWhite) {
    const img = fctx.getImageData(0, 0, outW, outH);
    const data = img.data;
    if (recolorOn) {
      const a = maskInOutput(assets.clothesMask, src.width, src.height, M, outW, outH);
      recolorRegion(data, a, outW, outH, hexToRgb(clothes.recolor.color), (clothes.recolor.strength ?? 100) / 100);
    }
    // skin probability from this face's own skin colour, measured before any tone change
    let skinP = null;
    const wantDetail = adjustOn && (edit.adjust.clarity > 0 || edit.adjust.sharpness > 0);
    if (face?.ellipse && wantDetail) skinP = skinProbability(data, outW, outH, ellipseToOutput(face.ellipse, src.width, src.height, M));
    let detailWeight = null;
    if (wantDetail && skinP) {
      // crisp hair/brows/stubble/clothes, calmer skin
      detailWeight = new Float32Array(skinP.length);
      for (let j = 0; j < skinP.length; j += 1) detailWeight[j] = 1 - 0.9 * skinP[j];
    }
    if (adjustOn) applyAdjustments(data, outW, outH, edit.adjust, { scale: Math.max(1, frameWidthPx / 350), detailWeight });
    if (faceOn) {
      const protect = (face.protect || []).map((z) => ellipseToOutput(z, src.width, src.height, M));
      const rep = applyFaceEngine(data, outW, outH, ellipseToOutput(face.ellipse, src.width, src.height, M), { ...face, protect });
      if (opts.faceReport) Object.assign(opts.faceReport, rep);
    }
    if (snapWhite) snapNearWhite(data);
    let alpha = null;
    if (bgOn) {
      alpha = maskInOutput(assets.mask, src.width, src.height, M, outW, outH);
      if (edit.bg.decontaminate !== false) decontaminate(data, alpha, outW, outH, Math.max(2, Math.round(frameWidthPx / 120)));
      for (let i = 0; i < alpha.length; i += 1) data[i * 4 + 3] = Math.round((data[i * 4 + 3] / 255) * alpha[i] * 255);
    }
    fctx.putImageData(img, 0, 0);
    if (bgOn) {
      const transparent = opts.transparent || edit.bg.mode === 'transparent';
      if (!transparent) {
        if (edit.bg.mode === 'image' && assets.bgImage) drawCover(octx, assets.bgImage, outW, outH);
        else { octx.fillStyle = edit.bg.color || '#ffffff'; octx.fillRect(0, 0, outW, outH); }
        const sh = edit.bg.shadow;
        if (sh?.enabled && sh.opacity > 0) drawShadow(octx, alpha, outW, outH, sh, pxPerMm);
      }
    } else {
      octx.fillStyle = (edit.bg && edit.bg.color) || '#ffffff';
      octx.fillRect(0, 0, outW, outH);
    }
  } else {
    octx.fillStyle = (!before && edit.bg && edit.bg.color) || '#ffffff';
    octx.fillRect(0, 0, outW, outH);
  }
  octx.drawImage(fg, 0, 0);

  const ov = clothes.overlay;
  if (!before && !opts.skipOverlay && ov?.enabled && assets.template && assets.templateMeta) {
    const meta = assets.templateMeta;
    const wPx = ov.width * src.width;
    const hPx = wPx / meta.aspect;
    const r = ((ov.rotation || 0) * Math.PI) / 180;
    const cos = Math.cos(r); const sin = Math.sin(r);
    const local = [cos, sin, -sin, cos, ov.x * src.width, ov.y * src.height];
    const T = multiplyMatrix(M, local);
    octx.imageSmoothingQuality = 'high';
    octx.setTransform(T[0], T[1], T[2], T[3], T[4], T[5]);
    octx.drawImage(assets.template, -meta.anchorX * wPx, -meta.anchorY * hPx, wPx, hPx);
    octx.setTransform(1, 0, 0, 1, 0, 0);
  }
  return out;
}

function drawShadow(ctx, alpha, w, h, sh, pxPerMm) {
  const r = Math.max(1, Math.round((sh.blurMm ?? 2) * pxPerMm));
  const blurred = boxFilter(boxFilter(alpha, w, h, Math.ceil(r / 2)), w, h, Math.ceil(r / 2));
  const c = makeCanvas(w, h);
  const cx = ctx2d(c);
  const img = cx.createImageData(w, h);
  const op = Math.min(1, (sh.opacity ?? 30) / 100);
  for (let i = 0; i < blurred.length; i += 1) img.data[i * 4 + 3] = Math.round(blurred[i] * op * 255);
  cx.putImageData(img, 0, 0);
  ctx.drawImage(c, (sh.offsetXmm ?? 0) * pxPerMm, (sh.offsetYmm ?? 1) * pxPerMm);
}

/** Build a canvas whose alpha channel holds a Uint8 mask. */
export function alphaCanvasFromBytes(bytes, w, h) {
  const c = makeCanvas(w, h);
  const cx = ctx2d(c);
  const img = cx.createImageData(w, h);
  for (let i = 0; i < w * h; i += 1) {
    img.data[i * 4] = 255; img.data[i * 4 + 1] = 255; img.data[i * 4 + 2] = 255; img.data[i * 4 + 3] = bytes[i];
  }
  cx.putImageData(img, 0, 0);
  return c;
}

/** Brush strokes on a mask canvas (alpha = foreground). Coordinates are normalised to the source. */
export function applyStrokes(maskCanvas, strokes) {
  if (!strokes?.length) return maskCanvas;
  const w = maskCanvas.width; const h = maskCanvas.height;
  const cx = maskCanvas.getContext('2d');
  for (const s of strokes) {
    const radius = Math.max(0.5, s.size * w);
    const hard = 1 - Math.min(1, Math.max(0, s.softness ?? 0.5));
    cx.globalCompositeOperation = s.mode === 'erase' ? 'destination-out' : 'source-over';
    const stamp = (x, y) => {
      const g = cx.createRadialGradient(x, y, radius * hard * 0.999, x, y, radius);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      cx.fillStyle = g;
      cx.beginPath();
      cx.arc(x, y, radius, 0, Math.PI * 2);
      cx.fill();
    };
    const pts = s.points;
    if (!pts.length) continue;
    let [px, py] = [pts[0][0] * w, pts[0][1] * h];
    stamp(px, py);
    const step = Math.max(0.5, radius * 0.25);
    for (let i = 1; i < pts.length; i += 1) {
      const x = pts[i][0] * w; const y = pts[i][1] * h;
      const d = Math.hypot(x - px, y - py);
      for (let t = step; t <= d; t += step) stamp(px + ((x - px) * t) / d, py + ((y - py) * t) / d);
      px = x; py = y;
    }
  }
  cx.globalCompositeOperation = 'source-over';
  return maskCanvas;
}

export function cloneCanvas(c) {
  const n = makeCanvas(c.width, c.height);
  n.getContext('2d').drawImage(c, 0, 0);
  return n;
}
