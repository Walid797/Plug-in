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
  skin: Object.freeze({ enabled: true, redness: 40, balance: 40, spots: 0 }),
  light: Object.freeze({ enabled: true, fill: 45, even: true, protect: true }),
});

/** Natural limit for red vs yellow in skin ((Cr-128)/(128-Cb)); only redness above it is reduced. */
export const REDNESS_LIMIT = 1.5;
const MAX_RED_SHIFT = 7; // Cr levels
const MAX_BLOTCH_SHIFT = 4;
const MAX_FILL_LIFT = 24; // luma levels
const MAX_EVEN_GAIN = 0.08;
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
  const y1 = Math.min(h, Math.ceil(ell.cy + Math.max(ell.rx, ell.ry) * 1.2));
  const bw = x1 - x0; const bh = y1 - y0;
  if (bw < 8 || bh < 8) return { applied: false, reason: 'NO_FACE' };
  const n = bw * bh;
  const cos = Math.cos(ell.rot); const sin = Math.sin(ell.rot);
  const Y = new Float32Array(n); const Cb = new Float32Array(n); const Cr = new Float32Array(n);
  const we = new Float32Array(n); const weW = new Float32Array(n); const U = new Float32Array(n);
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
    const lum = smooth(35, 75, Y[j]) * (1 - smooth(238, 252, Y[j]));
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
  const gL = lw > 0 && rw > 0 && light.enabled && light.even ? clamp(aY / (lY / lw), 1 - MAX_EVEN_GAIN, 1 + MAX_EVEN_GAIN) : 1;
  const gR = lw > 0 && rw > 0 && light.enabled && light.even ? clamp(aY / (rY / rw), 1 - MAX_EVEN_GAIN, 1 + MAX_EVEN_GAIN) : 1;
  report.evenGain = [gL, gR];
  let holeCand = null; let mSp = null; let msSp = null;
  if (skin.enabled && skin.spots > 0) {
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
  let protect = null;
  if (Array.isArray(params.protect) && params.protect.length) {
    protect = new Float32Array(n);
    for (const z of params.protect) {
      const zc = Math.cos(z.rot || 0); const zs = Math.sin(z.rot || 0);
      for (let y = 0; y < bh; y += 1) {
        for (let x = 0; x < bw; x += 1) {
          const dx = x0 + x + 0.5 - z.cx; const dy = y0 + y + 0.5 - z.cy;
          const u = (dx * zc + dy * zs) / z.rx; const v = (-dx * zs + dy * zc) / z.ry;
          const dd = Math.hypot(u, v); if (dd >= 1.2) continue;
          const wgt = dd <= 0.85 ? 1 : 1 - smooth(0.85, 1.2, dd);
          if (wgt > protect[y * bw + x]) protect[y * bw + x] = wgt;
        }
      }
    }
  }
  const spots = holeCand ? spotCorrection(Y, Cb, Cr, msSp, bw, bh, ell.rx, skin.spots, holeCand, mSp, protect) : null;
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
