// Global application state (immutable updates) + a tiny Preact hook.
import { useEffect, useRef, useState } from 'preact/hooks';
import { ADJUSTMENT_DEFAULTS } from '../core/adjust.js';

const listeners = new Set();

export const DEFAULT_SETTINGS = Object.freeze({
  theme: 'system', // system | dark | light
  retainOriginals: 'ask', // ask | always | never
  defaultPhotoId: '3x4',
  purposeId: 'tazkira',
  defaultDpi: 300,
  jpegQuality: 0.95,
  workspaceGray: false,
  onboardingDone: false,
  segModel: 'auto', // auto | mediapipe-multiclass | modnet
  aiDelegate: 'auto', // auto | gpu | cpu
  calibrationProfiles: [],
  activeCalibrationId: null,
  companion: { enabled: false, url: 'http://127.0.0.1:7860' },
  customProfiles: [],
  paperPresets: [],
  layoutPresets: [],
});

export const DEFAULT_SHEET = Object.freeze({
  paperId: '10x15',
  customPaper: { widthMm: 100, heightMm: 150 },
  orientation: 'auto',
  margins: { top: 5, right: 5, bottom: 5, left: 5 },
  marginsLinked: true,
  gap: { x: 2, y: 2 },
  gapLinked: true,
  mode: 'exact',
  allowRotation: false,
  grid: { cols: null, rows: null, rotated: false },
  align: { mode: 'center', offsetX: 0, offsetY: 0 },
  fillOrder: 'col-ltr',
  schema: 2,
  compact: true,
  marks: { cutLines: false, cropMarks: true, borders: false },
  label: { enabled: false, heightMm: 4, gapMm: 1, content: 'name', custom: '' },
  dpi: 300,
  printer: { borderless: false, hardMargins: { top: 3, right: 3, bottom: 3, left: 3 } },
  applyCalibrationPrint: true,
  applyCalibrationPdf: false,
  // print brightening (see core/adjust.js PRINT_BOOST_LEVELS): off | low | medium | high
  printBoost: 'medium',
  quickPresetId: null,
  items: [],
});

export function defaultEdit(widthMm = 30, heightMm = 40, sizeId = '3x4') {
  return {
    widthMm, heightMm, sizeId,
    crop: null,
    adjust: { ...ADJUSTMENT_DEFAULTS },
    bg: {
      enabled: false, mode: 'color', color: '#ffffff', imageKey: null,
      refine: { edgeAware: true, shift: 0, softness: 0.4, feather: 0 },
      strokes: [], decontaminate: true,
      shadow: { enabled: false, opacity: 25, blurMm: 1.5, offsetXmm: 0, offsetYmm: 0.8 },
      modelId: null,
    },
    clothes: {
      recolor: { enabled: false, color: '#1c2333', strength: 100, strokes: [] },
      overlay: { enabled: false, templateId: null, x: 0.5, y: 0.8, width: 0.6, rotation: 0 },
      patch: null,
    },
    aiEdited: false,
    profileId: null,
  };
}

let state = {
  ready: false,
  section: 'home',
  settings: { ...DEFAULT_SETTINGS },
  caps: null,
  storage: { mode: 'idb', backend: 'idb', error: null },
  project: null,
  photos: {},
  selectedPhotoId: null,
  saveStatus: 'idle',
  tasks: {},
  toasts: [],
  dialog: null,
  models: {},
  rev: {}, // per-photo asset revision counters (masks, templates)
  projectsIndex: [],
  history: { canUndo: false, canRedo: false },
  swUpdate: false,
};

export const getState = () => state;

export function setState(update) {
  const next = typeof update === 'function' ? update(state) : { ...state, ...update };
  if (!next || next === state) return;
  const prev = state;
  state = next;
  for (const l of listeners) l(state, prev);
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function shallowEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const ka = Object.keys(a); const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!Object.is(a[k], b[k])) return false;
  return true;
}

/** Subscribe a component to a slice of state. */
export function useStore(selector) {
  const sel = useRef(selector);
  sel.current = selector;
  const [value, setValue] = useState(() => selector(state));
  const valueRef = useRef(value);
  useEffect(() => {
    const check = (s) => {
      const v = sel.current(s);
      if (!shallowEqual(v, valueRef.current)) { valueRef.current = v; setValue(v); }
    };
    check(state);
    return subscribe(check);
  }, []);
  return value;
}

/* ---------------------------------------------------------------- helpers */

let idCounter = 0;
export function uid(prefix = 'id') {
  idCounter += 1;
  const rnd = (globalThis.crypto?.getRandomValues ? Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, '0')).join('') : Math.random().toString(16).slice(2, 14));
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}${rnd}`;
}

export function selectedPhoto(s = state) {
  return s.selectedPhotoId ? s.photos[s.selectedPhotoId] || null : null;
}

export function orderedPhotos(s = state) {
  return (s.project?.photoIds || []).map((id) => s.photos[id]).filter(Boolean);
}

export function updatePhoto(id, fn) {
  setState((s) => {
    const p = s.photos[id];
    if (!p) return s;
    const np = fn(p);
    if (np === p) return s;
    return { ...s, photos: { ...s.photos, [id]: np } };
  });
}

export function bumpRev(photoId) {
  setState((s) => ({ ...s, rev: { ...s.rev, [photoId]: (s.rev[photoId] || 0) + 1 } }));
}

/* ------------------------------------------------------------ toasts/tasks */

export function toast(message, kind = 'info', timeout = 5000) {
  const id = uid('t');
  setState((s) => ({ ...s, toasts: [...s.toasts.slice(-4), { id, message, kind }] }));
  if (timeout) setTimeout(() => dismissToast(id), timeout);
  return id;
}

export function dismissToast(id) {
  setState((s) => ({ ...s, toasts: s.toasts.filter((t) => t.id !== id) }));
}

/** Track a long-running task; returns {update, done, signal}. */
export function startTask(label, { cancellable = false } = {}) {
  const id = uid('task');
  const controller = new AbortController();
  setState((s) => ({ ...s, tasks: { ...s.tasks, [id]: { id, label, progress: null, cancellable, controller } } }));
  return {
    id,
    signal: controller.signal,
    update(progress, newLabel) {
      setState((s) => (s.tasks[id] ? { ...s, tasks: { ...s.tasks, [id]: { ...s.tasks[id], progress, label: newLabel || s.tasks[id].label } } } : s));
    },
    done() {
      setState((s) => { const t = { ...s.tasks }; delete t[id]; return { ...s, tasks: t }; });
    },
  };
}

export function cancelTask(id) {
  const t = state.tasks[id];
  if (t?.controller) t.controller.abort();
}

export function hasRunningTasks() {
  return Object.keys(state.tasks).length > 0;
}

/* ------------------------------------------------------------- dialogs */

let dialogResolve = null;
/** Show a dialog component; resolves with the value passed to closeDialog. */
export function openDialog(kind, props = {}) {
  return new Promise((resolve) => {
    if (dialogResolve) dialogResolve(undefined);
    dialogResolve = resolve;
    setState((s) => ({ ...s, dialog: { kind, props } }));
  });
}

export function closeDialog(value) {
  const r = dialogResolve;
  dialogResolve = null;
  setState((s) => ({ ...s, dialog: null }));
  if (r) r(value);
}

export function confirmDialog(props) {
  return openDialog('confirm', props);
}

/* ------------------------------------------------------------- history */

const HISTORY_LIMIT = 100;
const HISTORY_BYTES = 6 * 1024 * 1024;
let past = []; let future = []; let bytes = 0;

const sizeOf = (v) => { try { return JSON.stringify(v).length * 2; } catch { return 2048; } };

function snapshot(target) {
  const s = state;
  if (target.type === 'edit') return s.photos[target.photoId] ? structuredClone(s.photos[target.photoId].edit) : null;
  if (target.type === 'sheet') return s.project ? structuredClone(s.project.sheet) : null;
  if (target.type === 'queue') return s.project ? [...s.project.photoIds] : null;
  return null;
}

function restore(target, value) {
  if (value == null) return;
  if (target.type === 'edit') updatePhoto(target.photoId, (p) => ({ ...p, edit: value }));
  else if (target.type === 'sheet') setState((s) => ({ ...s, project: { ...s.project, sheet: value } }));
  else if (target.type === 'queue') setState((s) => ({ ...s, project: { ...s.project, photoIds: value.filter((id) => s.photos[id]) } }));
}

function syncHistoryFlags() {
  setState((s) => ({ ...s, history: { canUndo: past.length > 0, canRedo: future.length > 0 } }));
}

/** Record the current state of a target before changing it. */
export function recordHistory(target) {
  const before = snapshot(target);
  if (before == null) return;
  const size = sizeOf(before);
  past.push({ target, before, size });
  bytes += size;
  future = [];
  while (past.length > HISTORY_LIMIT || (bytes > HISTORY_BYTES && past.length > 1)) bytes -= past.shift().size;
  syncHistoryFlags();
}

export function undo() {
  const e = past.pop();
  if (!e) return false;
  bytes -= e.size;
  future.push({ target: e.target, before: snapshot(e.target), size: e.size });
  restore(e.target, e.before);
  syncHistoryFlags();
  if (e.target.photoId) bumpRev(e.target.photoId);
  return true;
}

export function redo() {
  const e = future.pop();
  if (!e) return false;
  const cur = snapshot(e.target);
  const size = sizeOf(cur);
  past.push({ target: e.target, before: cur, size });
  bytes += size;
  restore(e.target, e.before);
  syncHistoryFlags();
  if (e.target.photoId) bumpRev(e.target.photoId);
  return true;
}

export function clearHistory() {
  past = []; future = []; bytes = 0;
  syncHistoryFlags();
}

/** Update a photo's edit parameters (optionally undoable). */
export function updateEdit(photoId, patch, { history = true } = {}) {
  if (history) recordHistory({ type: 'edit', photoId });
  updatePhoto(photoId, (p) => ({ ...p, edit: typeof patch === 'function' ? patch(p.edit) : { ...p.edit, ...patch } }));
}

export function updateSheet(patch, { history = true } = {}) {
  if (!state.project) return;
  if (history) recordHistory({ type: 'sheet' });
  setState((s) => ({ ...s, project: { ...s.project, sheet: typeof patch === 'function' ? patch(s.project.sheet) : { ...s.project.sheet, ...patch } } }));
}

export function updateSettings(patch) {
  setState((s) => ({ ...s, settings: { ...s.settings, ...(typeof patch === 'function' ? patch(s.settings) : patch) } }));
}

export function logEvent(kind, detail = '') {
  setState((s) => {
    if (!s.project) return s;
    const log = [...(s.project.log || []), { at: Date.now(), kind, detail }].slice(-200);
    return { ...s, project: { ...s.project, log } };
  });
}

export function setSection(section) {
  setState((s) => ({ ...s, section }));
  try { window.history.replaceState(null, '', `#${section}`); } catch { /* file:// may refuse */ }
}
