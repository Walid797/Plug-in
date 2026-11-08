// Lazy loading of the local inference runtimes (MediaPipe Tasks, ONNX Runtime Web)
// from the app's own vendor folder. Nothing is fetched from the internet.
import { loadModelBytes, markModel, sha256Hex } from './models.js';
import { CPU_FILES, createCpuSegmenter, createCpuFaceLandmarker } from './cpu-engine.js';
import { classifyAiError } from './errors.js';
import { getState } from '../state/store.js';

const scripts = new Map();
function loadScript(src) {
  if (scripts.has(src)) return scripts.get(src);
  const p = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => { scripts.delete(src); reject(Object.assign(new Error('RUNTIME_LOAD'), { code: 'RUNTIME_LOAD' })); };
    document.head.appendChild(s);
  });
  scripts.set(src, p);
  return p;
}

const abs = (p) => new URL(p, location.href).href;

/**
 * Time limits per stage (generous: a PC without a graphics card runs WebGL in software). A stage that never settles
 * (seen on a Windows PC without a graphics card) becomes a TIMEOUT error naming the stage instead of an endless spinner.
 */
export const STAGE_LIMIT_MS = { runtime: 60_000, model: 60_000, create: 180_000, run: 180_000 };
export function withTimeout(promise, stage, ms = STAGE_LIMIT_MS[stage] || 120_000) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(Object.assign(new Error(`TIMEOUT: ${stage} > ${Math.round(ms / 1000)}s`), { code: 'TIMEOUT', stage })), ms);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(t));
}

async function vision() {
  if (!window.Vision) await loadScript('vendor/mediapipe/vision_bundle.js');
  if (!window.Vision) throw Object.assign(new Error('RUNTIME_LOAD'), { code: 'RUNTIME_LOAD' });
  return window.Vision;
}

const FILESET = () => ({
  wasmLoaderPath: abs('vendor/mediapipe/wasm/vision_wasm_internal.js'),
  wasmBinaryPath: abs('vendor/mediapipe/wasm/vision_wasm_internal.wasm'),
});

const instances = new Map(); // id -> {instance, backend, delegate}
const creating = new Map();

/**
 * Delegate order. "auto" uses the CPU (WASM/XNNPACK) path: for single-photo
 * tasks it is fast enough everywhere and avoids mobile GPU driver problems
 * (missing FP16 / float read-back) that can make the GPU path fail or return
 * empty masks. The GPU path is used only when the user selects it, and any
 * GPU failure is retried on the CPU (see runWithFallback).
 */
function delegateOrder() {
  const pref = getState().settings.aiDelegate;
  if (pref === 'gpu' && getState().caps?.webgl2) return ['GPU', 'CPU'];
  return ['CPU'];
}

async function createMediapipe(id, factory, order) {
  const V = await withTimeout(vision(), 'runtime');
  const bytes = await withTimeout(loadModelBytes(id), 'model');
  let lastErr = null;
  for (const delegate of order) {
    try {
      const inst = await withTimeout(factory(V, { modelAssetBuffer: bytes, delegate }), 'create');
      return { instance: inst, delegate, backend: delegate === 'GPU' ? 'WebGL (GPU)' : 'WASM (CPU)' };
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('CREATE_FAILED');
}

export const delegateOf = (id) => instances.get(id)?.delegate || null;

async function getInstance(id, create) {
  if (instances.has(id)) return instances.get(id).instance;
  if (creating.has(id)) return creating.get(id);
  markModel(id, { status: 'loading', error: null });
  const p = (async () => {
    try {
      const r = await create();
      instances.set(id, r);
      markModel(id, { status: 'ready', backend: r.backend, error: null });
      return r.instance;
    } catch (e) {
      markModel(id, { status: 'error', error: e.code || String(e.message || e) });
      throw e;
    } finally {
      creating.delete(id);
    }
  })();
  creating.set(id, p);
  return p;
}

/* ------------------------------------------------- WebGL-free engine (ONNX) */

let glChecked = null;
/** Can this browser create a WebGL2 context? (MediaPipe Tasks needs it even for its CPU path.) Checked once. */
export function webgl2Works() {
  if (glChecked !== null) return glChecked;
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    glChecked = !!gl;
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
  } catch { glChecked = false; }
  return glChecked;
}
let glBroken = false; // MediaPipe failed because of WebGL in this session: use the ONNX engine from now on

/** Use the WebGL-free ONNX engine? (setting «بدون گرافیک», no WebGL2, or MediaPipe already failed on WebGL) */
export function useCpuEngine() {
  return getState().settings.aiDelegate === 'nogl' || glBroken || !webgl2Works();
}

async function loadCpuFile(file) {
  const r = await fetch(file.path, { cache: 'force-cache' }).catch(() => null);
  if (!r || !r.ok) throw Object.assign(new Error('MODEL_MISSING'), { code: 'MODEL_MISSING' });
  const bytes = new Uint8Array(await r.arrayBuffer());
  const h = await sha256Hex(bytes);
  if (h && h !== file.sha256) throw Object.assign(new Error('HASH_MISMATCH'), { code: 'HASH_MISMATCH' });
  return bytes;
}

async function cpuSession(ort, file) {
  const bytes = await withTimeout(loadCpuFile(file), 'model');
  return withTimeout(ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' }), 'create');
}

const cpuBackend = (ort) => `ONNX WASM (CPU، بدون گرافیک، ${ort.env.wasm.numThreads} رشته)`;

async function createCpuFace() {
  const ort = await withTimeout(ortRuntime(), 'runtime');
  const det = await cpuSession(ort, CPU_FILES.detector);
  const lmk = await cpuSession(ort, CPU_FILES.landmarks);
  return { instance: createCpuFaceLandmarker(ort, det, lmk, { numFaces: 3 }), delegate: 'ONNX', backend: cpuBackend(ort) };
}

async function createCpuSegmenterInstance() {
  const ort = await withTimeout(ortRuntime(), 'runtime');
  const seg = await cpuSession(ort, CPU_FILES.segmenter);
  return { instance: createCpuSegmenter(ort, seg), delegate: 'ONNX', backend: cpuBackend(ort) };
}

export function getFaceLandmarker({ cpuOnly = false } = {}) {
  if (useCpuEngine()) return getInstance('face-landmarker', createCpuFace);
  return getInstance('face-landmarker', () => createMediapipe('face-landmarker', (V, baseOptions) => V.FaceLandmarker.createFromOptions(FILESET(), {
    baseOptions, runningMode: 'IMAGE', numFaces: 3, outputFaceBlendshapes: false, outputFacialTransformationMatrixes: false,
    minFaceDetectionConfidence: 0.5, minFacePresenceConfidence: 0.5,
  }), cpuOnly ? ['CPU'] : delegateOrder()));
}

export function getSegmenter({ cpuOnly = false } = {}) {
  if (useCpuEngine()) return getInstance('selfie-multiclass', createCpuSegmenterInstance);
  return getInstance('selfie-multiclass', () => createMediapipe('selfie-multiclass', (V, baseOptions) => V.ImageSegmenter.createFromOptions(FILESET(), {
    baseOptions, runningMode: 'IMAGE', outputConfidenceMasks: true, outputCategoryMask: false,
  }), cpuOnly ? ['CPU'] : delegateOrder()));
}

/** A MediaPipe failure that the WebGL-free engine avoids: no WebGL, or the model never finished starting. */
function isGlFailure(e) {
  return classifyAiError(e).kind === 'webgl' || classifyAiError(e).kind === 'gpu' || (e?.code === 'TIMEOUT' && (e.stage === 'create' || e.stage === 'run'));
}

/**
 * Run an inference with a MediaPipe task. If the GPU path throws (e.g. "No full
 * support of FP16 on this GPU") or returns a result that fails `validate`
 * (e.g. an empty mask from a failed float read-back), the model is recreated
 * on the CPU and the inference is retried once.
 */
export async function runWithFallback(id, getter, fn, validate = () => true) {
  const usedCpuEngine = useCpuEngine();
  try {
    return await runOnce(id, getter, fn, validate);
  } catch (e) {
    if (usedCpuEngine || !isGlFailure(e)) throw e;
    // MediaPipe cannot run here (WebGL missing or stuck): switch to the WebGL-free engine for the rest of the session
    console.warn(`${id}: MediaPipe failed (${e?.message || e}); switching to the WebGL-free ONNX engine`);
    glBroken = true;
    disposeAll();
    return runOnce(id, getter, fn, validate);
  }
}

async function runOnce(id, getter, fn, validate) {
  const inst = await getter();
  if (delegateOf(id) !== 'GPU') {
    try {
      return await withTimeout(fn(inst), 'run');
    } catch (e) {
      if (e?.code === 'TIMEOUT') throw e; // a stuck engine is not retried (it would only double the wait)
      // one fresh start: the model is released (its memory is freed) and recreated, then the run is repeated
      console.warn(`inference failed for ${id}; retrying once with a fresh model`, e);
      disposeModel(id);
      return fn(await getter({ cpuOnly: true }));
    }
  }
  try {
    const r = await fn(inst);
    if (validate(r)) return r;
  } catch (e) {
    console.warn(`GPU inference failed for ${id}; retrying on CPU`, e);
  }
  disposeModel(id);
  return fn(await getter({ cpuOnly: true }));
}

/* -------------------------------------------------------------- ONNX */

async function ortRuntime() {
  if (!window.ort) await loadScript('vendor/ort/ort.webgpu.min.js');
  const ort = window.ort;
  if (!ort) throw Object.assign(new Error('RUNTIME_LOAD'), { code: 'RUNTIME_LOAD' });
  ort.env.wasm.wasmPaths = abs('vendor/ort/');
  ort.env.wasm.numThreads = window.crossOriginIsolated ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1)) : 1;
  ort.env.logLevel = 'error';
  return ort;
}

export function getModnet() {
  return getInstance('modnet', async () => {
    const ort = await ortRuntime();
    const bytes = await loadModelBytes('modnet');
    const caps = getState().caps;
    const pref = getState().settings.aiDelegate;
    const orders = pref !== 'cpu' && caps?.webgpu ? [['webgpu'], ['wasm']] : [['wasm']];
    let lastErr = null;
    for (const eps of orders) {
      try {
        const session = await ort.InferenceSession.create(bytes, { executionProviders: eps, graphOptimizationLevel: 'all' });
        return { instance: { ort, session }, backend: eps[0] === 'webgpu' ? 'WebGPU' : `WASM (${ort.env.wasm.numThreads} رشته)` };
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('CREATE_FAILED');
  });
}

export function disposeModel(id) {
  const r = instances.get(id);
  if (!r) return;
  try {
    if (r.instance?.close) r.instance.close();
    if (r.instance?.session?.release) r.instance.session.release();
  } catch { /* ignore */ }
  instances.delete(id);
  markModel(id, { status: 'available', backend: null });
}

export function disposeAll() {
  for (const id of [...instances.keys()]) disposeModel(id);
}

export const isLoaded = (id) => instances.has(id);
