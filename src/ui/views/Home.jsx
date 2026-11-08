import { useRef, useState } from 'preact/hooks';
import { useStore, setSection, getState, updateEdit, updateSettings } from '../../state/store.js';
import { importFiles, thumbUrl } from '../../state/media.js';
import { createProject, openProject } from '../../state/persist.js';
import { PURPOSES, findPhoto } from '../../core/presets.js';
import { WORKFLOW, OFFLINE_BADGE, APP_NAME } from '../../i18n/fa.js';
import { formatNumber } from '../../core/digits.js';
import { formatDateTimeFa } from '../../core/dates.js';
import { Icon, Button, Badge } from '../kit.jsx';
import { ACCEPT } from '../Queue.jsx';
import { aiAvailability } from '../../platform/capabilities.js';

export function HomeView() {
  const project = useStore((s) => s.project);
  const count = useStore((s) => s.project?.photoIds.length || 0);
  const recent = useStore((s) => s.projectsIndex.slice(0, 6));
  const caps = useStore((s) => s.caps);
  const models = useStore((s) => s.models);
  const storage = useStore((s) => s.storage);
  const purposeId = useStore((s) => s.settings.purposeId);
  const [over, setOver] = useState(false);
  const fileRef = useRef(null);
  const camRef = useRef(null);

  const onFiles = async (files) => {
    const added = await importFiles(files);
    if (added.length) setSection('editor');
  };

  const choosePurpose = (p) => {
    const preset = findPhoto(p.photoId);
    updateSettings({ defaultPhotoId: p.photoId, purposeId: p.id });
    const s = getState();
    for (const id of s.project?.photoIds || []) {
      const ph = s.photos[id];
      if (ph && ph.edit.sizeId !== preset.id) updateEdit(id, { widthMm: preset.widthMm, heightMm: preset.heightMm, sizeId: preset.id, profileId: p.profileId });
      else if (ph) updateEdit(id, { profileId: p.profileId }, { history: false });
    }
    fileRef.current?.click();
  };

  const ai = caps ? aiAvailability(caps) : { ok: false };
  const aiReady = Object.values(models).filter((m) => m.status === 'available' || m.status === 'ready').length;

  return (
    <div class="view">
      <div class="page home">
        <section class="hero">
          <div class="hero-text">
            <span class="eyebrow"><Icon name="shield-check" size={16} />{OFFLINE_BADGE}</span>
            <h2 class="hero-title">{APP_NAME}</h2>
            <p class="hero-lead">عکس پرسنلی، پاسپورت، مکتب و کارمندی را وارد کنید، کادر و نور را استاندارد کنید، پس‌زمینه را عوض کنید و هر تعداد عکس را با <b>اندازهٔ دقیق فیزیکی</b> روی کاغذ عکس چاپ کنید — بدون انترنت.</p>
            <ol class="flow" aria-label="مراحل کار">
              {WORKFLOW.map((w, i) => <li key={w}><span>{formatNumber(i + 1)}</span>{w}</li>)}
            </ol>
          </div>
          <div
            class={`dropzone ${over ? 'over' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setOver(true); }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); const f = [...(e.dataTransfer?.files || [])]; if (f.length) onFiles(f); }}
          >
            <div class="big-icon"><Icon name="upload" /></div>
            <h3>عکس‌ها را اینجا رها کنید</h3>
            <p class="muted small">JPG، PNG یا WebP — یک یا چند عکس. عکس اصلی هرگز تغییر نمی‌کند.</p>
            <div class="btn-row" style={{ justifyContent: 'center' }}>
              <Button variant="primary" size="lg" icon="images" onClick={() => fileRef.current?.click()}>انتخاب عکس از دستگاه</Button>
              <Button size="lg" icon="camera" onClick={() => camRef.current?.click()} title="در موبایل دوربین باز می‌شود؛ در کمپیوتر انتخاب فایل">گرفتن عکس با دوربین</Button>
            </div>
            <input ref={fileRef} type="file" accept={ACCEPT} multiple hidden onChange={(e) => { const f = [...e.currentTarget.files]; e.currentTarget.value = ''; if (f.length) onFiles(f); }} />
            <input ref={camRef} type="file" accept="image/*" capture="user" hidden onChange={(e) => { const f = [...e.currentTarget.files]; e.currentTarget.value = ''; if (f.length) onFiles(f); }} />
            {count ? <p class="small">این پروژه {formatNumber(count)} عکس دارد. <button type="button" class="link-btn" onClick={() => setSection('editor')}>ادامهٔ ویرایش</button></p> : null}
          </div>
        </section>

        <section class="home-section">
          <h3>برای چه کاری؟</h3>
          <p class="muted small">اندازهٔ پیش‌فرض عکس تنظیم می‌شود (بعداً قابل تغییر است). شرایط رسمی هر اداره را جداگانه بررسی کنید.</p>
          <div class="purpose-grid">
            {PURPOSES.map((p) => {
              const ph = findPhoto(p.photoId);
              return (
                <button type="button" key={p.id} class={`purpose ${purposeId === p.id ? 'active' : ''}`} aria-pressed={String(purposeId === p.id)} onClick={() => choosePurpose(p)}>
                  <span class="purpose-frame" style={{ aspectRatio: `${ph.widthMm} / ${ph.heightMm}` }}><Icon name="user-round" /></span>
                  <span class="purpose-name">{p.nameFa}</span>
                  <span class="purpose-size">{ph.nameFa}</span>
                </button>
              );
            })}
          </div>
        </section>

        <div class="home-cols">
          <section class="card">
            <div class="group-title"><span>پروژه‌های اخیر</span>
              <span class="actions"><Button size="sm" icon="plus" onClick={() => createProject()}>پروژهٔ تازه</Button></span>
            </div>
            {recent.length ? (
              <ul class="recent-list">
                {recent.map((r) => (
                  <li key={r.id}>
                    <button type="button" class={`recent ${project?.id === r.id ? 'current' : ''}`} onClick={() => (project?.id === r.id ? setSection('editor') : openProject(r.id).then(() => setSection('editor')))}>
                      <span class="recent-thumb">{r.thumb ? <ThumbFromBlob blob={r.thumb} /> : <Icon name="folder" />}</span>
                      <span class="recent-meta"><b>{r.name}</b><span class="faint tiny">{formatNumber(r.count)} عکس · {formatDateTimeFa(r.updatedAt)}</span></span>
                      {project?.id === r.id ? <Badge kind="accent">باز</Badge> : null}
                    </button>
                  </li>
                ))}
              </ul>
            ) : <p class="muted small">هنوز پروژه‌ای ذخیره نشده است.</p>}
          </section>
          <section class="card">
            <div class="group-title"><span>وضعیت این دستگاه</span></div>
            <ul class="status-list">
              <li><Icon name="wifi-off" /><span>ویرایش و چاپ بدون انترنت</span><Badge kind="ok">آماده</Badge></li>
              <li><Icon name="hard-drive" /><span>ذخیره‌سازی محلی</span>{storage.mode === 'memory' ? <Badge kind="err">در دسترس نیست</Badge> : <Badge kind="ok">{storage.backend === 'opfs' ? 'OPFS + IndexedDB' : 'IndexedDB'}</Badge>}</li>
              <li><Icon name="cpu" /><span>هوش مصنوعی محلی</span>{ai.ok ? <Badge kind={aiReady ? 'ok' : 'warn'}>{aiReady ? `${formatNumber(aiReady)} مدل آماده` : 'مدلی پیدا نشد'}</Badge> : <Badge kind="warn">غیرفعال</Badge>}</li>
              <li><Icon name="gauge" /><span>شتاب‌دهی</span><span class="faint small">{caps?.webgpu ? 'WebGPU' : caps?.webgl2 ? 'WebGL2' : 'CPU'}{caps?.wasmThreads ? ' · چندرشته‌ای' : ''}</span></li>
            </ul>
            {!ai.ok && caps ? <p class="hint">{ai.reason}</p> : null}
            <Button size="sm" variant="ghost" icon="settings" onClick={() => setSection('settings')}>جزئیات و مدل‌ها</Button>
          </section>
        </div>
      </div>
    </div>
  );
}

function ThumbFromBlob({ blob }) {
  const [url] = useState(() => (blob ? URL.createObjectURL(blob) : null));
  return url ? <img src={url} alt="" onLoad={() => setTimeout(() => URL.revokeObjectURL(url), 1000)} /> : null;
}

export { thumbUrl };
