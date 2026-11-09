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
  skin: Object.freeze({ enabled: true, redness: 40, balance: 40, spots: 0, smooth: 0, lips: 0 }),
  light: Object.freeze({ enabled: true, fill: 45, even: true, protect: true }),
});

/** Natural limit for red vs yellow in skin ((Cr-128)/(128-Cb)); only redness above it is reduced. */
export const REDNESS_LIMIT = 1.5;
const MAX_RED_SHIFT = 7; // Cr levels
const MAX_BLOTCH_SHIFT = 4;
const MAX_FILL_LIFT = 24; // luma levels
/** Largest left/right brightness correction (±22 %): a hard side shadow is evened out, a natural asymmetry is not forced flat. */
export const MAX_EVEN_GAIN = 0.22;
/** Shading flattening in Lab lightness (a side shadow, a rim light): shadowed skin may be lifted up to ×1.9, a lit side dimmed by at most 8 % (dimming near-white skin turns it grey). Colour is kept as it is, so nothing turns orange or grey. */
export const SHADE_UP = 0.9;
export const SHADE_DOWN = 0.12;
const PROTECT_FROM = 224;
const MAX_SPOT_LIFT = 70; // luma levels a single spot may be raised
const MAX_SPOT_RED = 28; // Cr levels a single red mark may be reduced

/** 1-D box average over a window of 2r+1 pixels, horizontal or vertical (edges clamped). */
function boxAxis(a, w, h, r, horizontal) {
  const out = new Float32Array(w * h);
  const win = 2 * r + 1;
  if (horizontal) {
    for (let y = 0; y < h; y += 1) {
      let acc = 0;
      for (let i = -r; i <= r; i += 1) acc += a[y * w + clamp(i, 0, w - 1)];
      for (let x = 0; x < w; x += 1) {
        out[y * w + x] = acc / win;
        acc += a[y * w + Math.min(w - 1, x + r + 1)] - a[y * w + Math.max(0, x - r)];
      }
    }
  } else {
    for (let x = 0; x < w; x += 1) {
      let acc = 0;
      for (let i = -r; i <= r; i += 1) acc += a[clamp(i, 0, h - 1) * w + x];
      for (let y = 0; y < h; y += 1) {
        out[y * w + x] = acc / win;
        acc += a[Math.min(h - 1, y + r + 1) * w + x] - a[Math.max(0, y - r) * w + x];
      }
    }
  }
  return out;
}

/**
 * Which flagged pixels belong to a compact ROUND blob of blemish size (1 = yes)? A blob is round when both a
 * horizontal and a vertical window of its size are mostly flagged and the window is well filled (a thin hair or lash
 * fails), and small when a much larger window is mostly unflagged again (lips, eyes and brows fail). Tiny
 * blobs (3×3 window) must additionally be isolated, because crossing or clumped hairs look like blobs there.
 */
function roundBlobs(flag, bw, bh, rx) {
  const n = bw * bh;
  const q = new Float32Array(n);
  const radii = [...new Set([0.006, 0.01, 0.014, 0.02, 0.03, 0.04, 0.055].map((f) => Math.max(1, Math.round(rx * f))))];
  for (const r of radii) {
    const R = r === 1 ? 5 : Math.round(3.2 * r) + 1; // the 'small blob' window is clearly larger than the blob it tests
    const fbMax = r === 1 ? 0.12 : 0.3;
    const fsMin = r === 1 ? 0.88 : 0.7; // the 3x3 window is too coarse: a bend of a 2 px hair would pass 0.7
    const fh = boxAxis(flag, bw, bh, r, true); const fv = boxAxis(flag, bw, bh, r, false);
    const fs = boxFilter(flag, bw, bh, r); const fb = boxFilter(flag, bw, bh, R);
    for (let j = 0; j < n; j += 1) {
      if (!flag[j]) continue;
      const roundBlob = Math.min(fh[j], fv[j]) >= 0.6 && fs[j] >= fsMin && fb[j] < fbMax;
      // a tiny 2-3 px dot (a mole, a pimple head) cannot fill a 3x3 window: accept it when it is clearly isolated
      const tinyDot = r === 1 && fs[j] >= 0.4 && fb[j] < 0.08;
      if (roundBlob || tinyDot) q[j] = 1;
    }
  }
  return q;
}

/**
 * Spot healing by frequency separation (realistic, texture kept): small blobs that are darker or redder than
 * the skin around them (pimples, marks, stains) get their LOW-frequency colour moved towards the surroundings,
 * while the pixel's fine detail (pores, grain) is untouched. Larger structures (shadows, eye bags, big moles)
 * are not blobs at this scale and are left alone; clusters of dark dots (stubble, dense freckles) are
 * detected by their density and skipped, so the beard and natural freckle patterns stay.
 * A blemish is often outside the skin colour (a red mark), so compact, small "holes" in the skin mask (candidate
 * pixels that are warm and bright enough, not eye-white, not hair) count as skin for this purpose only. A hole
 * qualifies when it is round (a window of the blob's size is mostly hole; thin hairs and lashes fail this) and
 * small (a window 2.5× larger is mostly skin again; lips, eyes and brows fail this).
 * @param {number} rx face half-width in pixels (sets the blob scales)
 * @param {Float32Array|null} holeCand 1 for pixels that may be blemishes (outside the strict skin mask)
 * @returns {{dY:Float32Array, dCr:Float32Array, fixedFrac:number}}
 */
export function spotCorrection(Y, Cb, Cr, strictW, bw, bh, rx, strength, holeCand = null, rawM = null, protect = null) {
  const n = bw * bh;
  let skinW = strictW;
  if (holeCand) {
    const q = roundBlobs(holeCand, bw, bh, rx);
    // elongated but THICK holes (a stain: >= 3 px survives a 3x3 erosion; no hair does) count as well
    const er = new Float32Array(n);
    for (let y = 1; y < bh - 1; y += 1) for (let x = 1; x < bw - 1; x += 1) {
      const j = y * bw + x; let all = 1;
      for (let oy = -1; oy <= 1 && all; oy += 1) for (let ox = -1; ox <= 1; ox += 1) if (!holeCand[j + oy * bw + ox]) { all = 0; break; }
      er[j] = all;
    }
    const thickHole = boxFilter(er, bw, bh, 2);
    const holeDens = boxFilter(holeCand, bw, bh, Math.max(10, Math.round(rx * 0.1))); // a stain is isolated; stubble and clumps are dense
    skinW = new Float32Array(n);
    for (let j = 0; j < n; j += 1) skinW[j] = Math.max(strictW[j], q[j] * 0.9, holeCand[j] && thickHole[j] > 0.04 && holeDens[j] < 0.2 && !(protect && protect[j] > 0.05) ? 0.9 : 0);
  }
  const dY = new Float32Array(n); const dCb = new Float32Array(n); const dCr = new Float32Array(n);
  if (!(strength > 0)) return { dY, dCb, dCr, fixedFrac: 0 };
  const num = (arr, r) => boxFilter(arr, bw, bh, r);
  // the blob itself (small window) uses skinW; the SURROUNDINGS use CONFIDENT skin only (the unsmoothed skin
  // probability): a blemish is often half-way a skin pixel by colour and must not weigh in its own reference
  const wY = new Float32Array(n); const wC = new Float32Array(n); const sY = new Float32Array(n); const sC = new Float32Array(n); const sB = new Float32Array(n);
  const sure = new Float32Array(n);
  for (let j = 0; j < n; j += 1) {
    sure[j] = smooth(0.6, 0.9, rawM ? rawM[j] : strictW[j]);
    wY[j] = Y[j] * skinW[j]; wC[j] = Cr[j] * skinW[j]; sY[j] = Y[j] * sure[j]; sC[j] = Cr[j] * sure[j]; sB[j] = Cb[j] * sure[j];
  }
  const wB0 = new Float32Array(n);
  for (let j = 0; j < n; j += 1) wB0[j] = Cb[j] * skinW[j];
  const D = new Float32Array(n); const E = new Float32Array(n);
  for (const f of [0.006, 0.014, 0.03, 0.055]) { // blob radii: ~0.6%, 1.4%, 3% and 5.5% of the face half-width
    const r1 = Math.max(1, Math.round(rx * f)); const r2 = Math.max(r1 * 2 + 1, Math.round(r1 * 2.6));
    const m2 = num(sure, r2); const y2 = num(sY, r2); const c2 = num(sC, r2); const bs2 = num(sB, r2);
    // the blob signal is measured along a horizontal AND a vertical window and the weaker one counts: a round blemish is
    // dark/red in both, a thin hair (any direction) is weak in at least one, so hairs and lashes are not mistaken for it
    const sig = (horizontal) => {
      const m1 = boxAxis(skinW, bw, bh, r1, horizontal); const y1 = boxAxis(wY, bw, bh, r1, horizontal); const c1 = boxAxis(wC, bw, bh, r1, horizontal); const b1 = boxAxis(wB0, bw, bh, r1, horizontal);
      const d = new Float32Array(n); const e = new Float32Array(n); const eb = new Float32Array(n);
      for (let j = 0; j < n; j += 1) {
        if (m1[j] < 0.25 || m2[j] < 0.25) continue;
        d[j] = y2[j] / m2[j] - y1[j] / m1[j]; // positive: darker than the surroundings
        e[j] = c1[j] / m1[j] - c2[j] / m2[j]; // positive: redder
        eb[j] = bs2[j] / m2[j] - b1[j] / m1[j]; // positive: more yellow-brown
      }
      return { d, e, eb };
    };
    const H = sig(true); const V = sig(false);
    for (let j = 0; j < n; j += 1) {
      // isotropy: a round blob is about equally dark/red in both directions, a thin line much more along its length
      const d = Math.min(H.d[j], V.d[j]) >= 0.72 * Math.max(H.d[j], V.d[j]) ? Math.min(H.d[j], V.d[j]) : 0;
      const e = Math.min(H.e[j], V.e[j]) >= 0.72 * Math.max(H.e[j], V.e[j]) ? Math.min(H.e[j], V.e[j]) : 0;
      if (d > D[j]) D[j] = d;
      if (e > E[j]) E[j] = e;
    }
  }
  // Wide pigment marks (a brown or red stain, elongated): thick enough that no hair is (>= 3 px survives a 3x3
  // erosion) AND different in colour from the skin around it. Shadows, folds and the sides of the nose only change
  // the light, not the colour, so they do not qualify.
  const raw2 = new Float32Array(n);
  {
    const wB = new Float32Array(n);
    for (let j = 0; j < n; j += 1) wB[j] = Cb[j] * skinW[j];
    const cand = new Float32Array(n);
    const dd = new Float32Array(n); const cd = new Float32Array(n);
    for (const [r1, r2] of [[2, 7], [3, 10]]) {
      const m1 = num(skinW, r1); const mm2 = num(sure, r2);
      const y1 = num(wY, r1); const y2 = num(sY, r2); const c1 = num(wC, r1); const c2 = num(sC, r2); const b1 = num(wB, r1); const b2 = num(sB, r2);
      for (let j = 0; j < n; j += 1) {
        if (m1[j] < 0.4 || mm2[j] < 0.25) continue;
        const d = y2[j] / mm2[j] - y1[j] / m1[j];
        const chroma = Math.max(c1[j] / m1[j] - c2[j] / mm2[j], b2[j] / mm2[j] - b1[j] / m1[j]); // redder or more yellow-brown
        if (d > dd[j]) dd[j] = d;
        if (chroma > cd[j]) cd[j] = chroma;
      }
    }
    for (let j = 0; j < n; j += 1) cand[j] = dd[j] > 9 && cd[j] > 3 && skinW[j] >= 0.5 ? 1 : 0;
    const er = new Float32Array(n); // 3x3 erosion: a hair (<= 2 px) vanishes, a stain stays
    for (let y = 1; y < bh - 1; y += 1) for (let x = 1; x < bw - 1; x += 1) {
      const j = y * bw + x; let all = 1;
      for (let oy = -1; oy <= 1 && all; oy += 1) for (let ox = -1; ox <= 1; ox += 1) if (!cand[j + oy * bw + ox]) { all = 0; break; }
      er[j] = all;
    }
    const thick = boxFilter(er, bw, bh, 2); // grow back over the stain
    for (let j = 0; j < n; j += 1) if (thick[j] > 0.04 && cand[j]) raw2[j] = smooth(9, 28, dd[j]) * smooth(3, 8, cd[j]);
  }
  const raw = new Float32Array(n);
  for (let j = 0; j < n; j += 1) {
    if (skinW[j] < 0.5) continue;
    raw[j] = Math.max(smooth(8, 24, D[j]), smooth(2.5, 7, E[j]), raw2[j]);
  }
  // dense clusters of dark dots are texture (stubble, freckles), not blemishes
  const dens = boxFilter(raw, bw, bh, Math.max(3, Math.round(rx * 0.1)));
  const k = clamp(strength / 100, 0, 1);
  const w0 = new Float32Array(n);
  for (let j = 0; j < n; j += 1) {
    // weak detections are ignored (thin hairs and fine texture give weak, partial responses); only clear blemishes are healed
    if (raw[j] > 0.25) w0[j] = raw[j] * (1 - smooth(0.12, 0.3, dens[j])) * k * Math.min(1, skinW[j] * 1.4) * (protect ? 1 - protect[j] : 1);
  }
  // grow the repair area by one pixel so the soft rim of the blemish is covered too
  const wg = boxFilter(w0, bw, bh, 1);
  const w = new Float32Array(n);
  let fixed = 0; let total = 0;
  for (let j = 0; j < n; j += 1) {
    if (skinW[j] > 0.3) total += 1;
    w[j] = Math.max(w0[j], Math.min(1, wg[j] * 2.2) * (w0[j] > 0 || wg[j] > 0.15 ? 1 : 0));
    if (w[j] < 0.03) w[j] = 0;
    else if (w[j] > 0.25) fixed += 1;
  }
  // Heal like a repair brush: the blemish takes the texture of a clean patch of skin nearby (so it is real skin,
  // not a flat fill), shifted to match the local light and colour of its own surroundings.
  const Rr = Math.max(3, Math.round(rx * 0.045));
  const mr = num(sure, Rr); const ryS = num(sY, Rr); const rcS = num(sC, Rr); const rbS = num(sB, Rr);
  const refOk = (j) => mr[j] > 0.2;
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];
  const dists = [Math.max(4, Math.round(rx * 0.07)), Math.max(8, Math.round(rx * 0.14))];
  for (let j = 0; j < n; j += 1) {
    if (w[j] === 0) continue;
    const x = j % bw; const y = (j / bw) | 0;
    let best = -1; let bestScore = Infinity;
    if (refOk(j)) {
      for (const dist of dists) {
        for (const [ox, oy] of dirs) {
          const xx = x + ox * dist; const yy = y + oy * dist;
          if (xx < 0 || yy < 0 || xx >= bw || yy >= bh) continue;
          const jj = yy * bw + xx;
          if (sure[jj] < 0.9 || w[jj] > 0 || !refOk(jj)) continue;
          const sc = Math.abs(ryS[jj] / mr[jj] - ryS[j] / mr[j]) + 2 * Math.abs(rcS[jj] / mr[jj] - rcS[j] / mr[j]);
          if (sc < bestScore) { bestScore = sc; best = jj; }
        }
      }
    }
    if (best >= 0) {
      const tY = Y[best] + (ryS[j] / mr[j] - ryS[best] / mr[best]);
      const tCr = Cr[best] + (rcS[j] / mr[j] - rcS[best] / mr[best]);
      const tCb = Cb[best] + (rbS[j] / mr[j] - rbS[best] / mr[best]);
      dY[j] = w[j] * clamp(tY - Y[j], -MAX_SPOT_LIFT * 1.6, MAX_SPOT_LIFT * 1.6);
      dCr[j] = w[j] * clamp(tCr - Cr[j], -MAX_SPOT_RED, MAX_SPOT_RED);
      dCb[j] = w[j] * clamp(tCb - Cb[j], -MAX_SPOT_RED, MAX_SPOT_RED);
    } else { // no clean patch found: move only the low-frequency colour (still keeps the pixel's own detail)
      dY[j] = w[j] * Math.min(MAX_SPOT_LIFT, D[j]);
      dCr[j] = -w[j] * Math.min(MAX_SPOT_RED, E[j]);
    }
  }
  return { dY, dCb, dCr, fixedFrac: total ? fixed / total : 0 };
}

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
export function skinDetailWeight(data, w, h, ell, skinFactor = 0.3) {
  const ps = skinProbability(data, w, h, ell);
  if (!ps) return null;
  const out = new Float32Array(ps.length);
  for (let j = 0; j < ps.length; j += 1) out[j] = 1 - (1 - skinFactor) * ps[j];
  return out;
}

/**
 * Whole-image skin probability (0..1, smooth): face, ears, neck and hands, from this face's own skin
 * colour. Hair, brows, clothes and the background stay near 0.
 * @returns {Float32Array|null} null when the skin colour cannot be measured
 */
export function skinProbability(data, w, h, ell) {
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
  for (let j = 0; j < n; j += 1) ps[j] = clamp(ps[j], 0, 1);
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
  // blemish removal also covers the throat and neck below the chin (the skin-colour gate keeps collar and clothes out)
  const neckReach = (skin.enabled && (skin.spots > 0 || skin.smooth > 0)) || (light.enabled && light.even) ? ell.ry * 1.95 : 0;
  const y1 = Math.min(h, Math.ceil(ell.cy + Math.max(Math.max(ell.rx, ell.ry) * 1.2, neckReach)));
  const bw = x1 - x0; const bh = y1 - y0;
  if (bw < 8 || bh < 8) return { applied: false, reason: 'NO_FACE' };
  const n = bw * bh;
  const cos = Math.cos(ell.rot); const sin = Math.sin(ell.rot);
  const Y = new Float32Array(n); const Cb = new Float32Array(n); const Cr = new Float32Array(n);
  const we = new Float32Array(n); const weW = new Float32Array(n); const weS = new Float32Array(n); const U = new Float32Array(n);
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
      // wider region for blemish healing only: cheeks beside the ears and the jaw lie outside the face ellipse
      // (sideways only: widening upwards would reach the hair)
      const dW = Math.hypot(u * 0.77, v);
      weW[j] = dW <= 1.05 ? 1 : dW >= 1.3 ? 0 : 1 - smooth(1.05, 1.3, dW);
      if (neckReach > 0 && v > 0.8) { // throat and neck: a band below the jaw, as wide as the neck
        const nw = (1 - smooth(0.78, 0.98, Math.abs(u))) * (1 - smooth(1.75, 1.95, v)) * smooth(0.8, 0.95, v);
        if (nw > weW[j]) weW[j] = nw;
      }
      // region of the shading correction: the face, widened smoothly upwards across the whole forehead to the hairline, sideways and down the neck
      const dS = v < 0 ? Math.hypot(u * 0.9, v * 0.85) : Math.hypot(u * 0.77, v * 0.88);
      weS[j] = Math.max(weW[j], dS <= 1.05 ? 1 : dS >= 1.4 ? 0 : 1 - smooth(1.05, 1.4, dS));
      if (d < 0.6 && Y[j] > 50 && Y[j] < 240 && Cb[j] > 77 && Cb[j] < 127 && Cr[j] > 133 && Cr[j] < 173) { seedCb.push(Cb[j]); seedCr.push(Cr[j]); }
    }
  }
  if (seedCb.length < 150) return { applied: false, reason: 'NO_SKIN' };
  const mCb = median(seedCb); const mCr = median(seedCr);
  // skin probability around this face's own skin colour; lips/eyes/brows/hair/beard fall off
  // Burnt (very bright) skin loses saturation, so in the highlights the colour tolerance widens, but
  // only for pixels that are still clearly warm: neutral eye whites stay excluded.
  const warm = Math.max(1, mCr - 128);
  const m = new Float32Array(n); const base = new Float32Array(n);
  for (let j = 0; j < n; j += 1) {
    if (weW[j] <= 0) continue;
    const relax = smooth(190, 235, Y[j]) * smooth(0.15 * warm, 0.35 * warm, Cr[j] - 128);
    const tol = 1 + 2.5 * relax;
    const dCb = (Cb[j] - mCb) / (7 * tol); const dCr = (Cr[j] - mCr) / (8 * tol);
    const chroma = Math.exp(-0.5 * (dCb * dCb + dCr * dCr));
    const lum = smooth(22, 60, Y[j]) * (1 - smooth(238, 252, Y[j]));
    base[j] = chroma * lum;
    m[j] = base[j] * we[j];
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
  report.evenGain = [1, 1];
  let holeCand = null; let mSp = null; let msSp = null;
  if (skin.enabled && (skin.spots > 0 || skin.smooth > 0)) {
    mSp = new Float32Array(n);
    for (let j = 0; j < n; j += 1) mSp[j] = base[j] * weW[j];
    msSp = boxFilter(mSp, bw, bh, r0);
    for (let j = 0; j < n; j += 1) msSp[j] *= smooth(0.08, 0.45, mSp[j]);
    holeCand = new Float32Array(n);
    for (let j = 0; j < n; j += 1) {
      if (weW[j] > 0.5 && msSp[j] < 0.5 && Y[j] > 70 && Y[j] < 240 && Cr[j] - 128 >= 0.35 * warm) holeCand[j] = 1;
    }
  }
  // retouch-free zones (eyes, mouth, nostrils) in bbox coordinates, soft edge
  let protect = null; let coreHard = null; let coreSoft = null;
  if (Array.isArray(params.protect) && params.protect.length) {
    protect = new Float32Array(n);
    coreHard = new Float32Array(n); coreSoft = new Float32Array(n);
    for (const z of params.protect) {
      const zc = Math.cos(z.rot || 0); const zs = Math.sin(z.rot || 0);
      for (let y = 0; y < bh; y += 1) {
        for (let x = 0; x < bw; x += 1) {
          const dx = x0 + x + 0.5 - z.cx; const dy = y0 + y + 0.5 - z.cy;
          const u = (dx * zc + dy * zs) / z.rx; const v = (-dx * zs + dy * zc) / z.ry;
          const dd = Math.hypot(u, v);
          if (dd <= 0.8) (z.soft ? coreSoft : coreHard)[y * bw + x] = 1; // un-feathered core (blemish finder)
          if (dd >= 1.2) continue;
          const wgt = dd <= 0.85 ? 1 : 1 - smooth(0.85, 1.2, dd);
          if (wgt > protect[y * bw + x]) protect[y * bw + x] = wgt;
        }
      }
    }
  }
  // Large-scale shading (a shadow on one side of the face, a strong side or rim light), flattened in Lab lightness only.
  // The lightness is divided by its own very smooth, face-sized trend over the skin (normalised convolution, repeated rounds
  // so the edge of the face is not biased); colour and fine texture are not touched. The skin weight is tolerant in colour
  // (shadowed skin shifts), feathered widely, and excludes eyes, brows, mouth and nostrils.
  const shadeR = Math.max(3, Math.round(ell.rx * 0.35));
  const blurBig = (a) => boxFilter(boxFilter(a, bw, bh, shadeR), bw, bh, Math.max(2, Math.round(shadeR * 0.6)));
  let kS = null; let shadeGain = null; let Lb = null; let shadeStats = null;
  if (light.enabled && light.even) {
    const kS0 = new Float32Array(n);
    for (let j = 0; j < n; j += 1) {
      if (weS[j] <= 0) continue;
      const dCb = (Cb[j] - mCb) / (7 * 1.8); const dCr = (Cr[j] - mCr) / (8 * 1.8);
      kS0[j] = Math.exp(-0.5 * (dCb * dCb + dCr * dCr)) * smooth(15, 45, Y[j]) * (1 - smooth(238, 252, Y[j])) * weS[j];
    }
    kS = boxFilter(kS0, bw, bh, Math.max(2, Math.round(ell.rx * 0.02)));
    for (let j = 0; j < n; j += 1) kS[j] *= smooth(0.08, 0.45, kS0[j]);
    Lb = new Float32Array(n);
    for (let y = 0; y < bh; y += 1) for (let x = 0; x < bw; x += 1) { const i = ((y0 + y) * w + x0 + x) * 4; Lb[y * bw + x] = rgbToLab(data[i], data[i + 1], data[i + 2])[0]; }
    const shm = blurBig(kS);
    let tn = 0; let td = 0; for (let j = 0; j < n; j += 1) { tn += Lb[j] * kS[j]; td += kS[j]; }
    const tgt = td > 0 ? tn / td : 60;
    shadeGain = new Float32Array(n).fill(1);
    const tmp = new Float32Array(n);
    for (let round = 0; round < 3; round += 1) {
      for (let j = 0; j < n; j += 1) tmp[j] = Lb[j] * shadeGain[j] * kS[j];
      const low = blurBig(tmp);
      for (let j = 0; j < n; j += 1) {
        if (shm[j] <= 1e-3) continue;
        shadeGain[j] = clamp(shadeGain[j] * Math.pow(tgt / Math.max(8, low[j] / shm[j]), 0.9), 1 - SHADE_DOWN, 1 + SHADE_UP);
      }
    }
    const sm = boxFilter(shadeGain, bw, bh, Math.max(2, Math.round(shadeR * 0.2)));
    for (let j = 0; j < n; j += 1) shadeGain[j] = sm[j];
    shadeStats = { tgt };
  }
  const spots = holeCand && skin.spots > 0 ? spotCorrection(Y, Cb, Cr, msSp, bw, bh, ell.rx, skin.spots, holeCand, mSp, protect) : null;
  // complete pass: every mark that clearly stands out from its skin (found on the untouched pixels, healed after)
  let blemish = null; let hairInfo = null;
  if (mSp) {
    const sureB = new Float32Array(n);
    for (let j = 0; j < n; j += 1) sureB[j] = smooth(0.6, 0.9, mSp[j]);
    // hair is never touched, by either spot pass: no correction within reach of a hair, stubble stroke or lash
    const hair = hairMask(Y, sureB, bw, bh, ell.rx);
    hairInfo = hair;
    if (spots) {
      // whole blobs: if any pixel of a corrected blob lies in the hair margin, the entire blob is left as it was
      const seenS = new Uint8Array(n); const stk = [];
      let kept = 0; let total = 0;
      for (let j0 = 0; j0 < n; j0 += 1) {
        if (seenS[j0] || (spots.dY[j0] === 0 && spots.dCr[j0] === 0 && spots.dCb[j0] === 0)) continue;
        const pix = []; let hit = false; stk.length = 0; stk.push(j0); seenS[j0] = 1;
        while (stk.length) {
          const j = stk.pop(); pix.push(j); if (hair.near[j]) hit = true;
          const x = j % bw; const y = (j - x) / bw;
          for (let oy = -1; oy <= 1; oy += 1) for (let ox = -1; ox <= 1; ox += 1) {
            const xx = x + ox; const yy = y + oy;
            if (xx < 0 || yy < 0 || xx >= bw || yy >= bh) continue;
            const jj = yy * bw + xx;
            if (!seenS[jj] && (spots.dY[jj] !== 0 || spots.dCr[jj] !== 0 || spots.dCb[jj] !== 0)) { seenS[jj] = 1; stk.push(jj); }
          }
        }
        total += pix.length;
        if (hit) for (const j of pix) { spots.dY[j] = 0; spots.dCr[j] = 0; spots.dCb[j] = 0; } else kept += pix.length;
      }
      if (total) spots.fixedFrac *= kept / total;
    }
    if (skin.spots > 0) blemish = findBlemishes(Y, Cr, sureB, coreHard, coreSoft, bw, bh, ell.rx, clamp(skin.spots / 90, 0.3, 1.3), hair);
    if (blemish && typeof params.debugBlemish === 'function') params.debugBlemish(blemish, { x0, y0, bw, bh });
  }
  report.spotsFrac = spots ? spots.fixedFrac : 0;
  let after = 0; let liftSum = 0; let blotchSum = 0; let protectedW = 0;
  for (let y = 0; y < bh; y += 1) {
    for (let x = 0; x < bw; x += 1) {
      const j = y * bw + x; const k = ms[j];
      // a blemish pixel is outside the strict skin mask but still gets its spot correction
      const sp = !!spots && (spots.dY[j] !== 0 || spots.dCr[j] !== 0 || spots.dCb[j] !== 0);
      if (k <= 0.01 && !sp) continue;
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
      if (spots) { // spot healing: raise the blob's light and cool its redness; fine texture is kept
        const sy = spots.dY[j]; const sc = spots.dCr[j]; const sb = spots.dCb[j];
        R += sy + 1.402 * sc; G += sy - 0.344136 * sb - 0.714136 * sc; B += sy + 1.772 * sb;
      }
      // luminance: fill light, left/right balance, highlight protection (multiplicative: keeps chroma ratio)
      const y0v = Y[j];
      let gain = 1;
      if (kFill > 0 && fm[j] > 1e-3) {
        const local = fY[j] / fm[j];
        const lift = Math.min(MAX_FILL_LIFT, kFill * Math.max(0, local - y0v)) * k;
        gain *= Math.min(1.6, (y0v + lift) / Math.max(y0v, 8));
        liftSum += lift * k;
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
  // apply the shading correction in Lab lightness (colour untouched)
  let gLsum = 0; let gLw = 0; let gRsum = 0; let gRw = 0; let capped = 0; let shadeW = 0;
  if (kS && shadeGain) {
    for (let y = 0; y < bh; y += 1) {
      for (let x = 0; x < bw; x += 1) {
        const j = y * bw + x; const ks = kS[j];
        if (ks <= 0.004) continue;
        const gs = shadeGain[j]; const i = ((y0 + y) * w + x0 + x) * 4;
        const [L, a, b] = rgbToLab(data[i], data[i + 1], data[i + 2]);
        const gk0 = 1 + (gs - 1) * ks; const gk = gk0 < 1 && L > 78 ? 1 - (1 - gk0) * (1 - smooth(78, 90, L)) : gk0; // near-white skin is not dimmed (it would turn grey)
        const ch = 1.0; // colour is truly kept untouched; lifted shadows do not gain red/yellow saturation
        const [R2, G2, B2] = labToRgb(Math.min(100, L * gk), a * ch, b * ch);
        data[i] = R2; data[i + 1] = G2; data[i + 2] = B2;
        if (U[j] < 0) { gLsum += gs * ks; gLw += ks; } else { gRsum += gs * ks; gRw += ks; }
        shadeW += ks; if (gs <= 1 - SHADE_DOWN + 1e-3 || gs >= 1 + SHADE_UP - 1e-3) capped += ks;
      }
    }
  }
  report.evenGain = [gLw > 0 ? gLsum / gLw : 1, gRw > 0 ? gRsum / gRw : 1];
  report.evenClipped = shadeW > 0 ? capped / shadeW : 0;
  report.lift = liftSum / wsum;
  report.blotch = blotchSum / wsum;
  report.protectedFrac = protectedW / wsum;
  report.lumaAfter = after / wsum;
  // gentle, edge-preserving skin smoothing (pores, tiny freckles, uneven texture) - never on hair, lips, eyes or brows
  if (skin.smooth > 0 && mSp && hairInfo) {
    const wgt = new Float32Array(n);
    for (let j = 0; j < n; j += 1) wgt[j] = smooth(0.2, 0.6, mSp[j]) * (hairInfo.near[j] ? 0 : 1) * (1 - (protect ? protect[j] : 0));
    report.smoothed = smoothSkinRegion(data, w, x0, y0, bw, bh, wgt, (skin.smooth / 100) * 0.9, ell.rx);
  }
  if (skin.enabled && skin.lips > 0 && params.lips) {
    const sr = [aY + 1.402 * (aCr - 128), aY - 0.344136 * (aCb - 128) - 0.714136 * (aCr - 128), aY + 1.772 * (aCb - 128)];
    const lr = recolorLips(data, w, h, params.lips, sr, skin.lips / 100);
    report.lips = lr.recolored ? { before: lr.before, after: lr.after } : null;
  }
  if (skin.enabled && params.eyes) {
    const eyeRep = enhanceEyes(data, w, h, params.eyes, 0.75);
    report.eyes = eyeRep.enhanced;
  }
  if (blemish?.discs.length) {
    const hr = healDiscs(data, w, h, blemish.discs.map((d) => ({ x: d.x + x0, y: d.y + y0, r: d.r })));
    report.blemishes = hr.healed;
  } else report.blemishes = 0;
  return report;
}

/**
 * Hair-like dark structures (hairs, stubble strokes, lashes, brows) and a margin around them. Compact dark blobs
 * (a very dark mole) are not hair. Every automatic retouch skips this mask completely: hair is never damaged.
 * @returns {{mask:Uint8Array, near:Uint8Array, dark:Uint8Array, skinMed:number}}
 */
export function hairMask(Y, sure, bw, bh, rx) {
  const n = bw * bh;
  const v = []; for (let j = 0; j < n; j += 53) if (sure[j] > 0.95) v.push(Y[j]); v.sort((a, b) => a - b);
  const skinMed = v.length ? v[v.length >> 1] : 180;
  const dark = new Uint8Array(n);
  for (let j = 0; j < n; j += 1) dark[j] = Y[j] < skinMed * 0.55 ? 1 : 0;
  const hair = new Float32Array(n);
  const seen = new Uint8Array(n);
  const stack = [];
  for (let j0 = 0; j0 < n; j0 += 1) {
    if (!dark[j0] || seen[j0]) continue;
    const pix = []; stack.length = 0; stack.push(j0); seen[j0] = 1;
    let sx = 0; let sy = 0; let sxx = 0; let syy = 0; let sxy = 0;
    while (stack.length) {
      const j = stack.pop(); pix.push(j);
      const x = j % bw; const y = (j - x) / bw;
      sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
      for (let oy = -1; oy <= 1; oy += 1) for (let ox = -1; ox <= 1; ox += 1) {
        const xx = x + ox; const yy = y + oy;
        if (xx < 0 || yy < 0 || xx >= bw || yy >= bh) continue;
        const jj = yy * bw + xx;
        if (dark[jj] && !seen[jj]) { seen[jj] = 1; stack.push(jj); }
      }
    }
    const c = pix.length; const mx = sx / c; const my = sy / c;
    const vxx = sxx / c - mx * mx; const vyy = syy / c - my * my; const vxy = sxy / c - mx * my;
    const tr = vxx + vyy; const dt = Math.sqrt(Math.max(0, ((vxx - vyy) / 2) ** 2 + vxy * vxy));
    const e1 = tr / 2 + dt; const e2 = Math.max(1e-3, tr / 2 - dt);
    // a few dark pixels (the core of a mole) are not a hair; a line, a thin stroke or a big dark mass is
    const compact = c < 6 ? Math.sqrt(e1 / e2) < 2.5 : 4 * Math.sqrt(e2) >= 3 && Math.sqrt(e1 / e2) < 2.5 && c < Math.PI * (rx * 0.06) ** 2;
    if (!compact) for (const j of pix) hair[j] = 1;
  }
  const rho = 2; // a heal never reaches beyond its own disc, so a thin margin is enough
  const spread = boxFilter(hair, bw, bh, rho);
  const mask = new Uint8Array(n);
  for (let j = 0; j < n; j += 1) mask[j] = spread[j] > 1e-4 ? 1 : 0;
  // the pixel-wise (older) pass corrects a blob plus a halo around it: it keeps a wider distance
  const nearSpread = boxFilter(hair, bw, bh, 6);
  const near = new Uint8Array(n);
  for (let j = 0; j < n; j += 1) near[j] = nearSpread[j] > 1e-4 ? 1 : 0;
  return { mask, near, dark, skinMed };
}

/**
 * Complete automatic blemish finder: anything on the skin that clearly stands out from its own surroundings
 * (dark spot, mole, pimple, red mark, stain, smudge) becomes a set of discs to heal with real skin texture.
 * Works in bbox coordinates. Hairs and other thin lines, dense clusters (stubble), and the protected zones
 * (eyes, brows, mouth, nostrils) are never touched.
 * @returns {{discs:{x:number,y:number,r:number}[], found:number, rejected:number}}
 */
export function findBlemishes(Y, Cr, sure, protect, soft, bw, bh, rx, strength = 1, hair = null) {
  const n = bw * bh;
  const R = Math.max(6, Math.round(rx * 0.08));
  const wY = new Float32Array(n); const wC = new Float32Array(n);
  for (let j = 0; j < n; j += 1) { wY[j] = Y[j] * sure[j]; wC[j] = Cr[j] * sure[j]; }
  const sm = boxFilter(sure, bw, bh, R); const bY = boxFilter(wY, bw, bh, R); const bC = boxFilter(wC, bw, bh, R);
  const c = new Float32Array(n);
  for (let j = 0; j < n; j += 1) {
    if (sm[j] < 0.35) continue;
    const refY = bY[j] / sm[j]; const refC = bC[j] / sm[j];
    c[j] = Math.max(0, refY - Y[j]) + 1.5 * Math.max(0, Cr[j] - refC);
  }
  const cs = boxFilter(c, bw, bh, 1);
  // noise of the skin itself decides how strong a mark must be
  const samp = [];
  for (let j = 0; j < n; j += 97) if (sure[j] > 0.95 && sm[j] > 0.8) samp.push(cs[j]);
  samp.sort((a, b) => a - b);
  const med = samp.length ? samp[samp.length >> 1] : 0;
  const devs = samp.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
  const mad = devs.length ? devs[devs.length >> 1] * 1.4826 : 3;
  const T = Math.max(11, med + 3.4 * mad) / Math.max(0.5, strength);
  const flag = new Uint8Array(n);
  let skinOk = 0;
  for (let j = 0; j < n; j += 1) {
    if (sm[j] < 0.4) continue;
    if (cs[j] > T || c[j] > 2.4 * T) flag[j] = 1;
    skinOk += 1;
  }
  if (skinOk < 100) return { discs: [], found: 0, rejected: 0, T };
  // very dark pixels wherever they are, skin mask or not: if the surroundings of a mark contain them, it is a hairy area
  const H = hair || hairMask(Y, sure, bw, bh, rx);
  const dark = H.dark;
  const low = dark;
  const seen = new Uint8Array(n);
  const comps = [];
  const stack = [];
  const maxArea = Math.PI * (rx * 0.06) ** 2;
  for (let j0 = 0; j0 < n; j0 += 1) {
    if (!flag[j0] || seen[j0]) continue;
    const pix = []; stack.length = 0; stack.push(j0); seen[j0] = 1;
    while (stack.length) {
      const j = stack.pop(); pix.push(j);
      const x = j % bw; const y = (j - x) / bw;
      for (let oy = -1; oy <= 1; oy += 1) {
        for (let ox = -1; ox <= 1; ox += 1) {
          const xx = x + ox; const yy = y + oy;
          if (xx < 0 || yy < 0 || xx >= bw || yy >= bh) continue;
          const jj = yy * bw + xx;
          if (flag[jj] && !seen[jj]) { seen[jj] = 1; stack.push(jj); }
        }
      }
    }
    if (pix.length < 2 || pix.length > maxArea) continue;
    comps.push(pix);
  }
  const info = [];
  let rejected = 0;
  for (const pix of comps) {
    let sx = 0; let sy = 0; let pk = 0; let pr = 0; let ps = 0;
    let x0 = bw; let x1 = 0; let y0 = bh; let y1 = 0;
    for (const j of pix) {
      const x = j % bw; const y = (j - x) / bw;
      sx += x; sy += y; if (c[j] > pk) pk = c[j];
      if (protect && protect[j] > pr) pr = protect[j];
      if (soft && soft[j] > ps) ps = soft[j];
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    const m = pix.length; const mx = sx / m; const my = sy / m;
    let sxx = 0; let syy = 0; let sxy = 0;
    for (const j of pix) { const x = j % bw; const y = (j - x) / bw; sxx += (x - mx) ** 2; syy += (y - my) ** 2; sxy += (x - mx) * (y - my); }
    sxx /= m; syy /= m; sxy /= m;
    const tr = sxx + syy; const dt = Math.sqrt(Math.max(0, ((sxx - syy) / 2) ** 2 + sxy * sxy));
    const l1 = tr / 2 + dt; const l2 = Math.max(1e-3, tr / 2 - dt);
    const major = 4 * Math.sqrt(l1);
    // thickness from the area and the length (a bounding box overstates a diagonal hair)
    const thick = m <= 4 ? Math.sqrt(m) + 0.5 : Math.min(4 * Math.sqrt(l2), (4 / Math.PI) * m / Math.max(major, 1));
    const elong = Math.sqrt(l1 / l2);
    // surroundings must be skin (not an eye/brow/lip/hair border)
    const pad = Math.max(3, Math.round(0.6 * Math.max(x1 - x0, y1 - y0)) + 2);
    let ringSkin = 0; let ringN = 0; let ringC = 0; let inC = 0;
    let solid = 0;
    for (const j of pix) { inC += c[j]; if (c[j] > 0.6 * T) solid += 1; }
    inC /= m;
    solid /= m; // a stain is solid; crossing hairs are thin lines whose smoothed halo is mostly skin
    for (let y = Math.max(0, y0 - pad); y <= Math.min(bh - 1, y1 + pad); y += 1) {
      for (let x = Math.max(0, x0 - pad); x <= Math.min(bw - 1, x1 + pad); x += 1) {
        const j = y * bw + x; if (flag[j]) continue;
        ringN += 1; ringSkin += sure[j] > 0.5 ? 1 : 0; ringC += c[j];
      }
    }
    const skinFrac = ringN ? ringSkin / ringN : 0;
    ringC = ringN ? ringC / ringN : 0;
    // a mark has a sharp edge: just outside it the skin is back to normal (a shading feature fades out slowly)
    const sharp = inC / Math.max(4, ringC * 2.2);
    // flagged pixels around it (stubble, pores): a crowded neighbourhood is texture, not a blemish
    const cr = Math.max(10, Math.round(rx * 0.12)); let crowd = 0; let crowdN = 0;
    for (let y = Math.max(0, Math.round(my) - cr); y <= Math.min(bh - 1, Math.round(my) + cr); y += 1) {
      for (let x = Math.max(0, Math.round(mx) - cr); x <= Math.min(bw - 1, Math.round(mx) + cr); x += 1) {
        if (x >= x0 - pad && x <= x1 + pad && y >= y0 - pad && y <= y1 + pad) continue; // its own halo does not count
        crowdN += 1; crowd += low[y * bw + x];
      }
    }
    const crowdFrac = crowd / Math.max(1, crowdN);
    const strongMole = pk >= 6.5 * T && sharp >= 5 && elong <= 2 && thick >= 4 && thick <= 10;
    let ok = true;
    if (pr > 0.3) ok = false;
    else if (thick < 2.6 && elong > 2.2) ok = false; // a hair
    else if (thick > rx * 0.09) ok = false; // big dark masses are shading or beard, not a blemish
    else if (elong > (thick >= 4.5 ? 5.5 : 4.2)) ok = false; // long and thin = hair or crease; thick = a stain
    else if (skinFrac < (thick >= 4.5 ? 0.5 : 0.6)) ok = false;
    else if (m > 20 && solid < 0.55) ok = false;
    else if (sharp < 3 || (elong > 3.5 && sharp < 4.5)) ok = false;
    else if (pk < 2.7 * T) ok = false; // freckles and pores stay: only marks that clearly stand out
    else if (strongMole && crowdFrac <= 0.012) ok = true; // a dark, sharp, round dot is a mole
    else if (crowdFrac > 0.012) ok = false; // hairs/stubble around: leave the whole area alone
    else if (ps > 0.3 && (pk < 4 * T || m < 5 || elong > 2.2)) ok = false; // inside stubble areas only clear, round, strong marks
    else if (m <= 4 && pk < 2.6 * T) ok = false; // a 2-4 px speck must be strong
    if (!ok) { rejected += 1; continue; }
    info.push({ pix, mx, my, thick, major, elong, pk, m, soft: ps > 0.3 });
  }
  // dense clusters (stubble, freckle fields): only very strong marks inside them
  const dens = Math.max(10, rx * 0.16);
  const kept = [];
  for (const a of info) {
    let near = 0;
    for (const b of info) if (b !== a && Math.abs(b.mx - a.mx) < dens && Math.abs(b.my - a.my) < dens && Math.hypot(b.mx - a.mx, b.my - a.my) < dens) near += 1;
    if (near > (a.soft ? 5 : 10) && a.pk < 3.2 * T) { rejected += 1; continue; }
    kept.push(a);
  }
  kept.sort((p, q) => q.pk * q.m - p.pk * p.m);
  const discs = [];
  for (const a of kept.slice(0, 80)) {
    const r = clamp(0.62 * a.thick + 2.4, 2.6, Math.max(3, rx * 0.05)); // small pen: never a big smear
    // hair guard (1): a mark buried in hair is left alone; (2) below, every single disc must stay clear of hair
    let inHair = 0;
    for (const j of a.pix) if (H.mask[j]) inHair += 1;
    if (inHair > 0.3 * a.pix.length) { rejected += 1; continue; }
    // the faint penumbra around a mark (still above a low threshold, within 4 px, never hair) belongs to it: heal it too
    {
      const mark = new Map(); for (const j of a.pix) mark.set(j, 0);
      let frontier = [...a.pix];
      for (let step = 1; step <= 4 && frontier.length && mark.size < a.pix.length * 3; step += 1) {
        const nxt = [];
        for (const j of frontier) {
          const x = j % bw; const y = (j - x) / bw;
          for (let oy = -1; oy <= 1; oy += 1) for (let ox = -1; ox <= 1; ox += 1) {
            const xx = x + ox; const yy = y + oy;
            if (xx < 0 || yy < 0 || xx >= bw || yy >= bh) continue;
            const jj = yy * bw + xx;
            if (mark.has(jj) || H.mask[jj] || sm[jj] < 0.4 || cs[jj] < 0.4 * T) continue;
            mark.set(jj, step); nxt.push(jj);
          }
        }
        frontier = nxt;
      }
      a.pix = [...mark.keys()];
    }
    // discs: centre first, then whatever is still uncovered (a long stain gets several small discs)
    const order = [...a.pix].sort((p, q) => Math.hypot(p % bw - a.mx, ((p - (p % bw)) / bw) - a.my) - Math.hypot(q % bw - a.mx, ((q - (q % bw)) / bw) - a.my));
    const cover = new Set();
    let placed = 0;
    for (const j of order) {
      if (cover.has(j) || placed >= 14) continue;
      const x = j % bw; const y = (j - x) / bw;
      let nearHair = false;
      for (let yy = Math.max(0, Math.floor(y - r * 1.25)); yy <= Math.min(bh - 1, Math.ceil(y + r * 1.25)) && !nearHair; yy += 1) {
        for (let xx = Math.max(0, Math.floor(x - r * 1.25)); xx <= Math.min(bw - 1, Math.ceil(x + r * 1.25)); xx += 1) if (H.mask[yy * bw + xx]) { nearHair = true; break; }
      }
      if (nearHair) continue;
      discs.push({ x: x + 0.5, y: y + 0.5, r }); placed += 1;
      for (const k of a.pix) { const kx = k % bw; const ky = (k - kx) / bw; if (Math.hypot(kx - x, ky - y) < r * 0.8) cover.add(k); }
    }
  }
  return { discs, found: kept.length, rejected, T };
}

/**
 * Edge-preserving smoothing of the skin: a blurred copy replaces the pixel only where the two are close (pores, grain,
 * faint freckles); real edges (hair, eyes, brows, lips, clothes) are above the tolerance and stay sharp.
 * @returns {number} mean blend actually used over the weighted area (0..1)
 */
export function smoothSkinRegion(data, w, x0, y0, bw, bh, weight, strength, rx) {
  const n = bw * bh;
  const r1 = Math.max(1, Math.round(rx * 0.012)); const r2 = Math.max(2, Math.round(rx * 0.03));
  const ch = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  const Yl = new Float32Array(n);
  for (let y = 0; y < bh; y += 1) for (let x = 0; x < bw; x += 1) {
    const j = y * bw + x; const i = ((y0 + y) * w + x0 + x) * 4;
    ch[0][j] = data[i]; ch[1][j] = data[i + 1]; ch[2][j] = data[i + 2];
    Yl[j] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  const b1 = ch.map((c) => boxFilter(c, bw, bh, r1)); const b2 = ch.map((c) => boxFilter(c, bw, bh, r2));
  const Y1 = boxFilter(Yl, bw, bh, r1);
  const tol = 15;
  let used = 0; let cnt = 0;
  for (let j = 0; j < n; j += 1) {
    const wj = weight[j]; if (wj <= 0.01) continue;
    const dY = Yl[j] - Y1[j];
    const keep = Math.exp(-((dY / tol) ** 2)); // a pixel far from its local mean is an edge or a hair: not smoothed
    const f = strength * wj * keep;
    if (f <= 0.005) continue;
    const y = (j / bw) | 0; const x = j - y * bw; const i = ((y0 + y) * w + x0 + x) * 4;
    for (let c = 0; c < 3; c += 1) {
      const target = 0.6 * b1[c][j] + 0.4 * b2[c][j];
      data[i + c] += (target - data[i + c]) * f;
    }
    used += f; cnt += 1;
  }
  return cnt ? used / cnt : 0;
}

const srgbLin = (v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const linSrgb = (c) => 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
function rgbToLab(R, G, B) {
  const r = srgbLin(R); const g = srgbLin(G); const b = srgbLin(B);
  const X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047; const Yv = 0.2126 * r + 0.7152 * g + 0.0722 * b; const Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(X); const fy = f(Yv); const fz = f(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
function labToRgb(L, a, b) {
  const fy = (L + 16) / 116; const fx = fy + a / 500; const fz = fy - b / 200;
  const inv = (t) => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787);
  const X = inv(fx) * 0.95047; const Yv = inv(fy); const Z = inv(fz) * 1.08883;
  const r = 3.2406 * X - 1.5372 * Yv - 0.4986 * Z; const g = -0.9689 * X + 1.8758 * Yv + 0.0415 * Z; const bb = 0.0557 * X - 0.204 * Yv + 1.057 * Z;
  return [clamp(linSrgb(Math.max(0, r)), 0, 255), clamp(linSrgb(Math.max(0, g)), 0, 255), clamp(linSrgb(Math.max(0, bb)), 0, 255)];
}

/** Soft mask (0..1) of a polygon inside the w×h image, with a small feather. */
function polygonMask(poly, w, h, feather = 1) {
  const m = new Float32Array(w * h);
  let y0 = h; let y1 = 0;
  for (const [, y] of poly) { if (y < y0) y0 = y; if (y > y1) y1 = y; }
  y0 = Math.max(0, Math.floor(y0)); y1 = Math.min(h - 1, Math.ceil(y1));
  for (let y = y0; y <= y1; y += 1) {
    const yc = y + 0.5; const xs = [];
    for (let i = 0; i < poly.length; i += 1) {
      const [ax, ay] = poly[i]; const [bx, by] = poly[(i + 1) % poly.length];
      if ((ay <= yc && by > yc) || (by <= yc && ay > yc)) xs.push(ax + ((yc - ay) / (by - ay)) * (bx - ax));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) for (let x = Math.max(0, Math.ceil(xs[k] - 0.5)); x <= Math.min(w - 1, Math.floor(xs[k + 1] - 0.5)); x += 1) m[y * w + x] = 1;
  }
  return feather > 0 ? boxFilter(m, w, h, feather) : m;
}

/**
 * Natural lip colour: the lips keep their own light, texture and shape; only their mean colour moves towards a lip colour
 * that fits THIS skin (redder and a little less yellow than the skin, a little darker). A lip that already has such a
 * colour hardly changes. Teeth and the dark of the mouth opening are excluded; a hair-thin edge keeps skin and lip apart.
 * @param {{outer:number[][], inner:number[][]}} lips polygons in output pixels
 * @param {number[]} skinRgb mean skin colour
 * @param {number} strength 0..1
 * @returns {{recolored:boolean, before?:number[], after?:number[]}}
 */
export function recolorLips(data, w, h, lips, skinRgb, strength) {
  if (!lips?.outer?.length || !(strength > 0) || !skinRgb) return { recolored: false };
  const outer = polygonMask(lips.outer, w, h, 1);
  const inner = lips.inner?.length ? boxFilter(polygonMask(lips.inner, w, h, 0), w, h, 1) : null; // dilated opening
  const wgt = new Float32Array(w * h);
  let sumL = 0; let sumA = 0; let sumB = 0; let sw = 0;
  for (let j = 0; j < wgt.length; j += 1) {
    if (outer[j] <= 0.01) continue;
    const k = outer[j] * (1 - Math.min(1, (inner ? inner[j] : 0) * 3));
    if (k <= 0.01) continue;
    wgt[j] = k;
    const [L, a, b] = rgbToLab(data[j * 4], data[j * 4 + 1], data[j * 4 + 2]);
    sumL += L * k; sumA += a * k; sumB += b * k; sw += k;
  }
  if (sw < 12) return { recolored: false };
  const mL = sumL / sw; const mA = sumA / sw; const mB = sumB / sw;
  const [sL, sA, sB] = rgbToLab(skinRgb[0], skinRgb[1], skinRgb[2]);
  const tA = clamp(sA + 12, 22, 40); const tB = clamp(sB - 6, 8, 24); const tL = clamp(sL - 14, 28, 62);
  // a lip colour inside the natural band is left as it is; only a pale, grey, blue or over-yellow lip is moved (to the band's edge)
  const band = (v, lo, hi) => (v < lo ? lo - v : v > hi ? hi - v : 0);
  const st = Math.min(1, strength * 1.4);
  const dA = band(mA, tA - 2, tA + 8) * st; const dB = band(mB, tB - 3, tB + 5) * st;
  const dL = (mL < tL - 12 || mL > tL + 12 ? (tL - mL) * 0.3 : 0) * st;
  for (let j = 0; j < wgt.length; j += 1) {
    const k = wgt[j]; if (k <= 0.01) continue;
    const i = j * 4;
    const [L, a, b] = rgbToLab(data[i], data[i + 1], data[i + 2]);
    // a near-black or near-white pixel (shadow in the corner, glint) is left alone
    const edge = smooth(8, 22, L) * (1 - smooth(88, 96, L));
    const kk = k * edge;
    const [R2, G2, B2] = labToRgb(L + dL * kk, a + dA * kk, b + dB * kk);
    data[i] += (R2 - data[i]) * Math.min(1, kk + 0.0); data[i + 1] += (G2 - data[i + 1]) * Math.min(1, kk); data[i + 2] += (B2 - data[i + 2]) * Math.min(1, kk);
  }
  return { recolored: true, before: [mL, mA, mB], after: [mL + dL, mA + dA, mB + dB] };
}

/**
 * Studio Eye Clarification & Catchlight:
 * - Sclera (eye whites): gently desaturate yellow/red veins and lift lightness toward clean, healthy neutral white.
 * - Iris: define pupil/limbal ring depth and boost iris micro-contrast.
 * - Studio Catchlight: add a crisp, delicate pinpoint reflection in the upper pupil if missing.
 */
export function enhanceEyes(data, w, h, eyes, strength = 0.75) {
  if (!eyes || !(strength > 0)) return { enhanced: false };
  const toMask = (poly) => (poly?.length ? polygonMask(poly, w, h, 1) : null);
  const mR = toMask(eyes.right);
  const mL = toMask(eyes.left);
  if (!mR && !mL) return { enhanced: false };

  const lum = (idx) => 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
  let count = 0;

  for (const [m, iris] of [[mR, eyes.irisR], [mL, eyes.irisL]]) {
    if (!m) continue;
    const irX = iris ? iris.cx : 0;
    const irY = iris ? iris.cy : 0;
    const irR = iris ? Math.max(3, iris.r) : 0;

    let maxIrisL = 0;
    if (irR > 0) {
      for (let dy = -irR; dy <= irR; dy += 1) {
        for (let dx = -irR; dx <= irR; dx += 1) {
          if (dx * dx + dy * dy <= irR * irR) {
            const px = Math.round(irX + dx); const py = Math.round(irY + dy);
            if (px >= 0 && px < w && py >= 0 && py < h) {
              const l = lum((py * w + px) * 4);
              if (l > maxIrisL) maxIrisL = l;
            }
          }
        }
      }
    }

    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const j = y * w + x;
        const wgt = m[j];
        if (wgt <= 0.02) continue;
        const idx = j * 4;
        const [L, a, b] = rgbToLab(data[idx], data[idx + 1], data[idx + 2]);
        const dIris = irR > 0 ? Math.hypot(x + 0.5 - irX, y + 0.5 - irY) : 999;

        if (dIris <= irR) {
          // Iris: gentle vibrance boost to eye color and micro-contrast, without darkening
          const chBoost = 1 + 0.14 * strength * wgt;
          const [r2, g2, b2] = labToRgb(Math.min(95, L + 1.5 * strength * wgt), a * chBoost, b * chBoost);
          data[idx] = clamp(Math.round(r2), 0, 255);
          data[idx + 1] = clamp(Math.round(g2), 0, 255);
          data[idx + 2] = clamp(Math.round(b2), 0, 255);
        } else if (dIris > irR * 1.05 && L > 35) {
          // Sclera: clean eye whites by gently calming yellow/red cast and lifting lightness
          const scleraFactor = smooth(35, 60, L) * smooth(irR * 1.05, irR * 1.35, dIris) * wgt * strength;
          if (scleraFactor > 0.01) {
            const cleanA = a * (1 - 0.45 * scleraFactor);
            const cleanB = b * (1 - 0.45 * scleraFactor);
            const liftL = Math.min(92, L + 8 * scleraFactor);
            const [r2, g2, b2] = labToRgb(liftL, cleanA, cleanB);
            data[idx] = clamp(Math.round(r2), 0, 255);
            data[idx + 1] = clamp(Math.round(g2), 0, 255);
            data[idx + 2] = clamp(Math.round(b2), 0, 255);
            count += 1;
          }
        }
      }
    }

    // Studio Catchlight: subtle pinpoint reflection in upper pupil
    if (irR >= 3.5 && maxIrisL < 215) {
      const clX = irX - irR * 0.22;
      const clY = irY - irR * 0.28;
      const clRad = Math.max(1.0, irR * 0.15);
      const xStart = Math.max(0, Math.floor(clX - clRad * 2.5));
      const xEnd = Math.min(w - 1, Math.ceil(clX + clRad * 2.5));
      const yStart = Math.max(0, Math.floor(clY - clRad * 2.5));
      const yEnd = Math.min(h - 1, Math.ceil(clY + clRad * 2.5));

      for (let cy = yStart; cy <= yEnd; cy += 1) {
        for (let cx = xStart; cx <= xEnd; cx += 1) {
          const d = Math.hypot(cx + 0.5 - clX, cy + 0.5 - clY);
          if (d <= clRad * 2.2) {
            const alpha = Math.exp(-((d / clRad) ** 2)) * 0.8 * strength;
            const idx = (cy * w + cx) * 4;
            data[idx] = clamp(Math.round(data[idx] + (255 - data[idx]) * alpha), 0, 255);
            data[idx + 1] = clamp(Math.round(data[idx + 1] + (255 - data[idx + 1]) * alpha), 0, 255);
            data[idx + 2] = clamp(Math.round(data[idx + 2] + (255 - data[idx + 2]) * alpha), 0, 255);
          }
        }
      }
    }
  }

  return { enhanced: true, modifiedPixels: count };
}

/**
 * Manual spot removal ("repair brush"). Every disc is replaced by real skin texture cloned from a clean
 * patch nearby, shifted so its surroundings match the surroundings of the disc, then feathered into the
 * skin. Nothing is invented: the pixels come from the same photo. Works in place on RGBA data.
 * @param {Uint8ClampedArray} data
 * @param {number} w
 * @param {number} h
 * @param {{x:number,y:number,r:number}[]} discs centres/radii in output pixels
 * @returns {{healed:number,skipped:number}}
 */
export function healDiscs(data, w, h, discs) {
  let healed = 0; let skipped = 0;
  const ANG = 12;
  const dirs = [];
  for (let a = 0; a < ANG; a += 1) dirs.push([Math.cos((a * 2 * Math.PI) / ANG), Math.sin((a * 2 * Math.PI) / ANG)]);
  const lum = (i) => 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  /** mean RGB + luma stdev of the disc interior (rad) or of the ring (rad*1.35..rad*2) at (cx,cy). */
  const stats = (cx, cy, rad, ring) => {
    const lo = ring ? rad * 1.35 : 0; const hi = ring ? rad * 2 : rad;
    const xa = Math.max(0, Math.floor(cx - hi)); const xb = Math.min(w - 1, Math.ceil(cx + hi));
    const ya = Math.max(0, Math.floor(cy - hi)); const yb = Math.min(h - 1, Math.ceil(cy + hi));
    let n = 0; let s0 = 0; let s1 = 0; let s2 = 0; let sl = 0; let sl2 = 0;
    for (let y = ya; y <= yb; y += 1) {
      for (let x = xa; x <= xb; x += 1) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        if (d > hi || d < lo) continue;
        const i = (y * w + x) * 4; const l = lum(i);
        n += 1; s0 += data[i]; s1 += data[i + 1]; s2 += data[i + 2]; sl += l; sl2 += l * l;
      }
    }
    if (n < 6) return null;
    const ml = sl / n;
    return { rgb: [s0 / n, s1 / n, s2 / n], std: Math.sqrt(Math.max(0, sl2 / n - ml * ml)), n };
  };
  for (const disc of discs || []) {
    const r = Math.max(1.5, disc.r);
    const cx = disc.x; const cy = disc.y;
    if (!(cx > -r && cy > -r && cx < w + r && cy < h + r)) { skipped += 1; continue; }
    const target = stats(cx, cy, r, true);
    if (!target) { skipped += 1; continue; }
    // best clean source patch: surroundings like ours, flat inside (no blemish of its own)
    let best = null;
    for (const dist of [2.6, 3.4, 4.4]) {
      for (const [dx, dy] of dirs) {
        const sx = cx + dx * r * dist; const sy = cy + dy * r * dist;
        if (sx - r * 2 < 0 || sy - r * 2 < 0 || sx + r * 2 >= w || sy + r * 2 >= h) continue;
        const ring = stats(sx, sy, r, true); const inner = stats(sx, sy, r, false);
        if (!ring || !inner) continue;
        let diff = 0; let inDiff = 0;
        for (let c = 0; c < 3; c += 1) { diff += Math.abs(ring.rgb[c] - target.rgb[c]); inDiff += Math.abs(inner.rgb[c] - ring.rgb[c]); }
        const score = diff + 1.5 * inDiff + 0.8 * inner.std + dist * 1.5;
        if (!best || score < best.score) best = { sx, sy, ring, score };
      }
    }
    if (!best) { skipped += 1; continue; }
    const off = [target.rgb[0] - best.ring.rgb[0], target.rgb[1] - best.ring.rgb[1], target.rgb[2] - best.ring.rgb[2]];
    const ox = best.sx - cx; const oy = best.sy - cy;
    const xa = Math.max(0, Math.floor(cx - r * 1.2)); const xb = Math.min(w - 1, Math.ceil(cx + r * 1.2));
    const ya = Math.max(0, Math.floor(cy - r * 1.2)); const yb = Math.min(h - 1, Math.ceil(cy + r * 1.2));
    const patch = [];
    for (let y = ya; y <= yb; y += 1) {
      for (let x = xa; x <= xb; x += 1) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / r;
        if (d >= 1.2) continue;
        const k = d <= 0.8 ? 1 : 1 - smooth(0.8, 1.2, d);
        const sxp = Math.min(w - 1, Math.max(0, Math.round(x + ox))); const syp = Math.min(h - 1, Math.max(0, Math.round(y + oy)));
        const si = (syp * w + sxp) * 4;
        patch.push([(y * w + x) * 4, k, data[si] + off[0], data[si + 1] + off[1], data[si + 2] + off[2]]);
      }
    }
    for (const [i, k, r2, g2, b2] of patch) {
      data[i] = data[i] + (r2 - data[i]) * k;
      data[i + 1] = data[i + 1] + (g2 - data[i + 1]) * k;
      data[i + 2] = data[i + 2] + (b2 - data[i + 2]) * k;
    }
    healed += 1;
  }
  return { healed, skipped };
}
