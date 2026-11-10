// Skin profile of one photo: what this person's skin really looks like in this picture (tone, colour, noise,
// unevenness, blemishes), measured on the aligned face square, and the plan derived from it. Nothing here is a fixed
// setting for everybody: the brightness the skin is brought to, how much of the face is rebuilt, how coarse the rebuilt
// band is and how strongly the skin engine works all follow from the measurement. Pure: no DOM, no model code.
import { gaussBlur } from './relight.js';

const T = 512; // the template the coordinates below are written in
const lin = (v) => { const x = v / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
const toSrgb = (v) => 255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
const LIN = new Float32Array(256); for (let i = 0; i < 256; i += 1) LIN[i] = lin(i);
const fLab = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);

/** sRGB bytes → CIE L*a*b* (D65). */
export function rgbToLab(r, g, b) {
  const R = LIN[r]; const G = LIN[g]; const B = LIN[b];
  const fx = fLab((0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047);
  const fy = fLab(0.2126729 * R + 0.7151522 * G + 0.072175 * B);
  const fz = fLab((0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function median(values, n = values.length) {
  if (!n) return NaN;
  const a = Float32Array.from(values.subarray ? values.subarray(0, n) : values.slice(0, n)).sort();
  return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
}
function quantile(values, n, q) {
  if (!n) return NaN;
  const a = Float32Array.from(values.subarray(0, n)).sort();
  return a[Math.min(n - 1, Math.max(0, Math.round(q * (n - 1))))];
}
const inEllipse = (x, y, cx, cy, rx, ry) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 < 1;

/** Zones of the template that are never skin: eyes, brows, nostrils, mouth (template pixels). */
function featureZone(x, y) {
  return inEllipse(x, y, 193, 240, 46, 25) || inEllipse(x, y, 319, 240, 46, 25)
    || inEllipse(x, y, 190, 206, 56, 19) || inEllipse(x, y, 322, 206, 56, 19)
    || inEllipse(x, y, 257, 324, 32, 13) || inEllipse(x, y, 257, 374, 70, 32);
}

/** Individual Typology Angle classes (degrees), lightest first. */
export const TONE_CLASSES = Object.freeze([
  { id: 'very-light', nameFa: 'خیلی روشن', above: 55 },
  { id: 'light', nameFa: 'روشن', above: 41 },
  { id: 'intermediate', nameFa: 'متوسط', above: 28 },
  { id: 'tan', nameFa: 'گندمی', above: 10 },
  { id: 'brown', nameFa: 'سبزه', above: -30 },
  { id: 'dark', nameFa: 'تیره', above: -Infinity },
]);
export function toneClass(ita) { return TONE_CLASSES.find((c) => ita > c.above) || TONE_CLASSES[TONE_CLASSES.length - 1]; }

/**
 * Measure the skin of an aligned face square (the restoration model's template: eyes at fixed places).
 * @param {Uint8ClampedArray|Uint8Array} rgba size×size×4
 * @returns {object|null} profile, with `mask` (Float32Array, soft 0..1 skin weight at this size); null when no skin was found
 */
export function skinProfile(rgba, size = T) {
  const k = size / T; const n = size * size;
  const L = new Float32Array(n); const A = new Float32Array(n); const B = new Float32Array(n); const Y = new Float32Array(n); const Yl = new Float32Array(n);
  for (let i = 0, j = 0; j < n; i += 4, j += 1) {
    const lab = rgbToLab(rgba[i], rgba[i + 1], rgba[i + 2]);
    L[j] = lab[0]; A[j] = lab[1]; B[j] = lab[2];
    Y[j] = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
    Yl[j] = 0.2126729 * LIN[rgba[i]] + 0.7151522 * LIN[rgba[i + 1]] + 0.072175 * LIN[rgba[i + 2]];
  }
  // seed: the strip between the eyes and the mouth (nose and upper cheeks) is skin on nearly every face
  const tmp = new Float32Array(n); let c = 0;
  const seed = (src) => { c = 0; for (let y = Math.round(262 * k); y < 335 * k; y += 1) for (let x = Math.round(190 * k); x < 322 * k; x += 1) { if (!inEllipse(x / k, y / k, 257, 324, 32, 13)) { tmp[c] = src[y * size + x]; c += 1; } } return median(tmp, c); };
  const L0 = seed(L); const a0 = seed(A); const b0 = seed(B);
  if (!Number.isFinite(L0)) return null;
  // skin: inside the face oval, outside the feature zones, close to the seed colour (beard, hair, glasses fall out)
  const hard = new Float32Array(n); let cand = 0; let cnt = 0;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const tx = x / k; const ty = y / k;
      if (!inEllipse(tx, ty, 256, 292, 158, 196) || featureZone(tx, ty)) continue;
      cand += 1;
      const j = y * size + x;
      if (Math.abs(A[j] - a0) < 9 && Math.abs(B[j] - b0) < 11 && Math.abs(L[j] - L0) < 34) { hard[j] = 1; cnt += 1; }
    }
  }
  if (cnt < 400 * k * k) return null;
  const mask = gaussBlur(hard, size, size, 3 * k);
  // the area that is rebuilt: the skin with its holes closed (a pimple, a scar or a red patch is not skin-coloured,
  // so it is a hole in the mask above — and exactly what has to be covered), still without beard, hair and features
  const wide = gaussBlur(hard, size, size, 7 * k);
  const closed = new Float32Array(n);
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) { const j = y * size + x; if (wide[j] > 0.42 && !featureZone(x / k, y / k)) closed[j] = 1; }
  const regenMask = gaussBlur(closed, size, size, 5 * k);
  const core = (j) => mask[j] > 0.92;
  const collect = (src, test = core) => { c = 0; for (let j = 0; j < n; j += 1) if (test(j)) { tmp[c] = src[j]; c += 1; } return c; };
  let m = collect(L); const Lm = median(tmp, m);
  m = collect(A); const am = median(tmp, m);
  m = collect(B); const bm = median(tmp, m);
  m = collect(Yl); const yLin = median(tmp, m);
  if (!m) return null;
  const C = Math.hypot(am, bm); const hue = (Math.atan2(bm, am) * 180) / Math.PI;
  const ita = (Math.atan2(Lm - 50, bm) * 180) / Math.PI;

  // sclera: the bright, colourless pixels beside the iris. Its brightness against the skin says how light the skin
  // itself is, whatever the exposure of the photo.
  let sc = 0; const scl = new Float32Array(Math.ceil(2 * 70 * 26 * k * k) + 8);
  for (const ex of [193, 319]) {
    for (let y = Math.round((240 - 11) * k); y <= (240 + 11) * k; y += 1) {
      for (let x = Math.round((ex - 34) * k); x <= (ex + 34) * k; x += 1) {
        if (x < 0 || y < 0 || x >= size || y >= size || Math.abs(x / k - ex) < 12) continue;
        const j = y * size + x;
        if (Math.hypot(A[j], B[j]) < Math.max(7, 0.55 * C) && sc < scl.length) { scl[sc] = Yl[j]; sc += 1; }
      }
    }
  }
  let scleraLin = sc >= 40 * k * k ? quantile(scl, sc, 0.85) : null;
  if (scleraLin != null && scleraLin < 0.45 * yLin) scleraLin = null; // lashes and iris only: no usable white of the eye

  // noise (finest band), unevenness and blemishes (middle band), red patches — all on the skin only
  const b1 = gaussBlur(Y, size, size, 1 * k); const b2 = gaussBlur(Y, size, size, 2.2 * k); const b12 = gaussBlur(Y, size, size, 13 * k);
  const a2 = gaussBlur(A, size, size, 2.2 * k); const a14 = gaussBlur(A, size, size, 14 * k);
  const dev = new Float32Array(n); let cc = 0; let spots = 0; let red = 0;
  const fine = new Float32Array(n);
  for (let j = 0; j < n; j += 1) {
    if (!core(j)) continue;
    fine[cc] = Math.abs(Y[j] - b1[j]);
    const mid = b2[j] - b12[j];
    dev[cc] = Math.abs(mid);
    if (mid < -5.5) spots += 1;
    if (a2[j] - a14[j] > 2.4) red += 1;
    cc += 1;
  }
  const noise = 1.4826 * median(fine, cc);
  const unevenness = 1.4826 * median(dev, cc);
  return {
    L: Lm, a: am, b: bm, chroma: C, hue, ita, tone: toneClass(ita).id,
    yLin, luma: toSrgb(yLin), scleraLin, skinToSclera: scleraLin ? yLin / scleraLin : null,
    skinFraction: cnt / Math.max(1, cand), noise, unevenness, spots: spots / cc, redPatches: red / cc,
    size, mask, regenMask, hard,
  };
}

const segDist = (x, y, x0, y0, x1, y1) => {
  const dx = x1 - x0; const dy = y1 - y0; let t = ((x - x0) * dx + (y - y0) * dy) / (dx * dx + dy * dy); t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(x - (x0 + t * dx), y - (y0 + t * dy));
};
/** The folds from the nose wings to the mouth corners: dark lines that belong to the face (template pixels). */
const foldZone = (x, y) => segDist(x, y, 213, 318, 180, 395) < 17 || segDist(x, y, 299, 318, 332, 395) < 17;

function skinAverage(src, weight, size, sigma, wBlur = null) {
  const n = size * size; const t = new Float32Array(n);
  for (let j = 0; j < n; j += 1) t[j] = src[j] * weight[j];
  const sm = gaussBlur(t, size, size, sigma); const wb = wBlur || gaussBlur(weight, size, size, sigma);
  for (let j = 0; j < n; j += 1) sm[j] = wb[j] > 0.02 ? sm[j] / wb[j] : src[j];
  return { avg: sm, wb };
}

/**
 * Find the blemishes of the skin: compact spots that are darker or redder than the clean skin around them (pimples,
 * marks, stains) and short marks outside the natural folds. Thresholds are relative to this face's own skin and its own
 * noise, so they hold for light and dark skin alike. A single very dark, sharp spot is treated as a mole and kept
 * (it is part of how the person looks) unless `moles` is true.
 * @returns {{mask:Float32Array, count:number, area:number, kept:number}} soft heal mask; area = share of the skin covered
 */
export function findBlemishes(rgba, profile, { moles = false, sensitivity = 1 } = {}) {
  const size = profile.size; const k = size / T; const n = size * size;
  const Y = new Float32Array(n); const A = new Float32Array(n);
  for (let i = 0, j = 0; j < n; i += 4, j += 1) { Y[j] = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]; A[j] = 0.5 * rgba[i] - 0.418688 * rgba[i + 1] - 0.081312 * rgba[i + 2]; }
  const { hard, regenMask } = profile;
  const refY = skinAverage(Y, hard, size, 9 * k); const refA = skinAverage(A, hard, size, 9 * k, refY.wb);
  const sY = gaussBlur(Y, size, size, 1.2 * k); const sA = gaussBlur(A, size, size, 1.6 * k);
  const rel = new Float32Array(n); const dA = new Float32Array(n); const tmp = new Float32Array(n); const tmp2 = new Float32Array(n); let c = 0;
  for (let j = 0; j < n; j += 1) {
    rel[j] = (sY[j] - refY.avg[j]) / Math.max(24, refY.avg[j]); dA[j] = (sA[j] - refA.avg[j]) / Math.max(24, refY.avg[j]);
    if (hard[j] && refY.wb[j] > 0.5) { tmp[c] = Math.abs(rel[j]); tmp2[c] = Math.abs(dA[j]); c += 1; }
  }
  const sRel = 1.4826 * median(tmp, c); const sRed = 1.4826 * median(tmp2, c);
  const tDark = Math.max(0.055, 3.2 * sRel) / sensitivity; const tRed = Math.max(0.02, 3.2 * sRed) / sensitivity;
  const cand = new Uint8Array(n);
  for (let j = 0; j < n; j += 1) if (regenMask[j] > 0.9 && refY.wb[j] > 0.3 && (rel[j] < -tDark || dA[j] > tRed)) cand[j] = 1;
  // connected components: keep the compact ones (and short marks outside the folds)
  const label = new Int32Array(n); const stack = new Int32Array(n); const keep = new Float32Array(n);
  let count = 0; let kept = 0; let skinPx = 0; let healPx = 0; const comps = [];
  for (let j = 0; j < n; j += 1) if (regenMask[j] > 0.8) skinPx += 1;
  for (let j0 = 0; j0 < n; j0 += 1) {
    if (!cand[j0] || label[j0]) continue;
    let sp = 0; stack[sp] = j0; sp += 1; label[j0] = j0 + 1;
    let a = 0; let peak = 0; let peakRed = 0; let sumRed = 0; let x0 = size; let y0 = size; let x1 = 0; let y1 = 0; let sumRel = 0; let sx = 0; let sy = 0; let border = false;
    const members = [];
    while (sp) {
      sp -= 1; const j = stack[sp]; const x = j % size; const y = (j - x) / size;
      members.push(j); a += 1; sumRel += rel[j]; sumRed += dA[j]; sx += x; sy += y;
      if (rel[j] < peak) peak = rel[j]; if (dA[j] > peakRed) peakRed = dA[j];
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (const q of [j - 1, j + 1, j - size, j + size]) {
        if (q < 0 || q >= n) continue;
        if (Math.abs((q % size) - x) > 1) continue;
        if (regenMask[q] < 0.8) border = true;
        if (cand[q] && !label[q]) { label[q] = j0 + 1; stack[sp] = q; sp += 1; }
      }
    }
    const bw = x1 - x0 + 1; const bh = y1 - y0 + 1; const long = Math.max(bw, bh); const short = Math.min(bw, bh);
    const area = a / (k * k); const cx = sx / a / k; const cy = sy / a / k;
    const compact = long / short <= 2.6 && a / (bw * bh) >= 0.35 && area <= 520;
    // a longer mark is taken only when it is reddish (a scar, a scratch): dark lines are folds, wrinkles and hair
    const mark = long / k <= 60 && area <= 200 && sumRed / a > tRed && !foldZone(cx, cy);
    const strong = peak < -1.5 * tDark || peakRed > 1.5 * tRed; // a real spot stands clearly out of its surroundings
    if (area < 5 || border || !strong || !(compact || mark)) continue;
    if (!moles && peak < -0.45 && area >= 25 && compact) { kept += 1; continue; }
    comps.push({ members, area, cx, cy });
  }
  // specks that come in crowds are stubble or freckles, not blemishes: a small spot with many small neighbours is left alone
  for (const cpt of comps) {
    if (cpt.area < 40) {
      let near = 0;
      for (const o of comps) if (o !== cpt && o.area < 40 && Math.hypot(o.cx - cpt.cx, o.cy - cpt.cy) < 42) near += 1;
      if (near >= 4) continue;
    }
    count += 1; healPx += cpt.members.length;
    for (const j of cpt.members) keep[j] = 1;
  }
  const grown = gaussBlur(keep, size, size, 2.2 * k);
  for (let j = 0; j < n; j += 1) grown[j] = grown[j] > 0.12 ? 1 : 0;
  return { mask: gaussBlur(grown, size, size, 1.4 * k), core: grown, count, kept, area: healPx / Math.max(1, skinPx) };
}

/**
 * Cover the blemishes with the clean skin around them: every marked pixel takes the average of the unmarked skin near
 * it (colour and light of that very place). The result is smooth there — the skin texture is laid on afterwards by the
 * restoration model, or by the photo's own fine grain (kept below) when no model is installed.
 * @returns {Uint8ClampedArray} new RGBA
 */
export function healBlemishes(rgba, profile, found) {
  const size = profile.size; const k = size / T; const n = size * size;
  const out = new Uint8ClampedArray(rgba);
  if (!found || !found.count) return out;
  const w = new Float32Array(n);
  for (let j = 0; j < n; j += 1) w[j] = profile.regenMask[j] > 0.5 && !found.core[j] ? 1 : 0;
  const wb = gaussBlur(w, size, size, 6 * k);
  const ch = new Float32Array(n);
  for (let cI = 0; cI < 3; cI += 1) {
    for (let j = 0; j < n; j += 1) ch[j] = rgba[j * 4 + cI];
    const { avg } = skinAverage(ch, w, size, 6 * k, wb);
    const fineSrc = gaussBlur(ch, size, size, 0.9 * k);
    for (let j = 0; j < n; j += 1) {
      const m = found.mask[j];
      if (m > 0.003 && wb[j] > 0.02) out[j * 4 + cI] = ch[j] + m * (avg[j] + 0.6 * (ch[j] - fineSrc[j]) - ch[j]);
    }
  }
  return out;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * The plan for one photo, derived from its skin profile. Every value is specific to this face.
 * @param {object} profile from skinProfile
 * @param {{faceWidthPx?:number, strength?:number, blemishArea?:number}} [ctx] width of the face in the ORIGINAL file
 *   (pixels, cheek to cheek), the user's strength 0..1, share of the skin covered by blemishes
 */
export function skinPlan(profile, { faceWidthPx = 600, strength = 0.75, blemishArea = 0 } = {}) {
  // how light this person's skin is, 0 (dark) .. 1 (light). The white of the eye is the yardstick when it can be
  // seen (it does not depend on the exposure); the typology angle of the skin colour supports it.
  const tIta = clamp01((profile.ita + 10) / 60);
  const tScl = profile.skinToSclera != null ? clamp01((profile.skinToSclera - 0.3) / 0.55) : null;
  // The two can disagree: shaded eyes make the skin look lighter than it is against them, an under-exposed photo makes
  // light skin look dark by its angle. The lighter reading is taken; without a visible white of the eye the skin is
  // never assumed to be darker than medium, so that an under-exposed photo of light skin is still brought up.
  const lightness = tScl != null ? Math.max(tScl, tIta) : Math.max(tIta, 0.5);
  // brightness (sRGB luma) the skin is brought to: light skin as bright as the studio reference, darker skin stays darker
  const targetLuma = Math.round(132 + 54 * lightness);
  const defect = clamp01(blemishArea / 0.03);
  const lowRes = clamp01((520 - faceWidthPx) / 300);
  const need = Math.max(defect, lowRes);
  // colour: only what is outside the natural range of skin is corrected
  const saturation = profile.chroma < 17 ? Math.min(12, (17 - profile.chroma) * 2) : profile.chroma > 32 ? -Math.min(12, (profile.chroma - 32) * 1.5) : 0;
  const temperature = profile.hue < 38 ? Math.min(6, (38 - profile.hue) * 0.6) : profile.hue > 66 ? -Math.min(6, (profile.hue - 66) * 0.6) : 0;
  return {
    lightness, tone: profile.tone, targetLuma, referenceL: 0.66 * (targetLuma / 186),
    defect, lowRes,
    restoreStrength: clamp01(strength * (0.85 + 0.35 * need)),
    regen: clamp01((0.45 + 0.55 * need) * Math.min(1, strength / 0.5)),
    sigmaSkin: Math.round(22 + 16 * need),
    chromaEven: clamp01((0.35 + 0.55 * defect) * Math.min(1, strength / 0.5)),
    smoothScale: 0.25 + 0.45 * defect,
    saturation: Math.round(saturation * 10) / 10, temperature: Math.round(temperature * 10) / 10,
  };
}
