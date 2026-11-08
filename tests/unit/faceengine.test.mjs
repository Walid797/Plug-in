import test from 'node:test';
import assert from 'node:assert/strict';
import { applyFaceEngine, faceEllipse, ellipseToOutput, REDNESS_LIMIT, FACE_ENGINE_DEFAULTS } from '../../src/core/faceengine.js';
import { buildLuts, applyAdjustments, chromaDenoise, ADJUSTMENT_DEFAULTS } from '../../src/core/adjust.js';
import { suggestCrop, evaluateCrop, faceMetrics, shoulderSides, assessQuality } from '../../src/core/idphoto.js';
import { setPngSrgb, setPngDpi, readPngPhys } from '../../src/core/binary.js';

const W = 220; const H = 280;
const ELL = { cx: 110, cy: 130, rx: 62, ry: 82, rot: 0 };

/** Deterministic pseudo-random texture in -1..1. */
const noise = (x, y) => { const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453; return (s - Math.floor(s)) * 2 - 1; };

/**
 * Synthetic portrait: white background, a textured skin face in the ellipse, with eyes (white + dark iris),
 * brows and a beard patch (dark), lips (strongly red), a shadow band under the eyes and a flushed cheek.
 */
function portrait(skin = [224, 172, 150], { flush = 0, shadow = 0.78, burnt = false } = {}) {
  const d = new Uint8ClampedArray(W * H * 4).fill(255);
  const regions = { eyeL: [86, 108, 14, 7], eyeR: [134, 108, 14, 7], lips: [110, 170, 20, 8], beard: [110, 205, 34, 12], brow: [86, 94, 18, 3] };
  const inside = (x, y, [cx, cy, rx, ry]) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const u = (x + 0.5 - ELL.cx) / ELL.rx; const v = (y + 0.5 - ELL.cy) / ELL.ry;
      if (u * u + v * v > 1) continue;
      const i = (y * W + x) * 4;
      const t = noise(x, y) * 5;
      let [r, g, b] = skin;
      // flushed cheeks (left side of the image)
      if (flush && inside(x, y, [78, 135, 24, 20])) { r += flush * 14; g -= flush * 26; b -= flush * 20; }
      // shadow bands: under the eyes and beside the nose
      if (shadow < 1 && (inside(x, y, [86, 118, 16, 5]) || inside(x, y, [134, 118, 16, 5]) || inside(x, y, [104, 148, 4, 14]))) { r *= shadow; g *= shadow; b *= shadow; }
      if (burnt && y < 80) { r = 252; g = 236; b = 222; }
      d[i] = r + t; d[i + 1] = g + t; d[i + 2] = b + t; d[i + 3] = 255;
      if (inside(x, y, regions.eyeL) || inside(x, y, regions.eyeR)) { const c = Math.hypot(x - (inside(x, y, regions.eyeL) ? 86 : 134), y - 108) < 4 ? [40, 30, 25] : [240, 240, 240]; d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; }
      if (inside(x, y, regions.lips)) { d[i] = 185; d[i + 1] = 70; d[i + 2] = 80; }
      if (inside(x, y, regions.beard)) { d[i] = 52; d[i + 1] = 44; d[i + 2] = 40; }
      if (inside(x, y, regions.brow)) { d[i] = 60; d[i + 1] = 45; d[i + 2] = 38; }
    }
  }
  return { d, regions, inside };
}

const luma = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
function stats(d, pred) {
  let n = 0; let Y = 0; let cr = 0; let cb = 0;
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) {
    if (!pred(x, y)) continue; const i = (y * W + x) * 4; n += 1; Y += luma(d, i);
    cb += 128 - 0.168736 * d[i] - 0.331264 * d[i + 1] + 0.5 * d[i + 2]; cr += 128 + 0.5 * d[i] - 0.418688 * d[i + 1] - 0.081312 * d[i + 2];
  }
  return { n, Y: Y / n, cb: cb / n, cr: cr / n, R: (cr / n - 128) / Math.max(8, 128 - cb / n) };
}
const hf = (d, pred) => { // high-frequency energy: mean |pixel - 3x3 mean|
  let s = 0; let n = 0;
  for (let y = 2; y < H - 2; y += 1) for (let x = 2; x < W - 2; x += 1) {
    if (!pred(x, y)) continue;
    let m = 0; for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) m += luma(d, ((y + dy) * W + x + dx) * 4);
    s += Math.abs(luma(d, (y * W + x) * 4) - m / 9); n += 1;
  }
  return s / n;
};

test('face engine leaves lips, eyes, brows, beard and the background exactly as they were', () => {
  const { d, regions, inside } = portrait();
  const orig = d.slice();
  const rep = applyFaceEngine(d, W, H, ELL, FACE_ENGINE_DEFAULTS);
  assert.equal(rep.applied, true, JSON.stringify(rep));
  for (const [name, reg] of Object.entries(regions)) {
    let worst = 0;
    for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) {
      if (!inside(x, y, reg)) continue;
      const i = (y * W + x) * 4;
      // pixels at the very rim of a region can share a smoothing neighbourhood; the core must be untouched
      const core = inside(x, y, [reg[0], reg[1], reg[2] - 3, Math.max(1, reg[3] - 2)]);
      if (!core) continue;
      worst = Math.max(worst, Math.abs(d[i] - orig[i]), Math.abs(d[i + 1] - orig[i + 1]), Math.abs(d[i + 2] - orig[i + 2]));
    }
    assert.ok(worst <= 6, `${name}: colours unchanged (max diff ${worst})`);
  }
  // lips keep their red, eyes stay white/dark
  const lip = (110 + 170 * W) * 4;
  assert.ok(d[lip] > 170 && d[lip + 1] < 90, 'lip colour kept');
  // everything outside the face ellipse is bit-identical (the white background included)
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) {
    const u = (x + 0.5 - ELL.cx) / ELL.rx; const v = (y + 0.5 - ELL.cy) / ELL.ry;
    if (Math.hypot(u, v) < 1.3) continue;
    const i = (y * W + x) * 4;
    assert.ok(d[i] === orig[i] && d[i + 1] === orig[i + 1] && d[i + 2] === orig[i + 2], `outside pixel ${x},${y} changed`);
  }
});

test('shadows (eyes, nose) are lifted, skin is not whitened, fine texture is kept', () => {
  const { d, inside } = portrait([224, 172, 150], { shadow: 0.72 });
  const orig = d.slice();
  const eyeShadow = (x, y) => inside(x, y, [86, 118, 16, 5]) || inside(x, y, [134, 118, 16, 5]);
  const cheek = (x, y) => inside(x, y, [70, 150, 12, 10]) || inside(x, y, [150, 150, 12, 10]);
  const skinAll = (x, y) => ((x - ELL.cx) / ELL.rx) ** 2 + ((y - ELL.cy) / ELL.ry) ** 2 < 0.5 && !inside(x, y, [110, 170, 24, 10]) && !inside(x, y, [86, 108, 16, 9]) && !inside(x, y, [134, 108, 16, 9]) && !inside(x, y, [110, 205, 36, 14]) && !inside(x, y, [86, 94, 20, 5]);
  const before = { shadow: stats(orig, eyeShadow).Y, skin: stats(orig, skinAll).Y, hf: hf(orig, skinAll) };
  const rep = applyFaceEngine(d, W, H, ELL, FACE_ENGINE_DEFAULTS);
  const after = { shadow: stats(d, eyeShadow).Y, skin: stats(d, skinAll).Y, hf: hf(d, skinAll) };
  assert.ok(after.shadow > before.shadow + 6, `under-eye shadow lifted (${before.shadow.toFixed(1)} → ${after.shadow.toFixed(1)})`);
  assert.ok(after.skin - before.skin < 10, `skin not whitened (mean +${(after.skin - before.skin).toFixed(1)} levels)`);
  assert.ok(rep.lumaAfter - rep.lumaBefore < 10, 'reported mean lift is small');
  assert.ok(after.hf > before.hf * 0.8, `skin texture kept (${before.hf.toFixed(2)} → ${after.hf.toFixed(2)})`);
  assert.ok(after.hf < before.hf * 1.2, 'no artificial sharpening either');
  const calm = stats(d, cheek).Y - stats(orig, cheek).Y;
  assert.ok(calm < 8, `already-lit cheeks barely change (+${calm.toFixed(1)})`);
});

test('excess redness is reduced to the natural limit, normal skin is not recoloured', () => {
  const flushed = portrait([232, 150, 140]);
  const o1 = flushed.d.slice();
  const all = (x, y) => ((x - ELL.cx) / ELL.rx) ** 2 + ((y - ELL.cy) / ELL.ry) ** 2 < 0.4 && !flushed.inside(x, y, [110, 170, 24, 10]) && !flushed.inside(x, y, [86, 108, 16, 9]) && !flushed.inside(x, y, [134, 108, 16, 9]) && !flushed.inside(x, y, [86, 94, 20, 5]);
  const rep = applyFaceEngine(flushed.d, W, H, ELL, { skin: { enabled: true, redness: 100, balance: 0 }, light: { enabled: false } });
  assert.equal(rep.applied, true);
  const b = stats(o1, all); const a = stats(flushed.d, all);
  assert.ok(b.R > REDNESS_LIMIT + 0.2, `test skin is clearly too red (R=${b.R.toFixed(2)})`);
  assert.ok(a.R < b.R, `redness reduced (${b.R.toFixed(2)} → ${a.R.toFixed(2)})`);
  assert.ok(a.cr < b.cr && b.cr - a.cr <= 7.01, `shift capped at 7 levels (${(b.cr - a.cr).toFixed(2)})`);
  assert.ok(Math.abs(a.Y - b.Y) < 1.5, 'luminance unchanged by the redness step');
  // normal skin (R below the limit) keeps its colour
  const normal = portrait([200, 150, 110]);
  const o2 = normal.d.slice();
  applyFaceEngine(normal.d, W, H, ELL, { skin: { enabled: true, redness: 100, balance: 0 }, light: { enabled: false } });
  const nb = stats(o2, all); const na = stats(normal.d, all);
  assert.ok(nb.R < REDNESS_LIMIT);
  assert.ok(Math.abs(na.cr - nb.cr) < 0.6 && Math.abs(na.cb - nb.cb) < 0.6, 'normal skin colour untouched');
  // redness 0 = off
  const off = portrait([232, 150, 140]); const o3 = off.d.slice();
  applyFaceEngine(off.d, W, H, ELL, { skin: { enabled: true, redness: 0, balance: 0 }, light: { enabled: false } });
  assert.ok(Math.abs(stats(off.d, all).cr - stats(o3, all).cr) < 0.3);
});

test('burnt highlights are compressed; light balance evens a darker side; works on dark and light skin', () => {
  const burnt = portrait([224, 172, 150], { burnt: true });
  const o = burnt.d.slice();
  const fore = (x, y) => y < 80 && ((x - ELL.cx) / ELL.rx) ** 2 + ((y - ELL.cy) / ELL.ry) ** 2 < 0.7;
  const rep = applyFaceEngine(burnt.d, W, H, ELL, { skin: { enabled: false }, light: { enabled: true, fill: 0, even: false, protect: true } });
  assert.equal(rep.applied, true);
  assert.ok(stats(burnt.d, fore).Y < stats(o, fore).Y - 4, 'burnt forehead pulled back');
  // darker left side
  const side = portrait([224, 172, 150]);
  for (let y = 0; y < H; y += 1) for (let x = 0; x < 110; x += 1) { const i = (y * W + x) * 4; if (side.d[i] !== 255 || side.d[i + 1] !== 255) { side.d[i] *= 0.9; side.d[i + 1] *= 0.9; side.d[i + 2] *= 0.9; } }
  const so = side.d.slice();
  const L = (x, y) => x < 100 && x > 60 && Math.abs(y - 135) < 25; const R = (x, y) => x > 120 && x < 160 && Math.abs(y - 135) < 25;
  const gap0 = stats(so, R).Y - stats(so, L).Y;
  applyFaceEngine(side.d, W, H, ELL, { skin: { enabled: false }, light: { enabled: true, fill: 0, even: true, protect: false } });
  const gap1 = stats(side.d, R).Y - stats(side.d, L).Y;
  assert.ok(gap1 < gap0 * 0.85, `left/right difference reduced (${gap0.toFixed(1)} → ${gap1.toFixed(1)})`);
  // deep and light skin tones are both detected (the cluster is measured per face)
  for (const tone of [[110, 74, 56], [244, 205, 185], [180, 128, 96]]) {
    const p = portrait(tone, { shadow: 0.7 });
    const r = applyFaceEngine(p.d, W, H, ELL, FACE_ENGINE_DEFAULTS);
    assert.equal(r.applied, true, `skin ${tone} detected: ${JSON.stringify(r)}`);
  }
});

test('no face or no skin: nothing is applied and nothing is changed', () => {
  const grey = new Uint8ClampedArray(W * H * 4).fill(120);
  for (let i = 3; i < grey.length; i += 4) grey[i] = 255;
  const copy = grey.slice();
  assert.equal(applyFaceEngine(grey, W, H, ELL, FACE_ENGINE_DEFAULTS).reason, 'NO_SKIN');
  assert.deepEqual(grey, copy);
  assert.equal(applyFaceEngine(grey, W, H, null, FACE_ENGINE_DEFAULTS).reason, 'NO_FACE');
  assert.equal(applyFaceEngine(grey, W, H, ELL, { skin: { enabled: false }, light: { enabled: false } }).reason, 'OFF');
  assert.deepEqual(grey, copy);
});

test('ellipse from face metrics round-trips through the crop matrix; face is centred exactly', () => {
  // 478 synthetic landmarks around a face centred left of the frame centre
  const lm = Array.from({ length: 478 }, () => ({ x: 0.4, y: 0.4 }));
  const set = (i, x, y) => { lm[i] = { x, y }; };
  set(468, 0.34, 0.38); set(473, 0.46, 0.38); set(1, 0.4, 0.45); set(152, 0.4, 0.58); set(10, 0.4, 0.2); set(234, 0.3, 0.4); set(454, 0.5, 0.4);
  const srcW = 1000; const srcH = 1400;
  const m = faceMetrics(lm, srcW, srcH);
  const crop = suggestCrop(m, { widthMm: 30, heightMm: 40, headHeight: { min: 25, max: 31, target: 28 }, eyeFromBottom: { target: 23.5 } }, srcW, srcH);
  const ev = evaluateCrop(m, crop, 30, 40, srcW, srcH);
  assert.ok(Math.abs(ev.centreOffsetMm) < 0.05, `face centre exactly on the frame centre (${ev.centreOffsetMm})`);
  const e = faceEllipse(m, srcW, srcH);
  assert.ok(Math.abs(e.cx - 0.4) < 0.01 && e.rx > 0 && e.ry > e.rx * 0.9);
  // output size 354x472 px at the crop: the ellipse centre must land near the frame centre horizontally
  const cm = (cw) => { const s = (354 / (cw * srcW)); const rot = (crop.rotation * Math.PI) / 180; return [s * Math.cos(-rot), s * Math.sin(-rot), -s * Math.sin(-rot), s * Math.cos(-rot), 0, 0]; };
  const M0 = cm(crop.cw);
  const px = ellipseToOutput(e, srcW, srcH, [M0[0], M0[1], M0[2], M0[3], 177 - (M0[0] * crop.cx * srcW + M0[2] * crop.cy * srcH), 236 - (M0[1] * crop.cx * srcW + M0[3] * crop.cy * srcH)]);
  assert.ok(Math.abs(px.rx / (e.rx * srcW) - Math.hypot(M0[0], M0[1])) < 1e-6, 'radii scale uniformly (no stretching)');
});

test('whites, blacks and colour denoise: monotonic, reversible defaults, luminance kept', () => {
  const lut = buildLuts({ ...ADJUSTMENT_DEFAULTS, whites: 8, blacks: -3 })[0];
  for (let v = 1; v < 256; v += 1) assert.ok(lut[v] >= lut[v - 1], `monotonic at ${v}`);
  const neutral = buildLuts({})[0];
  for (let v = 0; v < 256; v += 1) assert.equal(neutral[v], v, 'defaults are the identity');
  assert.ok(buildLuts({ whites: 40 })[0][230] > 230, 'whites > 0 brightens light tones');
  assert.ok(buildLuts({ whites: -40 })[0][230] < 230);
  assert.ok(buildLuts({ blacks: -40 })[0][20] < 20, 'blacks < 0 deepens dark tones');
  assert.ok(buildLuts({ blacks: 40 })[0][5] > 5);
  // the full grading table keeps pure black from lifting more than a few levels and the order of tones intact
  const g = buildLuts({ exposure: 7.5, brightness: 8, contrast: 5, highlights: -10, shadows: 12, saturation: 3, temperature: 2, whites: 8, blacks: -3 });
  for (let c = 0; c < 3; c += 1) { for (let v = 1; v < 256; v += 1) assert.ok(g[c][v] >= g[c][v - 1]); assert.ok(g[c][0] <= 6, `black stays dark (${g[c][0]})`); }
  assert.ok(g[1][128] > 128 && g[1][128] < 150, `mid-tones lifted a little (${g[1][128]})`);
  // chroma denoise: colour speckle drops, luminance (detail) unchanged
  const px = new Uint8ClampedArray(32 * 32 * 4);
  for (let i = 0; i < 1024; i += 1) { const n = noise(i % 32, (i / 32) | 0); px[i * 4] = 150 + n * 20; px[i * 4 + 1] = 120; px[i * 4 + 2] = 100 - n * 20; px[i * 4 + 3] = 255; }
  const before = px.slice(); chromaDenoise(px, 32, 32, 0.8, 1);
  const chromaVar = (d) => { let s = 0; const vals = []; for (let i = 0; i < 1024; i += 1) vals.push(128 + 0.5 * d[i * 4] - 0.418688 * d[i * 4 + 1] - 0.081312 * d[i * 4 + 2]); const m = vals.reduce((a, b) => a + b) / vals.length; for (const v of vals) s += (v - m) ** 2; return s / vals.length; };
  assert.ok(chromaVar(px) < chromaVar(before) * 0.6, 'colour noise reduced');
  let dY = 0; for (let i = 0; i < 1024; i += 1) dY = Math.max(dY, Math.abs(luma(px, i * 4) - luma(before, i * 4)));
  assert.ok(dY < 1.5, `luminance detail untouched (max ${dY.toFixed(2)})`);
  // applyAdjustments with all-new keys runs and white stays white-ish
  const white = new Uint8ClampedArray([255, 255, 255, 255]);
  applyAdjustments(white, 1, 1, { whites: 8, blacks: -3, denoise: 30 });
  assert.ok(white[0] >= 253);
});

test('shoulder sides report left/right coverage and symmetry; PNG gets an sRGB chunk', () => {
  const sampleLeft = (x) => (x < 500 ? 1 : 0);
  const crop = { cx: 0.5, cy: 0.5, cw: 1, rotation: 0 };
  const s = shoulderSides(crop, 30, 40, 1000, 1333, (x) => sampleLeft(x));
  assert.ok(s.left > 0.9 && s.right < 0.1 && Math.abs(s.frac - 0.5) < 0.1);
  const warn = assessQuality({ metrics: { rollDeg: 0, yaw: 0 }, faceCount: 1, shoulderFrac: s.frac, shoulderSides: s });
  assert.equal(warn.find((q) => q.code === 'SHOULDER_SYMMETRY').level, 'warn');
  const even = shoulderSides(crop, 30, 40, 1000, 1333, () => 1);
  assert.equal(assessQuality({ metrics: { rollDeg: 0, yaw: 0 }, faceCount: 1, shoulderFrac: 1, shoulderSides: even }).find((q) => q.code === 'SHOULDER_SYMMETRY').level, 'ok');
  // minimal valid PNG: signature + IHDR + IDAT(empty-ish) + IEND
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  const chunk = (type, data) => { const out = new Uint8Array(12 + data.length); new DataView(out.buffer).setUint32(0, data.length); out.set([...type].map((c) => c.charCodeAt(0)), 4); out.set(data, 8); return out; };
  const ihdr = new Uint8Array(13); new DataView(ihdr.buffer).setUint32(0, 1); new DataView(ihdr.buffer).setUint32(4, 1); ihdr[8] = 8; ihdr[9] = 2;
  const png = new Uint8Array([...sig, ...chunk('IHDR', ihdr), ...chunk('IDAT', new Uint8Array([120, 1, 99, 96, 96, 96, 0, 0, 0, 4, 0, 1])), ...chunk('IEND', new Uint8Array(0))]);
  const tagged = setPngSrgb(setPngDpi(png, 300));
  const text = Buffer.from(tagged).toString('latin1');
  assert.ok(text.includes('sRGB') && text.includes('pHYs'));
  assert.ok(text.indexOf('IHDR') < text.indexOf('sRGB') && text.indexOf('sRGB') < text.indexOf('IDAT'), 'sRGB chunk before the image data');
  assert.ok(Math.abs(readPngPhys(tagged).x * 0.0254 - 300) < 1);
  assert.equal(Buffer.from(setPngSrgb(tagged)).toString('latin1').split('sRGB').length - 1, 1, 'idempotent: one sRGB chunk');
});
