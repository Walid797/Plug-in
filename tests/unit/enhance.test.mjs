import test from 'node:test';
import assert from 'node:assert/strict';
import { FACE_TEMPLATE, FACE_SIZE, TEMPLATE_FACE_WIDTH, fivePoints, similarityFit, featherWeight, restoreShare, upscalePlan, tilePlan, maskBounds, toPlanar, fromPlanar, mergeFaceDetail } from '../../src/core/enhance.js';
import { MODELS, findModel, hashAccepted } from '../../src/ai/registry.js';

const apply = (M, p) => [M[0] * p[0] + M[2] * p[1] + M[4], M[1] * p[0] + M[3] * p[1] + M[5]];

test('similarity fit: exact for a rotated, scaled, shifted copy; never mirrors', () => {
  const ang = 0.4; const k = 3.7; const t = [120, -45];
  const src = FACE_TEMPLATE.map(([x, y]) => [(x * Math.cos(ang) - y * Math.sin(ang)) * k + t[0], (x * Math.sin(ang) + y * Math.cos(ang)) * k + t[1]]);
  const M = similarityFit(src, FACE_TEMPLATE);
  src.forEach((p, i) => { const q = apply(M, p); assert.ok(Math.hypot(q[0] - FACE_TEMPLATE[i][0], q[1] - FACE_TEMPLATE[i][1]) < 1e-6); });
  assert.ok(Math.abs(Math.hypot(M[0], M[1]) - 1 / k) < 1e-9, 'scale');
  assert.ok(M[0] * M[3] - M[1] * M[2] > 0, 'no reflection');
  // a mirrored face cannot be matched exactly, and the fit still has positive determinant
  const mir = src.map(([x, y]) => [-x, y]);
  const Mm = similarityFit(mir, FACE_TEMPLATE);
  assert.ok(Mm[0] * Mm[3] - Mm[1] * Mm[2] > 0);
  assert.equal(similarityFit([[1, 1]], FACE_TEMPLATE), null);
  assert.equal(similarityFit([[1, 1], [1, 1], [1, 1]], FACE_TEMPLATE), null, 'degenerate points');
});

test('five points come from the iris centres when the landmarks have them', () => {
  const lm = Array.from({ length: 478 }, (_, i) => ({ x: (i % 30) / 30, y: ((i * 7) % 40) / 40 }));
  const p = fivePoints(lm, 200, 400);
  assert.deepEqual(p[0], [lm[468].x * 200, lm[468].y * 400]);
  assert.deepEqual(p[1], [lm[473].x * 200, lm[473].y * 400]);
  assert.deepEqual(p[2], [lm[4].x * 200, lm[4].y * 400]);
  const q = fivePoints(lm.slice(0, 468), 200, 400);
  assert.deepEqual(q[0], [((lm[33].x + lm[133].x) / 2) * 200, ((lm[33].y + lm[133].y) / 2) * 400], 'eye-corner midpoint without iris landmarks');
});

test('feather: full over the face, zero at the border, smooth and symmetric', () => {
  assert.equal(featherWeight(256, 256), 1);
  for (const [x, y] of FACE_TEMPLATE) assert.equal(featherWeight(x, y), 1, 'all alignment points are fully inside');
  assert.equal(featherWeight(0, 256), 0); assert.equal(featherWeight(256, FACE_SIZE - 1), 0); assert.equal(featherWeight(20, 20), 0);
  let prev = 0; for (let x = 0; x < 256; x += 1) { const v = featherWeight(x, 256); assert.ok(v >= prev - 1e-12 && v <= 1); prev = v; }
  assert.ok(Math.abs(featherWeight(60, 256) - featherWeight(FACE_SIZE - 1 - 60, 256)) < 1e-12);
});

test('restore share: full for a face the model can resolve, reduced for a large sharp face, never zero when asked for', () => {
  assert.equal(restoreShare(200, 0.8), 0.8);
  assert.equal(restoreShare(TEMPLATE_FACE_WIDTH * 1.6, 0.8), 0.8);
  assert.ok(restoreShare(800, 0.8) < 0.8 && restoreShare(800, 0.8) > restoreShare(1100, 0.8));
  assert.ok(Math.abs(restoreShare(5000, 1) - 0.5) < 1e-9, 'floor of 50 % for very large faces');
  assert.equal(restoreShare(300, 0), 0); assert.equal(restoreShare(0, 1), 0);
});

test('upscale plan: ×4 for small sources, capped by the longest side, none for large ones', () => {
  assert.deepEqual(upscalePlan(400, 500, 190), { scale: 4, outW: 1600, outH: 2000, reason: 'small' });
  const p = upscalePlan(700, 466, 157); assert.equal(p.outW, 2600); assert.ok(Math.abs(p.scale - 2600 / 700) < 1e-9); assert.equal(p.outH, Math.round(466 * p.scale));
  assert.equal(upscalePlan(4000, 3000, 1130).scale, 1);
  assert.equal(upscalePlan(1300, 1300, 260).scale > 1, true, 'a mid-size picture with a small face is still upscaled');
  assert.equal(upscalePlan(1300, 1300, 330).scale, 1, 'enough pixels on the face already');
  assert.equal(upscalePlan(1500, 1500, 600).scale, 1);
  assert.equal(upscalePlan(2000, 1500, 300).scale, 1, 'too large to gain from it');
});

test('tiles: cores cover the region exactly once, padding stays inside the picture', () => {
  const w = 500; const h = 333;
  for (const region of [null, { x0: 37.4, y0: 20, x1: 411.2, y1: 333 }]) {
    const tiles = tilePlan(w, h, region);
    const cover = new Uint8Array(w * h);
    for (const t of tiles) {
      assert.ok(t.sx >= 0 && t.sy >= 0 && t.sx + t.sw <= w && t.sy + t.sh <= h, 'padded rect inside');
      assert.ok(t.cx >= t.sx && t.cy >= t.sy && t.cx + t.cw <= t.sx + t.sw && t.cy + t.ch <= t.sy + t.sh, 'core inside padded rect');
      assert.ok(t.sw <= 192 + 24 && t.sh <= 192 + 24);
      for (let y = t.cy; y < t.cy + t.ch; y += 1) for (let x = t.cx; x < t.cx + t.cw; x += 1) cover[y * w + x] += 1;
    }
    const x0 = region ? Math.floor(region.x0) : 0; const y0 = region ? Math.floor(region.y0) : 0; const x1 = region ? Math.ceil(region.x1) : w; const y1 = region ? Math.ceil(region.y1) : h;
    for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) assert.equal(cover[y * w + x], x >= x0 && x < x1 && y >= y0 && y < y1 ? 1 : 0);
  }
});

test('mask bounds: the person box in picture pixels with a margin, null for an empty mask', () => {
  const mw = 10; const mh = 10; const m = new Uint8Array(100);
  assert.equal(maskBounds(m, mw, mh, 1000, 500), null);
  for (let y = 2; y <= 7; y += 1) for (let x = 3; x <= 5; x += 1) m[y * mw + x] = 255;
  const b = maskBounds(m, mw, mh, 1000, 500, 0);
  assert.deepEqual(b, { x0: 300, y0: 100, x1: 600, y1: 400 });
  const g = maskBounds(m, mw, mh, 1000, 500, 0.1);
  assert.ok(g.x0 < 300 && g.x1 > 600 && g.y0 < 100 && g.y1 > 400 && g.x0 >= 0 && g.y1 <= 500);
});

test('planar conversion round trip in both value ranges', () => {
  const rgba = new Uint8ClampedArray([0, 128, 255, 255, 10, 20, 30, 255, 250, 3, 77, 255, 99, 100, 101, 255]);
  for (const [lo, hi] of [[0, 1], [-1, 1]]) {
    const p = toPlanar(rgba, 2, 2, lo, hi);
    assert.equal(p.length, 12);
    assert.ok(Math.abs(p[0] - lo) < 1e-6 && Math.abs(p[8] - hi) < 1e-6, 'planes are R, G, B');
    assert.deepEqual(Array.from(fromPlanar(p, 2, 2, new Uint8ClampedArray(16), lo, hi)), Array.from(rgba));
  }
  const clipped = fromPlanar(new Float32Array([2, -3, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]), 2, 2, new Uint8ClampedArray(16));
  assert.equal(clipped[0], 255); assert.equal(clipped[4], 0);
});

test('face detail merge: tone and colour stay the photo\'s, fine luminance detail comes from the model', () => {
  const S = 128; const n = S * S;
  const base = new Uint8ClampedArray(n * 4); const rest = new Uint8ClampedArray(n * 4);
  for (let y = 0; y < S; y += 1) for (let x = 0; x < S; x += 1) {
    const i = (y * S + x) * 4;
    const shade = 0.6 + 0.4 * (x / S);                       // the photo: warm skin with a left-to-right light gradient, no detail
    base[i] = 200 * shade; base[i + 1] = 150 * shade; base[i + 2] = 120 * shade; base[i + 3] = 255;
    const tex = ((x + y) % 2 ? 12 : -12);                    // the model: flat grey-blue tone (wrong colour, wrong light) with crisp texture
    rest[i] = 120 + tex; rest[i + 1] = 130 + tex; rest[i + 2] = 150 + tex; rest[i + 3] = 255;
  }
  const out = mergeFaceDetail(base, rest, S, { sigma: 6 });
  const mean = (d, c, x0, x1) => { let s = 0; let k = 0; for (let y = 20; y < S - 20; y += 1) for (let x = x0; x < x1; x += 1) { s += d[(y * S + x) * 4 + c]; k += 1; } return s / k; };
  for (const [x0, x1] of [[20, 50], [80, 108]]) for (let c = 0; c < 3; c += 1) assert.ok(Math.abs(mean(out, c, x0, x1) - mean(base, c, x0, x1)) < 2.5, `tone and colour of the photo are kept (channel ${c}, columns ${x0}-${x1})`);
  assert.ok(mean(out, 0, 20, 50) > mean(out, 2, 20, 50) + 30, 'still warm skin, not the model\'s grey-blue');
  // the checker texture of the model is in the result
  let e = 0; let k = 0; for (let y = 30; y < S - 30; y += 1) for (let x = 30; x < S - 31; x += 1) { e += Math.abs(out[(y * S + x) * 4 + 1] - out[(y * S + x + 1) * 4 + 1]); k += 1; }
  assert.ok(e / k > 15, `fine detail from the model (${(e / k).toFixed(1)})`);
  for (let j = 3; j < out.length; j += 4) assert.equal(out[j], 255);
});

test('registry: the enhancement models are described and their hashes are checked', () => {
  const up = findModel('realesr'); const fr = findModel('gfpgan');
  assert.ok(up && fr);
  assert.equal(up.bundled, true); assert.equal(fr.bundled, false);
  assert.equal(up.license, 'BSD-3-Clause'); assert.equal(fr.license, 'Apache-2.0');
  assert.equal(hashAccepted(up, up.sha256), true); assert.equal(hashAccepted(up, 'x'.repeat(64)), false);
  assert.ok(Array.isArray(fr.sha256) && fr.sha256.length === 2 && fr.sha256.every((h) => /^[0-9a-f]{64}$/.test(h)));
  for (const h of fr.sha256) assert.equal(hashAccepted(fr, h), true);
  assert.equal(hashAccepted(fr, up.sha256), false);
  assert.equal(hashAccepted({ sha256: null }, 'anything'), true, 'a model without a registered hash is not checked');
  for (const m of MODELS) assert.ok(m.nameFa && m.license && m.source && m.path, m.id);
});
