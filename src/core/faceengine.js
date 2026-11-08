// Face & skin engine and lighting engine — local, texture-preserving corrections.
//
// What it does (all limited to the skin inside the face ellipse; never any warping):
//  • skin detection per photo: the skin colour cluster is measured from the face itself, so any
//    skin tone works; lips, eyes, brows, beard and hair fall outside the cluster and are untouched;
//  • excess redness: only the part of the redness above a natural limit is pulled back, as a smooth
//    low-frequency shift (the fine texture of the skin is not touched);
//  • colour evenness: large blotches of colour are evened out, fine detail kept;
//  • fill light: shadows inside the skin (under the eyes, beside the nose, under the chin, forehead)
//    are lifted towards the local skin tone, with a cap so the face is never "whitened";
//  • left/right light balance, and highlight protection against burnt skin.
// Face geometry is never changed: no resizing, reshaping or smoothing of features.

import { boxFilter } from './mask.js';
import { faceToSource } from './idphoto.js';

export const FACE_ENGINE_DEFAULTS = Object.freeze({
  skin: Object.freeze({ enabled: true, redness: 40, balance: 40 }),
  light: Object.freeze({ enabled: true, fill: 45, even: true, protect: true }),
});

/** Natural limit for red vs yellow in skin ((Cr-128)/(128-Cb)); only redness above it is reduced. */
export const REDNESS_LIMIT = 1.5;
const MAX_RED_SHIFT = 7; // Cr levels
const MAX_BLOTCH_SHIFT = 4;
const MAX_FILL_LIFT = 24; // luma levels
const MAX_EVEN_GAIN = 0.08;
const PROTECT_FROM = 224;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

/**
 * Face ellipse in source-normalised units (x,y over the source size, radii over the source width)
 * from face metrics. Covers forehead to just below the chin (chin shadow).
 */
export function faceEllipse(m, srcW, srcH) {
  const top = m.foreheadV;
  const bottom = m.chinV * 1.1;
  const c = faceToSource(m, m.faceCenterU, (top + bottom) / 2);
  return {
    cx: c.x / srcW, cy: c.y / srcH,
    rx: (m.faceWidth / 2) * 1.05 / srcW,
    ry: ((bottom - top) / 2) * 1.05 / srcW,
    rot: m.rollDeg,
  };
}

/** Map a source-normalised ellipse into output pixels through the crop matrix M. */
export function ellipseToOutput(ell, srcW, srcH, M) {
  const scale = Math.hypot(M[0], M[1]);
  return {
    cx: M[0] * ell.cx * srcW + M[2] * ell.cy * srcH + M[4],
    cy: M[1] * ell.cx * srcW + M[3] * ell.cy * srcH + M[5],
    rx: ell.rx * srcW * scale, ry: ell.ry * srcW * scale,
    rot: (ell.rot * Math.PI) / 180 + Math.atan2(M[1], M[0]),
  };
}

const median = (arr) => {
  const a = Float32Array.from(arr).sort();
  return a[a.length >> 1];
};

/**
 * Per-photo skin colour cluster (median Cb/Cr of the face's own skin pixels), or null when too little skin is found.
 * @returns {{mCb:number,mCr:number}|null}
 */
export function measureSkinCluster(data, w, h, ell) {
  if (!ell || !(ell.rx > 4) || !(ell.ry > 4)) return null;
  const cos = Math.cos(ell.rot); const sin = Math.sin(ell.rot);
  const rr = Math.max(ell.rx, ell.ry);
  const x0 = Math.max(0, Math.floor(ell.cx - rr)); const x1 = Math.min(w, Math.ceil(ell.cx + rr));
  const y0 = Math.max(0, Math.floor(ell.cy - rr)); const y1 = Math.min(h, Math.ceil(ell.cy + rr));
  const cbs = []; const crs = [];
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const dx = x + 0.5 - ell.cx; const dy = y + 0.5 - ell.cy;
      const u = (dx * cos + dy * sin) / ell.rx; const v = (-dx * sin + dy * cos) / ell.ry;
      if (Math.hypot(u, v) >= 0.6) continue;
      const i = (y * w + x) * 4; const R = data[i]; const G = data[i + 1]; const B = data[i + 2];
      const Yv = 0.299 * R + 0.587 * G + 0.114 * B; const cb = 128 - 0.168736 * R - 0.331264 * G + 0.5 * B; const cr = 128 + 0.5 * R - 0.418688 * G - 0.081312 * B;
      if (Yv > 50 && Yv < 240 && cb > 77 && cb < 127 && cr > 133 && cr < 173) { cbs.push(cb); crs.push(cr); }
    }
  }
  if (cbs.length < 150) return null;
  return { mCb: median(cbs), mCr: median(crs) };
}

/**
 * Detail weight map for sharpening / clarity: 1 on everything that is not skin (hair, brows, stubble,
 * clothes) and `skinFactor` on skin, so crisp hair does not turn into crunchy skin. Whole image, smooth.
 * @returns {Float32Array|null} null when the skin colour cannot be measured (then detail applies evenly)
 */
export function skinDetailWeight(data, w, h, ell, skinFactor = 0.35) {
  const cl = measureSkinCluster(data, w, h, ell);
  if (!cl) return null;
  const n = w * h;
  const p = new Float32Array(n);
  for (let j = 0, i = 0; j < n; j += 1, i += 4) {
    const R = data[i]; const G = data[i + 1]; const B = data[i + 2];
    const Yv = 0.299 * R + 0.587 * G + 0.114 * B;
    const dCb = (128 - 0.168736 * R - 0.331264 * G + 0.5 * B - cl.mCb) / 7; const dCr = (128 + 0.5 * R - 0.418688 * G - 0.081312 * B - cl.mCr) / 8;
    p[j] = Math.exp(-0.5 * (dCb * dCb + dCr * dCr)) * smooth(35, 75, Yv) * (1 - smooth(238, 252, Yv));
  }
  const ps = boxFilter(p, w, h, Math.max(1, Math.round(Math.min(w, h) / 300)));
  for (let j = 0; j < n; j += 1) ps[j] = 1 - (1 - skinFactor) * clamp(ps[j], 0, 1);
  return ps;
}

/**
 * Apply the engines in place.
 * @param {Uint8ClampedArray} data RGBA output pixels
 * @param {{cx:number,cy:number,rx:number,ry:number,rot:number}} ell ellipse in output pixels (rot radians)
 * @param {{skin?:object, light?:object}} params see FACE_ENGINE_DEFAULTS
 * @returns {{applied:boolean, reason?:string, skinFrac?:number, redShift?:number, blotch?:number, lift?:number, evenGain?:number[], protectedFrac?:number, lumaBefore?:number, lumaAfter?:number}}
 */
export function applyFaceEngine(data, w, h, ell, params = {}) {
  const skin = { ...FACE_ENGINE_DEFAULTS.skin, ...(params.skin || {}) };
  const light = { ...FACE_ENGINE_DEFAULTS.light, ...(params.light || {}) };
  if (!ell || !(ell.rx > 4) || !(ell.ry > 4)) return { applied: false, reason: 'NO_FACE' };
  if (!skin.enabled && !light.enabled) return { applied: false, reason: 'OFF' };
  const x0 = Math.max(0, Math.floor(ell.cx - Math.max(ell.rx, ell.ry) * 1.2));
  const x1 = Math.min(w, Math.ceil(ell.cx + Math.max(ell.rx, ell.ry) * 1.2));
  const y0 = Math.max(0, Math.floor(ell.cy - Math.max(ell.rx, ell.ry) * 1.2));
  const y1 = Math.min(h, Math.ceil(ell.cy + Math.max(ell.rx, ell.ry) * 1.2));
  const bw = x1 - x0; const bh = y1 - y0;
  if (bw < 8 || bh < 8) return { applied: false, reason: 'NO_FACE' };
  const n = bw * bh;
  const cos = Math.cos(ell.rot); const sin = Math.sin(ell.rot);
  const Y = new Float32Array(n); const Cb = new Float32Array(n); const Cr = new Float32Array(n);
  const we = new Float32Array(n); const U = new Float32Array(n);
  const seedCb = []; const seedCr = [];
  for (let y = 0; y < bh; y += 1) {
    for (let x = 0; x < bw; x += 1) {
      const j = y * bw + x; const i = ((y0 + y) * w + x0 + x) * 4;
      const R = data[i]; const G = data[i + 1]; const B = data[i + 2];
      Y[j] = 0.299 * R + 0.587 * G + 0.114 * B;
      Cb[j] = 128 - 0.168736 * R - 0.331264 * G + 0.5 * B;
      Cr[j] = 128 + 0.5 * R - 0.418688 * G - 0.081312 * B;
      const dx = x0 + x + 0.5 - ell.cx; const dy = y0 + y + 0.5 - ell.cy;
      const u = (dx * cos + dy * sin) / ell.rx; const v = (-dx * sin + dy * cos) / ell.ry;
      U[j] = u;
      const d = Math.hypot(u, v);
      we[j] = d <= 0.85 ? 1 : d >= 1.05 ? 0 : 1 - smooth(0.85, 1.05, d);
      if (d < 0.6 && Y[j] > 50 && Y[j] < 240 && Cb[j] > 77 && Cb[j] < 127 && Cr[j] > 133 && Cr[j] < 173) { seedCb.push(Cb[j]); seedCr.push(Cr[j]); }
    }
  }
  if (seedCb.length < 150) return { applied: false, reason: 'NO_SKIN' };
  const mCb = median(seedCb); const mCr = median(seedCr);
  // skin probability around this face's own skin colour; lips/eyes/brows/hair/beard fall off
  // Burnt (very bright) skin loses saturation, so in the highlights the colour tolerance widens, but
  // only for pixels that are still clearly warm: neutral eye whites stay excluded.
  const warm = Math.max(1, mCr - 128);
  const m = new Float32Array(n);
  for (let j = 0; j < n; j += 1) {
    if (we[j] <= 0) continue;
    const relax = smooth(190, 235, Y[j]) * smooth(0.15 * warm, 0.35 * warm, Cr[j] - 128);
    const tol = 1 + 2.5 * relax;
    const dCb = (Cb[j] - mCb) / (7 * tol); const dCr = (Cr[j] - mCr) / (8 * tol);
    const chroma = Math.exp(-0.5 * (dCb * dCb + dCr * dCr));
    const lum = smooth(35, 75, Y[j]) * (1 - smooth(238, 252, Y[j]));
    m[j] = chroma * lum * we[j];
  }
  const r0 = Math.max(1, Math.round(Math.min(ell.rx, ell.ry) / 40));
  const ms = boxFilter(m, bw, bh, r0);
  // smoothing may feather the edge inside the skin, but a pixel that is not skin itself never gets weight:
  // thin features (brows, lash line, lips) are not touched through their neighbours
  for (let j = 0; j < n; j += 1) ms[j] *= smooth(0.08, 0.45, m[j]);
  let wsum = 0; let sY = 0; let sCb = 0; let sCr = 0; let lY = 0; let lw = 0; let rY = 0; let rw = 0;
  for (let j = 0; j < n; j += 1) {
    const k = ms[j]; if (k <= 0.01) continue;
    wsum += k; sY += Y[j] * k; sCb += Cb[j] * k; sCr += Cr[j] * k;
    if (U[j] < 0) { lY += Y[j] * k; lw += k; } else { rY += Y[j] * k; rw += k; }
  }
  const area = Math.PI * ell.rx * ell.ry;
  if (wsum < area * 0.12) return { applied: false, reason: 'NO_SKIN' };
  const aY = sY / wsum; const aCb = sCb / wsum; const aCr = sCr / wsum;
  const report = { applied: true, skinFrac: wsum / area, redShift: 0, blotch: 0, lift: 0, evenGain: [1, 1], protectedFrac: 0, lumaBefore: aY };

  // excess redness: low-frequency shift only
  let dCrRed = 0;
  if (skin.enabled && skin.redness > 0) {
    const excess = (aCr - 128) - REDNESS_LIMIT * Math.max(8, 128 - aCb);
    if (excess > 0) dCrRed = Math.min(MAX_RED_SHIFT, excess * (skin.redness / 100));
  }
  report.redShift = dCrRed;

  // colour evenness: pull the large-scale chroma towards its mean, leaving fine detail alone
  const bigR = Math.max(2, Math.round(ell.rx / 3));
  const wCb = new Float32Array(n); const wCr = new Float32Array(n); const wY = new Float32Array(n);
  for (let j = 0; j < n; j += 1) { wCb[j] = Cb[j] * ms[j]; wCr[j] = Cr[j] * ms[j]; wY[j] = Y[j] * ms[j]; }
  const bm = boxFilter(ms, bw, bh, bigR);
  const bCb = boxFilter(wCb, bw, bh, bigR); const bCr = boxFilter(wCr, bw, bh, bigR);
  const fillR = Math.max(2, Math.round(ell.rx / 2.5));
  const fm = boxFilter(ms, bw, bh, fillR); const fY = boxFilter(wY, bw, bh, fillR);
  const kBal = skin.enabled ? (skin.balance / 100) * 0.6 : 0;
  const kFill = light.enabled ? (light.fill / 100) * 0.8 : 0;
  const gL = lw > 0 && rw > 0 && light.enabled && light.even ? clamp(aY / (lY / lw), 1 - MAX_EVEN_GAIN, 1 + MAX_EVEN_GAIN) : 1;
  const gR = lw > 0 && rw > 0 && light.enabled && light.even ? clamp(aY / (rY / rw), 1 - MAX_EVEN_GAIN, 1 + MAX_EVEN_GAIN) : 1;
  report.evenGain = [gL, gR];
  let after = 0; let liftSum = 0; let blotchSum = 0; let protectedW = 0;
  for (let y = 0; y < bh; y += 1) {
    for (let x = 0; x < bw; x += 1) {
      const j = y * bw + x; const k = ms[j];
      if (k <= 0.01) continue;
      const i = ((y0 + y) * w + x0 + x) * 4;
      let R = data[i]; let G = data[i + 1]; let B = data[i + 2];
      // chroma: redness + evenness
      let dCr = -dCrRed * k; let dCb = 0;
      if (kBal > 0 && bm[j] > 1e-3) {
        const lowCb = bCb[j] / bm[j]; const lowCr = bCr[j] / bm[j];
        const eCb = clamp(kBal * (aCb - lowCb), -MAX_BLOTCH_SHIFT, MAX_BLOTCH_SHIFT) * k;
        const eCr = clamp(kBal * (aCr - lowCr), -MAX_BLOTCH_SHIFT, MAX_BLOTCH_SHIFT) * k;
        dCb += eCb; dCr += eCr; blotchSum += Math.abs(eCr) * k;
      }
      R += 1.402 * dCr; G += -0.344136 * dCb - 0.714136 * dCr; B += 1.772 * dCb;
      // luminance: fill light, left/right balance, highlight protection (multiplicative: keeps chroma ratio)
      const y0v = Y[j];
      let gain = 1;
      if (kFill > 0 && fm[j] > 1e-3) {
        const local = fY[j] / fm[j];
        const lift = Math.min(MAX_FILL_LIFT, kFill * Math.max(0, local - y0v)) * k;
        gain *= Math.min(1.6, (y0v + lift) / Math.max(y0v, 8));
        liftSum += lift * k;
      }
      if (gL !== 1 || gR !== 1) {
        const t = clamp((U[j] + 1) / 2, 0, 1);
        gain *= 1 + ((gL + (gR - gL) * t) - 1) * k;
      }
      if (light.enabled && light.protect) {
        const yy = y0v * gain;
        if (yy > PROTECT_FROM) {
          const target = PROTECT_FROM + (yy - PROTECT_FROM) * 0.55;
          gain *= 1 + (target / yy - 1) * k;
          protectedW += k;
        }
      }
      R *= gain; G *= gain; B *= gain;
      data[i] = R; data[i + 1] = G; data[i + 2] = B;
      after += (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) * k;
    }
  }
  report.lift = liftSum / wsum;
  report.blotch = blotchSum / wsum;
  report.protectedFrac = protectedW / wsum;
  report.lumaAfter = after / wsum;
  return report;
}
