import test from 'node:test';
import assert from 'node:assert/strict';
import { DIPLOMAT_GEOMETRY, measureNeck, fitCollar } from '../../src/core/suitfit.js';

const W = 1000; const H = 1400; const mw = 250; const mh = 350;
const metrics = (roll = 0) => ({ eyeMid: { x: 500, y: 500 }, rollDeg: roll, faceWidth: 300, chinV: 260, faceCenterU: 0 });
/** Skin map with a neck of the given width and centre offset (photo px) from below the chin to `bottom`. */
function neckMask(width, offset, bottom) {
  const m = new Uint8Array(mw * mh);
  for (let y = 0; y < mh; y += 1) for (let x = 0; x < mw; x += 1) { const px = (x + 0.5) * (W / mw); const py = (y + 0.5) * (H / mh); if (py > 700 && py < bottom && Math.abs(px - (500 + offset)) < width / 2) m[y * mw + x] = 255; }
  return m;
}

test('neck is measured: width, centre and where its skin ends', () => {
  const n = measureNeck(neckMask(240, 30, 950), mw, mh, W, H, metrics());
  assert.ok(Math.abs(n.width - 240) < 14, `width ${n.width}`);
  assert.ok(Math.abs(n.centerU - 30) < 8, `centre ${n.centerU}`);
  assert.ok(Math.abs(500 + n.bottomV - 950) < 12, `bottom ${n.bottomV}`);
  assert.equal(measureNeck(new Uint8Array(mw * mh), mw, mh, W, H, metrics()), null, 'no skin below the chin');
});

test('collar is sized to the neck, centred on it, and keeps skin in its opening', () => {
  const m = metrics(); const aspect = 768 / 1024; const g = DIPLOMAT_GEOMETRY;
  const wide = fitCollar(m, W, H, g, aspect, { width: 280, centerU: 0, bottomV: 500 });
  const thin = fitCollar(m, W, H, g, aspect, { width: 200, centerU: 0, bottomV: 500 });
  assert.ok(wide.width > thin.width, 'a wider neck gets a wider suit');
  assert.ok(Math.abs(wide.width * W * g.opening - 280 * 1.1) < 1, 'opening = neck width + 10 %');
  for (const f of [wide, thin]) assert.ok(f.width * W >= 2.05 * 300 - 1e-6 && f.width * W <= 2.95 * 300 + 1e-6, 'within the proportions of the face');
  assert.ok(Math.abs(wide.y * H - (500 + 260 + 0.16 * 300)) < 1e-6, 'tips just below the chin line');
  const off = fitCollar(m, W, H, g, aspect, { width: 240, centerU: 40, bottomV: 500 });
  assert.ok(off.x * W > 500 + 20 && off.x * W <= 500 + 40, 'follows the neck sideways (the body), not only the face');
  const short = fitCollar(m, W, H, g, aspect, { width: 240, centerU: 0, bottomV: 330 });
  assert.ok(short.tipsV < wide.tipsV && short.tipsV >= 260 + 0.05 * 300 - 1e-6, 'a short visible neck raises the collar, never above the chin');
  const none = fitCollar(m, W, H, g, aspect, null);
  assert.equal(none.source, 'proportion'); assert.ok(Math.abs(none.neckWidth - 240) < 1e-6);
  const rolled = fitCollar(metrics(10), W, H, g, aspect, null);
  assert.equal(rolled.rotation, 10); assert.ok(rolled.x * W < 500, 'placed along the tilted face axis');
});
