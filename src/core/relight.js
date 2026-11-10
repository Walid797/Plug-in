// Studio relight: removes the shadow of one-sided light from a face without touching its shape or identity.
//
// The 468-point face mesh has an exact left/right mirror map, so for every face pixel we know where the same
// anatomical point lies on the other side. The log-luminance difference between a point and its mirror is free of
// albedo (beard against beard, cheek against cheek): it measures only the difference in light. The result is a smooth
// multiplicative gain (one value per pixel, plus a small per-channel part for the colour cast of the shadow side),
// computed once per photo in a fixed "work" frame (face upright, fixed size) and applied in linear light.
//
// Pure functions, no DOM: the caller supplies the work-frame pixels and masks.
import { MESH_TRI, MESH_MIRROR } from './facemesh.js';
import { boxFilter } from './mask.js';

/** Work frame (W×H px, face width FW px) and the packed field size. */
export const RELIGHT = Object.freeze({ W: 512, H: 640, FW: 230, PW: 256, PH: 320, G_MIN: -0.7, G_SPAN: 2.8, C_SPAN: 1.0, K_MIN: -0.5, K_SPAN: 1.2 });
const NV = 468;
const NT = MESH_TRI.length / 3;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
/** Smoothstep from a to b (a may be greater than b for a falling edge). */
const smooth = (a, b, x) => { let t = (x - a) / (b - a); t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); };

const LIN = new Float32Array(256);
for (let i = 0; i < 256; i += 1) { const v = i / 255; LIN[i] = v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }
const SRGB_N = 4096;
const SRGB = new Uint8Array(SRGB_N + 1);
for (let i = 0; i <= SRGB_N; i += 1) { const v = i / SRGB_N; SRGB[i] = Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055)); }

/* ------------------------------------------------------------------ blur */

function boxRadii(sigma) {
  const ideal = Math.sqrt((12 * sigma * sigma) / 3 + 1);
  let wl = Math.floor(ideal); if (wl % 2 === 0) wl -= 1;
  const wu = wl + 2;
  const m = Math.round((12 * sigma * sigma - 3 * wl * wl - 12 * wl - 9) / (-4 * wl - 4));
  return [0, 1, 2].map((i) => ((i < m ? wl : wu) - 1) / 2);
}

function boxPass(src, dst, w, h, r, tmp) {
  if (r <= 0) { dst.set(src); return; }
  for (let y = 0; y < h; y += 1) {
    const row = y * w; let acc = 0;
    const lim = Math.min(r, w - 1);
    for (let x = 0; x <= lim; x += 1) acc += src[row + x];
    for (let x = 0; x < w; x += 1) {
      const lo = x - r < 0 ? 0 : x - r; const hi = x + r > w - 1 ? w - 1 : x + r;
      tmp[row + x] = acc / (hi - lo + 1);
      if (x + r + 1 < w) acc += src[row + x + r + 1];
      if (x - r >= 0) acc -= src[row + x - r];
    }
  }
  for (let x = 0; x < w; x += 1) {
    let acc = 0;
    const lim = Math.min(r, h - 1);
    for (let y = 0; y <= lim; y += 1) acc += tmp[y * w + x];
    for (let y = 0; y < h; y += 1) {
      const lo = y - r < 0 ? 0 : y - r; const hi = y + r > h - 1 ? h - 1 : y + r;
      dst[y * w + x] = acc / (hi - lo + 1);
      if (y + r + 1 < h) acc += tmp[(y + r + 1) * w + x];
      if (y - r >= 0) acc -= tmp[(y - r) * w + x];
    }
  }
}

/** Gaussian blur (three box passes; windows are normalised at the borders). Returns a new array. */
export function gaussBlur(src, w, h, sigma, scratch = null) {
  const out = new Float32Array(src.length);
  if (!(sigma > 0.3)) { out.set(src); return out; }
  const tmp = scratch?.a || new Float32Array(src.length); const mid = scratch?.b || new Float32Array(src.length);
  const [r0, r1, r2] = boxRadii(sigma);
  boxPass(src, out, w, h, r0, tmp); boxPass(out, mid, w, h, r1, tmp); boxPass(mid, out, w, h, r2, tmp);
  return out;
}

/* ------------------------------------------------------------------ geometry */

/**
 * Similarity from source pixels to the work frame: eyes level, face width FW, face centre at a fixed place.
 * @param {(i:number)=>[number,number]} pt landmark i in source pixels
 * @returns {number[]} canvas-style matrix [a,b,c,d,e,f]
 */
export function workMatrix(pt) {
  const mid = (i, j) => { const p = pt(i); const q = pt(j); return [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]; };
  const le = mid(33, 133); const re = mid(263, 362);
  const ang = Math.atan2(re[1] - le[1], re[0] - le[0]);
  const a = pt(234); const b = pt(454);
  const fw = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (!(fw > 1)) return null;
  const s = RELIGHT.FW / fw;
  const c = Math.cos(-ang) * s; const sn = Math.sin(-ang) * s;
  const cx = (a[0] + b[0]) / 2; const cy = (a[1] + b[1]) / 2;
  return [c, sn, -sn, c, RELIGHT.W / 2 - (c * cx - sn * cy), RELIGHT.H * 0.4 - (sn * cx + c * cy)];
}

function vertexNormals(P, Z) {
  const n = new Float32Array(NV * 3);
  for (let t = 0; t < NT; t += 1) {
    const i0 = MESH_TRI[t * 3]; const i1 = MESH_TRI[t * 3 + 1]; const i2 = MESH_TRI[t * 3 + 2];
    const ax = P[i1 * 2] - P[i0 * 2]; const ay = P[i1 * 2 + 1] - P[i0 * 2 + 1]; const az = Z[i1] - Z[i0];
    const bx = P[i2 * 2] - P[i0 * 2]; const by = P[i2 * 2 + 1] - P[i0 * 2 + 1]; const bz = Z[i2] - Z[i0];
    const nx = ay * bz - az * by; const ny = az * bx - ax * bz; const nz = ax * by - ay * bx;
    for (const i of [i0, i1, i2]) { n[i * 3] += nx; n[i * 3 + 1] += ny; n[i * 3 + 2] += nz; }
  }
  let sz = 0;
  for (let i = 0; i < NV; i += 1) {
    const l = Math.hypot(n[i * 3], n[i * 3 + 1], n[i * 3 + 2]) + 1e-9;
    n[i * 3] /= l; n[i * 3 + 1] /= l; n[i * 3 + 2] /= l; sz += n[i * 3 + 2];
  }
  // the camera looks along +z, so a surface that faces it has negative z: orient the mesh that way, then report nz > 0 = facing the camera
  const flip = sz > 0 ? -1 : 1;
  for (let i = 0; i < NV; i += 1) { n[i * 3] *= flip; n[i * 3 + 1] *= flip; n[i * 3 + 2] *= -flip; }
  return n;
}

/** Rasterise the mesh in the work frame with a depth buffer. attrs: K values per vertex. */
function rasterMesh(P, Z, attrs, K, W, H) {
  const n = W * H;
  const out = new Float32Array(n * K); const cov = new Float32Array(n); const zb = new Float32Array(n).fill(Infinity);
  let areaSum = 0;
  const area = new Float32Array(NT);
  for (let t = 0; t < NT; t += 1) {
    const i0 = MESH_TRI[t * 3] * 2; const i1 = MESH_TRI[t * 3 + 1] * 2; const i2 = MESH_TRI[t * 3 + 2] * 2;
    area[t] = (P[i1] - P[i0]) * (P[i2 + 1] - P[i0 + 1]) - (P[i1 + 1] - P[i0 + 1]) * (P[i2] - P[i0]);
    areaSum += area[t];
  }
  const front = areaSum >= 0 ? 1 : -1;
  for (let t = 0; t < NT; t += 1) {
    const ar = area[t];
    if (ar * front <= 1e-6) continue;
    const v0 = MESH_TRI[t * 3]; const v1 = MESH_TRI[t * 3 + 1]; const v2 = MESH_TRI[t * 3 + 2];
    const ax = P[v0 * 2]; const ay = P[v0 * 2 + 1]; const bx = P[v1 * 2]; const by = P[v1 * 2 + 1]; const cx = P[v2 * 2]; const cy = P[v2 * 2 + 1];
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))); const x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx, cx)));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy))); const y1 = Math.min(H - 1, Math.ceil(Math.max(ay, by, cy)));
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        const w0 = ((bx - x) * (cy - y) - (by - y) * (cx - x)) / ar;
        const w1 = ((cx - x) * (ay - y) - (cy - y) * (ax - x)) / ar;
        const w2 = 1 - w0 - w1;
        if (w0 < -1e-4 || w1 < -1e-4 || w2 < -1e-4) continue;
        const z = w0 * Z[v0] + w1 * Z[v1] + w2 * Z[v2];
        const j = y * W + x;
        if (!(z < zb[j])) continue;
        zb[j] = z; cov[j] = 1;
        for (let k = 0; k < K; k += 1) out[j * K + k] = w0 * attrs[v0 * K + k] + w1 * attrs[v1 * K + k] + w2 * attrs[v2 * K + k];
      }
    }
  }
  return { out, cov };
}

/** Coverage and smooth unit normals (nz > 0 faces the camera) of the mesh in the work frame. */
export function meshNormalMap(P, Z) {
  const { W, H } = RELIGHT; const n = W * H;
  const N = vertexNormals(P, Z);
  const { out, cov } = rasterMesh(P, Z, N, 3, W, H);
  const nx = new Float32Array(n); const ny = new Float32Array(n); const nz = new Float32Array(n);
  for (let j = 0; j < n; j += 1) { const l = Math.hypot(out[j * 3], out[j * 3 + 1], out[j * 3 + 2]) + 1e-9; nx[j] = out[j * 3] / l; ny[j] = out[j * 3 + 1] / l; nz[j] = out[j * 3 + 2] / l; }
  return { cov, nx, ny, nz };
}

function sampleBilinear(a, w, h, x, y) {
  const fx = x < 0 ? 0 : x > w - 1 ? w - 1 : x; const fy = y < 0 ? 0 : y > h - 1 ? h - 1 : y;
  const x0 = Math.floor(fx); const y0 = Math.floor(fy);
  const x1 = x0 + 1 < w ? x0 + 1 : x0; const y1 = y0 + 1 < h ? y0 + 1 : y0;
  const tx = fx - x0; const ty = fy - y0;
  const p = a[y0 * w + x0] * (1 - tx) + a[y0 * w + x1] * tx;
  const q = a[y1 * w + x0] * (1 - tx) + a[y1 * w + x1] * tx;
  return p * (1 - ty) + q * ty;
}

function quantile(sorted, q) {
  const pos = (sorted.length - 1) * q; const lo = Math.floor(pos); const hi = Math.min(sorted.length - 1, lo + 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function gauss1d(a, sigma) {
  const r = Math.max(1, Math.ceil(sigma * 3)); const k = new Float32Array(2 * r + 1); let ks = 0;
  for (let i = -r; i <= r; i += 1) { k[i + r] = Math.exp(-0.5 * (i / sigma) ** 2); ks += k[i + r]; }
  const out = new Float32Array(a.length);
  for (let y = 0; y < a.length; y += 1) {
    let s = 0;
    for (let i = -r; i <= r; i += 1) s += a[clamp(y + i, 0, a.length - 1)] * k[i + r];
    out[y] = s / ks;
  }
  return out;
}

/** Identity up to knee*top, then a smooth approach to top (a plain tanh would already bend small values). */
export function softCap(x, top, knee = 0.72) {
  const k = knee * top;
  return x <= k ? x : k + (top - k) * Math.tanh((x - k) / (top - k));
}

/**
 * Lateral light from the albedo-free mirror difference. Shading S(n) = max(eps, 1 + a·nx + b·up + c·nz);
 * D = log S(n_mirror) − log S(n). Grid search over a (side) and c (front); b (from above) is a fixed prior.
 * @param {{D:Float32Array, wt:Float32Array, n:Float32Array, nm:Float32Array, count:number}} s samples (normals as xyz triples)
 */
export function fitLight(s, b = 0.12, eps = 0.1) {
  const N = s.count;
  let wsum = 0; let e0 = 0;
  for (let i = 0; i < N; i += 1) { wsum += s.wt[i]; e0 += s.D[i] * s.D[i] * s.wt[i]; }
  if (!(wsum > 0)) return null;
  e0 /= wsum;
  const base = new Float32Array(N); const basem = new Float32Array(N);
  let best = { err: Infinity, a: 0, c: 0.7 };
  for (let ci = 0; ci < 13; ci += 1) {
    const c = 0.15 + ci * 0.1;
    for (let i = 0; i < N; i += 1) { base[i] = 1 - b * s.n[i * 3 + 1] + c * s.n[i * 3 + 2]; basem[i] = 1 - b * s.nm[i * 3 + 1] + c * s.nm[i * 3 + 2]; }
    for (let ai = 0; ai < 97; ai += 1) {
      const a = -2.4 + ai * 0.05;
      let err = 0;
      for (let i = 0; i < N; i += 1) {
        const S = Math.max(eps, base[i] + a * s.n[i * 3]); const Sm = Math.max(eps, basem[i] + a * s.nm[i * 3]);
        const e = Math.log(Sm / S) - s.D[i];
        err += e * e * s.wt[i];
      }
      err = err / wsum + 0.004 * (c - 0.7) * (c - 0.7);
      if (err < best.err) best = { err, a, c };
    }
  }
  return { a: best.a, c: best.c, err: best.err, err0: e0 };
}

/* ------------------------------------------------------------------ field */

/**
 * Compute the relight field in the work frame.
 * @param {object} inp
 * @param {Uint8ClampedArray|Uint8Array} inp.rgba work-frame pixels (W×H RGBA, sRGB)
 * @param {Float32Array} inp.skin @param {Float32Array} inp.hair @param {Float32Array} inp.clothes @param {Float32Array} inp.person class probabilities 0..1 in the work frame
 * @param {Float32Array} inp.P 468 vertex positions (x,y pairs) in work pixels @param {Float32Array} inp.Z 468 depths in work pixels (smaller = nearer)
 * @param {{alpha?:number, kc?:number, gmax?:number, kappa?:number, model?:boolean}} [opt]
 * @returns {{G:Float32Array, GC:Float32Array, K:Float32Array, report:object}} log-gain per pixel, per-channel colour part (RGB triples) and log detail gain
 */
export function computeRelight(inp, opt = {}) {
  const { W, H, FW } = RELIGHT; const n = W * H;
  const alpha = opt.alpha ?? 1; const kc = opt.kc ?? 0.9; const gmax = opt.gmax ?? 1.9; const kappa = opt.kappa ?? 0.85;
  const { rgba, skin, hair, clothes, person, P, Z } = inp;
  const scratch = { a: new Float32Array(n), b: new Float32Array(n) };
  const gb = (x, s) => gaussBlur(x, W, H, s, scratch);
  const lin = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  const Y = new Float32Array(n); const mxv = new Float32Array(n);
  for (let j = 0, i = 0; j < n; j += 1, i += 4) {
    const r = LIN[rgba[i]]; const g = LIN[rgba[i + 1]]; const b = LIN[rgba[i + 2]];
    lin[0][j] = r; lin[1][j] = g; lin[2][j] = b;
    Y[j] = 0.2126 * r + 0.7152 * g + 0.0722 * b; mxv[j] = Math.max(r, g, b);
  }
  const l = gb(Y, 1.5); for (let j = 0; j < n; j += 1) l[j] = Math.log(l[j] + 0.003);
  const mxc = gb(mxv, 1.5);
  // mesh: mirror position and normal of every face pixel
  const N = vertexNormals(P, Z);
  const attrs = new Float32Array(NV * 5);
  for (let i = 0; i < NV; i += 1) {
    const m = MESH_MIRROR[i];
    attrs[i * 5] = P[m * 2]; attrs[i * 5 + 1] = P[m * 2 + 1]; attrs[i * 5 + 2] = N[i * 3]; attrs[i * 5 + 3] = N[i * 3 + 1]; attrs[i * 5 + 4] = N[i * 3 + 2];
  }
  const { out: mp, cov } = rasterMesh(P, Z, attrs, 5, W, H);
  const covS = gb(cov, 0.015 * FW);
  const nrm = [0, 1, 2].map((k) => { const a = new Float32Array(n); for (let j = 0; j < n; j += 1) a[j] = mp[j * 5 + 2 + k]; return gb(a, 0.015 * FW); });
  for (let j = 0; j < n; j += 1) {
    const d = covS[j] + 1e-3; const x = nrm[0][j] / d; const y = nrm[1][j] / d; const z = nrm[2][j] / d;
    const len = Math.hypot(x, y, z) + 1e-6;
    nrm[0][j] = x / len; nrm[1][j] = y / len; nrm[2][j] = z / len;
  }
  const skS = new Float32Array(n); for (let j = 0; j < n; j += 1) skS[j] = clamp(skin[j], 0, 1);
  const lcs = lin.map((c) => { const a = gb(c, 2.0); for (let j = 0; j < n; j += 1) a[j] = Math.log(a[j] + 0.006); return a; });
  // crispness: energy of the fine detail (log-luminance minus its local mean). Compared with the mirror point it tells
  // how much softer (camera noise reduction in the dark, focus) or rougher (noise) the shadow side is than the lit side.
  const lf = new Float32Array(n); for (let j = 0; j < n; j += 1) lf[j] = Math.log(Y[j] + 0.003);
  const lfb = gb(lf, 2.5);
  for (let j = 0; j < n; j += 1) { const h = lf[j] - lfb[j]; lf[j] = h * h; }
  const E = gb(lf, 0.03 * FW);
  const dk = new Float32Array(n);
  const w = new Float32Array(n); const d = new Float32Array(n); const dist = new Float32Array(n).fill(1e6);
  const nrmm = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  const dch = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const j = y * W + x;
      if (!cov[j]) continue;
      const mx = mp[j * 5]; const my = mp[j * 5 + 1];
      dist[j] = Math.hypot(mx - x, my - y);
      const nzm = sampleBilinear(nrm[2], W, H, mx, my);
      nrmm[0][j] = sampleBilinear(nrm[0], W, H, mx, my); nrmm[1][j] = sampleBilinear(nrm[1], W, H, mx, my); nrmm[2][j] = nzm;
      const clipv = smooth(0.985, 0.93, Math.max(mxc[j], sampleBilinear(mxc, W, H, mx, my))); // blown highlights say nothing
      const vis = smooth(0.12, 0.35, nrm[2][j]) * smooth(0.12, 0.35, nzm);
      w[j] = sampleBilinear(cov, W, H, mx, my) * smooth(0.3, 0.7, skS[j]) * smooth(0.3, 0.7, sampleBilinear(skS, W, H, mx, my)) * vis * (0.15 + 0.85 * clipv);
      const dl = sampleBilinear(l, W, H, mx, my) - l[j];
      d[j] = clamp(dl, -2.2, 2.2);
      for (let c = 0; c < 3; c += 1) dch[c][j] = clamp(sampleBilinear(lcs[c], W, H, mx, my) - lcs[c][j], -2.5, 2.5) - d[j];
      dk[j] = clamp(0.5 * Math.log((sampleBilinear(E, W, H, mx, my) + 1e-4) / (E[j] + 1e-4)), -0.5, 0.7); // log ratio of detail amplitude
    }
  }
  // the mirror correspondence is exact at the midline and loosens with distance, so the smoothing can be fine
  // near the nose (where the light changes abruptly) and coarse on the cheeks
  const wd = new Float32Array(n); for (let j = 0; j < n; j += 1) wd[j] = w[j] * d[j];
  const ncf = (sg) => { const ws = gb(w, sg); const v = gb(wd, sg); for (let j = 0; j < n; j += 1) v[j] /= ws[j] + 1e-3; return [v, ws]; };
  const s = 0.045 * FW;
  const [Df, wf] = ncf(0.014 * FW); const [Dm, wm] = ncf(0.028 * FW); const [Dc, wsum] = ncf(s);
  let D = new Float32Array(n);
  for (let j = 0; j < n; j += 1) {
    const t1 = smooth(0.03 * FW, 0.16 * FW, dist[j]); const t2 = smooth(0.16 * FW, 0.42 * FW, dist[j]);
    const cf = smooth(0.05, 0.3, wf[j]); const cm = smooth(0.05, 0.3, wm[j]);
    const Dmid = cm * Dm[j] + (1 - cm) * Dc[j]; const Dfine = cf * Df[j] + (1 - cf) * Dmid;
    D[j] = (1 - t1) * Dfine + t1 * ((1 - t2) * Dmid + t2 * Dc[j]);
  }
  D = gb(D, 0.008 * FW);
  const conf = new Float32Array(n); for (let j = 0; j < n; j += 1) conf[j] = smooth(0.02, 0.25, wsum[j]) * cov[j];
  // balance: each side moves half of the difference (D/2), plus a common lift Gs. Away from the midline Gs = |D|/2,
  // which leaves the lit side as it is and brings the shadow side up to it. At the midline D is 0 by construction
  // even when the centre of the face is in shadow, so there Gs comes from a fitted light (what a frontal light
  // would add), limited by the lift of the cheeks at the same height.
  let Gs = new Float32Array(n); for (let j = 0; j < n; j += 1) Gs[j] = Math.abs(D[j]) * 0.5;
  let fit = null;
  if (opt.model !== false) {
    let count = 0;
    for (let y = 1; y < H; y += 2) for (let x = 1; x < W; x += 2) if (conf[y * W + x] > 0.6) count += 1;
    if (count > 200) {
      const stride = Math.max(1, Math.ceil(count / 4000));
      const m = Math.ceil(count / stride);
      const smp = { D: new Float32Array(m), wt: new Float32Array(m), n: new Float32Array(m * 3), nm: new Float32Array(m * 3), count: 0 };
      let k = 0;
      for (let y = 1; y < H; y += 2) {
        for (let x = 1; x < W; x += 2) {
          const j = y * W + x;
          if (!(conf[j] > 0.6)) continue;
          if (k % stride === 0) {
            const q = smp.count; smp.D[q] = D[j]; smp.wt[q] = conf[j];
            for (let c = 0; c < 3; c += 1) { smp.n[q * 3 + c] = nrm[c][j]; smp.nm[q * 3 + c] = nrmm[c][j]; }
            smp.count += 1;
          }
          k += 1;
        }
      }
      fit = fitLight(smp);
    }
    if (fit) {
      const b = 0.12; const eps = 0.1; const lt = Math.hypot(fit.a, fit.c);
      const trust = clamp((1 - fit.err / Math.max(fit.err0, 1e-4)) / 0.5, 0, 1); // how much of the difference the light explains
      const plateau = new Float32Array(H); const buf = [];
      for (let y = 0; y < H; y += 1) {
        buf.length = 0;
        for (let x = 0; x < W; x += 1) { const j = y * W + x; if (conf[j] > 0.5) buf.push(Gs[j]); }
        if (buf.length > 8) { buf.sort((p, q) => p - q); plateau[y] = quantile(buf, 0.75); }
      }
      const pl = gauss1d(plateau, 0.05 * FW);
      const G2 = new Float32Array(n);
      for (let y = 0; y < H; y += 1) {
        for (let x = 0; x < W; x += 1) {
          const j = y * W + x;
          const S = (nx, ny, nz) => Math.max(eps, 1 + fit.a * nx - b * ny + fit.c * nz);
          const St = (ny, nz) => Math.max(eps, 1 - b * ny + lt * nz);
          const Gm = 0.5 * (Math.log(St(nrm[1][j], nrm[2][j])) + Math.log(St(nrmm[1][j], nrmm[2][j])) - Math.log(S(nrm[0][j], nrm[1][j], nrm[2][j])) - Math.log(S(nrmm[0][j], nrmm[1][j], nrmm[2][j])));
          G2[j] = Math.max(Gs[j], Math.min(Gm * trust, kappa * pl[y]));
        }
      }
      Gs = gb(G2, 0.012 * FW);
    }
  }
  const gl = new Float32Array(n); for (let j = 0; j < n; j += 1) gl[j] = softCap(alpha * (0.5 * D[j] + Gs[j]), gmax);
  // continue a field known inside the mesh to everywhere (coarse-to-fine normalised convolution)
  const ncExtend = (val, sigmas) => {
    const iv = new Float32Array(n); for (let j = 0; j < n; j += 1) iv[j] = conf[j] * val[j];
    let res = null;
    for (const sg of sigmas.slice().sort((p, q) => q - p)) {
      const ws = gb(conf, sg); const e = gb(iv, sg);
      for (let j = 0; j < n; j += 1) { const v = e[j] / (ws[j] + 1e-4); const c = smooth(0.02, 0.35, ws[j]); e[j] = res ? c * v + (1 - c) * res[j] : v; }
      res = e;
    }
    for (let j = 0; j < n; j += 1) res[j] = conf[j] * val[j] + (1 - conf[j]) * res[j];
    return res;
  };
  // beyond the mesh (forehead edge, ears, neck, hair of the same side) the field continues, fading with distance
  const field = ncExtend(gl, [0.02 * FW, 0.05 * FW, 0.11 * FW, 0.24 * FW]);
  const fade = gb(conf, 0.3 * FW); for (let j = 0; j < n; j += 1) fade[j] = smooth(0, 0.1, fade[j]);
  let region = new Float32Array(n);
  for (let j = 0; j < n; j += 1) region[j] = clamp(skS[j] + 0.75 * hair[j] + 0.25 * clothes[j], 0, 1) * person[j];
  region = gb(region, 0.01 * FW);
  let G = new Float32Array(n); for (let j = 0; j < n; j += 1) G[j] = field[j] * fade[j] * region[j];
  G = gb(G, 0.012 * FW);
  // colour: the same comparison per channel. The part of each channel's difference that is not the common light
  // difference is a colour cast of the shadow side (warm fill light, redder skin in shadow); it is removed as a
  // per-channel gain, so dark details (stubble, brows) stay neutral instead of being tinted.
  const sc2 = s * 1.6; const w2 = gb(w, sc2);
  const cast = dch.map((dc) => {
    const a = new Float32Array(n); for (let j = 0; j < n; j += 1) a[j] = w[j] * dc[j];
    const v = gb(a, sc2); for (let j = 0; j < n; j += 1) v[j] = clamp(v[j] / (w2[j] + 1e-3), -0.5, 0.5);
    return ncExtend(v, [0.03 * FW, 0.08 * FW, 0.2 * FW]);
  });
  const Dpos = new Float32Array(n); for (let j = 0; j < n; j += 1) Dpos[j] = Math.max(D[j], 0);
  const shade = ncExtend(Dpos, [0.03 * FW, 0.08 * FW, 0.2 * FW]); // the shadow side only
  const GC = new Float32Array(n * 3);
  const chan = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  for (let j = 0; j < n; j += 1) {
    const mean = 0.2126 * cast[0][j] + 0.7152 * cast[1][j] + 0.0722 * cast[2][j]; // no net luminance change
    const k = smooth(0.05, 0.4, shade[j]) * fade[j] * smooth(0.2, 0.6, skS[j]) * kc;
    for (let c = 0; c < 3; c += 1) chan[c][j] = (cast[c][j] - mean) * k;
  }
  for (let c = 0; c < 3; c += 1) { const v = gb(chan[c], 0.012 * FW); for (let j = 0; j < n; j += 1) GC[j * 3 + c] = v[j]; }
  // detail gain of the lifted side: its fine detail is brought to the crispness of the lit side (never applied to the lit side)
  const wk = new Float32Array(n); for (let j = 0; j < n; j += 1) wk[j] = w[j] * dk[j];
  const kv = gb(wk, s); for (let j = 0; j < n; j += 1) kv[j] /= wsum[j] + 1e-3;
  const kext = ncExtend(kv, [0.03 * FW, 0.08 * FW, 0.2 * FW]);
  let K = new Float32Array(n);
  for (let j = 0; j < n; j += 1) K[j] = kext[j] * smooth(0.05, 0.4, shade[j]) * fade[j] * smooth(0.2, 0.6, skS[j]);
  K = gb(K, 0.012 * FW);
  // report
  const absD = []; let gMax = 0;
  for (let j = 0; j < n; j += 1) { if (conf[j] > 0.5) absD.push(Math.abs(D[j])); if (G[j] > gMax) gMax = G[j]; }
  absD.sort((p, q) => p - q);
  const report = { sideDiff: absD.length ? quantile(absD, 0.75) : 0, gainMax: Math.exp(gMax), facePixels: absD.length };
  if (fit) Object.assign(report, { lightA: fit.a, lightC: fit.c, fitGain: 1 - fit.err / Math.max(fit.err0, 1e-4) });
  return { G, GC, K, report };
}

/**
 * Pack a field to PW×PH×4 bytes: gain, colour part of red and of blue (green follows: the colour part carries no
 * luminance), detail gain. 2×2 means, 8 bits each; the field is smooth, so this loses nothing visible.
 */
export function packRelight(field) {
  const { W, PW, PH, G_MIN, G_SPAN, C_SPAN, K_MIN, K_SPAN } = RELIGHT;
  const out = new Uint8Array(PW * PH * 4);
  for (let y = 0; y < PH; y += 1) {
    for (let x = 0; x < PW; x += 1) {
      const j0 = y * 2 * W + x * 2; const idx = [j0, j0 + 1, j0 + W, j0 + W + 1];
      let g = 0; let cr = 0; let cb = 0; let k = 0;
      for (const j of idx) { g += field.G[j]; cr += field.GC[j * 3]; cb += field.GC[j * 3 + 2]; k += field.K ? field.K[j] : 0; }
      const o = (y * PW + x) * 4;
      out[o] = Math.round(clamp((g / 4 - G_MIN) / G_SPAN, 0, 1) * 255);
      out[o + 1] = Math.round(clamp(cr / 4 / C_SPAN + 0.5, 0, 1) * 255);
      out[o + 2] = Math.round(clamp(cb / 4 / C_SPAN + 0.5, 0, 1) * 255);
      out[o + 3] = Math.round(clamp((k / 4 - K_MIN) / K_SPAN, 0, 1) * 255);
    }
  }
  return out;
}

/** True when a packed field changes nothing anywhere (all gains ≈ 0). */
export function relightIsNeutral(packed) {
  const { G_MIN, G_SPAN } = RELIGHT; const zero = Math.round((-G_MIN / G_SPAN) * 255);
  for (let i = 0; i < packed.length; i += 4) if (Math.abs(packed[i] - zero) > 2) return false;
  return true;
}

function unboundedGuided(I, p, w, h, r, eps) {
  const n = w * h; const Ip = new Float32Array(n); const II = new Float32Array(n);
  for (let i = 0; i < n; i += 1) { Ip[i] = I[i] * p[i]; II[i] = I[i] * I[i]; }
  const mI = boxFilter(I, w, h, r); const mp = boxFilter(p, w, h, r); const mIp = boxFilter(Ip, w, h, r); const mII = boxFilter(II, w, h, r);
  const a = new Float32Array(n); const b = new Float32Array(n);
  for (let i = 0; i < n; i += 1) { a[i] = (mIp[i] - mI[i] * mp[i]) / (mII[i] - mI[i] * mI[i] + eps); b[i] = mp[i] - a[i] * mI[i]; }
  const ma = boxFilter(a, w, h, r); const mb = boxFilter(b, w, h, r);
  const q = new Float32Array(n); for (let i = 0; i < n; i += 1) q[i] = ma[i] * I[i] + mb[i];
  return q;
}

/**
 * Apply a packed relight field to output pixels, in place.
 * The fine detail of the lifted side is scaled by the field's detail gain, so it ends as crisp as the lit side (softer
 * shadows are sharpened, noisier ones calmed). Colour noise of a strongly lifted area (JPEG blocks) is smoothed along
 * the picture's own edges; luminance detail is never blurred.
 * @param {Uint8ClampedArray} data RGBA output pixels @param {number} w @param {number} h
 * @param {Uint8Array} packed from packRelight
 * @param {number[]} T canvas-style matrix from output pixels to work-frame pixels
 * @param {{strength?:number, eta?:number}} [opt]
 * @returns {{applied:boolean, maxGain:number, liftedFrac:number}}
 */
export function applyRelight(data, w, h, packed, T, opt = {}) {
  const { W, H, FW, PW, PH, G_MIN, G_SPAN, C_SPAN, K_MIN, K_SPAN } = RELIGHT;
  const strength = clamp(opt.strength ?? 1, 0, 1); const eta = opt.eta ?? 0;
  if (!(strength > 0) || !packed) return { applied: false, maxGain: 1, liftedFrac: 0 };
  // bounding box of the work frame in the output
  const det = T[0] * T[3] - T[1] * T[2];
  if (!(Math.abs(det) > 1e-12)) return { applied: false, maxGain: 1, liftedFrac: 0 };
  const inv = [T[3] / det, -T[1] / det, -T[2] / det, T[0] / det, (T[2] * T[5] - T[3] * T[4]) / det, (T[1] * T[4] - T[0] * T[5]) / det];
  let bx0 = Infinity; let by0 = Infinity; let bx1 = -Infinity; let by1 = -Infinity;
  for (const [x, y] of [[0, 0], [W, 0], [W, H], [0, H]]) {
    const ox = inv[0] * x + inv[2] * y + inv[4]; const oy = inv[1] * x + inv[3] * y + inv[5];
    bx0 = Math.min(bx0, ox); bx1 = Math.max(bx1, ox); by0 = Math.min(by0, oy); by1 = Math.max(by1, oy);
  }
  const x0 = Math.max(0, Math.floor(bx0)); const y0 = Math.max(0, Math.floor(by0)); const x1 = Math.min(w, Math.ceil(bx1)); const y1 = Math.min(h, Math.ceil(by1));
  const bw = x1 - x0; const bh = y1 - y0;
  if (bw < 2 || bh < 2) return { applied: false, maxGain: 1, liftedFrac: 0 };
  const n = bw * bh;
  const G = new Float32Array(n); const GC = [new Float32Array(n), new Float32Array(n), new Float32Array(n)]; const KD = new Float32Array(n);
  const kx = PW / W; const ky = PH / H;
  let gMax = 0; let any = false; let lifted = 0;
  for (let y = 0; y < bh; y += 1) {
    for (let x = 0; x < bw; x += 1) {
      const ox = x0 + x + 0.5; const oy = y0 + y + 0.5;
      const wx = (T[0] * ox + T[2] * oy + T[4]) * kx - 0.5; const wy = (T[1] * ox + T[3] * oy + T[5]) * ky - 0.5;
      if (wx < -0.5 || wy < -0.5 || wx > PW - 0.5 || wy > PH - 0.5) continue;
      const fx = clamp(wx, 0, PW - 1); const fy = clamp(wy, 0, PH - 1);
      const xa = Math.floor(fx); const ya = Math.floor(fy); const xb = Math.min(PW - 1, xa + 1); const yb = Math.min(PH - 1, ya + 1);
      const tx = fx - xa; const ty = fy - ya;
      const i00 = (ya * PW + xa) * 4; const i01 = (ya * PW + xb) * 4; const i10 = (yb * PW + xa) * 4; const i11 = (yb * PW + xb) * 4;
      const j = y * bw + x;
      const smp = (k) => (packed[i00 + k] * (1 - tx) + packed[i01 + k] * tx) * (1 - ty) + (packed[i10 + k] * (1 - tx) + packed[i11 + k] * tx) * ty;
      const g = ((smp(0) / 255) * G_SPAN + G_MIN) * strength;
      G[j] = Math.abs(g) < 0.006 ? 0 : g; // below the 8-bit step of the packed field
      const cr = (smp(1) / 255 - 0.5) * C_SPAN * strength; const cb = (smp(2) / 255 - 0.5) * C_SPAN * strength;
      GC[0][j] = Math.abs(cr) < 0.003 ? 0 : cr; GC[2][j] = Math.abs(cb) < 0.003 ? 0 : cb;
      GC[1][j] = -(0.2126 * GC[0][j] + 0.0722 * GC[2][j]) / 0.7152;
      const kd = ((smp(3) / 255) * K_SPAN + K_MIN) * strength; KD[j] = Math.abs(kd) < 0.004 ? 0 : kd;
      if (G[j] !== 0 || GC[0][j] !== 0 || GC[2][j] !== 0) any = true;
      if (G[j] > gMax) gMax = G[j];
      if (G[j] > 0.1) lifted += 1;
    }
  }
  if (!any) return { applied: false, maxGain: 1, liftedFrac: 0 };
  const sc = Math.hypot(T[0], T[1]); // work pixels per output pixel
  const sig = Math.max(1, (0.014 * FW) / sc);
  const scratch = { a: new Float32Array(n), b: new Float32Array(n) };
  const lg = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  for (let y = 0; y < bh; y += 1) {
    for (let x = 0; x < bw; x += 1) {
      const j = y * bw + x; const i = ((y0 + y) * w + x0 + x) * 4;
      lg[0][j] = Math.log(LIN[data[i]] + 0.004); lg[1][j] = Math.log(LIN[data[i + 1]] + 0.004); lg[2][j] = Math.log(LIN[data[i + 2]] + 0.004);
    }
  }
  const out = lg.map((ch, c) => {
    const base = gaussBlur(ch, bw, bh, sig, scratch);
    for (let j = 0; j < n; j += 1) base[j] = base[j] + G[j] + GC[c][j] + (ch[j] - base[j]) * Math.exp(KD[j]) * (1 - eta * smooth(0.1, 0.9, G[j]));
    return base;
  });
  if (gMax > 0.25) {
    const Yl = new Float32Array(n); for (let j = 0; j < n; j += 1) Yl[j] = 0.2126 * out[0][j] + 0.7152 * out[1][j] + 0.0722 * out[2][j];
    const r = Math.max(2, Math.round(sig * 2.2));
    for (const c of [0, 2]) {
      const ch = new Float32Array(n); for (let j = 0; j < n; j += 1) ch[j] = out[c][j] - out[1][j]; // colour as log ratios to green
      const sm = unboundedGuided(Yl, ch, bw, bh, r, 0.02);
      for (let j = 0; j < n; j += 1) { const k = smooth(0.25, 0.9, G[j]); if (k > 0) out[c][j] += (sm[j] - ch[j]) * k; }
    }
  }
  for (let y = 0; y < bh; y += 1) {
    for (let x = 0; x < bw; x += 1) {
      const j = y * bw + x;
      if (G[j] === 0 && GC[0][j] === 0 && GC[1][j] === 0 && GC[2][j] === 0) continue;
      const i = ((y0 + y) * w + x0 + x) * 4;
      for (let c = 0; c < 3; c += 1) data[i + c] = SRGB[Math.round(clamp(Math.exp(out[c][j]) - 0.004, 0, 1) * SRGB_N)];
    }
  }
  return { applied: true, maxGain: Math.exp(gMax), liftedFrac: lifted / n };
}
