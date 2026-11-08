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
  if (p.sharpness > 0) {
    const radius = Math.max(1, Math.round(1 * (opts.scale || 1)));
    const blurred = boxBlurRGB(data, w, h, radius);
    const amount = (p.sharpness / 100) * 1.6;
    for (let i = 0, j = 0; i < n; i += 4, j += 3) {
      for (let c = 0; c < 3; c += 1) {
        const v = data[i + c];
        const d = v - blurred[j + c];
        if (Math.abs(d) > 2) data[i + c] = v + d * amount;
      }
    }
  }
  return data;
}
