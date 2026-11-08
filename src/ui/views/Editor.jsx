import { useRef, useState } from 'preact/hooks';
import { useStore, updateEdit, recordHistory, getState, orderedPhotos, setSection } from '../../state/store.js';
import { PhotoCanvas } from '../PhotoCanvas.jsx';
import { Queue, NeedPhotos } from '../Queue.jsx';
import { Icon, IconButton, Slider, Select, Segmented, Switch, NumberInput, Group, Notice, Button, Badge } from '../kit.jsx';
import { PHOTO_PRESETS, DPI_PRESETS } from '../../core/presets.js';
import { ADJUSTMENT_DEFAULTS } from '../../core/adjust.js';
import { constrainCrop, defaultCrop, isFrameInside } from '../../core/crop.js';
import { formatNumber, formatBytes } from '../../core/digits.js';
import { outputInfo, exportPhoto, exportBatch } from '../../render/export.js';
import { mmToPx } from '../../core/units.js';

/** Crop gesture → exactly one undo step per gesture. */
export function useCropHandlers(photo) {
  const active = useRef(false);
  return {
    onCropStart: () => { if (!active.current) { recordHistory({ type: 'edit', photoId: photo.id }); active.current = true; } },
    onCrop: (crop) => updateEdit(photo.id, { crop }, { history: false }),
    onCropEnd: () => { active.current = false; },
  };
}

export function ViewSwitch({ view, setView, extra = [] }) {
  return (
    <Segmented
      value={view}
      onChange={setView}
      options={[
        { value: 'result', label: 'نتیجه', icon: 'eye' },
        { value: 'before', label: 'قبل', icon: 'eye-off' },
        { value: 'split', label: 'مقایسه', icon: 'columns-2' },
        ...extra,
      ]}
    />
  );
}

const ADJ = [
  { key: 'exposure', label: 'نوردهی', min: -100, max: 100 },
  { key: 'brightness', label: 'روشنایی', min: -100, max: 100 },
  { key: 'contrast', label: 'کنتراست', min: -100, max: 100 },
  { key: 'highlights', label: 'روشنی‌ها', min: -100, max: 100 },
  { key: 'shadows', label: 'سایه‌ها', min: -100, max: 100 },
  { key: 'saturation', label: 'اشباع رنگ', min: -100, max: 100 },
  { key: 'temperature', label: 'دمای رنگ (سرد ↔ گرم)', min: -100, max: 100 },
  { key: 'tint', label: 'ته‌رنگ (سبز ↔ ارغوانی)', min: -100, max: 100 },
  { key: 'whites', label: 'سفیدها (Whites)', min: -100, max: 100 },
  { key: 'blacks', label: 'سیاه‌ها (Blacks)', min: -100, max: 100 },
  { key: 'sharpness', label: 'وضوح (تیزی)', min: 0, max: 100 },
  { key: 'clarity', label: 'وضوح موضعی (Clarity: مو، ابرو، ریش)', min: 0, max: 100 },
  { key: 'denoise', label: 'کاهش نویز رنگی', min: 0, max: 100 },
];

export function SizePicker({ photo }) {
  const e = photo.edit;
  const custom = e.sizeId === 'custom';
  const setSize = (id) => {
    if (id === 'custom') { updateEdit(photo.id, { sizeId: 'custom' }); return; }
    const p = PHOTO_PRESETS.find((x) => x.id === id);
    updateEdit(photo.id, { sizeId: id, widthMm: p.widthMm, heightMm: p.heightMm });
  };
  return (
    <Group title="اندازهٔ عکس">
      <div class="chips" role="group" aria-label="اندازه‌های آماده">
        {PHOTO_PRESETS.map((p) => <button type="button" key={p.id} class="chip" aria-pressed={String(e.sizeId === p.id)} onClick={() => setSize(p.id)}>{p.nameFa}</button>)}
        <button type="button" class="chip" aria-pressed={String(custom)} onClick={() => setSize('custom')}>سفارشی</button>
      </div>
      {custom ? (
        <div class="grid-2">
          <NumberInput label="عرض" unit="ملی‌متر" value={e.widthMm} min={5} max={300} step={0.5} onChange={(v) => updateEdit(photo.id, { widthMm: v })} />
          <NumberInput label="ارتفاع" unit="ملی‌متر" value={e.heightMm} min={5} max={300} step={0.5} onChange={(v) => updateEdit(photo.id, { heightMm: v })} />
        </div>
      ) : null}
      <p class="hint">نسبت کادر همیشه برابر اندازهٔ انتخاب‌شده است؛ عکس فقط بریده و یکنواخت بزرگ/کوچک می‌شود و هرگز کشیده نمی‌شود.</p>
    </Group>
  );
}

function ResolutionInfo({ photo, dpi }) {
  const info = outputInfo(photo, dpi);
  const level = info.effectiveDpi < 150 ? 'err' : info.effectiveDpi < 250 ? 'warn' : 'ok';
  return (
    <dl class="kv">
      <dt>عکس اصلی</dt><dd>{formatNumber(photo.width)}×{formatNumber(photo.height)} پیکسل · {formatBytes(photo.size)}</dd>
      <dt>خروجی در {formatNumber(dpi)} DPI</dt><dd>{formatNumber(info.outW)}×{formatNumber(info.outH)} پیکسل</dd>
      <dt>وضوح مؤثر</dt><dd><Badge kind={level}>{formatNumber(info.effectiveDpi, { maxFraction: 0 })} DPI</Badge>{info.upscaled ? <span class="faint tiny"> — بزرگ‌نمایی لازم است</span> : null}</dd>
    </dl>
  );
}

export function EditorView() {
  const photo = useStore((s) => (s.selectedPhotoId ? s.photos[s.selectedPhotoId] : null));
  const dpiDefault = useStore((s) => s.settings.defaultDpi);
  const hasBg = photo?.edit.bg.enabled;
  const [view, setView] = useState('result');
  const [guides, setGuides] = useState(false);
  const [dpi, setDpi] = useState(dpiDefault);
  const [format, setFormat] = useState('jpeg');
  const handlers = useCropHandlers(photo || { id: null });
  if (!photo) return <div class="view"><NeedPhotos /></div>;
  const e = photo.edit;
  const aspect = e.widthMm / e.heightMm;
  const crop = e.crop || defaultCrop(photo.width, photo.height, aspect);
  const dcw = defaultCrop(photo.width, photo.height, aspect).cw;
  const rot = crop.rotation || 0;
  const base = Math.round(rot / 90);
  const straighten = Math.round((rot - base * 90) * 10) / 10;
  const inside = isFrameInside(crop, photo.width, photo.height, aspect);
  const setAdj = (key, v, history) => updateEdit(photo.id, (ed) => ({ ...ed, adjust: { ...ed.adjust, [key]: v } }), { history });
  const profileGuides = e.profileId || guides ? { headHeight: { target: e.heightMm * 0.7 }, eyeFromBottom: { min: e.heightMm * 0.52, max: e.heightMm * 0.66, target: e.heightMm * 0.57 } } : null;

  return (
    <div class="view">
      <div class="workspace">
        <Queue />
        <section class="stage" aria-label="بوم ویرایش">
          <div class="stage-toolbar" role="toolbar" aria-label="ابزارهای کادر">
            <IconButton icon="rotate-ccw" label="چرخش ۹۰ درجه به چپ" onClick={() => updateEdit(photo.id, { crop: constrainCrop({ ...crop, rotation: rot - 90 }, photo.width, photo.height, aspect) })} />
            <IconButton icon="rotate-cw" label="چرخش ۹۰ درجه به راست" onClick={() => updateEdit(photo.id, { crop: constrainCrop({ ...crop, rotation: rot + 90 }, photo.width, photo.height, aspect) })} />
            <IconButton icon="zoom-in" label="بزرگ‌نمایی" onClick={() => updateEdit(photo.id, { crop: { ...crop, cw: crop.cw / 1.1 } })} />
            <IconButton icon="zoom-out" label="کوچک‌نمایی" onClick={() => updateEdit(photo.id, { crop: { ...crop, cw: crop.cw * 1.1 } })} />
            <IconButton icon="maximize" label="جا دادن کادر داخل عکس" onClick={() => updateEdit(photo.id, { crop: constrainCrop(crop, photo.width, photo.height, aspect) })} />
            <IconButton icon="refresh-cw" label="بازنشانی کادر" onClick={() => updateEdit(photo.id, { crop: null })} />
            <IconButton icon="grid-3x3" label="خطوط راهنمای چهره" pressed={guides} onClick={() => setGuides(!guides)} />
            <span class="toolbar-spacer" />
            <ViewSwitch view={view} setView={setView} />
          </div>
          <PhotoCanvas photo={photo} mode="crop" view={view} guides={profileGuides} {...handlers} />
          {!inside ? <div class="stage-note"><Icon name="triangle-alert" size={16} />بخشی از کادر بیرون از عکس است و با {hasBg ? 'رنگ پس‌زمینه' : 'سفید'} پر می‌شود.</div> : null}
        </section>
        <aside class="panel" aria-label="تنظیمات ویرایش">
          <div class="panel-inner">
            <SizePicker photo={photo} />
            <Group title="صاف کردن و چرخش">
              <Slider label="صاف کردن (درجه)" min={-45} max={45} step={0.1} value={straighten} defaultValue={0}
                format={(v) => `${formatNumber(v, { maxFraction: 1 })}°`}
                onInput={(v) => updateEdit(photo.id, { crop: { ...crop, rotation: base * 90 + v } }, { history: false })}
                onCommit={(v, start) => { updateEdit(photo.id, { crop: { ...crop, rotation: base * 90 + start } }, { history: false }); updateEdit(photo.id, { crop: { ...crop, rotation: base * 90 + v } }); }} />
              <Slider label="بزرگ‌نمایی" min={25} max={800} step={1} value={Math.round((100 * dcw) / crop.cw)} defaultValue={100}
                format={(v) => `${formatNumber(v)}٪`}
                onInput={(v) => updateEdit(photo.id, { crop: { ...crop, cw: (dcw * 100) / v } }, { history: false })}
                onCommit={(v, start) => { updateEdit(photo.id, { crop: { ...crop, cw: (dcw * 100) / start } }, { history: false }); updateEdit(photo.id, { crop: { ...crop, cw: (dcw * 100) / v } }); }} />
              <p class="hint">کادر را با کشیدن جابجا کنید؛ با چرخ ماوس یا دو انگشت بزرگ‌نمایی کنید. کلیدهای جهت برای جابجایی دقیق.</p>
            </Group>
            <Group title="نور و رنگ" actions={<Button size="sm" variant="ghost" icon="rotate-ccw" disabled={JSON.stringify(e.adjust) === JSON.stringify(ADJUSTMENT_DEFAULTS)} onClick={() => updateEdit(photo.id, { adjust: { ...ADJUSTMENT_DEFAULTS } })}>بازنشانی همه</Button>}>
              {ADJ.map((a) => (
                <Slider key={a.key} label={a.label} min={a.min} max={a.max} value={e.adjust[a.key] ?? 0} defaultValue={ADJUSTMENT_DEFAULTS[a.key]}
                  format={(v) => formatNumber(v)}
                  onInput={(v) => setAdj(a.key, v, false)}
                  onCommit={(v, start) => { setAdj(a.key, start, false); setAdj(a.key, v, true); }} />
              ))}
              <Switch label="سیاه و سفید" checked={e.adjust.grayscale} onChange={(v) => setAdj('grayscale', v, true)} />
              <p class="hint">این ابزارها فقط نور و رنگ را تغییر می‌دهند؛ شکل صورت، سن یا چهره هرگز خودکار تغییر داده نمی‌شود.</p>
            </Group>
            <Group title="خروجی همین عکس">
              <ResolutionInfo photo={photo} dpi={dpi} />
              <div class="grid-2">
                <Select label="DPI" value={String(dpi)} onChange={(v) => setDpi(Number(v))} options={DPI_PRESETS.map((d) => ({ value: String(d), label: `${formatNumber(d)} DPI` }))} />
                <Select label="قالب فایل" value={format} onChange={setFormat} options={[
                  { value: 'jpeg', label: 'JPEG (کیفیت بالا)' },
                  { value: 'png', label: 'PNG (بدون افت)' },
                  { value: 'png-t', label: 'PNG شفاف', disabled: !hasBg },
                ]} />
              </div>
              {format === 'png-t' && !hasBg ? <p class="hint">PNG شفاف فقط پس از حذف پس‌زمینه ممکن است.</p> : null}
              <p class="hint">اندازهٔ فیزیکی: {formatNumber(e.widthMm)} × {formatNumber(e.heightMm)} ملی‌متر = {formatNumber(mmToPx(e.widthMm, dpi))}×{formatNumber(mmToPx(e.heightMm, dpi))} پیکسل (پیکسل = سانتی‌متر ÷ ۲٫۵۴ × DPI). مقدار DPI در فایل ثبت می‌شود، اما برنامه‌های دیگر ممکن است آن را نادیده بگیرند.</p>
              <div class="btn-row">
                <Button variant="primary" icon="download" onClick={() => exportPhoto(photo, { format: format === 'jpeg' ? 'jpeg' : 'png', dpi, transparent: format === 'png-t' })}>ذخیرهٔ فایل</Button>
                <Button icon="file-archive" onClick={() => exportBatch(orderedPhotos(getState()).filter((p) => p.hasOriginal || true), { format: format === 'jpeg' ? 'jpeg' : 'png', dpi })}>خروجی همه (ZIP)</Button>
              </div>
              <Button variant="ghost" icon="printer" onClick={() => setSection('print')}>رفتن به استودیوی چاپ</Button>
            </Group>
            {!photo.hasOriginal ? <Notice kind="warn">عکس اصلی این مورد فقط در همین جلسه نگه داشته می‌شود. برای باز کردن دوبارهٔ پروژه، در تنظیمات «ذخیرهٔ عکس‌های اصلی» را روشن کنید.</Notice> : null}
          </div>
        </aside>
      </div>
    </div>
  );
}
