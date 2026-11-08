import { useRef, useState } from 'preact/hooks';
import { useStore, setState, confirmDialog, recordHistory } from '../state/store.js';
import { importFiles, duplicatePhoto, removePhoto, movePhoto, movePhotoTo, thumbUrl } from '../state/media.js';
import { Icon, IconButton } from './kit.jsx';
import { formatNumber } from '../core/digits.js';

export const ACCEPT = 'image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp';

export function Queue() {
  const ids = useStore((s) => s.project?.photoIds || []);
  const photos = useStore((s) => s.photos);
  const sel = useStore((s) => s.selectedPhotoId);
  const rev = useStore((s) => s.rev);
  const addRef = useRef(null);
  const replRef = useRef(null);
  const [dragId, setDragId] = useState(null);
  const selected = sel ? photos[sel] : null;
  const idx = ids.indexOf(sel);

  const select = (id) => setState((s) => ({ ...s, selectedPhotoId: id }));
  const remove = async () => {
    if (!selected) return;
    const ok = await confirmDialog({ title: 'حذف عکس از پروژه', body: `«${selected.name}» از این پروژه و از برگه‌های چاپ حذف شود؟ این کار برگشت‌پذیر نیست.`, confirmLabel: 'حذف', danger: true });
    if (ok) await removePhoto(selected.id);
  };

  return (
    <aside class="queue-pane" aria-label="عکس‌های پروژه">
      <div class="queue-head">
        <span class="small muted">{formatNumber(ids.length)} عکس</span>
        <IconButton small icon="image-plus" label="افزودن عکس" onClick={() => addRef.current?.click()} />
        <input ref={addRef} type="file" accept={ACCEPT} multiple hidden onChange={(e) => { const f = [...e.currentTarget.files]; e.currentTarget.value = ''; importFiles(f); }} />
      </div>
      <ul class="queue-list" role="listbox" aria-label="فهرست عکس‌ها" aria-activedescendant={sel ? `q-${sel}` : undefined}>
        {ids.map((id, i) => {
          const p = photos[id];
          if (!p) return null;
          const url = thumbUrl(id);
          return (
            <li
              key={id}
              id={`q-${id}`}
              role="option"
              aria-selected={String(id === sel)}
              class={`queue-item ${id === sel ? 'selected' : ''} ${dragId === id ? 'dragging' : ''}`}
              draggable
              onDragStart={(e) => { setDragId(id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', id); }}
              onDragEnd={() => setDragId(null)}
              onDragOver={(e) => { if (dragId) e.preventDefault(); }}
              onDrop={(e) => { e.preventDefault(); if (dragId && dragId !== id) { recordHistory({ type: 'queue' }); movePhotoTo(dragId, i); } setDragId(null); }}
            >
              <button type="button" class="queue-thumb" onClick={() => select(id)} aria-label={`${formatNumber(i + 1)}. ${p.name}`}>
                {url ? <img src={url} alt="" key={rev[id] || 0} /> : <span class="thumb-missing"><Icon name="image" /></span>}
                <span class="queue-num">{formatNumber(i + 1)}</span>
                {!p.hasOriginal ? <span class="queue-flag warn" title="عکس اصلی ذخیره نشده است"><Icon name="triangle-alert" size={12} /></span> : null}
                {p.edit.aiEdited ? <span class="queue-flag ai" title="ویرایش‌شده با هوش مصنوعی"><Icon name="sparkles" size={12} /></span> : null}
              </button>
            </li>
          );
        })}
      </ul>
      {selected ? (
        <div class="queue-actions" role="toolbar" aria-label="عملیات عکس انتخاب‌شده">
          <IconButton small icon="arrow-up" label="انتقال به بالا" disabled={idx <= 0} onClick={() => { recordHistory({ type: 'queue' }); movePhoto(sel, -1); }} />
          <IconButton small icon="arrow-down" label="انتقال به پایین" disabled={idx >= ids.length - 1} onClick={() => { recordHistory({ type: 'queue' }); movePhoto(sel, 1); }} />
          <IconButton small icon="copy" label="کاپی (تکثیر) عکس" onClick={() => duplicatePhoto(sel)} />
          <IconButton small icon="refresh-cw" label="جایگزینی عکس اصلی (تنظیمات حفظ می‌شود)" onClick={() => replRef.current?.click()} />
          <IconButton small icon="trash-2" label="حذف از پروژه" onClick={remove} />
          <input ref={replRef} type="file" accept={ACCEPT} hidden onChange={(e) => { const f = [...e.currentTarget.files]; e.currentTarget.value = ''; if (f[0]) importFiles([f[0]], { replaceId: sel }); }} />
        </div>
      ) : null}
    </aside>
  );
}

/** Shown in editing sections when the project has no photos. */
export function NeedPhotos({ title = 'هنوز عکسی وارد نشده است' }) {
  const ref = useRef(null);
  return (
    <div class="page">
      <div class="empty">
        <div class="empty-icon"><Icon name="image-plus" /></div>
        <h3>{title}</h3>
        <p class="muted small">از صفحهٔ شروع یا همین‌جا عکس وارد کنید (JPG، PNG یا WebP).</p>
        <button type="button" class="btn btn-primary" onClick={() => ref.current?.click()}><Icon name="upload" />انتخاب عکس</button>
        <input ref={ref} type="file" accept={ACCEPT} multiple hidden onChange={(e) => { const f = [...e.currentTarget.files]; e.currentTarget.value = ''; importFiles(f); }} />
      </div>
    </div>
  );
}
