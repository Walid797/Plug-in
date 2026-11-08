/* global __APP_VERSION__ */
import { render } from 'preact';
import { App } from './ui/App.jsx';
import { setState, getState, subscribe, toast, hasRunningTasks, openDialog, updateSettings } from './state/store.js';
import { detectCapabilities } from './platform/capabilities.js';
import { initStorage, blobBackend, kvGet } from './storage/db.js';
import { loadSettings, startAutosave, openProject, createProject, refreshProjectsIndex, hasUnsavedChanges, flushSave } from './state/persist.js';
import { refreshModelStatus } from './ai/models.js';
import { SECTIONS } from './i18n/fa.js';

function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'dark' || theme === 'light') root.dataset.theme = theme;
  else delete root.dataset.theme;
}

function registerServiceWorker(caps) {
  if (!caps.serviceWorker) return;
  navigator.serviceWorker.register('sw.js', { scope: './' }).then((reg) => {
    const onUpdate = (worker) => {
      worker.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) setState({ swUpdate: true });
      });
    };
    if (reg.installing) onUpdate(reg.installing);
    reg.addEventListener('updatefound', () => reg.installing && onUpdate(reg.installing));
  }).catch(() => { /* PWA optional */ });
}

async function boot() {
  render(<App />, document.getElementById('app'));
  window.addEventListener('error', (e) => { console.error(e.error || e.message); });
  window.addEventListener('unhandledrejection', (e) => {
    console.error(e.reason);
    const msg = String(e.reason?.message || '');
    if (/memory|allocation/i.test(msg)) toast('حافظهٔ دستگاه کافی نیست. عکس‌های کمتری باز کنید یا DPI را کم کنید.', 'error', 9000);
  });

  const caps = await detectCapabilities();
  const st = await initStorage();
  const backend = st.mode === 'memory' ? 'memory' : await blobBackend();
  setState({ caps, storage: { mode: st.mode, backend, error: st.error ? String(st.error.message || st.error) : null }, version: __APP_VERSION__ });
  const settings = await loadSettings();
  applyTheme(settings.theme);
  subscribe((s, prev) => { if (s.settings.theme !== prev.settings.theme) applyTheme(s.settings.theme); });
  startAutosave();

  const lastId = await kvGet('lastProjectId', null);
  let opened = null;
  if (lastId) opened = await openProject(lastId).catch(() => null);
  if (!opened) await createProject();
  await refreshProjectsIndex();

  const hash = location.hash.replace('#', '');
  const section = SECTIONS.some((x) => x.id === hash) ? hash : (getState().project?.photoIds.length ? 'editor' : 'home');
  setState({ ready: true, section, saveStatus: st.mode === 'memory' ? 'memory' : 'saved' });
  if (st.mode === 'memory') toast('ذخیره‌سازی محلی مرورگر در دسترس نیست (مثلاً پنجرهٔ خصوصی). کار شما پس از بستن صفحه حفظ نمی‌شود؛ قبل از بستن، خروجی بگیرید.', 'warn', 12000);
  if (caps.fileMode) toast('برنامه مستقیم از فایل باز شده است: ویرایش و چاپ کار می‌کند؛ برای هوش مصنوعی و نصب به‌عنوان برنامه، با راه‌انداز محلی باز کنید.', 'info', 9000);

  refreshModelStatus();
  registerServiceWorker(caps);
  if (/[?&]e2e=1\b/.test(location.search)) {
    // Opt-in hook for the automated end-to-end tests only (no network, no extra capability).
    const sheet = await import('./print/sheet.js');
    window.__hoshmand = { getState, setState, sheet };
  }

  if (!settings.onboardingDone) {
    await openDialog('onboarding');
    updateSettings({ onboardingDone: true });
  }

  window.addEventListener('beforeunload', (e) => {
    if (hasRunningTasks() || hasUnsavedChanges()) {
      flushSave();
      e.preventDefault();
      e.returnValue = '';
    }
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushSave(); });
}

boot().catch((e) => {
  console.error(e);
  const el = document.getElementById('app');
  el.innerHTML = '';
  const p = document.createElement('div');
  p.className = 'boot';
  p.setAttribute('role', 'alert');
  p.textContent = 'راه‌اندازی برنامه ناموفق بود. صفحه را دوباره بارگذاری کنید. اگر مشکل ادامه داشت، مرورگر دیگری (Chrome، Edge یا Firefox جدید) را امتحان کنید.';
  el.appendChild(p);
});
