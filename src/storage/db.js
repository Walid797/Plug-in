// IndexedDB access + blob store (OPFS when it works, IndexedDB otherwise),
// with an in-memory fallback when the browser forbids persistent storage.

const DB_NAME = 'hoshmand-studio';
const DB_VERSION = 1;
const STORES = ['projects', 'photos', 'blobs', 'kv'];

let dbPromise = null;
let memory = null; // Map-based fallback

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    let r;
    try {
      if (typeof indexedDB === 'undefined' || !indexedDB) { reject(new Error('IDB_UNAVAILABLE')); return; }
      r = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (e) { reject(e); return; }
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('photos')) {
        const s = db.createObjectStore('photos', { keyPath: 'id' });
        s.createIndex('projectId', 'projectId');
      }
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'key' });
    };
    r.onsuccess = () => {
      const db = r.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(new Error('IDB_BLOCKED'));
  });
  return dbPromise;
}

export async function initStorage() {
  try {
    const db = await openDb();
    // probe a write (fails in some private modes)
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put({ key: '__probe', value: Date.now() });
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
    return { mode: 'idb' };
  } catch (e) {
    memory = new Map(STORES.map((s) => [s, new Map()]));
    return { mode: 'memory', error: e };
  }
}

export const isMemoryMode = () => memory !== null;

async function withStore(name, mode, fn) {
  if (memory) return fn(null, memory.get(name));
  const db = await openDb();
  const tx = db.transaction(name, mode);
  const store = tx.objectStore(name);
  const result = await fn(store, null);
  await new Promise((res, rej) => {
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error || new Error('aborted'));
  });
  return result;
}

const keyOf = (name, v) => (name === 'blobs' || name === 'kv' ? v.key : v.id);

export function put(name, value) {
  return withStore(name, 'readwrite', (s, m) => (m ? (m.set(keyOf(name, value), structuredClone(value)), undefined) : req(s.put(value))));
}

export function get(name, key) {
  return withStore(name, 'readonly', (s, m) => (m ? structuredClone(m.get(key)) : req(s.get(key))));
}

export function del(name, key) {
  return withStore(name, 'readwrite', (s, m) => (m ? (m.delete(key), undefined) : req(s.delete(key))));
}

export function getAll(name) {
  return withStore(name, 'readonly', (s, m) => (m ? [...m.values()].map((v) => structuredClone(v)) : req(s.getAll())));
}

export function getByIndex(name, index, value) {
  return withStore(name, 'readonly', (s, m) => (m
    ? [...m.values()].filter((v) => v[index] === value).map((v) => structuredClone(v))
    : req(s.index(index).getAll(value))));
}

export async function kvGet(key, fallback = null) {
  try { const r = await get('kv', key); return r ? r.value : fallback; } catch { return fallback; }
}

export function kvSet(key, value) {
  return put('kv', { key, value });
}

/* ------------------------------------------------------------- blob store */

let opfsRoot = null;
let opfsChecked = false;

async function opfsDir() {
  if (opfsChecked) return opfsRoot;
  opfsChecked = true;
  try {
    if (memory || !navigator.storage?.getDirectory || location.protocol === 'file:') return null;
    const rootDir = await navigator.storage.getDirectory();
    const dir = await rootDir.getDirectoryHandle('hoshmand-blobs', { create: true });
    // createWritable is required on the main thread (Safari < 17 lacks it)
    const probe = await dir.getFileHandle('__probe', { create: true });
    if (typeof probe.createWritable !== 'function') return null;
    const w = await probe.createWritable();
    await w.write(new Blob(['ok']));
    await w.close();
    opfsRoot = dir;
  } catch { opfsRoot = null; }
  return opfsRoot;
}

const fileNameForKey = (key) => encodeURIComponent(key).replace(/%/g, '_');

export async function blobBackend() {
  return (await opfsDir()) ? 'opfs' : memory ? 'memory' : 'idb';
}

export async function putBlob(key, blob) {
  const dir = await opfsDir();
  if (dir) {
    const h = await dir.getFileHandle(fileNameForKey(key), { create: true });
    const w = await h.createWritable();
    await w.write(blob);
    await w.close();
    return 'opfs';
  }
  await put('blobs', { key, blob });
  return memory ? 'memory' : 'idb';
}

export async function getBlob(key) {
  const dir = await opfsDir();
  if (dir) {
    try {
      const h = await dir.getFileHandle(fileNameForKey(key));
      return await h.getFile();
    } catch { /* fall through to idb (older data) */ }
  }
  const r = await get('blobs', key).catch(() => null);
  return r ? r.blob : null;
}

export async function deleteBlob(key) {
  const dir = await opfsDir();
  if (dir) { try { await dir.removeEntry(fileNameForKey(key)); } catch { /* missing */ } }
  await del('blobs', key).catch(() => {});
}

/** Remove every stored project, photo, blob and setting. */
export async function clearAllData({ keepSettings = false } = {}) {
  const dir = await opfsDir();
  if (dir) {
    try {
      const rootDir = await navigator.storage.getDirectory();
      await rootDir.removeEntry('hoshmand-blobs', { recursive: true });
    } catch { /* ignore */ }
    opfsChecked = false; opfsRoot = null;
  }
  if (memory) {
    for (const [name, m] of memory) if (!(keepSettings && name === 'kv')) m.clear();
    return;
  }
  const db = await openDb();
  for (const name of STORES) {
    if (keepSettings && name === 'kv') continue;
    const tx = db.transaction(name, 'readwrite');
    tx.objectStore(name).clear();
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  }
}
