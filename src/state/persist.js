// Project persistence: create/open/save/delete, debounced autosave.
import { getState, setState, subscribe, uid, DEFAULT_SHEET, DEFAULT_SETTINGS, clearHistory, toast, logEvent } from './store.js';
import { put, get, del, getAll, getByIndex, kvGet, kvSet, deleteBlob } from '../storage/db.js';
import { releaseAllMedia, restoreThumbs } from './media.js';
import { storageErrorText } from '../i18n/fa.js';
import { dateStampFa } from '../core/dates.js';

const SAVE_DELAY = 700;
let timer = null;
let saving = false;
let lastSaved = { project: null, photos: {} , settings: null };

function projectRecord(p) {
  return { ...p };
}

function photoRecord(ph) {
  const { ...rest } = ph;
  return rest;
}

export async function loadSettings() {
  const s = await kvGet('settings', null);
  const settings = { ...DEFAULT_SETTINGS, ...(s || {}) };
  setState((st) => ({ ...st, settings }));
  lastSaved.settings = settings;
  return settings;
}

export async function refreshProjectsIndex() {
  try {
    const all = await getAll('projects');
    const index = all.map((p) => ({ id: p.id, name: p.name, createdAt: p.createdAt, updatedAt: p.updatedAt, count: p.photoIds.length, thumb: p.thumb || null }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    setState((s) => ({ ...s, projectsIndex: index }));
    return index;
  } catch {
    return [];
  }
}

export function newProjectObject(name) {
  const now = Date.now();
  return {
    id: uid('prj'),
    name: name || `پروژهٔ ${dateStampFa(new Date(now))}`,
    createdAt: now,
    updatedAt: now,
    photoIds: [],
    sheet: structuredClone(DEFAULT_SHEET),
    log: [{ at: now, kind: 'create', detail: '' }],
  };
}

export async function createProject(name) {
  await flushSave();
  releaseAllMedia();
  clearHistory();
  const project = newProjectObject(name);
  setState((s) => ({ ...s, project, photos: {}, selectedPhotoId: null, rev: {} }));
  await saveNow();
  await kvSet('lastProjectId', project.id).catch(() => {});
  await refreshProjectsIndex();
  return project;
}

export async function openProject(id) {
  await flushSave();
  const project = await get('projects', id);
  if (!project) { toast('پروژه پیدا نشد.', 'error'); return null; }
  const photos = await getByIndex('photos', 'projectId', id);
  releaseAllMedia();
  clearHistory();
  const map = {};
  for (const ph of photos) map[ph.id] = ph;
  project.photoIds = project.photoIds.filter((pid) => map[pid]);
  project.sheet = { ...structuredClone(DEFAULT_SHEET), ...project.sheet };
  setState((s) => ({ ...s, project, photos: map, selectedPhotoId: project.photoIds[0] || null, rev: {} }));
  await restoreThumbs(photos);
  lastSaved = { project, photos: { ...map }, settings: lastSaved.settings };
  await kvSet('lastProjectId', id).catch(() => {});
  const missing = photos.filter((p) => !p.hasOriginal).length;
  if (missing) toast(`عکس اصلیِ ${missing.toLocaleString('fa-AF')} عکس در این دستگاه ذخیره نشده بود. برای ویرایش یا چاپ، آن‌ها را با «جایگزینی» دوباره انتخاب کنید.`, 'warn', 10000);
  return project;
}

export async function deleteProject(id) {
  const isCurrent = getState().project?.id === id;
  if (isCurrent) {
    if (timer) { clearTimeout(timer); timer = null; }
    // detach first so autosave can never write the deleted project back
    setState((s) => ({ ...s, project: null, photos: {}, selectedPhotoId: null }));
    lastSaved = { project: null, photos: {}, settings: lastSaved.settings };
    releaseAllMedia();
  }
  const photos = await getByIndex('photos', 'projectId', id).catch(() => []);
  for (const p of photos) await deletePhotoRecord(p, true);
  await del('projects', id).catch(() => {});
  if (isCurrent) await createProject();
  await refreshProjectsIndex();
}

export async function duplicateProject(id) {
  const project = await get('projects', id);
  if (!project) return;
  const photos = await getByIndex('photos', 'projectId', id);
  const copy = { ...structuredClone(project), id: uid('prj'), name: `${project.name} (کاپی)`, createdAt: Date.now(), updatedAt: Date.now() };
  const idMap = {};
  for (const p of photos) {
    const nid = uid('ph');
    idMap[p.id] = nid;
    // originals/masks are shared by key; deleting one project keeps blobs still in use
    await put('photos', { ...p, id: nid, projectId: copy.id });
  }
  copy.photoIds = copy.photoIds.map((pid) => idMap[pid]).filter(Boolean);
  copy.sheet.items = copy.sheet.items.map((it) => ({ ...it, photoId: idMap[it.photoId] })).filter((it) => it.photoId);
  await put('projects', copy);
  await refreshProjectsIndex();
}

async function blobInUse(key, exceptPhotoId) {
  if (!key) return false;
  const all = await getAll('photos').catch(() => []);
  return all.some((p) => p.id !== exceptPhotoId && (p.origKey === key || p.maskKey === key || p.clothesKey === key));
}

export async function deletePhotoRecord(photo, deleteOriginal) {
  await del('photos', photo.id).catch(() => {});
  delete lastSaved.photos[photo.id];
  for (const key of [deleteOriginal ? photo.origKey : null, photo.maskKey, photo.clothesKey, photo.edit?.bg?.imageKey, photo.edit?.clothes?.patch?.key]) {
    if (key && !(await blobInUse(key, photo.id))) await deleteBlob(key).catch(() => {});
  }
}

export async function renameProject(id, name) {
  const clean = String(name || '').trim().slice(0, 120);
  if (!clean) return;
  if (getState().project?.id === id) setState((s) => ({ ...s, project: { ...s.project, name: clean } }));
  else {
    const p = await get('projects', id);
    if (p) await put('projects', { ...p, name: clean, updatedAt: Date.now() });
  }
  await refreshProjectsIndex();
}

/* --------------------------------------------------------------- autosave */

async function saveNow() {
  const s = getState();
  if (saving) { schedule(); return; }
  saving = true;
  try {
    if (s.settings !== lastSaved.settings) {
      await kvSet('settings', s.settings);
      lastSaved.settings = s.settings;
    }
    if (s.project) {
      setState((st) => ({ ...st, saveStatus: 'saving' }));
      const changedPhotos = Object.values(s.photos).filter((p) => lastSaved.photos[p.id] !== p);
      for (const p of changedPhotos) {
        await put('photos', photoRecord(p));
        lastSaved.photos[p.id] = p;
      }
      if (s.project !== lastSaved.project || changedPhotos.length) {
        const firstThumb = s.project.photoIds.map((id) => s.photos[id]?.thumb).find(Boolean) || null;
        const rec = { ...projectRecord(s.project), updatedAt: Date.now(), thumb: firstThumb };
        await put('projects', rec);
        lastSaved.project = s.project;
        refreshProjectsIndex();
      }
      setState((st) => ({ ...st, saveStatus: st.storage.mode === 'memory' ? 'memory' : 'saved' }));
    }
  } catch (e) {
    console.error(e);
    setState((st) => ({ ...st, saveStatus: 'error' }));
    toast(storageErrorText(e), 'error', 8000);
  } finally {
    saving = false;
  }
}

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(() => { timer = null; saveNow(); }, SAVE_DELAY);
}

export async function flushSave() {
  if (timer) { clearTimeout(timer); timer = null; }
  await saveNow();
}

export function startAutosave() {
  subscribe((s, prev) => {
    if (s.project !== prev.project || s.photos !== prev.photos || s.settings !== prev.settings) {
      if (s.project && (s.project !== prev.project || s.photos !== prev.photos)) setState((st) => (st.saveStatus === 'pending' ? st : { ...st, saveStatus: 'pending' }));
      schedule();
    }
  });
}

export function hasUnsavedChanges() {
  return !!timer || saving;
}

export async function exportProjectSettingsJson() {
  const s = getState();
  return JSON.stringify({ format: 'hoshmand-templates', version: 1, paperPresets: s.settings.paperPresets, layoutPresets: s.settings.layoutPresets, customProfiles: s.settings.customProfiles }, null, 2);
}

export { logEvent };
