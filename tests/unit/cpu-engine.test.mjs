import test from 'node:test';
import assert from 'node:assert/strict';
import { faceAnchors, decodeFaces, faceRoi, softmaxPlanes, resizePlane, CPU_FILES } from '../../src/ai/cpu-engine.js';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

test('the bundled ONNX files match the checksums the app verifies', () => {
  for (const f of Object.values(CPU_FILES)) {
    const h = createHash('sha256').update(readFileSync(new URL(`../../${f.path}`, import.meta.url))).digest('hex');
    assert.equal(h, f.sha256, f.path);
  }
});

test('face detector anchors: 896 in MediaPipe order (16×16×2 then 8×8×6)', () => {
  const a = faceAnchors();
  assert.equal(a.length, 896);
  assert.deepEqual(a[0], [1 / 32, 1 / 32]);
  assert.deepEqual(a[1], [1 / 32, 1 / 32]);
  assert.deepEqual(a[512], [1 / 16, 1 / 16]);
  assert.deepEqual(a[895], [15 / 16, 15 / 16]);
});

test('detections are decoded into image pixels, with NMS and a score threshold', () => {
  const reg = new Float32Array(896 * 16); const cls = new Float32Array(896).fill(-10);
  // anchor 600 (stride 16) holds one face: 40×40 px box (of 128) shifted +4 px, eyes level
  const i = 600; const set = (k, v) => { reg[i * 16 + k] = v; };
  set(0, 4); set(1, 0); set(2, 40); set(3, 40); set(4, -6); set(5, -4); set(6, 14); set(7, -4);
  cls[i] = 5; cls[i + 1] = 4; reg.set(reg.subarray(i * 16, i * 16 + 16), (i + 1) * 16); // same face twice → NMS keeps one
  const side = 512; const ox = 0; const oy = 64; // 512×384 image letterboxed into a 512 square
  const faces = decodeFaces(reg, cls, side, ox, oy);
  assert.equal(faces.length, 1);
  const a = faceAnchors()[i];
  assert.ok(Math.abs(faces[0].cx - ((4 / 128 + a[0]) * side - ox)) < 1e-3);
  assert.ok(Math.abs(faces[0].cy - (a[1] * side - oy)) < 1e-3);
  assert.ok(Math.abs(faces[0].bw - 160) < 1e-3);
  assert.equal(decodeFaces(reg, new Float32Array(896).fill(-10), side, ox, oy).length, 0);
});

test('the landmark region is 1.5× the face box, centred, and level for level eyes', () => {
  const face = { cx: 200, cy: 150, bw: 100, bh: 80, kps: [[180, 140], [220, 140]] };
  const m = faceRoi(face, 256);
  const map = (u, v) => [m.a * u + m.b * v + m.c0, m.d * u + m.e * v + m.f0];
  const [x, y] = map(128, 128);
  assert.ok(Math.abs(x - 200) < 1e-9 && Math.abs(y - 150) < 1e-9, 'centre');
  assert.ok(Math.abs(m.b) < 1e-12 && Math.abs(m.d) < 1e-12, 'no rotation');
  assert.ok(Math.abs(m.a * 256 - 150) < 1e-9, 'side = 1.5 × 100');
  const tilted = faceRoi({ ...face, kps: [[180, 160], [220, 120]] }, 256); // head tilted 45°
  assert.ok(Math.abs(Math.atan2(tilted.d, tilted.a) + Math.PI / 4) < 1e-9, 'rotated with the eyes');
});

test('softmax planes sum to one; bilinear resize keeps constants and corners', () => {
  const p = softmaxPlanes(new Float32Array([1, 2, 3, 0, 0, 0]), 2, 3);
  for (let i = 0; i < 2; i += 1) assert.ok(Math.abs(p[0][i] + p[1][i] + p[2][i] - 1) < 1e-6);
  assert.ok(p[2][0] > p[1][0] && p[1][0] > p[0][0]);
  const c = resizePlane(new Float32Array(16).fill(0.25), 4, 4, 9, 7);
  assert.ok(c.every((v) => Math.abs(v - 0.25) < 1e-7));
  const r = resizePlane(new Float32Array([0, 1, 0, 1]), 2, 2, 4, 4);
  assert.equal(r[0], 0); assert.equal(r[3], 1);
});
