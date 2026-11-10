// Heavy pure computations shared by the worker and the main-thread fallback.
import { refineMask, resizeMask, maskToBytes, lumaFromRGBA } from '../core/mask.js';
import { buildZip } from '../core/binary.js';
import { buildPdf } from '../core/pdf.js';
import { computeRelight, packRelight } from '../core/relight.js';

/**
 * Refine a model mask to edges of the guide image.
 * payload: { mask: Float32Array|Uint8Array, mw, mh, guide: Uint8ClampedArray RGBA (w*h*4), w, h, opts }
 * returns { alpha: Uint8ClampedArray (w*h) }
 */
export function refineMaskOp(payload, progress) {
  const { mask, mw, mh, guide, w, h, opts } = payload;
  const m = mask instanceof Float32Array ? mask : Float32Array.from(mask, (v) => v / 255);
  progress(0.1);
  const up = mw === w && mh === h ? m : resizeMask(m, mw, mh, w, h);
  progress(0.3);
  const luma = guide ? lumaFromRGBA(guide, w, h) : null;
  progress(0.4);
  const refined = refineMask(up, luma, w, h, opts || {});
  progress(0.95);
  return { alpha: maskToBytes(refined) };
}

export function zipOp(payload) {
  return { zip: buildZip(payload.files) };
}

export function pdfOp(payload) {
  return { pdf: buildPdf(payload.doc) };
}

/**
 * Relight field of a face (see core/relight.js). payload: the work-frame pixels, class masks and mesh.
 * returns { packed: Uint8Array, report }
 */
export function relightFieldOp(payload, progress) {
  progress(0.05);
  const field = computeRelight(payload, payload.opt || {});
  progress(0.95);
  return { packed: packRelight(field), report: field.report };
}

export { refineMaskOp as refineMask, zipOp as zip, pdfOp as pdf, relightFieldOp as relightField };
