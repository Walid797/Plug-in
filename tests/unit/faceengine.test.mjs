import test from 'node:test';
import assert from 'node:assert/strict';
import { applyFaceEngine, faceEllipse, ellipseToOutput, REDNESS_LIMIT, FACE_ENGINE_DEFAULTS, skinDetailWeight, healDiscs } from '../../src/core/faceengine.js';
import { fixesToDiscs } from '../../src/render/renderPhoto.js';
import { buildLuts, applyAdjustments, chromaDenoise, localContrast, snapNearWhite, ADJUSTMENT_DEFAULTS } from '../../src/core/adjust.js';
import { suggestCrop, evaluateCrop, faceMetrics, shoulderSides, assessQuality, exposureTowardTarget, backgroundWhiteness, faceProtectZones } from '../../src/core/idphoto.js';
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

test('clarity and sharpening: crisp hair, calmer skin, luminance only, no colour shifts', () => {
  // image: left half "hair" (dark brown, high-frequency stripes), right half skin with the same stripes
  const w = 120; const h = 80;
  const make = (rgbA, rgbB) => {
    const d = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 4; const hair = x < 60; const stripe = ((x >> 1) + (y >> 1)) % 2 === 0;
      const base = hair ? [92, 66, 48] : [224, 172, 150];
      const k = stripe ? 8 : -8;
      d[i] = base[0] + k; d[i + 1] = base[1] + k; d[i + 2] = base[2] + k; d[i + 3] = 255;
    }
    return d;
  };
  const src = make();
  const ell = { cx: 90, cy: 40, rx: 26, ry: 34, rot: 0 };
  const weight = skinDetailWeight(src, w, h, ell, 0.3);
  assert.ok(weight, 'skin cluster measured');
  const at = (x, y) => weight[y * w + x];
  assert.ok(at(30, 40) > 0.8, `hair gets (nearly) full detail (${at(30, 40).toFixed(2)})`);
  assert.ok(at(90, 40) < 0.45, `skin gets reduced detail (${at(90, 40).toFixed(2)})`);
  const amp = (d, x0, x1) => { let s = 0; let n = 0; for (let y = 10; y < h - 10; y += 1) for (let x = x0; x < x1; x += 1) { const i = (y * w + x) * 4; s += Math.abs(luma(d, i) - luma(d, i + ((x % 2 ? 1 : -1) * 8)));
    n += 1; } return s / n; };
  void amp;
  const contrast = (d, x0, x1) => { const v = []; for (let y = 10; y < h - 10; y += 1) for (let x = x0; x < x1; x += 1) v.push(luma(d, (y * w + x) * 4)); const m = v.reduce((a, b) => a + b) / v.length; return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length); };
  const plain = src.slice(); applyAdjustments(plain, w, h, { clarity: 70 }, { scale: 1 });
  const weighted = src.slice(); applyAdjustments(weighted, w, h, { clarity: 70 }, { scale: 1, detailWeight: weight });
  const c0 = { hair: contrast(src, 10, 50), skin: contrast(src, 70, 110) };
  const cp = { hair: contrast(plain, 10, 50), skin: contrast(plain, 70, 110) };
  const cw = { hair: contrast(weighted, 10, 50), skin: contrast(weighted, 70, 110) };
  assert.ok(cp.hair > c0.hair * 1.1 && cp.skin > c0.skin * 1.1, 'unweighted clarity boosts both');
  assert.ok(cw.hair > c0.hair * 1.1, `hair detail still boosted with the weight map (${c0.hair.toFixed(1)} → ${cw.hair.toFixed(1)})`);
  assert.ok(cw.skin - c0.skin < (cp.skin - c0.skin) * 0.6, `skin boost is much smaller (${(cw.skin - c0.skin).toFixed(1)} vs ${(cp.skin - c0.skin).toFixed(1)})`);
  // colour is untouched: the same amount is added to R, G and B
  for (let i = 0; i < w * h * 4; i += 4) {
    const dr = plain[i] - src[i]; const dg = plain[i + 1] - src[i + 1]; const db = plain[i + 2] - src[i + 2];
    if (plain[i] > 0 && plain[i] < 255 && plain[i + 1] > 0 && plain[i + 1] < 255 && plain[i + 2] > 0 && plain[i + 2] < 255) assert.ok(Math.abs(dr - dg) <= 1 && Math.abs(dg - db) <= 1, 'equal change in all channels');
  }
  // flat areas stay flat, amount 0 is a no-op, a missing skin cluster gives no weights
  const flat = new Uint8ClampedArray(w * h * 4).fill(150); for (let i = 3; i < flat.length; i += 4) flat[i] = 255;
  const f2 = flat.slice(); localContrast(f2, w, h, 1, 1); assert.deepEqual(f2, flat);
  const same = src.slice(); applyAdjustments(same, w, h, { clarity: 0 }, {}); assert.deepEqual(same, src);
  assert.equal(skinDetailWeight(flat, w, h, ell), null);
});

test('exposure toward the reference brightness: capped at +0.5 EV, never above the target, dark skin not whitened', () => {
  assert.equal(exposureTowardTarget(0.66), 0); assert.equal(exposureTowardTarget(0.65), 0); assert.equal(exposureTowardTarget(0.8), 0);
  assert.equal(exposureTowardTarget(NaN), 0); assert.equal(exposureTowardTarget(0), 0);
  const mid = exposureTowardTarget(0.56);
  assert.ok(mid > 0 && mid <= 25, `${mid}`);
  for (const L of [0.3, 0.4, 0.5, 0.6]) assert.ok(exposureTowardTarget(L) <= 25, 'never more than +0.5 EV (slider 25)');
  assert.ok(exposureTowardTarget(0.4) >= exposureTowardTarget(0.6), 'darker faces get at least as much');
  // applying it to a dark-skinned face does not push it to the reference brightness
  const lin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4); const srgb = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
  const afterL = srgb(lin(0.35) * 2 ** ((exposureTowardTarget(0.35) / 100) * 2));
  assert.ok(afterL < 0.5, `a face at 0.35 stays dark (${afterL.toFixed(2)})`);
});

test('background whiteness: a clean white backdrop is left alone, a coloured wall is not', () => {
  const w = 100; const h = 130;
  const frame = (bg) => { const d = new Uint8ClampedArray(w * h * 4); for (let i = 0; i < d.length; i += 4) { d[i] = bg[0]; d[i + 1] = bg[1]; d[i + 2] = bg[2]; d[i + 3] = 255; }
    for (let y = 40; y < h; y += 1) for (let x = 25; x < 75; x += 1) { const i = (y * w + x) * 4; d[i] = 60; d[i + 1] = 45; d[i + 2] = 40; } return d; };
  assert.equal(backgroundWhiteness(frame([254, 254, 254]), w, h).white, true, 'white backdrop with a person in the middle');
  assert.equal(backgroundWhiteness(frame([226, 238, 247]), w, h).white, false, 'light-blue wall (the studio\'s original photo)');
  assert.equal(backgroundWhiteness(frame([236, 236, 236]), w, h).white, false, 'grey-white backdrop is not clean white');
  const noisy = frame([250, 250, 250]); for (let i = 0; i < 4 * w * 6; i += 4) { const v = i % 8 ? 215 : 255; noisy[i] = v; noisy[i + 1] = v; noisy[i + 2] = v; }
  assert.equal(backgroundWhiteness(noisy, w, h).white, false, 'uneven backdrop (shadow/stains) is replaced');
});

test('white snap: neutral near-white becomes pure white; skin, blue shirt and mid-greys are untouched', () => {
  const px = new Uint8ClampedArray([251, 252, 250, 255,  253, 253, 253, 255,  224, 229, 248, 255,  232, 188, 168, 255,  200, 200, 200, 255,  242, 242, 242, 255,  255, 255, 255, 255]);
  snapNearWhite(px);
  assert.deepEqual([...px.slice(0, 3)], [255, 255, 255], 'backdrop at 251-253 -> 255');
  assert.deepEqual([...px.slice(4, 7)], [255, 255, 255]);
  assert.deepEqual([...px.slice(8, 11)], [224, 229, 248], 'light-blue shirt untouched');
  assert.deepEqual([...px.slice(12, 15)], [232, 188, 168], 'skin untouched');
  assert.deepEqual([...px.slice(16, 19)], [200, 200, 200], 'grey untouched');
  assert.ok(px[20] > 242 && px[20] < 255, 'in-between values blend smoothly (hair edge fringes stay natural)');
  assert.equal(px[24], 255);
  assert.deepEqual([...px.filter((_, i) => i % 4 === 3)], Array(7).fill(255), 'alpha untouched');
});

test('lift: brightens mid-tones and lights but spares the darks; identity at 0; monotonic', () => {
  const id = buildLuts({})[0]; const l0 = buildLuts({ lift: 0 })[0];
  for (let v = 0; v < 256; v += 1) assert.equal(l0[v], id[v], 'lift 0 is the identity');
  const lift = buildLuts({ lift: 25 })[0]; const exposure = buildLuts({ exposure: 25 })[0];
  for (let v = 1; v < 256; v += 1) assert.ok(lift[v] >= lift[v - 1], `monotonic at ${v}`);
  assert.ok(lift[40] - 40 <= 3, `dark hair tones barely move (${lift[40]})`);
  assert.ok(lift[40] - 40 < (exposure[40] - 40) * 0.25, 'much less than an ordinary exposure on the darks');
  assert.ok(lift[190] - 190 > 12, `skin/shirt tones are lifted (${lift[190]})`);
  assert.ok(Math.abs(lift[190] - exposure[190]) <= 4, 'on the lights it equals the exposure');
  assert.equal(lift[255], 255); assert.equal(lift[0], 0);
});

/** Textured synthetic skin with optional blemishes, thin hairs, a stubble cluster and a shadow band. */
function skinWith(opts = {}) {
  const w = 360; const h = 470; const ell = { cx: 180, cy: 230, rx: 150, ry: 200, rot: 0 };
  const d = new Uint8ClampedArray(w * h * 4).fill(255);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
    const u = (x - ell.cx) / ell.rx; const v = (y - ell.cy) / ell.ry; if (u * u + v * v > 1) continue;
    const i = (y * w + x) * 4; const t = noise(x, y) * 4; d[i] = 224 + t; d[i + 1] = 172 + t; d[i + 2] = 150 + t;
  }
  const disc = (cx, cy, r, rgb) => { for (let y = cy - r; y <= cy + r; y += 1) for (let x = cx - r; x <= cx + r; x += 1) if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) { const i = (y * w + x) * 4; d[i] = rgb[0]; d[i + 1] = rgb[1]; d[i + 2] = rgb[2]; } };
  const spots = [[120, 260, 4, [185, 95, 75]], [250, 250, 3, [150, 100, 80]], [180, 180, 2, [200, 140, 120]], [230, 330, 5, [170, 90, 70]]];
  for (const [x, y, r, c] of spots) disc(x, y, r, c);
  // thin hairs (mustache-like): 1-2 px wide diagonal and horizontal strokes
  const hairs = [];
  // separate strands (strands that cross or clump are a known limit, see docs)
  for (let k = 0; k < 10; k += 1) { const x0 = 140 + k * 10; for (let s = 0; s < 22; s += 1) { const x = x0 + s; const y = 300 + ((s * (k % 3 + 1)) >> 2); const i = (y * w + x) * 4; d[i] = 72; d[i + 1] = 54; d[i + 2] = 46; hairs.push([x, y]); if (k % 2) { const j = ((y + 1) * w + x) * 4; d[j] = 72; d[j + 1] = 54; d[j + 2] = 46; hairs.push([x, y + 1]); } } }
  // dense stubble: a patch full of small dark dots
  const stubble = [];
  for (let y = 380; y < 420; y += 1) for (let x = 140; x < 220; x += 1) if (noise(x * 3, y * 5) > 0.55) { disc(x, y, 1, [96, 74, 64]); stubble.push([x, y]); }
  return { d, w, h, ell, spots, hairs, stubble };
}
const P = (img, x, y) => [0, 1, 2].map((c) => img.d[(y * img.w + x) * 4 + c]);
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const SPOT_ONLY = { skin: { enabled: true, redness: 0, balance: 0, spots: 100 }, light: { enabled: false } };

test('spot healing: pimples, marks and stains take the colour AND texture of the skin around them', () => {
  const img = skinWith(); const orig = img.d.slice();
  const rep = applyFaceEngine(img.d, img.w, img.h, img.ell, SPOT_ONLY);
  assert.equal(rep.applied, true); assert.ok(rep.spotsFrac > 0);
  const skin = [224, 172, 150];
  for (const [x, y, r, c] of img.spots) {
    const before = dist(c, skin); const after = dist(P(img, x, y), skin);
    const faint = before < 70; // a faint spot is only faded, a clear blemish is healed completely
    assert.ok(faint ? after < before * 0.75 : after < before * 0.25 && after < 22, `spot ${x},${y}: distance to skin ${before.toFixed(0)} -> ${after.toFixed(0)}`);
  }
  // realistic: the healed patch is not a flat fill (it carries skin grain), and far-away skin is bit-identical
  const patch = []; for (let y = 256; y <= 264; y += 1) for (let x = 116; x <= 124; x += 1) patch.push(luma(img.d, (y * img.w + x) * 4));
  const m = patch.reduce((a, b) => a + b) / patch.length; const sd = Math.sqrt(patch.reduce((a, b) => a + (b - m) ** 2, 0) / patch.length);
  assert.ok(sd > 0.8, `healed area keeps grain (std ${sd.toFixed(2)})`);
  for (const [x, y] of [[60, 100], [300, 180], [180, 120], [100, 380], [260, 300]]) {
    const i = (y * img.w + x) * 4; assert.deepEqual([img.d[i], img.d[i + 1], img.d[i + 2]], [orig[i], orig[i + 1], orig[i + 2]], `untouched skin at ${x},${y}`);
  }
});

test('spot healing never touches thin hairs (mustache), dense stubble, or the white background', () => {
  const img = skinWith(); const orig = img.d.slice();
  applyFaceEngine(img.d, img.w, img.h, img.ell, SPOT_ONLY);
  let hairDiff = 0; for (const [x, y] of img.hairs) hairDiff = Math.max(hairDiff, dist(P(img, x, y), [orig[(y * img.w + x) * 4], orig[(y * img.w + x) * 4 + 1], orig[(y * img.w + x) * 4 + 2]]));
  assert.ok(hairDiff <= 8, `hair strokes unchanged (max diff ${hairDiff.toFixed(1)})`);
  let stubDiff = 0; for (const [x, y] of img.stubble) stubDiff = Math.max(stubDiff, dist(P(img, x, y), [96, 74, 64]));
  assert.ok(stubDiff <= 10, `stubble dots stay (max diff ${stubDiff.toFixed(1)})`);
  for (const [x, y] of [[5, 5], [350, 460], [20, 300]]) assert.deepEqual(P(img, x, y), [255, 255, 255]);
});

test('spot healing keeps lips, eyes, brows and the shading; off at strength 0', () => {
  const { d, regions, inside } = portrait([224, 172, 150], { shadow: 0.78 });
  const orig = d.slice();
  applyFaceEngine(d, W, H, ELL, { skin: { enabled: true, redness: 0, balance: 0, spots: 100 }, light: { enabled: false } });
  for (const [name, reg] of Object.entries(regions)) {
    let worst = 0;
    for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) {
      if (!inside(x, y, [reg[0], reg[1], reg[2] - 3, Math.max(1, reg[3] - 2)])) continue;
      const i = (y * W + x) * 4; worst = Math.max(worst, Math.abs(d[i] - orig[i]), Math.abs(d[i + 1] - orig[i + 1]), Math.abs(d[i + 2] - orig[i + 2]));
    }
    assert.ok(worst <= 6, `${name} unchanged by spot healing (max diff ${worst})`);
  }
  // the under-eye / nose shadow bands are structures, not blemishes: still there
  const band = (x, y) => inside(x, y, [86, 118, 16, 5]) || inside(x, y, [134, 118, 16, 5]);
  const cheek = (x, y) => inside(x, y, [70, 150, 12, 10]) || inside(x, y, [150, 150, 12, 10]);
  assert.ok(stats(orig, cheek).Y - stats(d, band).Y > 12, 'the shadow band is not removed');
  assert.ok(Math.abs(stats(d, band).Y - stats(orig, band).Y) < 3, 'shading unchanged');
  const off = portrait([224, 172, 150]); const o2 = off.d.slice();
  applyFaceEngine(off.d, W, H, ELL, { skin: { enabled: true, redness: 0, balance: 0, spots: 0 }, light: { enabled: false } });
  assert.deepEqual(off.d, o2, 'spots 0 = no change');
});

test('protected zones (eyes, mouth, nostrils) are never retouched, the same blob elsewhere is healed', () => {
  const dark = [135, 88, 72];
  const make = () => { const img = skinWith(); const disc = (cx, cy, r) => { for (let y = cy - r; y <= cy + r; y += 1) for (let x = cx - r; x <= cx + r; x += 1) if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) { const i = (y * img.w + x) * 4; img.d[i] = dark[0]; img.d[i + 1] = dark[1]; img.d[i + 2] = dark[2]; } };
    disc(200, 140, 5); disc(100, 200, 5); return img; }; // a nostril-like and an eye-corner-like dark round blob
  const zone = [{ cx: 200, cy: 140, rx: 16, ry: 14, rot: 0 }, { cx: 100, cy: 200, rx: 16, ry: 14, rot: 0 }];
  const a = make(); const oa = a.d.slice();
  applyFaceEngine(a.d, a.w, a.h, a.ell, { ...SPOT_ONLY, protect: zone });
  for (const [x, y] of [[200, 140], [100, 200], [202, 141]]) assert.ok(dist(P(a, x, y), [oa[(y * a.w + x) * 4], oa[(y * a.w + x) * 4 + 1], oa[(y * a.w + x) * 4 + 2]]) <= 6, `protected blob at ${x},${y} unchanged`);
  const b = make();
  applyFaceEngine(b.d, b.w, b.h, b.ell, SPOT_ONLY); // no zones: the same blobs are blemishes
  for (const [x, y] of [[200, 140], [100, 200]]) assert.ok(dist(P(b, x, y), [224, 172, 150]) < 55, `unprotected blob at ${x},${y} is healed (${P(b, x, y)})`);
  // the zones come from the landmarks: both eyes, the mouth and the underside of the nose
  const lm = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5 }));
  const set = (i, x, y) => { lm[i] = { x, y }; };
  set(33, 0.34, 0.4); set(133, 0.45, 0.4); set(263, 0.66, 0.4); set(362, 0.55, 0.4); set(61, 0.4, 0.72); set(291, 0.6, 0.72); set(0, 0.5, 0.7); set(17, 0.5, 0.76); set(98, 0.46, 0.6); set(327, 0.54, 0.6);
  set(70, 0.33, 0.34); set(107, 0.46, 0.35); set(300, 0.67, 0.34); set(336, 0.54, 0.35); set(152, 0.5, 0.86);
  const zones = faceProtectZones(lm, 1000, 1400);
  assert.equal(zones.length, 8, 'eyes x2, mouth, eyebrows x2, mustache band, beard area, nose underside');
  const near = (z, x, y) => Math.abs(z.cx - x) < 0.03 && Math.abs(z.cy - y) < 0.03;
  assert.ok(near(zones[0], 0.395, 0.4) && near(zones[1], 0.605, 0.4), 'eyes'); assert.ok(near(zones[2], 0.5, 0.72), 'mouth'); assert.ok(near(zones[7], 0.5, 0.6), 'nose underside');
  assert.ok(near(zones[3], 0.395, 0.345) && near(zones[4], 0.605, 0.345), 'eyebrows'); assert.ok(near(zones[5], 0.5, 0.66) && near(zones[6], 0.5, 0.81), 'mustache band and beard area');
  assert.ok(zones.every((z) => z.rx > 0 && z.ry > 0));
  assert.deepEqual(faceProtectZones(null, 10, 10), []);
});

test('an elongated stain (a brown smudge) is healed; an equally shaped shadow or crease is not', () => {
  const img = skinWith(); const rect = (x0, y0, w, h, rgb) => { for (let y = y0; y < y0 + h; y += 1) for (let x = x0; x < x0 + w; x += 1) { const i = (y * img.w + x) * 4; img.d[i] = rgb[0]; img.d[i + 1] = rgb[1]; img.d[i + 2] = rgb[2]; } };
  rect(70, 170, 4, 30, [186, 120, 92]); // stain: darker AND browner than the skin (like a mark beside the ear)
  rect(280, 170, 6, 30, [224 * 0.93, 172 * 0.93, 150 * 0.93]); // a soft crease/shadow: only a little darker, same colour
  const orig = img.d.slice();
  applyFaceEngine(img.d, img.w, img.h, img.ell, { ...SPOT_ONLY, protect: [] });
  const skin = [224, 172, 150];
  assert.ok(dist(P(img, 72, 185), skin) < 30, `stain healed (${P(img, 72, 185)})`);
  const crease = [orig[(185 * img.w + 282) * 4], orig[(185 * img.w + 282) * 4 + 1], orig[(185 * img.w + 282) * 4 + 2]];
  assert.ok(dist(P(img, 282, 185), crease) <= 8, 'a soft crease or shadow keeps its shape (it is skin-coloured, so not a stain)');
});

test('repair brush: a painted mark is replaced by real skin texture and nothing else changes', () => {
  const w = 160; const h = 160;
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 4; const t = noise(x, y) * 5;
      d[i] = 226 + t; d[i + 1] = 176 + t; d[i + 2] = 154 + t; d[i + 3] = 255;
    }
  }
  // a dark brown elongated mark (like a smudge by the ear) and a tiny mole
  for (let y = 60; y < 80; y += 1) for (let x = 78; x < 84; x += 1) { const i = (y * w + x) * 4; d[i] = 150; d[i + 1] = 98; d[i + 2] = 80; }
  for (let y = 118; y < 121; y += 1) for (let x = 40; x < 43; x += 1) { const i = (y * w + x) * 4; d[i] = 120; d[i + 1] = 70; d[i + 2] = 50; }
  const orig = d.slice();
  const lum = (a, x, y) => { const i = (y * w + x) * 4; return 0.299 * a[i] + 0.587 * a[i + 1] + 0.114 * a[i + 2]; };
  const r = healDiscs(d, w, h, [{ x: 81, y: 64, r: 8 }, { x: 81, y: 70, r: 8 }, { x: 81, y: 76, r: 8 }, { x: 41.5, y: 119.5, r: 5 }]);
  assert.equal(r.healed, 4); assert.equal(r.skipped, 0);
  for (const [x, y] of [[80, 62], [81, 70], [82, 77], [41, 119]]) assert.ok(Math.abs(lum(d, x, y) - 183) < 14, `mark at ${x},${y} gone (${lum(d, x, y).toFixed(0)})`);
  // far away pixels are bit-identical
  for (const [x, y] of [[5, 5], [150, 150], [120, 30], [20, 100]]) assert.equal(lum(d, x, y), lum(orig, x, y), 'untouched outside the brush');
  // the healed area keeps skin texture (not a flat smear)
  let mean = 0; let n = 0;
  for (let y = 62; y < 78; y += 1) for (let x = 77; x < 85; x += 1) { mean += lum(d, x, y); n += 1; }
  mean /= n; let v = 0;
  for (let y = 62; y < 78; y += 1) for (let x = 77; x < 85; x += 1) v += (lum(d, x, y) - mean) ** 2;
  assert.ok(Math.sqrt(v / n) > 0.8, 'texture is kept');
  // edge cases: off-image and empty input never throw
  assert.deepEqual(healDiscs(d, w, h, []), { healed: 0, skipped: 0 });
  assert.equal(healDiscs(d, w, h, [{ x: -500, y: 10, r: 5 }]).skipped, 1);
});

test('repair brush strokes map to output discs through the crop matrix', () => {
  const M = [2, 0, 0, 2, 10, 20]; // scale 2, offset
  const discs = fixesToDiscs([{ size: 0.01, points: [[0.1, 0.1], [0.1, 0.2]] }], 1000, 1000, M);
  assert.ok(discs.length >= 3, 'sampled along the stroke');
  assert.deepEqual([discs[0].x, discs[0].y], [210, 220]);
  assert.equal(discs[0].r, 20);
  assert.ok(discs.every((p) => p.x === 210));
  assert.equal(fixesToDiscs([], 10, 10, M).length, 0);
  assert.ok(fixesToDiscs(Array.from({ length: 50 }, () => ({ size: 0.004, points: [[0.1, 0.1], [0.9, 0.9]] })), 1000, 1000, M).length <= 600, 'capped');
});

test('complete automatic pass: moles (even in a stubble zone) and a long stain are healed; hairs and protected zones are not, freckles are only faded', () => {
  const img = skinWith(); const orig = img.d.slice();
  const disc = (cx, cy, r, rgb) => { for (let y = cy - r; y <= cy + r; y += 1) for (let x = cx - r; x <= cx + r; x += 1) if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) { const i = (y * img.w + x) * 4; img.d[i] = rgb[0]; img.d[i + 1] = rgb[1]; img.d[i + 2] = rgb[2]; } };
  disc(235, 160, 4, [112, 70, 52]);                       // a mole inside the (soft) mustache zone
  for (let y = 240; y < 266; y += 1) for (let x = 78; x < 85; x += 1) { const i = (y * img.w + x) * 4; img.d[i] = 192; img.d[i + 1] = 128; img.d[i + 2] = 106; } // a brownish smudge 7x26 px
  disc(250, 210, 1, [208, 152, 132]);                     // a faint freckle
  disc(150, 215, 5, [118, 74, 56]);                       // a dark blob inside a protected (eye-like) zone
  const o2 = img.d.slice();
  const protect = [{ cx: 150, cy: 215, rx: 20, ry: 16, rot: 0 }, { cx: 235, cy: 160, rx: 60, ry: 30, rot: 0, soft: true }];
  const rep = applyFaceEngine(img.d, img.w, img.h, img.ell, { ...SPOT_ONLY, protect });
  assert.ok(rep.blemishes >= 2, `blemishes healed (${rep.blemishes})`);
  const skin = [224, 172, 150];
  assert.ok(dist(P(img, 235, 160), skin) < 30, `mole in the stubble zone healed (${P(img, 235, 160)})`);
  assert.ok(dist(P(img, 81, 252), skin) < 30, `long stain healed (${P(img, 81, 252)})`);
  assert.ok(dist(P(img, 150, 215), [118, 74, 56]) < 6, 'a protected zone keeps its mark');
  assert.ok(dist(P(img, 250, 210), skin) > 6, 'a faint freckle is at most faded, never erased (skin character is kept)');
  for (const [x, y] of img.hairs) assert.ok(dist(P(img, x, y), [o2[(y * img.w + x) * 4], o2[(y * img.w + x) * 4 + 1], o2[(y * img.w + x) * 4 + 2]]) <= 8, 'hair untouched');
  for (const [x, y] of [[60, 100], [300, 180], [100, 380]]) assert.deepEqual(P(img, x, y), [orig[(y * img.w + x) * 4], orig[(y * img.w + x) * 4 + 1], orig[(y * img.w + x) * 4 + 2]]);
});

test('automatic pass never damages hair: a mark with hairs touching or right next to it is left completely alone', () => {
  const img = skinWith();
  const disc = (cx, cy, r, rgb) => { for (let y = cy - r; y <= cy + r; y += 1) for (let x = cx - r; x <= cx + r; x += 1) if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) { const i = (y * img.w + x) * 4; img.d[i] = rgb[0]; img.d[i + 1] = rgb[1]; img.d[i + 2] = rgb[2]; } };
  disc(100, 120, 4, [150, 96, 74]);                 // a mole...
  for (let s = 0; s < 14; s += 1) for (const yy of [118 + (s >> 3), 119 + (s >> 3)]) { const i = (yy * img.w + 108 + s) * 4; img.d[i] = 60; img.d[i + 1] = 44; img.d[i + 2] = 38; } // ...with a hair next to it
  disc(260, 130, 4, [150, 96, 74]);                 // the same mole far from any hair
  const before = img.d.slice();
  applyFaceEngine(img.d, img.w, img.h, img.ell, SPOT_ONLY);
  const near = [[100, 120], [104, 120], [96, 120], [112, 119], [118, 121], [108, 118]];
  for (const [x, y] of near) assert.deepEqual(P(img, x, y), [before[(y * img.w + x) * 4], before[(y * img.w + x) * 4 + 1], before[(y * img.w + x) * 4 + 2]], `untouched at ${x},${y}`);
  assert.ok(dist(P(img, 260, 130), [224, 172, 150]) < 30, 'the isolated mole is healed');
});

test('skin smoothing: grain is calmed on the skin, edges (hair, eyes) and the white background stay', () => {
  const img = skinWith(); const orig = img.d.slice();
  const sd = (a, x0, y0, x1, y1) => { const v = []; for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) v.push(0.299 * a[(y * img.w + x) * 4] + 0.587 * a[(y * img.w + x) * 4 + 1] + 0.114 * a[(y * img.w + x) * 4 + 2]); const m = v.reduce((p, q) => p + q) / v.length; return Math.sqrt(v.reduce((p, q) => p + (q - m) ** 2, 0) / v.length); };
  const before = sd(orig, 150, 170, 210, 200);
  const rep = applyFaceEngine(img.d, img.w, img.h, img.ell, { skin: { enabled: true, redness: 0, balance: 0, spots: 0, smooth: 80 }, light: { enabled: false } });
  const after = sd(img.d, 150, 170, 210, 200);
  assert.ok(rep.smoothed > 0.1, `smoothing applied (${rep.smoothed})`);
  assert.ok(after < before * 0.75 && after > 0.1, `grain calmed but not erased (${before.toFixed(2)} -> ${after.toFixed(2)})`);
  for (const [x, y] of img.hairs) assert.ok(dist(P(img, x, y), [orig[(y * img.w + x) * 4], orig[(y * img.w + x) * 4 + 1], orig[(y * img.w + x) * 4 + 2]]) <= 10, 'hair strokes keep their contrast');
  for (const [x, y] of [[5, 5], [350, 460], [20, 300]]) assert.deepEqual(P(img, x, y), [255, 255, 255]);
  const off = skinWith(); const o2 = off.d.slice();
  applyFaceEngine(off.d, off.w, off.h, off.ell, { skin: { enabled: true, redness: 0, balance: 0, spots: 0, smooth: 0 }, light: { enabled: false } });
  assert.deepEqual(off.d, o2, 'smooth 0 = no change');
});

test('lighting engine: a shadow on one side of the face (even a strong one) is flattened, a flat face is left alone', () => {
  // smooth left→right falloff like a side light: gain at the far left 1, at the far right `edge`
  const side = (edge) => {
    const img = skinWith();
    for (let y = 0; y < img.h; y += 1) for (let x = 0; x < img.w; x += 1) {
      const i = (y * img.w + x) * 4; if (img.d[i] === 255 && img.d[i + 1] === 255) continue;
      const t = Math.min(1, Math.max(0, (x - (img.ell.cx - img.ell.rx)) / (2 * img.ell.rx)));
      const g = 1 + (edge - 1) * t; img.d[i] *= g; img.d[i + 1] *= g; img.d[i + 2] *= g;
    }
    return img;
  };
  const third = (img, k) => { let s = 0; let n = 0; const x0 = img.ell.cx - img.ell.rx * 0.9 + k * img.ell.rx * 0.6; for (let y = 150; y < 260; y += 1) for (let x = Math.round(x0); x < Math.round(x0 + img.ell.rx * 0.6); x += 1) { const i = (y * img.w + x) * 4; s += 0.299 * img.d[i] + 0.587 * img.d[i + 1] + 0.114 * img.d[i + 2]; n += 1; } return s / n; };
  const LIGHT = { skin: { enabled: false }, light: { enabled: true, fill: 0, even: true, protect: false } };
  for (const [edge, limit] of [[0.8, 0.06], [0.45, 0.2]]) {
    const img = side(edge);
    const before = third(img, 0) / third(img, 2);
    const rep = applyFaceEngine(img.d, img.w, img.h, img.ell, LIGHT);
    const after = third(img, 0) / third(img, 2);
    assert.ok(before > 1.1 && Math.abs(before - 1) > 2 * Math.abs(after - 1), `shadow ${edge}: before ${before.toFixed(2)}, after ${after.toFixed(2)}`);
    assert.ok(Math.abs(after - 1) < limit, `both sides match within ${limit} (${after.toFixed(2)})`);
    assert.ok(rep.evenGain[0] < 1 && rep.evenGain[1] > 1, 'left dimmed, shadowed right lifted');
  }
  const flat = side(1); const o = flat.d.slice();
  applyFaceEngine(flat.d, flat.w, flat.h, flat.ell, LIGHT);
  let maxd = 0; // a clean patch of cheek (the synthetic face also holds marks, hairs and stubble)
  for (let y = 170; y < 215; y += 1) for (let x = 150; x < 215; x += 1) { const i = (y * flat.w + x) * 4; maxd = Math.max(maxd, Math.abs(o[i] - flat.d[i])); }
  assert.ok(maxd <= 6, `a flat face is hardly changed (max ${maxd})`);
});
