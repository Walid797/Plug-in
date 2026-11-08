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

async function vision() {
  if (!window.Vision) await loadScript('vendor/mediapipe/vision_bundle.js');
  if (!window.Vision) throw Object.assign(new Error('RUNTIME_LOAD'), { code: 'RUNTIME_LOAD' });
  return window.Vision;
}

const FILESET = () => ({
  wasmLoaderPath: abs('vendor/mediapipe/wasm/vision_wasm_internal.js'),
  wasmBinaryPath: abs('vendor/mediapipe/wasm/vision_wasm_internal.wasm'),
});

const instances = new Map(); // id -> {instance, backend}
const creating = new Map();

function delegateOrder() {
  const pref = getState().settings.aiDelegate;
  if (pref === 'cpu') return ['CPU'];
  if (pref === 'gpu') return ['GPU', 'CPU'];
  return getState().caps?.webgl2 ? ['GPU', 'CPU'] : ['CPU'];
}

async function createMediapipe(id, factory) {
  const V = await vision();
  const bytes = await loadModelBytes(id);
  let lastErr = null;
  for (const delegate of delegateOrder()) {
    try {
      const inst = await factory(V, { modelAssetBuffer: bytes, delegate });
      return { instance: inst, backend: delegate === 'GPU' ? 'WebGL (GPU)' : 'WASM (CPU)' };
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('CREATE_FAILED');
}

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

export function getFaceLandmarker() {
  return getInstance('face-landmarker', () => createMediapipe('face-landmarker', (V, baseOptions) => V.FaceLandmarker.createFromOptions(FILESET(), {
    baseOptions, runningMode: 'IMAGE', numFaces: 3, outputFaceBlendshapes: false, outputFacialTransformationMatrixes: false,
    minFaceDetectionConfidence: 0.5, minFacePresenceConfidence: 0.5,
  })));
}

export function getSegmenter() {
  return getInstance('selfie-multiclass', () => createMediapipe('selfie-multiclass', (V, baseOptions) => V.ImageSegmenter.createFromOptions(FILESET(), {
    baseOptions, runningMode: 'IMAGE', outputConfidenceMasks: true, outputCategoryMask: false,
  })));
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
