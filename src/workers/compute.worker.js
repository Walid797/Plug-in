// Compute worker entry (bundled to a string and started from a Blob URL).
import * as ops from './ops.js';

const transferablesOf = (result) => {
  const t = [];
  for (const v of Object.values(result || {})) {
    if (v && v.buffer instanceof ArrayBuffer) t.push(v.buffer);
  }
  return t;
};

self.onmessage = async (e) => {
  const { id, op, payload } = e.data;
  try {
    const fn = ops[op];
    if (typeof fn !== 'function') throw Object.assign(new Error(`unknown op ${op}`), { code: 'UNKNOWN_OP' });
    const result = await fn(payload, (p) => self.postMessage({ id, progress: p }));
    self.postMessage({ id, result }, transferablesOf(result));
  } catch (err) {
    self.postMessage({ id, error: { message: String(err?.message || err), code: err?.code || 'ERROR' } });
  }
};
