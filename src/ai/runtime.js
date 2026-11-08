// Lazy loading of the local inference runtimes (MediaPipe Tasks, ONNX Runtime Web)
// from the app's own vendor folder. Nothing is fetched from the internet.
import { loadModelBytes, markModel } from './models.js';
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

export function getFaceLandmarker({ cpuOnly = false } = {}) {
  return getInstance('face-landmarker', () => createMediapipe('face-landmarker', (V, baseOptions) => V.FaceLandmarker.createFromOptions(FILESET(), {
    baseOptions, runningMode: 'IMAGE', numFaces: 3, outputFaceBlendshapes: false, outputFacialTransformationMatrixes: false,
    minFaceDetectionConfidence: 0.5, minFacePresenceConfidence: 0.5,
  }), cpuOnly ? ['CPU'] : delegateOrder()));
}

export function getSegmenter({ cpuOnly = false } = {}) {
  return getInstance('selfie-multiclass', () => createMediapipe('selfie-multiclass', (V, baseOptions) => V.ImageSegmenter.createFromOptions(FILESET(), {
    baseOptions, runningMode: 'IMAGE', outputConfidenceMasks: true, outputCategoryMask: false,
  }), cpuOnly ? ['CPU'] : delegateOrder()));
}

/**
 * Run an inference with a MediaPipe task. If the GPU path throws (e.g. "No full
 * support of FP16 on this GPU") or returns a result that fails `validate`
 * (e.g. an empty mask from a failed float read-back), the model is recreated
 * on the CPU and the inference is retried once.
 */
export async function runWithFallback(id, getter, fn, validate = () => true) {
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
