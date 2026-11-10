// Alpha-mask utilities: resampling, box filters, guided-filter edge refinement,
// choke/expand and feathering. Masks are Float32Array values in 0..1.

export function boxFilter(src, w, h, r) {
  const rad = Math.round(r);
  if (rad <= 0) return Float32Array.from(src);
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  // horizontal (normalised by actual window size at borders)
  for (let y = 0; y < h; y += 1) {
    const row = y * w;
    let acc = 0;
    for (let x = 0; x <= Math.min(rad, w - 1); x += 1) acc += src[row + x];
    for (let x = 0; x < w; x += 1) {
      const lo = Math.max(0, x - rad); const hi = Math.min(w - 1, x + rad);
      tmp[row + x] = acc / (hi - lo + 1);
      if (x + rad + 1 < w) acc += src[row + x + rad + 1];
      if (x - rad >= 0) acc -= src[row + x - rad];
    }
  }
  for (let x = 0; x < w; x += 1) {
    let acc = 0;
    for (let y = 0; y <= Math.min(rad, h - 1); y += 1) acc += tmp[y * w + x];
    for (let y = 0; y < h; y += 1) {
      const lo = Math.max(0, y - rad); const hi = Math.min(h - 1, y + rad);
      out[y * w + x] = acc / (hi - lo + 1);
      if (y + rad + 1 < h) acc += tmp[(y + rad + 1) * w + x];
      if (y - rad >= 0) acc -= tmp[(y - rad) * w + x];
    }
  }
  return out;
}

/** Bilinear resample of a single-channel Float32 mask. */
export function resizeMask(src, sw, sh, dw, dh) {
  const out = new Float32Array(dw * dh);
  const sx = sw / dw; const sy = sh / dh;
  for (let y = 0; y < dh; y += 1) {
    const fy = Math.min(sh - 1, Math.max(0, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy); const y1 = Math.min(sh - 1, y0 + 1); const ty = fy - y0;
    for (let x = 0; x < dw; x += 1) {
      const fx = Math.min(sw - 1, Math.max(0, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx); const x1 = Math.min(sw - 1, x0 + 1); const tx = fx - x0;
      const a = src[y0 * sw + x0] * (1 - tx) + src[y0 * sw + x1] * tx;
      const b = src[y1 * sw + x0] * (1 - tx) + src[y1 * sw + x1] * tx;
      out[y * dw + x] = a * (1 - ty) + b * ty;
    }
  }
  return out;
}

/** Luma (0..1) of an RGBA byte buffer. */
export function lumaFromRGBA(data, w, h) {
  const out = new Float32Array(w * h);
  for (let i = 0, j = 0; j < w * h; i += 4, j += 1) {
    out[j] = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) / 255;
  }
  return out;
}

/**
 * Grey-guide guided filter (He et al.). Snaps a coarse mask `p` to edges in
 * guide `I`. r = window radius in pixels, eps = regularisation.
 */
export function guidedFilter(I, p, w, h, r, eps) {
  const n = w * h;
  const Ip = new Float32Array(n); const II = new Float32Array(n);
  for (let i = 0; i < n; i += 1) { Ip[i] = I[i] * p[i]; II[i] = I[i] * I[i]; }
  const mI = boxFilter(I, w, h, r); const mp = boxFilter(p, w, h, r);
  const mIp = boxFilter(Ip, w, h, r); const mII = boxFilter(II, w, h, r);
  const a = new Float32Array(n); const b = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const cov = mIp[i] - mI[i] * mp[i];
    const v = mII[i] - mI[i] * mI[i];
    a[i] = cov / (v + eps);
    b[i] = mp[i] - a[i] * mI[i];
  }
  const ma = boxFilter(a, w, h, r); const mb = boxFilter(b, w, h, r);
  const q = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const v = ma[i] * I[i] + mb[i];
    q[i] = v < 0 ? 0 : v > 1 ? 1 : v;
  }
  return q;
}

/**
 * Choke (shift < 0) / expand (shift > 0) and harden/feather a soft mask.
 * shift in -1..1, softness in 0..1 (0 = hard edge).
 */
export function shapeMask(m, shift = 0, softness = 0.5) {
  const center = 0.5 - shift * 0.35;
  const half = 0.02 + softness * 0.3;
  const lo = center - half; const hi = center + half;
  const out = new Float32Array(m.length);
  for (let i = 0; i < m.length; i += 1) {
    const t = (m[i] - lo) / (hi - lo);
    const c = t < 0 ? 0 : t > 1 ? 1 : t;
    out[i] = c * c * (3 - 2 * c);
  }
  return out;
}

/**
 * Full refinement pipeline used for model output.
 * @param {Float32Array} coarse model mask resized to (w,h)
 * @param {Float32Array|null} guide luma at (w,h) or null to skip edge snapping
 */
export function refineMask(coarse, guide, w, h, opts = {}) {
  const { edgeAware = true, radius = Math.max(2, Math.round(Math.min(w, h) / 120)), eps = 1e-3, shift = 0, softness = 0.4, feather = 0 } = opts;
  let m = coarse;
  if (edgeAware && guide) m = guidedFilter(guide, m, w, h, radius, eps);
  m = shapeMask(m, shift, softness);
  if (feather > 0) m = boxFilter(m, w, h, Math.round(feather));
  return m;
}

export function maskToBytes(m) {
  const out = new Uint8ClampedArray(m.length);
  for (let i = 0; i < m.length; i += 1) out[i] = Math.round(m[i] * 255);
  return out;
}

export function bytesToMask(b) {
  const out = new Float32Array(b.length);
  for (let i = 0; i < b.length; i += 1) out[i] = b[i] / 255;
  return out;
}

/**
 * Approximate foreground colour estimation for semi-transparent edge pixels:
 * replaces edge colours with alpha-weighted local foreground averages so the old
 * background does not tint hair against the new background.
 */
export function decontaminate(rgba, alpha, w, h, r = 4) {
  const n = w * h;
  const wr = new Float32Array(n); const wg = new Float32Array(n); const wb = new Float32Array(n);
  const a2 = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const a = alpha[i] * alpha[i];
    a2[i] = a; wr[i] = rgba[i * 4] * a; wg[i] = rgba[i * 4 + 1] * a; wb[i] = rgba[i * 4 + 2] * a;
  }
  const mr = boxFilter(wr, w, h, r); const mg = boxFilter(wg, w, h, r); const mb = boxFilter(wb, w, h, r);
  const ma = boxFilter(a2, w, h, r);
  for (let i = 0; i < n; i += 1) {
    const a = alpha[i];
    if (a > 0.02 && a < 0.98 && ma[i] > 1e-4) {
      const k = 1 - a; // trust estimate more where alpha is low
      rgba[i * 4] = rgba[i * 4] * (1 - k) + (mr[i] / ma[i]) * k;
      rgba[i * 4 + 1] = rgba[i * 4 + 1] * (1 - k) + (mg[i] / ma[i]) * k;
      rgba[i * 4 + 2] = rgba[i * 4 + 2] * (1 - k) + (mb[i] / ma[i]) * k;
    }
  }
  return rgba;
}

/**
 * Spill suppression: the rim of the person, just inside the cut-out, often still carries the old background — a light
 * line around dark hair, a coloured glow on a cheek or an ear lit by a coloured wall. For every pixel of that rim the
 * colour of the person further inside (I) and the colour of the old background just outside (B) are estimated; the
 * part of the pixel's (smoothed) colour that points from I towards B is taken out. Fine texture stays, because only
 * the smooth difference is moved. Where the background looks like the person, or there is no "inside" (thin parts),
 * nothing changes. Must run while the old background is still in the picture.
 * @returns {number} share of the person's pixels that were corrected by more than a just-visible amount
 */
export function suppressSpill(rgba, alpha, w, h, r = 4, strength = 1) {
  const n = w * h; const R = Math.max(2, Math.round(r));
  const ab = boxFilter(alpha, w, h, R);
  const wi = new Float32Array(n); const we = new Float32Array(n);
  for (let i = 0; i < n; i += 1) { wi[i] = ab[i] > 0.97 ? alpha[i] : 0; const e = 1 - alpha[i]; we[i] = e * e; }
  const wiB = boxFilter(wi, w, h, 2 * R); const weB = boxFilter(we, w, h, 2 * R);
  const ch = new Float32Array(n); const tmp = new Float32Array(n);
  const I = []; const B = []; const P = [];
  for (let c = 0; c < 3; c += 1) {
    for (let i = 0; i < n; i += 1) { ch[i] = rgba[i * 4 + c]; tmp[i] = ch[i] * wi[i]; }
    I.push(boxFilter(tmp, w, h, 2 * R));
    for (let i = 0; i < n; i += 1) tmp[i] = ch[i] * we[i];
    B.push(boxFilter(tmp, w, h, 2 * R));
    P.push(boxFilter(ch, w, h, Math.max(1, R >> 1)));
  }
  let changed = 0; let person = 0;
  for (let i = 0; i < n; i += 1) {
    const a = alpha[i];
    if (a > 0.5) person += 1;
    if (a < 0.3 || ab[i] >= 0.985 || wiB[i] < 0.02 || weB[i] < 0.004) continue;
    let t = (ab[i] - 0.8) / 0.185; t = t < 0 ? 0 : t > 1 ? 1 : t;
    const band = a * (1 - t * t * (3 - 2 * t));
    if (band <= 0.01) continue;
    const i0 = I[0][i] / wiB[i]; const i1 = I[1][i] / wiB[i]; const i2 = I[2][i] / wiB[i];
    const d0 = B[0][i] / weB[i] - i0; const d1 = B[1][i] / weB[i] - i1; const d2 = B[2][i] / weB[i] - i2;
    const len2 = d0 * d0 + d1 * d1 + d2 * d2;
    if (len2 < 400) continue; // the background is close to the person's own colour here: nothing to tell apart
    const p0 = P[0][i] - i0; const p1 = P[1][i] - i1; const p2 = P[2][i] - i2;
    let s = ((p0 * d0 + p1 * d1 + p2 * d2) / len2) * 1.25; s = s < 0 ? 0 : s > 1 ? 1 : s;
    const k = band * s * strength;
    if (k <= 0.01) continue;
    // only the component along (B − I) is removed
    // never more than this very pixel carries of it (a pixel cleaner than its surroundings must not tip over into
    // the opposite colour)
    const own = ((rgba[i * 4] - i0) * d0 + (rgba[i * 4 + 1] - i1) * d1 + (rgba[i * 4 + 2] - i2) * d2) / len2;
    const proj = Math.max(0, Math.min(1, own, (p0 * d0 + p1 * d1 + p2 * d2) / len2));
    rgba[i * 4] -= k * proj * d0; rgba[i * 4 + 1] -= k * proj * d1; rgba[i * 4 + 2] -= k * proj * d2;
    if (k * Math.abs(proj) * Math.sqrt(len2) > 6) changed += 1;
  }
  return changed / Math.max(1, person);
}

/** Luminance-preserving recolour of a region (clothing colour change). */
export function recolorRegion(rgba, alpha, w, h, rgb, strength = 1) {
  const lin = (v) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  const enc = (v) => { const s = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055; return Math.round(Math.min(1, Math.max(0, s)) * 255); };
  const n = w * h;
  let sumL = 0; let sumA = 0;
  for (let i = 0; i < n; i += 1) {
    const a = alpha[i];
    if (a > 0.5) {
      sumL += 0.2126 * lin(rgba[i * 4]) + 0.7152 * lin(rgba[i * 4 + 1]) + 0.0722 * lin(rgba[i * 4 + 2]);
      sumA += 1;
    }
  }
  if (!sumA) return rgba;
  const meanL = Math.max(1e-4, sumL / sumA);
  const t = [lin(rgb[0]), lin(rgb[1]), lin(rgb[2])];
  const tL = Math.max(1e-4, 0.2126 * t[0] + 0.7152 * t[1] + 0.0722 * t[2]);
  for (let i = 0; i < n; i += 1) {
    const a = alpha[i] * strength;
    if (a <= 0.003) continue;
    const L = 0.2126 * lin(rgba[i * 4]) + 0.7152 * lin(rgba[i * 4 + 1]) + 0.0722 * lin(rgba[i * 4 + 2]);
    const shade = L / meanL;
    for (let c = 0; c < 3; c += 1) {
      const target = Math.min(1, t[c] * shade * (tL < 0.02 ? 1 : 1));
      const src = rgba[i * 4 + c];
      rgba[i * 4 + c] = src * (1 - a) + enc(target) * a;
    }
  }
  return rgba;
}

/** Foreground share and spread of a 0..255 mask — used to reject empty/garbage model output. */
export function maskStats(bytes) {
  const n = bytes.length || 1;
  let fg = 0; let sum = 0; let sq = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    const v = bytes[i] / 255;
    if (v >= 0.5) fg += 1;
    sum += v; sq += v * v;
  }
  const mean = sum / n;
  return { fgFrac: fg / n, std: Math.sqrt(Math.max(0, sq / n - mean * mean)) };
}

/** A real portrait split has both person and background, with a clear boundary. */
export function plausibleMask(bytes) {
  const s = maskStats(bytes);
  return s.fgFrac > 0.01 && s.fgFrac < 0.99 && s.std > 0.08;
}
