// Model availability, installation (from a local file) and loading of bytes.
// Models are only ever read from this app's own origin or from browser storage.
import { MODELS, findModel } from './registry.js';
import { getState, setState, toast } from '../state/store.js';
import { putBlob, getBlob, deleteBlob, kvGet, kvSet } from '../storage/db.js';

const verified = new Map(); // id -> true once hash checked this session

function setModel(id, patch) {
  setState((s) => ({ ...s, models: { ...s.models, [id]: { ...(s.models[id] || {}), ...patch } } }));
}

export async function sha256Hex(bytes) {
  if (!globalThis.crypto?.subtle) return null;
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function bundledAvailable(m) {
  if (location.protocol === 'file:') return false;
  try {
    const r = await fetch(m.path, { method: 'HEAD', cache: 'no-store' });
    if (r.ok) return true;
  } catch { /* server not running */ }
  try {
    if (typeof caches !== 'undefined') return !!(await caches.match(m.path, { ignoreSearch: true }));
  } catch { /* none */ }
  return false;
}

/** Detect the status of every model (no downloads, same-origin only). */
export async function refreshModelStatus() {
  const installed = (await kvGet('installedModels', {})) || {};
  for (const m of MODELS) {
    const cur = getState().models[m.id];
    if (cur?.status === 'loading' || cur?.status === 'ready') continue;
    setModel(m.id, { status: 'checking' });
    let status = 'missing';
    let source = null;
    if (installed[m.id]) { status = 'available'; source = 'browser'; }
    else if (location.protocol === 'file:') status = 'file-protocol';
    else if (await bundledAvailable(m)) { status = 'available'; source = 'folder'; }
    setModel(m.id, { status, source, installedInfo: installed[m.id] || null, error: null });
  }
}

/** Read model bytes, verifying the SHA-256 when the registry knows it. */
export async function loadModelBytes(id) {
  const m = findModel(id);
  const installed = (await kvGet('installedModels', {})) || {};
  let bytes = null;
  if (installed[id]) {
    const blob = await getBlob(`model:${id}`);
    if (blob) bytes = new Uint8Array(await blob.arrayBuffer());
  }
  if (!bytes) {
    if (location.protocol === 'file:') throw Object.assign(new Error('FILE_PROTOCOL'), { code: 'FILE_PROTOCOL' });
    const r = await fetch(m.path, { cache: 'force-cache' }).catch(() => null);
    if (!r || !r.ok) throw Object.assign(new Error('MODEL_MISSING'), { code: 'MODEL_MISSING' });
    bytes = new Uint8Array(await r.arrayBuffer());
  }
  if (m.sha256 && !verified.get(id)) {
    const h = await sha256Hex(bytes);
    if (h && h !== m.sha256) throw Object.assign(new Error('HASH_MISMATCH'), { code: 'HASH_MISMATCH' });
    verified.set(id, true);
  }
  return bytes;
}

/** Install a model from a file the user selected (works without the models folder). */
export async function installModelFromFile(id, file) {
  const m = findModel(id);
  if (!m) return false;
  if (file.size < 1024 || file.size > 600 * 1024 * 1024) { toast('اندازهٔ فایل مدل غیرعادی است.', 'error'); return false; }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const hash = await sha256Hex(bytes);
  if (m.sha256 && hash !== m.sha256) {
    toast('چکسام فایل با مدل ثبت‌شده مطابقت ندارد؛ نصب انجام نشد. فایل درست را از منبع رسمی تهیه کنید.', 'error', 10000);
    return false;
  }
  const ext = m.runtime === 'onnx' ? 'onnx' : m.path.split('.').pop();
  if (!file.name.toLowerCase().endsWith(`.${ext}`)) {
    toast(`فایل باید پسوند .${ext} داشته باشد.`, 'error');
    return false;
  }
  if (m.runtime === 'onnx' && !(bytes[0] === 0x08)) {
    // ONNX ModelProto starts with field 1 (ir_version, varint) → 0x08
    toast('این فایل یک مدل ONNX معتبر به نظر نمی‌رسد.', 'error');
    return false;
  }
  await putBlob(`model:${id}`, new Blob([bytes]));
  const installed = (await kvGet('installedModels', {})) || {};
  installed[id] = { name: file.name, bytes: file.size, sha256: hash, at: Date.now(), verified: !!m.sha256 };
  await kvSet('installedModels', installed);
  verified.set(id, !!m.sha256);
  setModel(id, { status: 'available', source: 'browser', installedInfo: installed[id], error: null });
  toast(m.sha256 ? 'مدل نصب و چکسام آن تأیید شد.' : 'مدل نصب شد. توجه: چکسام این مدل در فهرست برنامه ثبت نیست و فقط با یک اجرای آزمایشی بررسی می‌شود.', m.sha256 ? 'success' : 'warn', 9000);
  return true;
}

export async function uninstallModel(id) {
  await deleteBlob(`model:${id}`);
  const installed = (await kvGet('installedModels', {})) || {};
  delete installed[id];
  await kvSet('installedModels', installed);
  verified.delete(id);
  setModel(id, { status: 'checking', source: null, installedInfo: null, backend: null });
  const { disposeModel } = await import('./runtime.js');
  disposeModel(id);
  await refreshModelStatus();
}

export function modelState(id) {
  return getState().models[id] || { status: 'checking' };
}

export const markModel = setModel;
