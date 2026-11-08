import { useEffect, useState } from 'preact/hooks';
import { useStore, setSection, undo, redo, dismissToast, cancelTask, setState, getState } from '../state/store.js';
import { SECTIONS, OFFLINE_BADGE, APP_NAME } from '../i18n/fa.js';
import { Icon, IconButton, Progress } from './kit.jsx';
import { Dialogs } from './dialogs.jsx';
import { renameProject } from '../state/persist.js';
import { HomeView } from './views/Home.jsx';
import { EditorView } from './views/Editor.jsx';
import { SmartView } from './views/Smart.jsx';
import { BackgroundView } from './views/Background.jsx';
import { ClothingView } from './views/Clothing.jsx';
import { PrintView } from './views/Print.jsx';
import { TemplatesView } from './views/Templates.jsx';
import { ProjectsView } from './views/Projects.jsx';
import { SettingsView } from './views/Settings.jsx';

const VIEWS = {
  home: HomeView, editor: EditorView, smart: SmartView, background: BackgroundView, clothing: ClothingView,
  print: PrintView, templates: TemplatesView, projects: ProjectsView, settings: SettingsView,
};
const MOBILE_PRIMARY = ['home', 'editor', 'smart', 'background', 'print'];

function BrandMark() {
  return (
    <svg class="brand-mark" viewBox="0 0 512 512" aria-hidden="true">
      <rect width="512" height="512" rx="112" fill="#2346c9" />
      <rect x="146" y="104" width="220" height="292" rx="18" fill="#f7f8fb" />
      <circle cx="256" cy="214" r="58" fill="#1c2f8f" />
      <path d="M168 380c8-64 46-100 88-100s80 36 88 100z" fill="#1c2f8f" />
      <path d="M120 150v-34a24 24 0 0 1 24-24h34M392 150v-34a24 24 0 0 0-24-24h-34M120 362v34a24 24 0 0 0 24 24h34M392 362v34a24 24 0 0 1-24 24h-34" fill="none" stroke="#e6ad3e" stroke-width="16" stroke-linecap="round" />
    </svg>
  );
}

function SaveState() {
  const st = useStore((s) => s.saveStatus);
  const text = { idle: '', pending: 'تغییرات ذخیره‌نشده', saving: 'در حال ذخیره…', saved: 'ذخیره شد', error: 'ذخیره ناموفق', memory: 'فقط در حافظهٔ موقت' }[st] || '';
  if (!text) return null;
  return <span class="save-state" data-state={st} role="status" aria-live="polite"><span class="dot" aria-hidden="true" />{text}</span>;
}

function Tasks() {
  const tasks = useStore((s) => s.tasks);
  const list = Object.values(tasks);
  if (!list.length) return null;
  const t = list[list.length - 1];
  return (
    <div class="taskbar" role="status" aria-live="polite">
      <Icon name="loader-circle" class="spin" size={16} />
      <span class="label">{t.label}</span>
      <Progress value={t.progress} />
      {t.cancellable ? <IconButton small icon="x" label="لغو عملیات" tipBelow onClick={() => cancelTask(t.id)} /> : null}
    </div>
  );
}

function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div class="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} class={`toast ${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'}>
          <Icon name={{ success: 'circle-check', error: 'circle-x', warn: 'triangle-alert', info: 'info' }[t.kind] || 'info'} />
          <div class="grow">{t.message}</div>
          <IconButton small icon="x" label="بستن پیام" onClick={() => dismissToast(t.id)} />
        </div>
      ))}
    </div>
  );
}

function Header({ section }) {
  const project = useStore((s) => s.project);
  const hist = useStore((s) => s.history);
  const swUpdate = useStore((s) => s.swUpdate);
  const storageMode = useStore((s) => s.storage.mode);
  const meta = SECTIONS.find((x) => x.id === section);
  const [name, setName] = useState(project?.name || '');
  useEffect(() => setName(project?.name || ''), [project?.name]);
  return (
    <header class="header">
      <div class="header-title">
        <h1 class="section-title">{meta?.title}</h1>
        {project ? (
          <input
            class="project-name"
            value={name}
            aria-label="نام پروژه"
            maxLength={120}
            onInput={(e) => setName(e.currentTarget.value)}
            onBlur={() => { if (name.trim() && name !== project.name) renameProject(project.id, name); else setName(project.name); }}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
          />
        ) : null}
      </div>
      <div class="header-actions">
        <Tasks />
        {swUpdate ? <button type="button" class="btn btn-sm btn-gold" onClick={() => { navigator.serviceWorker?.controller && setState({ swUpdate: false }); window.location.reload(); }}>نسخهٔ تازه آماده است — بارگذاری دوباره</button> : null}
        <SaveState />
        <IconButton icon="undo-2" label="واگرد (Ctrl+Z)" tipBelow disabled={!hist.canUndo} onClick={undo} />
        <IconButton icon="redo-2" label="از نو (Ctrl+Y)" tipBelow disabled={!hist.canRedo} onClick={redo} />
        <span class="privacy" role="note" title={storageMode === 'memory' ? 'ذخیره‌سازی محلی در دسترس نیست؛ پس از بستن صفحه، کار حفظ نمی‌شود.' : OFFLINE_BADGE}>
          <Icon name="shield-check" />
          <span class="privacy-text">{OFFLINE_BADGE}</span>
        </span>
      </div>
    </header>
  );
}

function Nav({ section, mobile }) {
  const [more, setMore] = useState(false);
  const items = mobile ? SECTIONS.filter((s) => MOBILE_PRIMARY.includes(s.id)) : SECTIONS;
  const go = (id) => { setSection(id); setMore(false); };
  const Item = ({ s }) => (
    <button type="button" class="rail-item" aria-current={section === s.id ? 'page' : undefined} onClick={() => go(s.id)} title={s.title}>
      <Icon name={s.icon} />
      <span>{s.short}</span>
    </button>
  );
  if (mobile) {
    return (
      <nav class="tabbar" aria-label="بخش‌های برنامه">
        {items.map((s) => <Item key={s.id} s={s} />)}
        <button type="button" class="rail-item" aria-expanded={more} aria-haspopup="true" onClick={() => setMore(!more)}>
          <Icon name="ellipsis" /><span>بیشتر</span>
        </button>
        {more ? (
          <div class="more-menu" role="menu">
            {SECTIONS.filter((s) => !MOBILE_PRIMARY.includes(s.id)).map((s) => <Item key={s.id} s={s} />)}
          </div>
        ) : null}
      </nav>
    );
  }
  return (
    <nav class="rail" aria-label="بخش‌های برنامه">
      <div class="brand" title={APP_NAME}><BrandMark /><span class="sr-only">{APP_NAME}</span></div>
      {items.map((s) => <Item key={s.id} s={s} />)}
      <div class="rail-spacer" />
    </nav>
  );
}

export function App() {
  const section = useStore((s) => s.section);
  const ready = useStore((s) => s.ready);
  const View = VIEWS[section] || HomeView;

  useEffect(() => {
    const onKey = (e) => {
      const tag = (e.target?.tagName || '').toLowerCase();
      const editable = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target?.isContentEditable;
      if ((e.ctrlKey || e.metaKey) && !editable) {
        if (e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
        else if (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
      }
      if (e.key === 'Escape' && getState().toasts.length) dismissToast(getState().toasts.at(-1).id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!ready) {
    return <div class="boot" role="status"><div class="boot-mark" aria-hidden="true" /><p>در حال آماده‌سازی…</p></div>;
  }
  return (
    <div class="shell">
      <Nav section={section} />
      <Header section={section} />
      <main class="main" id="main" tabIndex={-1}>
        <View key={section} />
      </main>
      <Nav section={section} mobile />
      <Toasts />
      <Dialogs />
    </div>
  );
}
