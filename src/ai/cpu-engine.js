// WebGL-free AI engine: the same MediaPipe models (face detector, 478-point face landmarks, selfie multiclass),
// converted to ONNX with tf2onnx and run by ONNX Runtime Web on the WASM (CPU) backend. MediaPipe Tasks needs WebGL
// even on its CPU path; this engine needs only WebAssembly and a 2D canvas, so it also works on PCs without a graphics
// card. The instances mimic the small part of the MediaPipe API the app uses (segment / detect), so the rest of the
// pipeline is unchanged. Measured against MediaPipe on real portraits: 99.8 % of mask pixels agree, landmarks within
// ~0.4 px (see tools/convert-cpu-models.md).
import { makeCanvas } from '../platform/image.js';

export const CPU_FILES = Object.freeze({
  segmenter: { path: 'models/onnx-cpu/selfie_multiclass_256x256.onnx', sha256: '8dab3c2447c0eb4b72c396d6d67e6ca83c87c1089a7d829b89412c72ce93f0b3' },
  detector: { path: 'models/onnx-cpu/face_detector.onnx', sha256: '56e25b8b125cb97a2ff8e52f8fdd5de8b374a452e33857197523406f60f48930' },
  landmarks: { path: 'models/onnx-cpu/face_landmarks_detector.onnx', sha256: '45416dffb4d6b5629ce11e0f3ff6c64ec27cad1cf86f120cce1ba63dc6e0052e' },
});

const dims = (img) => ({ w: img.naturalWidth || img.videoWidth || img.width, h: img.naturalHeight || img.videoHeight || img.height });

function ctx2d(c) {
  const cx = c.getContext('2d', { willReadFrequently: true });
  cx.imageSmoothingEnabled = true;
  cx.imageSmoothingQuality = 'high';
  return cx;
}

/** RGB pixels of a canvas as NHWC float32, mapped to [lo, hi]. */
function toTensorData(cx, size, lo, hi) {
  const d = cx.getImageData(0, 0, size, size).data;
  const out = new Float32Array(size * size * 3);
  const k = (hi - lo) / 255;
  for (let i = 0, j = 0; i < d.length; i += 4, j += 3) {
    out[j] = d[i] * k + lo; out[j + 1] = d[i + 1] * k + lo; out[j + 2] = d[i + 2] * k + lo;
  }
  return out;
}

/** Bilinear resize of one float plane (sw×sh → dw×dh), pixel-centre aligned. */
export function resizePlane(src, sw, sh, dw, dh) {
  const out = new Float32Array(dw * dh);
  const fx = sw / dw; const fy = sh / dh;
  for (let y = 0; y < dh; y += 1) {
    const sy = Math.min(sh - 1, Math.max(0, (y + 0.5) * fy - 0.5));
    const y0 = Math.floor(sy); const y1 = Math.min(sh - 1, y0 + 1); const wy = sy - y0;
    for (let x = 0; x < dw; x += 1) {
      const sx = Math.min(sw - 1, Math.max(0, (x + 0.5) * fx - 0.5));
      const x0 = Math.floor(sx); const x1 = Math.min(sw - 1, x0 + 1); const wx = sx - x0;
      const a = src[y0 * sw + x0] * (1 - wx) + src[y0 * sw + x1] * wx;
      const b = src[y1 * sw + x0] * (1 - wx) + src[y1 * sw + x1] * wx;
      out[y * dw + x] = a * (1 - wy) + b * wy;
    }
  }
  return out;
}

/** Per-pixel softmax over the class axis of an NHWC [h*w*c] logit tensor → c planes of h*w. */
export function softmaxPlanes(logits, n, c) {
  const planes = Array.from({ length: c }, () => new Float32Array(n));
  for (let i = 0; i < n; i += 1) {
    let m = -Infinity;
    for (let k = 0; k < c; k += 1) m = Math.max(m, logits[i * c + k]);
    let s = 0;
    for (let k = 0; k < c; k += 1) { const e = Math.exp(logits[i * c + k] - m); planes[k][i] = e; s += e; }
    for (let k = 0; k < c; k += 1) planes[k][i] /= s;
  }
  return planes;
}

/* ------------------------------------------------------------ segmentation */

export function createCpuSegmenter(ort, session) {
  const S = 256;
  const canvas = makeCanvas(S, S);
  const cx = ctx2d(canvas);
  return {
    engine: 'onnx-cpu',
    async segment(image) {
      const { w, h } = dims(image);
      cx.clearRect(0, 0, S, S);
      cx.drawImage(image, 0, 0, S, S);
      const input = toTensorData(cx, S, -1, 1);
      const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', input, [1, S, S, 3]) });
      const t = out[session.outputNames[0]];
      const classes = t.dims[t.dims.length - 1];
      const planes = softmaxPlanes(t.data, S * S, classes);
      // MediaPipe returns the confidence masks at the input image size
      const masks = planes.map((p) => {
        let full = null;
        return { width: w, height: h, getAsFloat32Array: () => (full ||= resizePlane(p, S, S, w, h)), close() {} };
      });
      return { confidenceMasks: masks, close() {} };
    },
    close() { session.release?.(); },
  };
}

/* ------------------------------------------------------------ face */

/** The 896 SSD anchors of MediaPipe's short-range face detector (128×128, strides 8 and 16). */
export function faceAnchors() {
  const out = [];
  for (const [stride, n] of [[8, 2], [16, 6]]) {
    const g = 128 / stride;
    for (let y = 0; y < g; y += 1) for (let x = 0; x < g; x += 1) for (let k = 0; k < n; k += 1) out.push([(x + 0.5) / g, (y + 0.5) / g]);
  }
  return out;
}
const ANCHORS = faceAnchors();
const sigmoid = (v) => 1 / (1 + Math.exp(-Math.max(-100, Math.min(100, v))));

function iou(a, b) {
  const x0 = Math.max(a.x0, b.x0); const y0 = Math.max(a.y0, b.y0); const x1 = Math.min(a.x1, b.x1); const y1 = Math.min(a.y1, b.y1);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const u = (a.x1 - a.x0) * (a.y1 - a.y0) + (b.x1 - b.x0) * (b.y1 - b.y0) - inter;
  return u > 0 ? inter / u : 0;
}

/**
 * Decode detector output into faces in image pixels (score, box centre/size, 6 keypoints), with NMS.
 * `side`, `ox`, `oy` describe the letterbox (square of `side` px, image placed at ox, oy).
 */
export function decodeFaces(reg, cls, side, ox, oy, { threshold = 0.5, maxFaces = 3, iouLimit = 0.3 } = {}) {
  const cands = [];
  for (let i = 0; i < ANCHORS.length; i += 1) {
    const score = sigmoid(cls[i]);
    if (score < threshold) continue;
    const [ax, ay] = ANCHORS[i];
    const r = (k) => reg[i * 16 + k] / 128;
    const cx = (r(0) + ax) * side - ox; const cy = (r(1) + ay) * side - oy;
    const bw = r(2) * side; const bh = r(3) * side;
    const kps = [];
    for (let k = 0; k < 6; k += 1) kps.push([(r(4 + 2 * k) + ax) * side - ox, (r(5 + 2 * k) + ay) * side - oy]);
    cands.push({ score, cx, cy, bw, bh, kps, x0: cx - bw / 2, y0: cy - bh / 2, x1: cx + bw / 2, y1: cy + bh / 2 });
  }
  cands.sort((a, b) => b.score - a.score);
  const kept = [];
  for (const c of cands) {
    if (kept.every((k) => iou(k, c) <= iouLimit)) kept.push(c);
    if (kept.length >= maxFaces) break;
  }
  return kept;
}

/**
 * Region for the landmark model, as MediaPipe builds it: square of 1.5 × the larger box side around the box centre,
 * rotated so the eyes are level. Returns the affine map from crop pixels (u, v) to image pixels (x, y).
 */
export function faceRoi(face, out = 256, scale = 1.5) {
  const [[rx, ry], [lx, ly]] = face.kps; // right eye, left eye
  let rot = -Math.atan2(-(ly - ry), lx - rx);
  rot -= 2 * Math.PI * Math.floor((rot + Math.PI) / (2 * Math.PI));
  const size = Math.max(face.bw, face.bh) * scale;
  const c = Math.cos(rot); const s = Math.sin(rot); const k = size / out;
  const a = c * k; const b = -s * k; const d = s * k; const e = c * k;
  const c0 = face.cx - (a + b) * out / 2; const f0 = face.cy - (d + e) * out / 2;
  return { a, b, c0, d, e, f0 };
}

export function createCpuFaceLandmarker(ort, detSession, lmkSession, { numFaces = 3 } = {}) {
  const D = 128; const L = 256;
  const dc = makeCanvas(D, D); const dcx = ctx2d(dc);
  const lc = makeCanvas(L, L); const lcx = ctx2d(lc);
  return {
    engine: 'onnx-cpu',
    async detect(image) {
      const { w, h } = dims(image);
      const side = Math.max(w, h); const ox = Math.floor((side - w) / 2); const oy = Math.floor((side - h) / 2);
      dcx.setTransform(1, 0, 0, 1, 0, 0);
      dcx.fillStyle = '#000'; dcx.fillRect(0, 0, D, D);
      dcx.drawImage(image, (ox * D) / side, (oy * D) / side, (w * D) / side, (h * D) / side);
      const det = await detSession.run({ [detSession.inputNames[0]]: new ort.Tensor('float32', toTensorData(dcx, D, -1, 1), [1, D, D, 3]) });
      const byName = (n) => det[n] || det[detSession.outputNames.find((o) => o.includes(n))];
      const reg = (byName('regressors') || det[detSession.outputNames[0]]).data;
      const cls = (byName('classificators') || det[detSession.outputNames[1]]).data;
      const faces = decodeFaces(reg, cls, side, ox, oy, { maxFaces: numFaces });
      const faceLandmarks = [];
      for (const f of faces) {
        const m = faceRoi(f, L);
        // canvas transform = inverse of (crop → image)
        const det2 = m.a * m.e - m.b * m.d;
        lcx.setTransform(1, 0, 0, 1, 0, 0);
        lcx.fillStyle = '#000'; lcx.fillRect(0, 0, L, L);
        lcx.setTransform(m.e / det2, -m.d / det2, -m.b / det2, m.a / det2, (-m.e * m.c0 + m.b * m.f0) / det2, (m.d * m.c0 - m.a * m.f0) / det2);
        lcx.drawImage(image, 0, 0, w, h);
        lcx.setTransform(1, 0, 0, 1, 0, 0);
        const out = await lmkSession.run({ [lmkSession.inputNames[0]]: new ort.Tensor('float32', toTensorData(lcx, L, 0, 1), [1, L, L, 3]) });
        const names = lmkSession.outputNames;
        const pts = names.map((n) => out[n]).find((t) => t.data.length === 1434);
        const presT = names.map((n) => out[n]).find((t) => t.data.length === 1 && t.dims.length === 4) || names.map((n) => out[n]).find((t) => t.data.length === 1);
        if (!pts || (presT && sigmoid(presT.data[0]) < 0.5)) continue;
        const lm = [];
        for (let i = 0; i < 478; i += 1) {
          const u = pts.data[i * 3]; const v = pts.data[i * 3 + 1];
          lm.push({ x: (m.a * u + m.b * v + m.c0) / w, y: (m.d * u + m.e * v + m.f0) / h, z: pts.data[i * 3 + 2] / L });
        }
        faceLandmarks.push(lm);
      }
      return { faceLandmarks };
    },
    close() { detSession.release?.(); lmkSession.release?.(); },
  };
}
