import { useState } from 'preact/hooks';
import { useStore, updateEdit, recordHistory, toast, setSection, startTask, orderedPhotos, getState, updateSettings } from '../../state/store.js';
import { PhotoCanvas } from '../PhotoCanvas.jsx';
import { Queue, NeedPhotos, ACCEPT } from '../Queue.jsx';
import { Button, Group, Notice, Slider, Switch, Segmented, FilePick, Badge, Select } from '../kit.jsx';
import { useCropHandlers, ViewSwitch } from './Editor.jsx';
import { segmentPhoto, chooseSegModel } from '../../ai/segment.js';
import { hasMask, clearMask, setBackgroundImage, getPersonMask, maskForegroundFraction } from '../../state/media.js';
import { BACKGROUND_PRESETS } from '../../core/presets.js';
import { aiAvailability } from '../../platform/capabilities.js';
import { formatNumber } from '../../core/digits.js';
import { findModel } from '../../ai/registry.js';
import { modelStatusText } from './Settings.jsx';

export { maskForegroundFraction };

export function segErrorText(err) {
  switch (err?.code) {
    case 'NO_ORIGINAL': return 'عکس اصلی در دسترس نیست؛ آن را دوباره انتخاب کنید.';
    case 'SEG_EMPTY': return 'مدل هیچ مرز مشخصی بین شخص و پس‌زمینه پیدا نکرد، پس پس‌زمینه حذف نشد. عکس باید یک نفر را از روبه‌رو با پس‌زمینهٔ قابل‌تشخیص نشان دهد. اگر عکس درست است، در «تنظیمات ← سخت‌افزار اجرای مدل» گزینهٔ «پردازنده (CPU)» را انتخاب و دوباره امتحان کنید.';
    case 'MODEL_MISSING': return 'فایل مدل پیدا نشد. از «تنظیمات و مدل‌های آفلاین» آن را نصب کنید.';
    case 'HASH_MISMATCH': return 'فایل مدل خراب یا تغییر یافته است (چکسام نادرست).';
    case 'FILE_PROTOCOL': return 'در حالت file:// مدل بارگذاری نمی‌شود؛ برنامه را با راه‌انداز محلی باز کنید.';
    default: return 'جداسازی پس‌زمینه ناموفق بود (حافظهٔ دستگاه یا اجرای مدل). صفحه را دوباره بارگذاری کنید و دوباره امتحان کنید.';
  }
}

function backendLabel(modelId) {
  const m = getState().models[modelId];
  return m?.backend || 'محلی';
}

export function strokeHandlers(photoId, path) {
  // path: ['bg','strokes'] or ['clothes','recolor','strokes']
  const set = (edit, fn) => {
    if (path[0] === 'face') return { ...edit, face: { ...edit.face, fixes: fn(edit.face?.fixes || []) } };
    if (path[0] === 'bg') return { ...edit, bg: { ...edit.bg, strokes: fn(edit.bg.strokes) } };
    return { ...edit, clothes: { ...edit.clothes, recolor: { ...edit.clothes.recolor, strokes: fn(edit.clothes.recolor.strokes) } } };
  };
  return {
    onStrokeStart: (s) => { recordHistory({ type: 'edit', photoId }); updateEdit(photoId, (ed) => set(ed, (list) => [...list, s].slice(-400)), { history: false }); },
    onStroke: (s) => updateEdit(photoId, (ed) => set(ed, (list) => [...list.slice(0, -1), s]), { history: false }),
    onStrokeEnd: () => {},
  };
}

export function BackgroundView() {
  const photo = useStore((s) => (s.selectedPhotoId ? s.photos[s.selectedPhotoId] : null));
  const caps = useStore((s) => s.caps);
  const models = useStore((s) => s.models);
  const rev = useStore((s) => (photo ? s.rev[photo.id] || 0 : 0));
  const segPref = useStore((s) => s.settings.segModel);
  const [view, setView] = useState('result');
  const [tool, setTool] = useState('move');
  const [brush, setBrush] = useState({ mode: 'erase', size: 0.06, softness: 0.5 });
  const [busy, setBusy] = useState(false);
  const handlers = useCropHandlers(photo || { id: null });
  if (!photo) return <div class="view"><NeedPhotos /></div>;
  void rev;
  const e = photo.edit;
  const bg = e.bg;
  const ai = caps ? aiAvailability(caps) : { ok: false };
  const modelId = chooseSegModel();
  const segState = models[modelId];
  const modelOk = segState && ['available', 'ready'].includes(segState.status);
  const canRun = ai.ok && modelOk;
  const reason = !ai.ok ? ai.reason : !modelOk ? `مدل جداسازی: ${modelStatusText(segState)}` : '';
  const masked = hasMask(photo, 'person');
  const setBg = (patch, history = true) => updateEdit(photo.id, (ed) => ({ ...ed, bg: { ...ed.bg, ...(typeof patch === 'function' ? patch(ed.bg) : patch) } }), { history });
  const setRefine = (k, v, h) => setBg((b) => ({ refine: { ...b.refine, [k]: v } }), h);
  const setShadow = (k, v, h) => setBg((b) => ({ shadow: { ...b.shadow, [k]: v } }), h);

  /**
   * Segment, then build the final refined mask BEFORE enabling the new
   * background, and measure it — success is only reported for a real split.
   */
  const run = async (target = photo) => {
    const r = await segmentPhoto(target);
    const fresh = getState().photos[target.id];
    const mask = await getPersonMask(fresh);
    const frac = maskForegroundFraction(mask);
    if (frac == null || frac < 0.01 || frac > 0.99) throw Object.assign(new Error('SEG_EMPTY'), { code: 'SEG_EMPTY' });
    updateEdit(target.id, (ed) => ({ ...ed, bg: { ...ed.bg, enabled: true, modelId: r.modelId } }));
    return { ...r, frac };
  };

  const onRun = async () => {
    setBusy(true);
    try {
      const r = await run();
      toast(`پس‌زمینه جدا شد: حدود ${formatNumber(r.frac * 100, { maxFraction: 0 })}٪ عکس «شخص» و بقیه «پس‌زمینه» تشخیص داده شد (مدل محلی، ${backendLabel(r.modelId)}). لبه‌ها را بررسی و در صورت نیاز با قلم‌مو اصلاح کنید.`, 'success', 9000);
    } catch (err) {
      console.error(err);
      toast(segErrorText(err), 'error', 10000);
    } finally { setBusy(false); }
  };

  const onBatch = async () => {
    const list = orderedPhotos(getState()).filter((p) => p.id !== photo.id || !masked);
    const task = startTask('حذف گروهی پس‌زمینه…', { cancellable: true });
    let ok = 0; let failed = 0;
    try {
      for (let i = 0; i < list.length; i += 1) {
        if (task.signal.aborted) break;
        task.update(i / list.length, `عکس ${formatNumber(i + 1)} از ${formatNumber(list.length)}`);
        try {
          await run(list[i]);
          updateEdit(list[i].id, (ed) => ({ ...ed, bg: { ...ed.bg, mode: bg.mode, color: bg.color, imageKey: bg.imageKey, shadow: bg.shadow, refine: bg.refine } }), { history: false });
          ok += 1;
        } catch (err) { console.error(err); failed += 1; }
      }
      toast(`پس‌زمینهٔ ${formatNumber(ok)} عکس جدا شد${failed ? `؛ ${formatNumber(failed)} عکس ناموفق بود (بدون مرز مشخص شخص/پس‌زمینه یا خطای مدل)` : ''}.`, failed ? 'warn' : 'success', 9000);
    } finally { task.done(); }
  };

  const brushing = tool === 'brush' && masked && bg.enabled;
  return (
    <div class="view">
      <div class="workspace">
        <Queue />
        <section class="stage" aria-label="بوم پس‌زمینه">
          <div class="stage-toolbar" role="toolbar">
            <Button variant="primary" icon="wand-sparkles" busy={busy} disabled={!canRun || busy} onClick={onRun} title={reason || 'جداسازی شخص از پس‌زمینه با مدل محلی'}>{masked ? 'جداسازی دوباره' : 'حذف پس‌زمینه'}</Button>
            <Segmented value={tool} onChange={setTool} options={[
              { value: 'move', label: 'جابجایی', icon: 'move' },
              { value: 'brush', label: 'قلم‌مو', icon: 'brush', disabled: !masked || !bg.enabled },
            ]} />
            <span class="toolbar-spacer" />
            <ViewSwitch view={view} setView={setView} extra={[{ value: 'mask', label: 'ماسک', icon: 'layers', disabled: !masked }]} />
          </div>
          <PhotoCanvas
            photo={photo}
            mode={brushing ? 'brush' : 'crop'}
            view={view}
            brush={brushing ? brush : null}
            maskTarget="person"
            {...handlers}
            {...strokeHandlers(photo.id, ['bg', 'strokes'])}
          />
        </section>
        <aside class="panel" aria-label="تنظیمات پس‌زمینه">
          <div class="panel-inner">
            {!canRun ? <Notice kind="warn" title="حذف خودکار پس‌زمینه در دسترس نیست"><p>{reason}</p><p>این برنامه حذف پس‌زمینه را با روش ساده و غیرهوشمند (مثل حذف رنگ) جعل نمی‌کند.</p><Button size="sm" variant="ghost" icon="settings" onClick={() => setSection('settings')}>نصب مدل</Button></Notice> : null}
            {masked ? (
              <Group title="وضعیت">
                <Switch label="پس‌زمینهٔ جدید فعال باشد" checked={bg.enabled} onChange={(v) => setBg({ enabled: v })} hint="با خاموش کردن، عکس اصلی بدون تغییر نمایش داده می‌شود." />
                <div class="btn-row"><Badge kind="accent" icon="cpu">{findModel(bg.modelId || modelId)?.nameFa?.split('—')[1]?.trim() || 'مدل محلی'}</Badge>
                  <Button size="sm" variant="ghost" icon="trash-2" onClick={async () => { await clearMask(photo.id); setBg({ enabled: false, strokes: [] }); }}>حذف ماسک</Button></div>
              </Group>
            ) : <p class="hint">ابتدا «حذف پس‌زمینه» را بزنید. پردازش کاملاً روی همین دستگاه انجام می‌شود.</p>}
            <Group title="پس‌زمینهٔ جدید">
              <div class="swatches" role="group" aria-label="رنگ پس‌زمینه">
                {BACKGROUND_PRESETS.map((b) => (
                  <button type="button" key={b.id} class="swatch" style={{ background: b.color }} aria-pressed={String(bg.mode === 'color' && bg.color === b.color)} aria-label={b.nameFa} data-tip={b.nameFa} onClick={() => setBg({ mode: 'color', color: b.color })} />
                ))}
                <label class="swatch custom" data-tip="رنگ دلخواه">
                  <input type="color" value={bg.color} aria-label="رنگ دلخواه" onChange={(ev) => setBg({ mode: 'color', color: ev.currentTarget.value })} />
                </label>
              </div>
              <div class="btn-row">
                <FilePick accept={ACCEPT} size="sm" icon="image" onFiles={async (f) => { const key = await setBackgroundImage(photo.id, f[0]); if (key) setBg({ mode: 'image', imageKey: key }); }}>تصویر پس‌زمینه از دستگاه</FilePick>
                <Button size="sm" variant={bg.mode === 'transparent' ? 'primary' : ''} icon="square-dashed" onClick={() => setBg({ mode: 'transparent' })}>شفاف (برای PNG)</Button>
              </div>
              {bg.mode === 'transparent' ? <p class="hint">در چاپ و JPEG، ناحیهٔ شفاف سفید چاپ می‌شود.</p> : null}
            </Group>
            <Group title="اصلاح لبه‌ها">
              <Switch label="چسباندن لبه به جزئیات عکس (فیلتر هدایت‌شده)" checked={bg.refine.edgeAware !== false} onChange={(v) => setRefine('edgeAware', v, true)} />
              <Slider label="جمع/گسترش لبه" min={-100} max={100} value={Math.round((bg.refine.shift || 0) * 100)} defaultValue={0} format={(v) => formatNumber(v)}
                onInput={(v) => setRefine('shift', v / 100, false)} onCommit={(v, s) => { setRefine('shift', s / 100, false); setRefine('shift', v / 100, true); }} />
              <Slider label="نرمی لبه" min={0} max={100} value={Math.round((bg.refine.softness ?? 0.4) * 100)} defaultValue={40} format={(v) => formatNumber(v)}
                onInput={(v) => setRefine('softness', v / 100, false)} onCommit={(v, s) => { setRefine('softness', s / 100, false); setRefine('softness', v / 100, true); }} />
              <Slider label="محو لبه (پیکسل)" min={0} max={12} value={bg.refine.feather || 0} defaultValue={0} format={(v) => formatNumber(v)}
                onInput={(v) => setRefine('feather', v, false)} onCommit={(v, s) => { setRefine('feather', s, false); setRefine('feather', v, true); }} />
              <Switch label="پاک‌سازی رنگ قدیمی در لبهٔ مو" checked={bg.decontaminate !== false} onChange={(v) => setBg({ decontaminate: v })} />
            </Group>
            <Group title="قلم‌مو (بازگرداندن / پاک کردن)" actions={bg.strokes.length ? <Button size="sm" variant="ghost" icon="trash-2" onClick={() => setBg({ strokes: [] })}>حذف همهٔ ضربه‌ها</Button> : null}>
              <Segmented value={brush.mode} onChange={(m) => { setBrush({ ...brush, mode: m }); setTool('brush'); }} disabled={!masked || !bg.enabled} options={[
                { value: 'restore', label: 'بازگرداندن', icon: 'brush' },
                { value: 'erase', label: 'پاک کردن', icon: 'eraser' },
              ]} />
              <Slider label="اندازهٔ قلم" min={1} max={30} value={Math.round(brush.size * 100)} defaultValue={6} format={(v) => formatNumber(v)} onInput={(v) => setBrush({ ...brush, size: v / 100 })} disabled={!masked} />
              <Slider label="نرمی قلم" min={0} max={100} value={Math.round(brush.softness * 100)} defaultValue={50} format={(v) => formatNumber(v)} onInput={(v) => setBrush({ ...brush, softness: v / 100 })} disabled={!masked} />
              <p class="hint">{formatNumber(bg.strokes.length)} ضربه. هر ضربه با واگرد (Ctrl+Z) برمی‌گردد. برای دیدن دقیق، نمای «ماسک» را انتخاب کنید.</p>
            </Group>
            <Group title="سایه">
              <Switch label="سایهٔ نرم پشت شخص" checked={bg.shadow.enabled} onChange={(v) => setShadow('enabled', v, true)} disabled={!masked} />
              {bg.shadow.enabled ? (
                <>
                  <Slider label="شدت" min={0} max={80} value={bg.shadow.opacity} defaultValue={25} format={(v) => `${formatNumber(v)}٪`} onInput={(v) => setShadow('opacity', v, false)} onCommit={(v, s) => { setShadow('opacity', s, false); setShadow('opacity', v, true); }} />
                  <Slider label="پخش (ملی‌متر)" min={0} max={6} step={0.1} value={bg.shadow.blurMm} defaultValue={1.5} format={(v) => formatNumber(v, { maxFraction: 1 })} onInput={(v) => setShadow('blurMm', v, false)} onCommit={(v, s) => { setShadow('blurMm', s, false); setShadow('blurMm', v, true); }} />
                  <Slider label="فاصلهٔ افقی (ملی‌متر)" min={-4} max={4} step={0.1} value={bg.shadow.offsetXmm} defaultValue={0} format={(v) => formatNumber(v, { maxFraction: 1 })} onInput={(v) => setShadow('offsetXmm', v, false)} onCommit={(v, s) => { setShadow('offsetXmm', s, false); setShadow('offsetXmm', v, true); }} />
                  <Slider label="فاصلهٔ عمودی (ملی‌متر)" min={-4} max={4} step={0.1} value={bg.shadow.offsetYmm} defaultValue={0.8} format={(v) => formatNumber(v, { maxFraction: 1 })} onInput={(v) => setShadow('offsetYmm', v, false)} onCommit={(v, s) => { setShadow('offsetYmm', s, false); setShadow('offsetYmm', v, true); }} />
                </>
              ) : null}
            </Group>
            <Group title="پردازش گروهی">
              <Button icon="users" disabled={!canRun} onClick={onBatch} title={reason}>حذف پس‌زمینهٔ همهٔ عکس‌ها با همین تنظیمات</Button>
            </Group>
            <Group title="مدل">
              <Select label="مدل جداسازی" value={segPref} onChange={(v) => updateSettings({ segModel: v })} options={[
                { value: 'auto', label: 'خودکار (بهترین مدل نصب‌شده)' },
                { value: 'selfie-multiclass', label: 'MediaPipe Selfie Multiclass' },
                { value: 'modnet', label: `MODNet${['available', 'ready'].includes(models.modnet?.status) ? '' : ' — نصب نشده'}`, disabled: !['available', 'ready'].includes(models.modnet?.status) },
              ]} />
            </Group>
          </div>
        </aside>
      </div>
    </div>
  );
}
