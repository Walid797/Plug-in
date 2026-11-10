// AI enhancement, pure parts: face alignment for the restoration model, tiling for the upscaler, and the rules
// that decide how much of each is used. No DOM, no model code.
import { gaussBlur } from './relight.js';

/** Side of the square the face-restoration model works on. */
export const FACE_SIZE = 512;
/** Alignment template of that model (FFHQ, 512 px): eye centres, nose tip, mouth corners — left of the picture first. */
export const FACE_TEMPLATE = Object.freeze([[192.98138, 239.94708], [318.90277, 240.1936], [256.63416, 314.01935], [201.26117, 371.41043], [313.08905, 371.15118]]);
/** Width of a face (cheek to cheek, landmarks 234–454) in the template, in pixels: what the model can resolve. */
export const TEMPLATE_FACE_WIDTH = 290;

/** The five alignment points from the 478 face landmarks (normalised), in pixels of a w×h picture. */
export function fivePoints(lm, w, h) {
  const p = (i) => [lm[i].x * w, lm[i].y * h];
  const mid = (i, j) => { const a = p(i); const b = p(j); return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; };
  const iris = lm.length >= 478;
  return [iris ? p(468) : mid(33, 133), iris ? p(473) : mid(263, 362), p(4), p(61), p(291)];
}

/**
 * Least-squares similarity (rotation, uniform scale, shift — no mirror) taking src points to dst points.
 * @returns {number[]|null} canvas-style matrix [a,b,c,d,e,f]
 */
export function similarityFit(src, dst) {
  const n = Math.min(src.length, dst.length);
  if (n < 2) return null;
  let sx = 0; let sy = 0; let dx = 0; let dy = 0;
  for (let i = 0; i < n; i += 1) { sx += src[i][0]; sy += src[i][1]; dx += dst[i][0]; dy += dst[i][1]; }
  sx /= n; sy /= n; dx /= n; dy /= n;
  let num1 = 0; let num2 = 0; let den = 0;
  for (let i = 0; i < n; i += 1) {
    const x = src[i][0] - sx; const y = src[i][1] - sy; const u = dst[i][0] - dx; const v = dst[i][1] - dy;
    num1 += x * u + y * v; num2 += x * v - y * u; den += x * x + y * y;
  }
  if (!(den > 1e-9)) return null;
  const a = num1 / den; const b = num2 / den;
  if (!(Math.hypot(a, b) > 1e-9)) return null;
  return [a, b, -b, a, dx - (a * sx - b * sy), dy - (b * sx + a * sy)];
}

/**
 * Blend weight of the restored face square: 1 over the face, falling smoothly to 0 before the border, so the paste
 * has no seam. d = distance to the nearest border of the square, in template pixels.
 */
export function featherWeight(x, y, size = FACE_SIZE, inner = 34, outer = 120) {
  const d = Math.min(x, y, size - 1 - x, size - 1 - y);
  let t = (d - inner) / (outer - inner); t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
}

/**
 * How strongly the restored face replaces the photo's own. The model resolves a face about TEMPLATE_FACE_WIDTH px wide:
 * a face with more pixels than that already carries finer detail than the model can give, so its share falls
 * (down to 30 %) as the face gets larger. strength 0..1 is the user's setting.
 */
export function restoreShare(faceWidthPx, strength = 0.8) {
  const s = Math.min(1, Math.max(0, strength));
  if (!(faceWidthPx > 0)) return 0;
  const lo = TEMPLATE_FACE_WIDTH * 1.6; const hi = TEMPLATE_FACE_WIDTH * 3.8;
  const t = Math.min(1, Math.max(0, (faceWidthPx - lo) / (hi - lo)));
  return s * (1 - 0.7 * t);
}

/**
 * Upscaling plan for a w×h source: ×4 for small pictures (the face would otherwise be printed from too few pixels),
 * none when the source is already large. The result never exceeds `maxSide` on its longer side.
 * @returns {{scale:number, outW:number, outH:number, reason:string}}
 */
export function upscalePlan(w, h, faceWidthPx, { maxSide = 2600, smallSide = 1100, smallFace = 420 } = {}) {
  const long = Math.max(w, h);
  const small = long <= smallSide || (faceWidthPx > 0 && faceWidthPx < smallFace && long <= smallSide * 1.5);
  if (!small) return { scale: 1, outW: w, outH: h, reason: 'large' };
  const k = Math.min(4, maxSide / long);
  if (k < 1.5) return { scale: 1, outW: w, outH: h, reason: 'large' };
  return { scale: k, outW: Math.round(w * k), outH: Math.round(h * k), reason: 'small' };
}

/**
 * Tiles for the upscaler over the region x0..x1 × y0..y1 of a w×h picture: each tile is run with `pad` pixels of
 * context on every side (cut off at the picture's edge) and only its core is kept, so tiles join without seams.
 * @returns {Array<{sx:number, sy:number, sw:number, sh:number, cx:number, cy:number, cw:number, ch:number}>} padded source rect and core rect
 */
export function tilePlan(w, h, region = null, tile = 192, pad = 12) {
  const rx0 = Math.max(0, Math.floor(region?.x0 ?? 0)); const ry0 = Math.max(0, Math.floor(region?.y0 ?? 0));
  const rx1 = Math.min(w, Math.ceil(region?.x1 ?? w)); const ry1 = Math.min(h, Math.ceil(region?.y1 ?? h));
  const out = [];
  for (let y = ry0; y < ry1; y += tile) {
    for (let x = rx0; x < rx1; x += tile) {
      const cw = Math.min(tile, rx1 - x); const ch = Math.min(tile, ry1 - y);
      const sx = Math.max(0, x - pad); const sy = Math.max(0, y - pad);
      const ex = Math.min(w, x + cw + pad); const ey = Math.min(h, y + ch + pad);
      out.push({ sx, sy, sw: ex - sx, sh: ey - sy, cx: x, cy: y, cw, ch });
    }
  }
  return out;
}

/** Bounding box (in pixels of a w×h picture) of a small class map's foreground, grown by `margin` of its size; null when empty. */
export function maskBounds(bytes, mw, mh, w, h, margin = 0.06, threshold = 96) {
  let x0 = mw; let y0 = mh; let x1 = -1; let y1 = -1;
  for (let y = 0; y < mh; y += 1) for (let x = 0; x < mw; x += 1) if (bytes[y * mw + x] >= threshold) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return null;
  const kx = w / mw; const ky = h / mh; const gx = (x1 - x0 + 1) * margin * kx; const gy = (y1 - y0 + 1) * margin * ky;
  return { x0: Math.max(0, x0 * kx - gx), y0: Math.max(0, y0 * ky - gy), x1: Math.min(w, (x1 + 1) * kx + gx), y1: Math.min(h, (y1 + 1) * ky + gy) };
}

/** RGBA bytes → planar float RGB (NCHW) in [lo, hi]. */
export function toPlanar(rgba, w, h, lo = 0, hi = 1) {
  const n = w * h; const out = new Float32Array(3 * n); const k = (hi - lo) / 255;
  for (let i = 0, j = 0; j < n; i += 4, j += 1) { out[j] = rgba[i] * k + lo; out[n + j] = rgba[i + 1] * k + lo; out[2 * n + j] = rgba[i + 2] * k + lo; }
  return out;
}

/** Planar float RGB (NCHW, values in [lo, hi]) → RGBA bytes written into `rgba` (alpha 255). */
export function fromPlanar(planar, w, h, rgba, lo = 0, hi = 1) {
  const n = w * h; const k = 255 / (hi - lo);
  for (let i = 0, j = 0; j < n; i += 4, j += 1) {
    rgba[i] = Math.round(Math.min(255, Math.max(0, (planar[j] - lo) * k)));
    rgba[i + 1] = Math.round(Math.min(255, Math.max(0, (planar[n + j] - lo) * k)));
    rgba[i + 2] = Math.round(Math.min(255, Math.max(0, (planar[2 * n + j] - lo) * k)));
    rgba[i + 3] = 255;
  }
  return rgba;
}

/**
 * Take only the detail of a restored face. The restoration model returns a whole new face square with its own skin
 * tone, lighting and eye colour; pasting that would change how the person looks. Here the photo keeps its own tone
 * and lighting (everything coarser than `sigma` px of luminance) and its own colour (chroma), and the model
 * contributes the luminance detail finer than that, plus a small share of its colour detail (clean edges of lips and iris).
 * @param {Uint8ClampedArray} base RGBA of the aligned face square taken from the photo
 * @param {Uint8ClampedArray} restored RGBA of the model's output for it
 * @returns {Uint8ClampedArray} RGBA (alpha 255)
 */
export function mergeFaceDetail(base, restored, size = FACE_SIZE, { sigma = 14, chromaDetail = 0.5 } = {}) {
  const n = size * size;
  const planes = (d) => {
    const Y = new Float32Array(n); const Cb = new Float32Array(n); const Cr = new Float32Array(n);
    for (let i = 0, j = 0; j < n; i += 4, j += 1) {
      const R = d[i]; const G = d[i + 1]; const B = d[i + 2];
      Y[j] = 0.299 * R + 0.587 * G + 0.114 * B; Cb[j] = -0.168736 * R - 0.331264 * G + 0.5 * B; Cr[j] = 0.5 * R - 0.418688 * G - 0.081312 * B;
    }
    return { Y, Cb, Cr };
  };
  const b = planes(base); const r = planes(restored);
  const lpB = gaussBlur(b.Y, size, size, sigma); const lpR = gaussBlur(r.Y, size, size, sigma);
  const chroma = (cb, cr) => {
    const smoothBase = gaussBlur(cb, size, size, 1.5); // the photo's colour, without its JPEG colour blocks
    const lp = gaussBlur(cr, size, size, 5);
    const out = new Float32Array(n);
    for (let j = 0; j < n; j += 1) out[j] = smoothBase[j] + chromaDetail * (cr[j] - lp[j]);
    return out;
  };
  const Cb = chroma(b.Cb, r.Cb); const Cr = chroma(b.Cr, r.Cr);
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0, j = 0; j < n; i += 4, j += 1) {
    const Y = r.Y[j] - lpR[j] + lpB[j];
    out[i] = Y + 1.402 * Cr[j]; out[i + 1] = Y - 0.344136 * Cb[j] - 0.714136 * Cr[j]; out[i + 2] = Y + 1.772 * Cb[j]; out[i + 3] = 255;
  }
  return out;
}
