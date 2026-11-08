import { useEffect, useState } from 'preact/hooks';
import { useStore, confirmDialog, setSection, openDialog, toast } from '../../state/store.js';
import { createProject, openProject, deleteProject, duplicateProject, renameProject, refreshProjectsIndex } from '../../state/persist.js';
import { formatNumber, formatBytes } from '../../core/digits.js';
import { formatDateTimeFa } from '../../core/dates.js';
import { Button, Icon, IconButton, Badge, Empty } from '../kit.jsx';

const LOG_FA = {
  create: 'ساخت پروژه', import: 'وارد کردن عکس', replace: 'جایگزینی عکس', duplicate: 'کاپی عکس', remove: 'حذف عکس',
  export: 'ذخیرهٔ فایل', print: 'باز کردن پنجرهٔ چاپ', pdf: 'ساخت PDF', 'sheet-image': 'ساخت تصویر برگه',
};

function Thumb({ blob }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    if (!blob) return undefined;
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  return url ? <img src={url} alt="" /> : <Icon name="folder" />;
}

export function ProjectsView() {
  const list = useStore((s) => s.projectsIndex);
  const current = useStore((s) => s.project);
  const caps = useStore((s) => s.caps);
  useEffect(() => { refreshProjectsIndex(); }, []);

  const remove = async (p) => {
    const ok = await confirmDialog({ title: 'حذف پروژه', body: `پروژهٔ «${p.name}» و همهٔ عکس‌ها، ماسک‌ها و تنظیمات آن برای همیشه از این دستگاه پاک شود؟`, confirmLabel: 'حذف برای همیشه', danger: true });
    if (ok) { await deleteProject(p.id); toast('پروژه پاک شد.', 'success'); }
  };
  const rename = async (p) => {
    const name = await openDialog('prompt', { title: 'تغییر نام پروژه', label: 'نام تازه', value: p.name });
    if (name) await renameProject(p.id, name);
  };

  return (
    <div class="view">
      <div class="page">
        <div class="page-head">
          <div><h2>پروژه‌ها و تاریخچه</h2><p class="muted">همهٔ پروژه‌ها فقط در حافظهٔ همین مرورگر روی همین دستگاه ذخیره می‌شوند.</p></div>
          <Button variant="primary" icon="plus" onClick={async () => { await createProject(); setSection('home'); }}>پروژهٔ تازه</Button>
        </div>
        {!list.length ? <Empty icon="folder-open" title="پروژه‌ای نیست">با وارد کردن عکس، پروژه خودکار ذخیره می‌شود.</Empty> : (
          <div class="project-grid">
            {list.map((p) => (
              <article class={`project-card ${current?.id === p.id ? 'current' : ''}`} key={p.id}>
                <button type="button" class="project-open" onClick={async () => { if (current?.id !== p.id) await openProject(p.id); setSection('editor'); }}>
                  <span class="project-thumb"><Thumb blob={p.thumb} /></span>
                  <span class="project-meta">
                    <b>{p.name}</b>
                    <span class="faint tiny">{formatNumber(p.count)} عکس · آخرین تغییر {formatDateTimeFa(p.updatedAt)}</span>
                  </span>
                  {current?.id === p.id ? <Badge kind="accent">باز است</Badge> : null}
                </button>
                <div class="project-actions">
                  <IconButton small icon="pencil" label="تغییر نام" onClick={() => rename(p)} />
                  <IconButton small icon="copy" label="کاپی پروژه" onClick={() => duplicateProject(p.id).then(() => toast('کاپی پروژه ساخته شد.', 'success'))} />
                  <IconButton small icon="trash-2" label="حذف پروژه" onClick={() => remove(p)} />
                </div>
              </article>
            ))}
          </div>
        )}
        {current ? (
          <section class="card">
            <h3>تاریخچهٔ پروژهٔ باز: {current.name}</h3>
            <ol class="log">
              {[...(current.log || [])].reverse().slice(0, 60).map((e, i) => (
                <li key={i}><span class="faint tiny">{formatDateTimeFa(e.at)}</span> <b>{LOG_FA[e.kind] || e.kind}</b> {e.detail ? <span class="muted">— {e.detail}</span> : null}</li>
              ))}
            </ol>
          </section>
        ) : null}
        {caps?.storage?.quota ? <p class="hint">فضای استفاده‌شدهٔ این برنامه در مرورگر: {formatBytes(caps.storage.usage)} از حدود {formatBytes(caps.storage.quota)}.</p> : null}
      </div>
    </div>
  );
}
