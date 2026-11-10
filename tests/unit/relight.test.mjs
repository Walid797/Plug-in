import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MESH_TRI, MESH_MIRROR } from '../../src/core/facemesh.js';
import { RELIGHT, computeRelight, applyRelight, packRelight, relightIsNeutral, workMatrix, softCap, gaussBlur, meshNormalMap, fitLight } from '../../src/core/relight.js';

const { W, H, FW } = RELIGHT; const n = W * H;
const canon = JSON.parse(readFileSync(new URL('../fixtures/canonical-face.json', import.meta.url))).xyz;
const toSrgb = (v) => Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055));
const toLin = (v) => { const x = v / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };

/** The canonical face placed upright in the work frame (face width FW), as the app's work matrix would place it. */
function canonicalMesh() {
  const P = new Float32Array(468 * 2); const Z = new Float32Array(468);
  const width = Math.hypot(canon[454 * 3] - canon[234 * 3], canon[454 * 3 + 1] - canon[234 * 3 + 1]);
  const k = FW / width; const my = (canon[234 * 3 + 1] + canon[454 * 3 + 1]) / 2;
  for (let i = 0; i < 468; i += 1) {
    P[i * 2] = W / 2 + canon[i * 3] * k; P[i * 2 + 1] = H * 0.4 - (canon[i * 3 + 1] - my) * k;
    Z[i] = -canon[i * 3 + 2] * k; // nearer = smaller
  }
  return { P, Z };
}

/**
 * A synthetic portrait in the work frame: uniform skin on the mesh, shaded by a light with side component `a`
 * (S = max(0.1, 1 + a·nx − 0.12·ny + 0.5·nz)), on a grey background. `texture(j, shadowSide)` scales fine detail.
 */
function synthFace(a, { texture = null, tint = null } = {}) {
  const { P, Z } = canonicalMesh();
  const m = meshNormalMap(P, Z);
  const rgba = new Uint8ClampedArray(n * 4); const skin = new Float32Array(n); const person = new Float32Array(n);
  let smax = 0; const S = new Float32Array(n);
  for (let j = 0; j < n; j += 1) if (m.cov[j]) { S[j] = Math.max(0.1, 1 + a * m.nx[j] - 0.12 * m.ny[j] + 0.5 * m.nz[j]); smax = Math.max(smax, S[j]); }
  for (let j = 0; j < n; j += 1) {
    const i = j * 4; rgba[i + 3] = 255;
    if (!m.cov[j]) { rgba[i] = 128; rgba[i + 1] = 128; rgba[i + 2] = 128; continue; }
    skin[j] = 1; person[j] = 1;
    let s = (S[j] / smax) * 0.85;
    const shadowSide = Math.sign(a) * m.nx[j] < 0;
    if (texture) s *= texture(j, shadowSide);
    const t = tint && shadowSide ? tint : [1, 1, 1];
    rgba[i] = toSrgb(Math.min(1, 0.80 * s * t[0])); rgba[i + 1] = toSrgb(Math.min(1, 0.55 * s * t[1])); rgba[i + 2] = toSrgb(Math.min(1, 0.45 * s * t[2]));
  }
  return { inp: { rgba, skin, hair: new Float32Array(n), clothes: new Float32Array(n), person, P, Z }, m };
}

function sideMeans(rgba, m) {
  let l = 0; let ln = 0; let r = 0; let rn = 0;
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const j = y * W + x;
      if (!m.cov[j] || m.nz[j] < 0.5 || Math.abs(x - W / 2) < 0.12 * FW) continue; // the two cheeks, away from the midline and the rim
      const Y = 0.2126 * toLin(rgba[j * 4]) + 0.7152 * toLin(rgba[j * 4 + 1]) + 0.0722 * toLin(rgba[j * 4 + 2]);
      if (x < W / 2) { l += Y; ln += 1; } else { r += Y; rn += 1; }
    }
  }
  return [l / ln, r / rn];
}

test('face mesh topology: 898 triangles, an exact mirror map that keeps every triangle', () => {
  assert.equal(MESH_TRI.length, 898 * 3);
  assert.equal(MESH_MIRROR.length, 468);
  let self = 0;
  for (let i = 0; i < 468; i += 1) { assert.equal(MESH_MIRROR[MESH_MIRROR[i]], i, `mirror is an involution at ${i}`); if (MESH_MIRROR[i] === i) self += 1; }
  assert.equal(self, 28, 'midline vertices map to themselves');
  const key = (a, b, c) => [a, b, c].sort((p, q) => p - q).join(',');
  const tris = new Set();
  for (let t = 0; t < 898; t += 1) { for (let k = 0; k < 3; k += 1) assert.ok(MESH_TRI[t * 3 + k] < 468); tris.add(key(MESH_TRI[t * 3], MESH_TRI[t * 3 + 1], MESH_TRI[t * 3 + 2])); }
  for (let t = 0; t < 898; t += 1) assert.ok(tris.has(key(MESH_MIRROR[MESH_TRI[t * 3]], MESH_MIRROR[MESH_TRI[t * 3 + 1]], MESH_MIRROR[MESH_TRI[t * 3 + 2]])), `mirrored triangle ${t} exists`);
  // the canonical model itself is symmetric: mirroring x maps each vertex onto its mirror vertex
  for (let i = 0; i < 468; i += 1) { const m = MESH_MIRROR[i]; assert.ok(Math.abs(canon[i * 3] + canon[m * 3]) < 1e-3 && Math.abs(canon[i * 3 + 1] - canon[m * 3 + 1]) < 1e-3); }
});

test('work matrix: eyes level, face width FW, face centre at its fixed place', () => {
  // a face tilted by 20° and scaled in a 2000×1500 source
  const ang = (20 * Math.PI) / 180; const k = 37;
  const src = (i) => { const x = canon[i * 3] * k; const y = -canon[i * 3 + 1] * k; return [1000 + x * Math.cos(ang) - y * Math.sin(ang), 700 + x * Math.sin(ang) + y * Math.cos(ang)]; };
  const M = workMatrix(src);
  const map = (p) => [M[0] * p[0] + M[2] * p[1] + M[4], M[1] * p[0] + M[3] * p[1] + M[5]];
  const a = map(src(234)); const b = map(src(454));
  assert.ok(Math.abs(Math.hypot(b[0] - a[0], b[1] - a[1]) - FW) < 1e-3, 'face width');
  assert.ok(Math.abs((a[0] + b[0]) / 2 - W / 2) < 1e-3 && Math.abs((a[1] + b[1]) / 2 - H * 0.4) < 1e-3, 'centre');
  const le = map(src(33)); const re = map(src(263));
  assert.ok(Math.abs(re[1] - le[1]) < 0.02 * FW && re[0] > le[0], 'eye line is level, left eye of the picture on the left');
  assert.equal(workMatrix(() => [5, 5]), null, 'degenerate landmarks give no matrix');
});

test('soft cap and blur helpers', () => {
  for (const x of [-1, 0, 0.5, 1.3]) assert.equal(softCap(x, 1.9), x, 'identity below the knee');
  let prev = -Infinity;
  for (let x = 0; x < 6; x += 0.05) { const v = softCap(x, 1.9); assert.ok(v >= prev && v <= 1.9 + 1e-9); prev = v; }
  const a = new Float32Array(64 * 64).fill(0.37);
  for (const v of gaussBlur(a, 64, 64, 5)) assert.ok(Math.abs(v - 0.37) < 1e-6, 'a constant stays constant (borders normalised)');
  const imp = new Float32Array(65 * 65); imp[32 * 65 + 32] = 1;
  const g = gaussBlur(imp, 65, 65, 4); let sum = 0; let var_ = 0;
  for (let y = 0; y < 65; y += 1) for (let x = 0; x < 65; x += 1) { sum += g[y * 65 + x]; var_ += g[y * 65 + x] * (x - 32) ** 2; }
  assert.ok(Math.abs(sum - 1) < 1e-4, 'mass kept');
  assert.ok(Math.abs(Math.sqrt(var_) - 4) < 0.4, `three box passes give sigma ≈ 4 (${Math.sqrt(var_).toFixed(2)})`);
});

test('one-sided light: the direction is found, the shadow side is lifted to the lit side, the lit side stays', () => {
  for (const a of [0.8, -0.8]) {
    const { inp, m } = synthFace(a);
    const [l0, r0] = sideMeans(inp.rgba, m);
    const lit0 = Math.max(l0, r0); const dark0 = Math.min(l0, r0);
    assert.ok(lit0 / dark0 > 1.8, `synthetic face is clearly one-sided (${(lit0 / dark0).toFixed(2)})`);
    assert.equal(a > 0 ? r0 > l0 : l0 > r0, true, 'the side the light comes from is the bright one');
    const f = computeRelight(inp);
    assert.ok(Math.sign(f.report.lightA) === Math.sign(a) && Math.abs(f.report.lightA - a) < 0.3, `fitted side light ${f.report.lightA} ≈ ${a}`);
    assert.ok(f.report.fitGain > 0.8, 'the light explains the difference');
    assert.ok(f.report.sideDiff > 0.5);
    const out = new Uint8ClampedArray(inp.rgba);
    const r = applyRelight(out, W, H, packRelight(f), [1, 0, 0, 1, 0, 0]);
    assert.equal(r.applied, true);
    const [l1, r1] = sideMeans(out, m);
    const ratio = Math.max(l1, r1) / Math.min(l1, r1);
    assert.ok(ratio < 1.12, `after relight the two cheeks agree within 12 % (${ratio.toFixed(3)})`);
    const lit1 = a > 0 ? r1 : l1;
    assert.ok(Math.abs(lit1 / lit0 - 1) < 0.08, `the lit side keeps its level (${(lit1 / lit0).toFixed(3)})`);
    // nothing outside the person changes
    for (const j of [0, W - 1, n - 1, (H - 1) * W]) for (let c = 0; c < 3; c += 1) assert.equal(out[j * 4 + c], inp.rgba[j * 4 + c]);
    // half strength moves half-way (in log terms): still clearly less balanced than full strength
    const half = new Uint8ClampedArray(inp.rgba);
    applyRelight(half, W, H, packRelight(f), [1, 0, 0, 1, 0, 0], { strength: 0.5 });
    const [lh, rh] = sideMeans(half, m);
    const rHalf = Math.max(lh, rh) / Math.min(lh, rh);
    assert.ok(rHalf > ratio + 0.15 && rHalf < lit0 / dark0 - 0.15, `strength 0.5 is in between (${rHalf.toFixed(2)})`);
  }
});

test('an evenly lit face is left alone', () => {
  const { inp, m } = synthFace(0);
  const f = computeRelight(inp);
  let gmax = 0; for (let j = 0; j < n; j += 1) gmax = Math.max(gmax, Math.abs(f.G[j]));
  assert.ok(gmax < 0.04, `no gain on a symmetric face (${gmax.toFixed(3)})`);
  assert.ok(f.report.sideDiff < 0.03);
  const packed = packRelight(f);
  assert.equal(relightIsNeutral(packed), true);
  const out = new Uint8ClampedArray(inp.rgba);
  applyRelight(out, W, H, packed, [1, 0, 0, 1, 0, 0]);
  let maxDiff = 0; for (let i = 0; i < out.length; i += 1) maxDiff = Math.max(maxDiff, Math.abs(out[i] - inp.rgba[i]));
  assert.ok(maxDiff <= 2, `pixels unchanged (max difference ${maxDiff})`);
  const [l, r] = sideMeans(out, m); assert.ok(Math.abs(l / r - 1) < 0.02);
});

test('colour cast of the shadow side is removed without changing its brightness balance', () => {
  // the shadow side is warmer (more red, less blue), like a warm fill light
  const { inp, m } = synthFace(0.8, { tint: [1.25, 1.0, 0.7] });
  const f = computeRelight(inp);
  const out = new Uint8ClampedArray(inp.rgba);
  applyRelight(out, W, H, packRelight(f), [1, 0, 0, 1, 0, 0]);
  const rb = (px) => { let l = 0; let ln = 0; let r = 0; let rn = 0;
    for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) { const j = y * W + x; if (!m.cov[j] || m.nz[j] < 0.5 || Math.abs(x - W / 2) < 0.12 * FW) continue; const v = Math.log(toLin(px[j * 4]) + 1e-3) - Math.log(toLin(px[j * 4 + 2]) + 1e-3); if (x < W / 2) { l += v; ln += 1; } else { r += v; rn += 1; } }
    return Math.abs(l / ln - r / rn); };
  const before = rb(inp.rgba); const after = rb(out);
  assert.ok(before > 0.4, `the two sides differ in red/blue before (${before.toFixed(2)})`);
  assert.ok(after < before * 0.4, `and much less after (${after.toFixed(2)})`);
});

test('detail of the lifted side is brought to the crispness of the lit side, never blurred', () => {
  // fine texture: full strength on the lit side, a third of it on the shadow side (as after noise reduction in the dark)
  const tex = (j, shadow) => { const x = j % W; const y = (j / W) | 0; const t = ((x + y) % 4 < 2 ? 1 : -1) * 0.12; return 1 + t * (shadow ? 0.33 : 1); };
  const { inp, m } = synthFace(0.8, { texture: tex });
  const f = computeRelight(inp);
  let kShadow = 0; let ns = 0; let kLit = 0; let nl = 0;
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) { const j = y * W + x; if (!m.cov[j] || m.nz[j] < 0.6 || Math.abs(x - W / 2) < 0.15 * FW) continue; if (x < W / 2) { kShadow += f.K[j]; ns += 1; } else { kLit += f.K[j]; nl += 1; } }
  assert.ok(kShadow / ns > 0.3, `the soft shadow side gets a detail gain above 1 (log ${(kShadow / ns).toFixed(2)})`);
  assert.ok(Math.abs(kLit / nl) < 0.02, 'the lit side gets none');
  const energy = (px) => { const out = [0, 0]; const cnt = [0, 0];
    for (let y = 1; y < H - 1; y += 1) for (let x = 1; x < W - 1; x += 1) { const j = y * W + x; if (!m.cov[j] || m.nz[j] < 0.6 || Math.abs(x - W / 2) < 0.15 * FW) continue; const v = Math.log(px[j * 4 + 1] + 1) - 0.25 * (Math.log(px[j * 4 + 1 - 4] + 1) + Math.log(px[j * 4 + 1 + 4] + 1) + Math.log(px[(j - W) * 4 + 1] + 1) + Math.log(px[(j + W) * 4 + 1] + 1)); const s = x < W / 2 ? 0 : 1; out[s] += v * v; cnt[s] += 1; }
    return [Math.sqrt(out[0] / cnt[0]), Math.sqrt(out[1] / cnt[1])]; };
  const out = new Uint8ClampedArray(inp.rgba);
  applyRelight(out, W, H, packRelight(f), [1, 0, 0, 1, 0, 0]);
  const [s0, l0] = energy(inp.rgba); const [s1, l1] = energy(out);
  assert.ok(s1 > s0 * 1.25, `shadow-side detail is stronger after relight, not weaker (${s0.toFixed(4)} → ${s1.toFixed(4)})`);
  assert.ok(s1 / l1 > (s0 / l0) * 1.25 && s1 / l1 < 1.3, `and closer to the lit side (${(s0 / l0).toFixed(2)} → ${(s1 / l1).toFixed(2)})`);
});

test('hair and background are not used as evidence and the field fades outside the person', () => {
  const { inp } = synthFace(0.8);
  // paint "hair" over the shadow-side forehead: darker pixels, marked as hair instead of skin
  const hair = new Float32Array(n); const skin = Float32Array.from(inp.skin); const rgba = new Uint8ClampedArray(inp.rgba);
  for (let y = 0; y < H * 0.3; y += 1) for (let x = 0; x < W / 2; x += 1) { const j = y * W + x; if (skin[j]) { skin[j] = 0; hair[j] = 1; rgba[j * 4] = 20; rgba[j * 4 + 1] = 15; rgba[j * 4 + 2] = 12; } }
  const f = computeRelight({ ...inp, rgba, skin, hair });
  // the dark hair must not read as a deep shadow: the lit forehead opposite it is not pushed down, and the fit is unchanged
  assert.ok(Math.abs(f.report.lightA - 0.8) < 0.35, `light still found (${f.report.lightA})`);
  let minLit = 0; for (let y = 0; y < H * 0.3; y += 1) for (let x = W / 2 + 10; x < W; x += 1) minLit = Math.min(minLit, f.G[y * W + x]);
  assert.ok(minLit > -0.08, `lit forehead not dimmed because of the hair opposite (${minLit.toFixed(3)})`);
  // no person → no gain
  const none = computeRelight({ ...inp, person: new Float32Array(n) });
  let g = 0; for (let j = 0; j < n; j += 1) g = Math.max(g, Math.abs(none.G[j]));
  assert.ok(g < 1e-6);
});

test('packed field: 8-bit round trip is accurate and maps through any output matrix', () => {
  const { inp, m } = synthFace(0.8);
  const f = computeRelight(inp);
  const packed = packRelight(f);
  assert.equal(packed.length, RELIGHT.PW * RELIGHT.PH * 4);
  // decode a few cells and compare with the 2×2 mean of the field
  for (const [px, py] of [[128, 128], [100, 150], [150, 100], [128, 60]]) {
    const o = (py * RELIGHT.PW + px) * 4; const j0 = py * 2 * W + px * 2;
    const g = (f.G[j0] + f.G[j0 + 1] + f.G[j0 + W] + f.G[j0 + W + 1]) / 4;
    assert.ok(Math.abs((packed[o] / 255) * RELIGHT.G_SPAN + RELIGHT.G_MIN - g) < 0.012);
  }
  // render at twice the size through a scale matrix: same balance as at the work size
  const S = 2; const big = new Uint8ClampedArray(W * S * H * S * 4);
  for (let y = 0; y < H * S; y += 1) for (let x = 0; x < W * S; x += 1) { const j = ((y / S) | 0) * W + ((x / S) | 0); const o = (y * W * S + x) * 4; big[o] = inp.rgba[j * 4]; big[o + 1] = inp.rgba[j * 4 + 1]; big[o + 2] = inp.rgba[j * 4 + 2]; big[o + 3] = 255; }
  const r = applyRelight(big, W * S, H * S, packed, [1 / S, 0, 0, 1 / S, 0, 0]);
  assert.equal(r.applied, true);
  const small = new Uint8ClampedArray(n * 4);
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) { const o = ((y * S) * W * S + x * S) * 4; const j = (y * W + x) * 4; small[j] = big[o]; small[j + 1] = big[o + 1]; small[j + 2] = big[o + 2]; small[j + 3] = 255; }
  const [l, rr] = sideMeans(small, m);
  assert.ok(Math.max(l, rr) / Math.min(l, rr) < 1.12);
  // a matrix that puts the work frame outside the output does nothing
  const off = new Uint8ClampedArray(inp.rgba);
  assert.equal(applyRelight(off, W, H, packed, [1, 0, 0, 1, 5000, 5000]).applied, false);
  assert.deepEqual(off, inp.rgba);
  assert.equal(applyRelight(off, W, H, packed, [1, 0, 0, 1, 0, 0], { strength: 0 }).applied, false);
});

test('light fit: recovers a known light from exact differences', () => {
  const { P, Z } = canonicalMesh(); const m = meshNormalMap(P, Z);
  const a = -1.1; const c = 0.45; const b = 0.12;
  const S = (nx, ny, nz) => Math.max(0.1, 1 + a * nx - b * ny + c * nz);
  const idx = []; for (let j = 0; j < n; j += 7) if (m.cov[j] && m.nz[j] > 0.3) idx.push(j);
  const smp = { D: new Float32Array(idx.length), wt: new Float32Array(idx.length).fill(1), n: new Float32Array(idx.length * 3), nm: new Float32Array(idx.length * 3), count: idx.length };
  idx.forEach((j, q) => { smp.n[q * 3] = m.nx[j]; smp.n[q * 3 + 1] = m.ny[j]; smp.n[q * 3 + 2] = m.nz[j]; smp.nm[q * 3] = -m.nx[j]; smp.nm[q * 3 + 1] = m.ny[j]; smp.nm[q * 3 + 2] = m.nz[j]; smp.D[q] = Math.log(S(-m.nx[j], m.ny[j], m.nz[j]) / S(m.nx[j], m.ny[j], m.nz[j])); });
  const fit = fitLight(smp);
  assert.ok(Math.abs(fit.a - a) < 0.051 && Math.abs(fit.c - c) < 0.11, `a ${fit.a}, c ${fit.c}`);
  assert.ok(fit.err < fit.err0 * 0.02);
});
