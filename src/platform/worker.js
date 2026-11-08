// RPC client for the compute worker. The worker source is inlined into the app
// bundle and started from a Blob URL, so it also works when the app is opened
// directly from disk (file://). Falls back to the main thread if Workers fail.
/* global __WORKER_SOURCE__ */
import * as ops from '../workers/ops.js';

let worker = null;
let failed = false;
let seq = 0;
const pending = new Map();

function start() {
  if (worker || failed) return worker;
  try {
    const url = URL.createObjectURL(new Blob([__WORKER_SOURCE__], { type: 'text/javascript' }));
    worker = new Worker(url);
    URL.revokeObjectURL(url);
    worker.onmessage = (e) => {
      const { id, result, error, progress } = e.data;
      const p = pending.get(id);
      if (!p) return;
      if (progress != null) { p.onProgress?.(progress); return; }
      pending.delete(id);
      if (error) p.reject(Object.assign(new Error(error.message), { code: error.code }));
      else p.resolve(result);
    };
    worker.onerror = () => {
      failed = true;
      for (const p of pending.values()) p.reject(new Error('WORKER_CRASHED'));
      pending.clear();
      worker = null;
    };
  } catch {
    failed = true;
    worker = null;
  }
  return worker;
}

/**
 * Run an operation off the main thread.
 * @param {string} op @param {object} payload @param {Transferable[]} [transfer]
 * @param {{signal?: AbortSignal, onProgress?: (p:number)=>void}} [opts]
 */
export function runTask(op, payload, transfer = [], opts = {}) {
  const w = start();
  if (!w) {
    // main-thread fallback (same code)
    return Promise.resolve().then(() => ops[op](payload, opts.onProgress || (() => {})));
  }
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress: opts.onProgress });
    if (opts.signal) {
      opts.signal.addEventListener('abort', () => {
        if (!pending.has(id)) return;
        pending.delete(id);
        // hard cancel: terminate and restart lazily
        worker?.terminate();
        worker = null;
        for (const p of pending.values()) p.reject(new Error('CANCELLED'));
        pending.clear();
        reject(Object.assign(new Error('CANCELLED'), { code: 'CANCELLED' }));
      }, { once: true });
    }
    w.postMessage({ id, op, payload }, transfer);
  });
}

export const workerStatus = () => (failed ? 'main-thread' : worker ? 'worker' : 'idle');
