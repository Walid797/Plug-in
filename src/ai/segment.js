// Person / clothing segmentation with local models.
import { getSegmenter, getModnet, runWithFallback } from './runtime.js';
import { getPreview, setRawMask, setClassMasks, getClassMasks } from '../state/media.js';
import { getState } from '../state/store.js';
import { makeCanvas } from '../platform/image.js';
import { maskStats, plausibleMask, resizeMask } from '../core/mask.js';

function toBytes(f32) {
  const out = new Uint8ClampedArray(f32.length);
  for (let i = 0; i < f32.length; i += 1) out[i] = Math.round(Math.min(1, Math.max(0, f32[i])) * 255);
  return out;
}

export { maskStats, plausibleMask };

/** MediaPipe selfie multiclass: background, hair, body-skin, face-skin, clothes, others. */
async function runMulticlass(pv) {
  return runWithFallback('selfie-multiclass', getSegmenter, (seg) => multiclassOnce(seg, pv), (r) => plausibleMask(r.person));
}

async function multiclassOnce(seg, pv) {
  const res = await seg.segment(pv.image); // MediaPipe answers at once, the WebGL-free ONNX engine asynchronously
  try {
    const masks = res.confidenceMasks || [];
    if (masks.length < 5) throw Object.assign(new Error('BAD_OUTPUT'), { code: 'BAD_OUTPUT' });
    const w = masks[0].width; const h = masks[0].height;
    const bg = masks[0].getAsFloat32Array();
    const clothes = masks[4].getAsFloat32Array();
    const person = new Float32Array(bg.length);
    for (let i = 0; i < bg.length; i += 1) person[i] = 1 - bg[i];
    // small copies of the classes the relight engine needs (hair, skin of face and body): the model works at 256 px anyway
    const k = Math.min(1, 256 / Math.max(w, h)); const cw = Math.max(1, Math.round(w * k)); const ch = Math.max(1, Math.round(h * k));
    const small = (p) => toBytes(resizeMask(p, w, h, cw, ch));
    const skin = new Float32Array(bg.length); const body = masks[2].getAsFloat32Array(); const faceSkin = masks[3].getAsFloat32Array();
    for (let i = 0; i < bg.length; i += 1) skin[i] = body[i] + faceSkin[i];
    const classes = { w: cw, h: ch, person: small(person), clothes: small(clothes), hair: small(masks[1].getAsFloat32Array()), skin: small(skin) };
    return { person: toBytes(person), clothes: toBytes(clothes), w, h, classes };
  } finally {
    res.close?.();
  }
}

/** MODNet portrait matting through ONNX Runtime Web (WebGPU or WASM). */
async function runModnet(pv) {
  const { ort, session } = await getModnet();
  const ref = 512;
  let rw; let rh;
  if (pv.width >= pv.height) { rh = ref; rw = Math.round((pv.width * ref) / pv.height); } else { rw = ref; rh = Math.round((pv.height * ref) / pv.width); }
  rw -= rw % 32; rh -= rh % 32;
  const c = makeCanvas(rw, rh);
  const cx = c.getContext('2d', { willReadFrequently: true });
  cx.drawImage(pv.image, 0, 0, rw, rh);
  const d = cx.getImageData(0, 0, rw, rh).data;
  const n = rw * rh;
  const input = new Float32Array(3 * n);
  for (let i = 0; i < n; i += 1) {
    input[i] = (d[i * 4] / 255 - 0.5) / 0.5;
    input[n + i] = (d[i * 4 + 1] / 255 - 0.5) / 0.5;
    input[2 * n + i] = (d[i * 4 + 2] / 255 - 0.5) / 0.5;
  }
  const feeds = { [session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, rh, rw]) };
  const out = await session.run(feeds);
  const t = out[session.outputNames[0]];
  const dims = t.dims;
  const oh = dims[dims.length - 2]; const ow = dims[dims.length - 1];
  if (ow * oh !== t.data.length) throw Object.assign(new Error('BAD_OUTPUT'), { code: 'BAD_OUTPUT' });
  return { person: toBytes(t.data), w: ow, h: oh };
}

export function chooseSegModel() {
  const s = getState();
  const pref = s.settings.segModel;
  const modnetOk = ['available', 'ready'].includes(s.models.modnet?.status);
  if (pref === 'modnet' && modnetOk) return 'modnet';
  if (pref === 'auto' && modnetOk) return 'modnet';
  return 'selfie-multiclass';
}

/**
 * Segment a photo. Stores raw person and clothing masks for later refinement.
 * @returns {{modelId:string, hasClothes:boolean}}
 */
export async function segmentPhoto(photo, { modelId = chooseSegModel(), withClothes = true } = {}) {
  const pv = await getPreview(photo);
  if (!pv) throw Object.assign(new Error('NO_ORIGINAL'), { code: 'NO_ORIGINAL' });
  let person; let clothes = null; let w; let h;
  if (modelId === 'modnet') {
    const r = await runModnet(pv);
    person = r.person; w = r.w; h = r.h;
    if (withClothes) {
      try { const mc = await runMulticlass(pv); clothes = { bytes: mc.clothes, w: mc.w, h: mc.h }; setClassMasks(photo.id, mc.classes); } catch { clothes = null; }
    }
  } else {
    const r = await runMulticlass(pv);
    person = r.person; w = r.w; h = r.h;
    clothes = { bytes: r.clothes, w: r.w, h: r.h };
    setClassMasks(photo.id, r.classes);
  }
  if (!plausibleMask(person)) {
    // Never report success for an empty or all-foreground mask.
    throw Object.assign(new Error('SEG_EMPTY'), { code: 'SEG_EMPTY', stats: maskStats(person) });
  }
  await setRawMask(photo.id, 'person', person, w, h);
  if (clothes) await setRawMask(photo.id, 'clothes', clothes.bytes, clothes.w, clothes.h);
  return { modelId, hasClothes: !!clothes, stats: maskStats(person) };
}

/** Hair / skin / clothes / person classes for the relight engine (memory only). Runs the multiclass model when they are not there yet. */
export async function ensureClassMasks(photo) {
  const hit = getClassMasks(photo.id);
  if (hit) return hit;
  const pv = await getPreview(photo);
  if (!pv) return null;
  const r = await runMulticlass(pv);
  setClassMasks(photo.id, r.classes);
  return r.classes;
}
