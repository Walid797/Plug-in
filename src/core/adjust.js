// Colour/tone adjustment pipeline. Pure functions on RGBA byte arrays so the
// exact same code runs for the on-screen preview, the export worker and tests.

export const ADJUSTMENT_DEFAULTS = Object.freeze({
  exposure: 0, // -100..100  → ±2 EV
  brightness: 0, // -100..100
  contrast: 0, // -100..100
  highlights: 0, // -100..100
  shadows: 0, // -100..100
  saturation: 0, // -100..100
  temperature: 0, // -100..100 (cool ↔ warm)
  tint: 0, // -100..100 (green ↔ magenta)
  sharpness: 0, // 0..100
  lift: 0, // 0..100: brightens mid-tones and lights (skin, white shirt) but spares the darks (hair, jacket); 100 = +2 EV on the lights
  whites: 0, // -100..100: moves the white point (brightens/dims the lightest tones)
  blacks: 0, // -100..100: moves the black point (negative = deeper blacks)
  denoise: 0, // 0..100: colour-noise reduction (chrominance only; luminance detail untouched)
  clarity: 0, // 0..100: local contrast on luminance only (hair curls, brows, stubble get crisper; no colour fringes)
  grayscale: false,
});

export const ADJUSTMENT_KEYS = Object.keys(ADJUSTMENT_DEFAULTS);

export function isNeutral(p) {
  return ADJUSTMENT_KEYS.every((k) => (p?.[k] ?? ADJUSTMENT_DEFAULTS[k]) === ADJUSTMENT_DEFAULTS[k]);
}

const srgbToLinear = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const linearToSrgb = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** White-balance multipliers (linear light), normalised to keep luminance. */
export function whiteBalance(temperature, tint) {
  const t = temperature / 100; const g = tint / 100;
  let r = 1 + 0.22 * t; let gg = 1 - 0.18 * g; let b = 1 - 0.22 * t;
  const lum = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
  r /= lum; gg /= lum; b /= lum;
  return [r, gg, b];
}

function toneCurve(s, p) {
  // white / black point first: whites>0 lowers the white point (lights get lighter),
  // blacks<0 raises the black point (deeper blacks). 0 and 1 stay mapped to themselves
  // when both sliders are 0; whites>0 clips the very top by design.
  const wp = 1 - 0.16 * ((p.whites || 0) / 100);
  const bp = -0.12 * ((p.blacks || 0) / 100);
  if (wp !== 1 || bp !== 0) s = clamp01((s - bp) / Math.max(0.2, wp - bp));
  const br = p.brightness / 100;
  if (br) s = s ** (2 ** (-0.85 * br));
  const hl = p.highlights / 100;
  if (hl) {
    const w = smoothstep(0.45, 1, s);
    s += hl * 0.35 * w * (hl > 0 ? 1 - s : s);
  }
  const sh = p.shadows / 100;
  if (sh) {
    const w = 1 - smoothstep(0, 0.55, s);
    s += sh * 0.35 * w * (sh > 0 ? 1 - s : s);
  }
  const ct = p.contrast / 100;
  if (ct) {
    const k = ct >= 0 ? 1 + 1.4 * ct : 1 + 0.75 * ct;
    s = 0.5 + (s - 0.5) * k;
  }
  return clamp01(s);
}

/** Per-channel 256-entry lookup tables for all per-channel operations. */
export function buildLuts(params) {
  const p = { ...ADJUSTMENT_DEFAULTS, ...params };
  const ev = 2 ** ((p.exposure / 100) * 2);
  const wb = whiteBalance(p.temperature, p.tint);
  const luts = [new Uint8ClampedArray(256), new Uint8ClampedArray(256), new Uint8ClampedArray(256)];
  for (let c = 0; c < 3; c += 1) {
    const mult = ev * wb[c];
    for (let v = 0; v < 256; v += 1) {
      let s = v / 255;
      if (mult !== 1) s = linearToSrgb(clamp01(srgbToLinear(s) * mult));
      if (p.lift) s = linearToSrgb(clamp01(srgbToLinear(s) * 2 ** ((p.lift / 100) * 2 * smoothstep(0.18, 0.62, s))));
      s = toneCurve(s, p);
      luts[c][v] = Math.round(s * 255);
    }
  }
  return luts;
}

/** Separable box blur of RGB channels (alpha untouched). Returns a new buffer. */
export function boxBlurRGB(src, w, h, r) {
  const tmp = new Float32Array(w * h * 3);
  const out = new Float32Array(w * h * 3);
  const win = 2 * r + 1;
  for (let y = 0; y < h; y += 1) {
    for (let c = 0; c < 3; c += 1) {
      let acc = 0;
      for (let i = -r; i <= r; i += 1) acc += src[(y * w + Math.min(w - 1, Math.max(0, i))) * 4 + c];
      for (let x = 0; x < w; x += 1) {
        tmp[(y * w + x) * 3 + c] = acc / win;
        const add = Math.min(w - 1, x + r + 1); const sub = Math.max(0, x - r);
        acc += src[(y * w + add) * 4 + c] - src[(y * w + sub) * 4 + c];
      }
    }
  }
  for (let x = 0; x < w; x += 1) {
    for (let c = 0; c < 3; c += 1) {
      let acc = 0;
      for (let i = -r; i <= r; i += 1) acc += tmp[(Math.min(h - 1, Math.max(0, i)) * w + x) * 3 + c];
      for (let y = 0; y < h; y += 1) {
        out[(y * w + x) * 3 + c] = acc / win;
        const add = Math.min(h - 1, y + r + 1); const sub = Math.max(0, y - r);
        acc += tmp[(add * w + x) * 3 + c] - tmp[(sub * w + x) * 3 + c];
      }
    }
  }
  return out;
}

/**
 * Snap near-white, neutral pixels to pure white (all channels ≥ 244 and nearly equal → 255, smoothly).
 * Used when the photo's own white backdrop is kept: tone adjustments may leave it at 250–253, but the
 * backdrop must print as clean white. Skin and tinted clothes have colour and are not affected.
 */
export function snapNearWhite(data) {
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]; const g = data[i + 1]; const b = data[i + 2];
    const lo = Math.min(r, g, b); const hi = Math.max(r, g, b);
    if (lo < 238 || hi - lo > 12) continue;
    const t = smoothstep(238, 248, lo) * (1 - smoothstep(6, 12, hi - lo));
    data[i] = r + (255 - r) * t; data[i + 1] = g + (255 - g) * t; data[i + 2] = b + (255 - b) * t;
  }
  return data;
}

/**
 * Local contrast ("clarity"): adds (luma − blurred luma) × amount to all channels equally, so only
 * luminance detail changes (no colour shifts); the boost per pixel is capped to avoid halos.
 * @param {number} amount 0..1
 */
export function localContrast(data, w, h, amount, scale = 1, weight = null) {
  const n = w * h;
  const r = Math.max(2, Math.round(3 * Math.max(1, scale)));
  const pack = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n * 4; i += 4) {
    const y = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    pack[i] = y; pack[i + 3] = 255;
  }
  const blurred = boxBlurRGB(pack, w, h, r);
  const k = amount * 1.1;
  for (let i = 0, j = 0; j < n; i += 4, j += 1) {
    const d = clampN((pack[i] - blurred[j * 3]) * k * (weight ? weight[j] : 1), -36, 36);
    data[i] += d; data[i + 1] += d; data[i + 2] += d;
  }
  return data;
}
const clampN = (v, a, b) => (v < a ? a : v > b ? b : v);

/**
 * Colour-noise reduction: blur only Cb/Cr (box blur) and keep the luminance exactly,
 * so hair, brows and skin texture stay sharp while colour speckles disappear.
 * @param {number} amount 0..1
 */
export function chromaDenoise(data, w, h, amount, scale = 1) {
  const r = Math.max(1, Math.round((1 + amount * 2) * Math.max(1, scale)));
  const n = w * h;
  const Y = new Float32Array(n);
  // pack Cb and Cr as "RGB-like" planes so boxBlurRGB (3 channels) can be reused
  const pack = new Uint8ClampedArray(n * 4);
  for (let i = 0, j = 0; j < n; i += 4, j += 1) {
    const R = data[i]; const G = data[i + 1]; const B = data[i + 2];
    Y[j] = 0.299 * R + 0.587 * G + 0.114 * B;
    pack[i] = clamp01((-0.168736 * R - 0.331264 * G + 0.5 * B) / 255 + 0.5) * 255;
    pack[i + 1] = clamp01((0.5 * R - 0.418688 * G - 0.081312 * B) / 255 + 0.5) * 255;
    pack[i + 3] = 255;
  }
  const blurred = boxBlurRGB(pack, w, h, r);
  for (let i = 0, j = 0; j < n; i += 4, j += 1) {
    const dCb = (pack[i] + (blurred[j * 3] - pack[i]) * amount - 127.5);
    const dCr = (pack[i + 1] + (blurred[j * 3 + 1] - pack[i + 1]) * amount - 127.5);
    const y = Y[j];
    data[i] = y + 1.402 * dCr;
    data[i + 1] = y - 0.344136 * dCb - 0.714136 * dCr;
    data[i + 2] = y + 1.772 * dCb;
  }
  return data;
}

/**
 * Apply adjustments in place on an RGBA Uint8ClampedArray.
 * @param {{scale?: number}} opts scale = output pixels per reference pixel
 *   (used so sharpening radius tracks the output resolution).
 */
export function applyAdjustments(data, w, h, params, opts = {}) {
  const p = { ...ADJUSTMENT_DEFAULTS, ...params };
  if (isNeutral(p)) return data;
  const [lr, lg, lb] = buildLuts(p);
  const sat = p.grayscale ? -1 : p.saturation / 100;
  const satK = 1 + (sat > 0 ? sat * 0.9 : sat);
  const n = w * h * 4;
  for (let i = 0; i < n; i += 4) {
    let r = lr[data[i]]; let g = lg[data[i + 1]]; let b = lb[data[i + 2]];
    if (satK !== 1) {
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      r = l + (r - l) * satK; g = l + (g - l) * satK; b = l + (b - l) * satK;
    }
    data[i] = r; data[i + 1] = g; data[i + 2] = b;
  }
  if (p.denoise > 0) chromaDenoise(data, w, h, p.denoise / 100, opts.scale || 1);
  if (p.clarity > 0) localContrast(data, w, h, p.clarity / 100, opts.scale || 1, opts.detailWeight || null);
  if (p.sharpness > 0) {
    const radius = Math.max(1, Math.round(1 * (opts.scale || 1)));
    const blurred = boxBlurRGB(data, w, h, radius);
    const amount = (p.sharpness / 100) * 1.6;
    for (let i = 0, j = 0; i < n; i += 4, j += 3) {
      for (let c = 0; c < 3; c += 1) {
        const v = data[i + c];
        const d = v - blurred[j + c];
        if (Math.abs(d) > 2) data[i + c] = v + d * amount * (opts.detailWeight ? opts.detailWeight[j / 3] : 1);
      }
    }
  }
  return data;
}

/**
 * Edge-preserving super-resolution detail reconstruction for low-resolution sources (e.g. 500px).
 * Reconstructs micro-contrast along authentic facial and hair contours without halos or noise amplification.
 */
export function reconstructEdgeDetails(data, w, h, upFactor, weight = null) {
  if (upFactor <= 1.15) return data;
  const n = w * h;
  const Y = new Float32Array(n);
  for (let i = 0, j = 0; j < n; i += 4, j += 1) {
    Y[j] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  const strength = Math.min(0.65, (upFactor - 1) * 0.45);
  for (let y = 1; y < h - 1; y += 1) {
    const row = y * w;
    for (let x = 1; x < w - 1; x += 1) {
      const j = row + x;
      const wVal = weight ? weight[j] : 1;
      if (wVal <= 0.05) continue;
      // 3x3 unsharp laplacian difference
      const center = Y[j];
      const lap = 8 * center - (
        Y[j - 1] + Y[j + 1] +
        Y[j - w] + Y[j + w] +
        Y[j - w - 1] + Y[j - w + 1] +
        Y[j + w - 1] + Y[j + w + 1]
      );
      // Only enhance authentic structural gradients (avoid flat areas and extreme clipping)
      const absLap = Math.abs(lap);
      if (absLap >= 4 && absLap <= 90) {
        const boost = clampN(lap * 0.12 * strength * wVal, -16, 16);
        const idx = j * 4;
        data[idx] += boost;
        data[idx + 1] += boost;
        data[idx + 2] += boost;
      }
    }
  }
  return data;
}

/* ------------------------------------------------------- print brightening */

/**
 * Compensation for prints that come out darker than the screen (typical for
 * 4-colour dye inkjets on glossy paper: ink spread darkens mid-tones and closes
 * shadows). A mid-tone gamma lift plus a shadow-opening bump:
 *   t = s^gamma,  f = t + bump·t·(1−t)²
 * Both terms keep 0 → 0 and 1 → 1 exactly, so pure white backgrounds stay pure
 * white (no ink) and black stays black. Applied only to print/PDF/sheet output,
 * never to the stored edit.
 * Mid-grey (sRGB 0.5) lift: low ≈ +¼ stop, medium ≈ +½ stop, high ≈ +⅔ stop.
 */
export const PRINT_BOOST_LEVELS = Object.freeze({
  off: Object.freeze({ gamma: 1, bump: 0 }),
  low: Object.freeze({ gamma: 0.93, bump: 0.15 }),
  medium: Object.freeze({ gamma: 0.87, bump: 0.28 }),
  high: Object.freeze({ gamma: 0.8, bump: 0.4 }),
});
export const PRINT_BOOST_IDS = Object.freeze(['off', 'low', 'medium', 'high']);

export function isPrintBoost(level) {
  return Object.prototype.hasOwnProperty.call(PRINT_BOOST_LEVELS, level) && level !== 'off';
}

/** Tone value (0..1) after print brightening. */
export function printBoostValue(s, level) {
  const p = PRINT_BOOST_LEVELS[level] || PRINT_BOOST_LEVELS.off;
  const t = clamp01(s) ** p.gamma;
  return clamp01(t + p.bump * t * (1 - t) * (1 - t));
}

const boostLutCache = new Map();
/** 256-entry LUT for a level, or null when the level is off/unknown. */
export function printBoostLut(level) {
  if (!isPrintBoost(level)) return null;
  let lut = boostLutCache.get(level);
  if (!lut) {
    lut = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v += 1) lut[v] = Math.round(printBoostValue(v / 255, level) * 255);
    boostLutCache.set(level, lut);
  }
  return lut;
}

/** Apply one LUT to the RGB channels of an RGBA buffer, in place (alpha untouched). */
export function applyLut(data, lut) {
  if (!lut) return data;
  for (let i = 0; i < data.length; i += 4) {
    data[i] = lut[data[i]]; data[i + 1] = lut[data[i + 1]]; data[i + 2] = lut[data[i + 2]];
  }
  return data;
}
