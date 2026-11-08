import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultCrop, cropMatrix, applyMatrix, invertMatrix, frameCorners, isFrameInside, constrainCrop,
  maxFrameWidth, panCrop, zoomCrop, sourcePixelsPerOutputPixel,
} from '../../src/core/crop.js';
import { buildLuts, applyAdjustments, isNeutral, ADJUSTMENT_DEFAULTS } from '../../src/core/adjust.js';
import { boxFilter, guidedFilter, resizeMask, shapeMask, refineMask } from '../../src/core/mask.js';
import { faceMetrics, suggestCrop, evaluateCrop, crownFromMask, genericProfile, assessQuality, faceRegionStats } from '../../src/core/idphoto.js';
import { RULE_PROFILES } from '../../src/core/presets.js';

const close = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

test('default crop is the largest centred frame for portrait, landscape and square sources', () => {
  for (const [w, h] of [[3000, 4000], [4000, 3000], [2000, 2000], [400, 300]]) {
    const aspect = 30 / 40;
    const c = defaultCrop(w, h, aspect);
    assert.ok(isFrameInside(c, w, h, aspect));
    const cw = c.cw * w; const ch = cw / aspect;
    assert.ok(close(cw, w) || close(ch, h), 'touches one image edge');
  }
});

test('crop matrix is a uniform scale (no stretching) and maps frame corners to output corners', () => {
  const srcW = 4000; const srcH = 3000; const outW = 354; const outH = 472;
  for (const rotation of [0, 7.5, -12, 90]) {
    const crop = { cx: 0.5, cy: 0.45, cw: 0.3, rotation };
    const M = cropMatrix(crop, srcW, srcH, outW, outH);
    const sx = Math.hypot(M[0], M[1]); const sy = Math.hypot(M[2], M[3]);
    assert.ok(close(sx, sy, 1e-9), 'uniform scale');
    assert.ok(close(M[0] * M[2] + M[1] * M[3], 0, 1e-9), 'orthogonal axes');
    const corners = frameCorners(crop, srcW, srcH, outW / outH);
    const expected = [[0, 0], [outW, 0], [outW, outH], [0, outH]];
    corners.forEach((p, i) => {
      const q = applyMatrix(M, p.x, p.y);
      assert.ok(close(q.x, expected[i][0], 1e-6) && close(q.y, expected[i][1], 1e-6), `corner ${i} rot ${rotation}`);
    });
    const inv = invertMatrix(M);
    const back = applyMatrix(inv, outW / 2, outH / 2);
    assert.ok(close(back.x, 0.5 * srcW, 1e-6) && close(back.y, 0.45 * srcH, 1e-6));
  }
});

test('constrainCrop keeps rotated frames inside the image', () => {
  const w = 3000; const h = 4000; const aspect = 0.75;
  const c = constrainCrop({ cx: 0.02, cy: 0.98, cw: 2, rotation: 10 }, w, h, aspect);
  assert.ok(isFrameInside(c, w, h, aspect));
  assert.ok(close(c.cw * w, maxFrameWidth(w, h, aspect, 10), 1e-6));
});

test('pan and zoom', () => {
  const c = { cx: 0.5, cy: 0.5, cw: 0.5, rotation: 0 };
  const p = panCrop(c, 100, 0, 1000, 1000, 500); // drag image right by 100 out px
  assert.ok(close(p.cx, 0.5 - (100 * (500 / 500)) / 1000));
  const z = zoomCrop(c, 2, 1000, 1000, { x: 500, y: 500 });
  assert.ok(close(z.cw, 0.25) && close(z.cx, 0.5));
  assert.ok(close(sourcePixelsPerOutputPixel({ cw: 0.1 }, 3000, 354), 300 / 354));
});

test('neutral adjustments are an exact identity', () => {
  assert.ok(isNeutral(ADJUSTMENT_DEFAULTS));
  const luts = buildLuts(ADJUSTMENT_DEFAULTS);
  for (const lut of luts) for (let v = 0; v < 256; v += 1) assert.equal(lut[v], v);
  const data = new Uint8ClampedArray([10, 200, 30, 255, 0, 0, 0, 255]);
  const copy = data.slice();
  applyAdjustments(data, 2, 1, ADJUSTMENT_DEFAULTS);
  assert.deepEqual(data, copy);
});

test('each tone control moves values in the expected direction and stays monotonic', () => {
  const mid = (p) => buildLuts(p)[1][128];
  assert.ok(mid({ exposure: 50 }) > 128 && mid({ exposure: -50 }) < 128);
  assert.ok(mid({ brightness: 50 }) > 128 && mid({ brightness: -50 }) < 128);
  assert.ok(buildLuts({ contrast: 60 })[0][200] > 200 && buildLuts({ contrast: 60 })[0][50] < 50);
  assert.ok(buildLuts({ highlights: -80 })[0][230] < 230);
  assert.ok(buildLuts({ shadows: 80 })[0][30] > 30);
  const warm = buildLuts({ temperature: 80 });
  assert.ok(warm[0][128] > warm[2][128]);
  for (const p of [{ exposure: 100 }, { contrast: 100 }, { brightness: -100 }, { shadows: 100 }, { highlights: -100 }]) {
    for (const lut of buildLuts(p)) for (let v = 1; v < 256; v += 1) assert.ok(lut[v] >= lut[v - 1], JSON.stringify(p));
  }
});

test('grayscale gives R=G=B; saturation and sharpening change pixels', () => {
  const w = 4; const h = 4;
  const img = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i += 1) { img[i * 4] = 200; img[i * 4 + 1] = 40 + i * 5; img[i * 4 + 2] = 90; img[i * 4 + 3] = 255; }
  const g = img.slice();
  applyAdjustments(g, w, h, { grayscale: true });
  for (let i = 0; i < w * h; i += 1) {
    assert.ok(Math.abs(g[i * 4] - g[i * 4 + 1]) <= 1 && Math.abs(g[i * 4 + 1] - g[i * 4 + 2]) <= 1);
  }
  const s = img.slice();
  applyAdjustments(s, w, h, { sharpness: 80 });
  assert.notDeepEqual(s, img);
  assert.equal(s[3], 255, 'alpha untouched');
});

test('mask filters: box filter preserves constants; guided filter snaps to edges', () => {
  const w = 40; const h = 20;
  const c = new Float32Array(w * h).fill(0.7);
  assert.ok(boxFilter(c, w, h, 3).every((v) => close(v, 0.7, 1e-6)));
  const guide = new Float32Array(w * h); const coarse = new Float32Array(w * h);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
    guide[y * w + x] = x < 20 ? 0.9 : 0.1; // sharp edge at x=20
    coarse[y * w + x] = Math.min(1, Math.max(0, (24 - x) / 8)); // blurry edge, offset
  }
  const q = guidedFilter(guide, coarse, w, h, 4, 1e-4);
  const row = 10 * w;
  const jump = q[row + 19] - q[row + 20];
  const coarseJump = coarse[row + 19] - coarse[row + 20];
  assert.ok(jump > 0.4 && jump > 3 * coarseJump, `edge snapped to guide (jump ${jump})`);
  assert.ok(q[row + 14] > 0.9 && q[row + 26] < 0.15);
  const up = resizeMask(new Float32Array([0, 1, 0, 1]), 2, 2, 8, 8);
  assert.equal(up.length, 64);
  const hard = shapeMask(new Float32Array([0.2, 0.5, 0.8]), 0, 0);
  assert.ok(hard[0] < 0.01 && close(hard[1], 0.5, 1e-6) && hard[2] > 0.99);
  const r = refineMask(coarse, guide, w, h, { feather: 1 });
  assert.equal(r.length, w * h);
});

/** Synthetic frontal face landmarks (478 points) for geometry tests. */
function syntheticLandmarks({ srcW, srcH, cx, eyeY, eyeDist, chinBelow, rollDeg = 0 }) {
  const lm = Array.from({ length: 478 }, () => ({ x: cx / srcW, y: eyeY / srcH, z: 0 }));
  const r = (rollDeg * Math.PI) / 180;
  const put = (i, u, v) => {
    lm[i] = { x: (cx + u * Math.cos(r) - v * Math.sin(r)) / srcW, y: (eyeY + u * Math.sin(r) + v * Math.cos(r)) / srcH, z: 0 };
  };
  put(468, -eyeDist / 2, 0); put(473, eyeDist / 2, 0);
  put(33, -eyeDist * 0.75, 0); put(133, -eyeDist * 0.25, 0); put(362, eyeDist * 0.25, 0); put(263, eyeDist * 0.75, 0);
  put(152, 0, chinBelow); put(10, 0, -chinBelow * 0.55); put(1, 0, chinBelow * 0.35);
  put(234, -eyeDist * 1.05, chinBelow * 0.2); put(454, eyeDist * 1.05, chinBelow * 0.2);
  return lm;
}

test('face metrics, suggested crop and evaluation agree with the rule profile', () => {
  const srcW = 3000; const srcH = 4000;
  for (const rollDeg of [0, 6, -4]) {
    const lm = syntheticLandmarks({ srcW, srcH, cx: 1480, eyeY: 1700, eyeDist: 300, chinBelow: 520, rollDeg });
    const m = faceMetrics(lm, srcW, srcH);
    assert.ok(close(m.rollDeg, rollDeg, 1e-6));
    assert.ok(close(m.eyeDist, 300, 1e-6));
    assert.ok(m.crownEstimated);
    const profile = RULE_PROFILES.find((p) => p.id === 'generic-3x4');
    const crop = suggestCrop(m, profile, srcW, srcH);
    assert.ok(close(crop.rotation, rollDeg, 1e-9), 'straightened to the eye line');
    const ev = evaluateCrop(m, crop, profile.widthMm, profile.heightMm, srcW, srcH);
    assert.ok(close(ev.headHeightMm, profile.headHeight.target, 1e-6), `head ${ev.headHeightMm}`);
    assert.ok(close(ev.eyeFromBottomMm, profile.eyeFromBottom.target, 1e-6));
    assert.ok(close(ev.residualRollDeg, 0, 1e-9));
    assert.ok(Math.abs(ev.centreOffsetMm) < 0.01);
    const q = assessQuality({ metrics: m, evaluation: ev, profile, faceCount: 1, effectiveDpi: 400 });
    assert.equal(q.find((x) => x.code === 'HEAD_SIZE').level, 'ok');
    assert.equal(q.find((x) => x.code === 'FACE_CROPPED').level, 'ok');
  }
});

test('crown from mask finds the top of the head', () => {
  const srcW = 1000; const srcH = 1000;
  const lm = syntheticLandmarks({ srcW, srcH, cx: 500, eyeY: 500, eyeDist: 100, chinBelow: 170 });
  const m = faceMetrics(lm, srcW, srcH);
  // foreground = everything below y=280 within an ellipse-ish column band
  const sample = (x, y) => (y >= 280 && Math.abs(x - 500) < 200 ? 1 : 0);
  const crownV = crownFromMask(m, sample, srcW, srcH);
  assert.ok(Math.abs(crownV - (280 - 500)) <= 3, `crown ${crownV}`);
});

test('quality flags: no face, multiple faces, tilt, low resolution, dark image', () => {
  assert.equal(assessQuality({ faceCount: 0 })[0].code, 'FACE_NOT_FOUND');
  const lm = syntheticLandmarks({ srcW: 1000, srcH: 1000, cx: 500, eyeY: 450, eyeDist: 100, chinBelow: 170, rollDeg: 12 });
  const m = faceMetrics(lm, 1000, 1000);
  const q = assessQuality({ metrics: m, faceCount: 2, effectiveDpi: 120, stats: { meanL: 0.1, balance: 0, sharpness: 100 } });
  assert.ok(q.some((x) => x.code === 'MULTIPLE_FACES' && x.level === 'error'));
  assert.equal(q.find((x) => x.code === 'ROLL').level, 'error');
  assert.equal(q.find((x) => x.code === 'RESOLUTION').level, 'error');
  assert.equal(q.find((x) => x.code === 'LIGHTING').level, 'warn');
  const gp = genericProfile(30, 40);
  assert.ok(gp.headHeight.target === 28 && gp.verified === false);
  const flat = new Uint8ClampedArray(16 * 16 * 4).fill(128);
  assert.ok(faceRegionStats(flat, 16, 16).sharpness < 1);
});

test('stepwise downscale plan always terminates and ends with a final scale ≥ 0.5 (regression)', async () => {
  const { halvingPlan } = await import('../../src/render/renderPhoto.js');
  for (const [scale, w, h] of [[0.118, 3000, 4000], [0.34, 1050, 1400], [0.01, 8000, 6000], [0.49, 10, 10], [0.2, 3, 3], [0.001, 2, 2]]) {
    const plan = halvingPlan(scale, w, h);
    assert.ok(plan.length < 24, 'bounded');
    if (plan.length) {
      const [cw] = plan.at(-1);
      const remaining = scale * (w / cw);
      assert.ok(remaining >= 0.5 || cw <= 2, `remaining scale ${remaining}`);
      assert.ok(remaining <= 1.01 || cw <= 2, `not over-shrunk ${remaining}`);
    }
  }
  assert.deepEqual(halvingPlan(0.6, 1000, 1000), []);
});

test('shoulder coverage and head-top margin checks', async () => {
  const { shoulderCoverage, assessQuality, faceMetrics: fm, evaluateCrop: ev, suggestCrop: sc } = await import('../../src/core/idphoto.js');
  const crop = { cx: 0.5, cy: 0.5, cw: 0.5, rotation: 0 };
  // person fills the lower half of a 1000×1000 image
  const full = shoulderCoverage(crop, 30, 40, 1000, 1000, (x, y) => (y > 500 ? 1 : 0));
  assert.equal(full, 1);
  const narrow = shoulderCoverage(crop, 30, 40, 1000, 1000, (x, y) => (y > 500 && Math.abs(x - 500) < 60 ? 1 : 0));
  assert.ok(narrow < 0.55);
  const lm = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.45 }));
  const set = (i, x, y) => { lm[i] = { x, y }; };
  set(468, 0.45, 0.45); set(473, 0.55, 0.45); set(152, 0.5, 0.62); set(10, 0.5, 0.36); set(1, 0.5, 0.51); set(234, 0.395, 0.48); set(454, 0.605, 0.48);
  const m = fm(lm, 1000, 1000);
  const profile = RULE_PROFILES[0];
  const good = sc(m, profile, 1000, 1000);
  const q = assessQuality({ metrics: m, evaluation: ev(m, good, 30, 40, 1000, 1000), profile, faceCount: 1, shoulderFrac: 0.9 });
  assert.equal(q.find((x) => x.code === 'TOP_MARGIN').level, 'ok');
  assert.equal(q.find((x) => x.code === 'SHOULDERS').level, 'ok');
  const tight = { ...good, cy: good.cy + 0.12 };
  const q2 = assessQuality({ metrics: m, evaluation: ev(m, tight, 30, 40, 1000, 1000), profile, faceCount: 1, shoulderFrac: 0.2 });
  assert.equal(q2.find((x) => x.code === 'TOP_MARGIN').level, 'warn');
  assert.equal(q2.find((x) => x.code === 'SHOULDERS').level, 'warn');
});
