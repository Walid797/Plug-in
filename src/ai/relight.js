// Relight field of a photo's face: prepares the work-frame pixels, class masks and mesh, and runs the pure engine
// (core/relight.js) in the worker. Everything stays on this device; the landmarks are used in memory only.
import { getFace, getPreview, setRelight, clearRelight } from '../state/media.js';
import { ensureClassMasks } from './segment.js';
import { RELIGHT, workMatrix } from '../core/relight.js';
import { drawThrough, maskInOutput, alphaCanvasFromBytes } from '../render/renderPhoto.js';
import { makeCanvas } from '../platform/image.js';
import { runTask } from '../platform/worker.js';

/**
 * Compute and store the relight field for a photo whose face has been analysed.
 * @returns {Promise<object|null>} the engine's report ({sideDiff, gainMax, lightA, ...}) or null when it cannot run
 *   (no face landmarks, no preview, or the class masks could not be made).
 */
export async function ensureRelight(photo) {
  const f = getFace(photo.id);
  const lm = f?.landmarks;
  if (!lm || lm.length < 468) return null;
  const pv = await getPreview(photo);
  if (!pv) return null;
  const cls = await ensureClassMasks(photo).catch((e) => { console.warn('relight: class masks failed', e); return null; });
  if (!cls) return null;
  const { W, H } = RELIGHT;
  const Wm = workMatrix((i) => [lm[i].x * pv.width, lm[i].y * pv.height]);
  if (!Wm) return null;
  const c = makeCanvas(W, H);
  const cx = c.getContext('2d', { willReadFrequently: true });
  cx.fillStyle = '#808080'; cx.fillRect(0, 0, W, H); // outside the picture: neutral, and no person there
  drawThrough(cx, pv.image, pv.width, pv.height, Wm, W, H);
  const rgba = cx.getImageData(0, 0, W, H).data;
  const plane = (bytes) => maskInOutput(alphaCanvasFromBytes(bytes, cls.w, cls.h), pv.width, pv.height, Wm, W, H);
  const sc = Math.hypot(Wm[0], Wm[1]);
  const P = new Float32Array(468 * 2); const Z = new Float32Array(468);
  for (let i = 0; i < 468; i += 1) {
    const x = lm[i].x * pv.width; const y = lm[i].y * pv.height;
    P[i * 2] = Wm[0] * x + Wm[2] * y + Wm[4]; P[i * 2 + 1] = Wm[1] * x + Wm[3] * y + Wm[5];
    Z[i] = (lm[i].z || 0) * pv.width * sc; // depth uses the scale of x
  }
  const { packed, report } = await runTask('relightField', { rgba, skin: plane(cls.skin), hair: plane(cls.hair), clothes: plane(cls.clothes), person: plane(cls.person), P, Z });
  await setRelight(photo.id, packed, { W: Wm, refW: pv.width, refH: pv.height, report });
  return report;
}

export { clearRelight };
