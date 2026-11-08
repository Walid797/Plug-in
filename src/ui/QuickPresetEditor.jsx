// Manual settings for one-click print presets: every value the preset applies,
// with a live, to-scale preview of the sheet computed by the real layout engine.
import { useMemo, useState } from 'preact/hooks';
import { useStore, closeDialog, confirmDialog, toast } from '../state/store.js';
import { Button, Icon, Group, NumberInput, Select, Segmented, Switch, Notice, Badge, Modal, Slider } from './kit.jsx';
import { formatNumber, toFaDigits } from '../core/digits.js';
import { orientationName, layoutErrorText } from '../i18n/fa.js';
import { PAPER_PRESETS, PHOTO_PRESETS, RULE_PROFILES, BACKGROUND_PRESETS, DPI_PRESETS, BORDER_COLORS } from '../core/presets.js';
import { PRINT_BOOST_IDS } from '../core/adjust.js';
import { findQuickPreset, normalizeQuickPreset, presetCapacity, quickPaper, quickWarnings, copiesPerPerson, QUICK_DEFAULTS, QUICK_PRESETS } from '../core/quickpresets.js';
import { saveQuickPreset, saveQuickPresetAsNew, resetQuickPreset, deleteQuickPreset } from '../state/quick.js';
import { PRINT_BOOST_FA } from '../print/sheet.js';

const sameSize = (a, w, h) => Math.abs(a.widthMm - w) < 0.01 && Math.abs(a.heightMm - h) < 0.01;

export function bgColorName(color) {
  return BACKGROUND_PRESETS.find((b) => b.color === color)?.nameFa || 'رنگ دلخواه';
}

function warningText(w) {
  if (w.code === 'MARGIN_IN_HARD') return `حاشیهٔ برگه (${formatNumber(w.margin)} ملی‌متر) از حاشیهٔ غیرقابل چاپ چاپگر (${formatNumber(w.hard)} ملی‌متر) کمتر است؛ لبهٔ عکس‌ها یا نشانه‌های برش ممکن است چاپ نشود.`;
  if (w.code === 'COPIES_MULTI_SHEET') return `${formatNumber(w.copies)} نسخه از ظرفیت یک برگه (${formatNumber(w.capacity)}) بیشتر است؛ برای هر نفر ${formatNumber(w.sheets)} برگه لازم است.`;
  if (w.code === 'NO_AUTO_CROP') return 'کادر خودکار خاموش است؛ کادر فعلی هر عکس (یا کادر وسط پیش‌فرض) استفاده می‌شود.';
  return '';
}

/** To-scale diagram of the sheet: printable area, slots and fill order. */
export function SheetDiagram({ layout, preset }) {
  if (!layout?.ok) return <div class="qp-diagram empty"><Icon name="triangle-alert" /></div>;
  const W = layout.sheet.widthMm; const H = layout.sheet.heightMm;
  const hm = preset.borderless ? 0 : preset.hardMargin;
  const page = layout.pages[0];
  const fs = Math.max(3, Math.min(page.placements[0]?.photo.w || 10, page.placements[0]?.photo.h || 10) * 0.32);
  return (
    <svg class="qp-diagram" viewBox={`-2 -2 ${W + 4} ${H + 4}`} role="img" aria-label={`پیش‌نمایش برگه ${formatNumber(W)} در ${formatNumber(H)} ملی‌متر با ${formatNumber(page.placements.length)} عکس`}>
      <rect x="0" y="0" width={W} height={H} fill="#fff" stroke="#9aa3b2" stroke-width="0.6" />
      {hm > 0 ? <rect x={hm} y={hm} width={W - 2 * hm} height={H - 2 * hm} fill="none" stroke="#e05252" stroke-width="0.35" stroke-dasharray="1.5 1.2" /> : null}
      {page.placements.map((pl) => (
        <g key={pl.index}>
          <rect x={pl.photo.x} y={pl.photo.y} width={pl.photo.w} height={pl.photo.h} fill={preset.whiteBg ? preset.bgColor : '#e9edf5'} stroke={preset.border ? preset.borderColor : '#3b5bdb'} stroke-width={preset.border ? Math.max(0.3, preset.borderWidth) : 0.4} />
          <circle cx={pl.photo.x + pl.photo.w / 2} cy={pl.photo.y + pl.photo.h * 0.42} r={Math.min(pl.photo.w, pl.photo.h) * 0.2} fill="#c9d3e6" />
          <text x={pl.photo.x + pl.photo.w / 2} y={pl.photo.y + pl.photo.h * 0.88} font-size={fs} text-anchor="middle" fill="#1f3fbf" font-weight="700">{toFaDigits(String(pl.index + 1))}</text>
        </g>
      ))}
    </svg>
  );
}

export function QuickPresetEditorDialog({ presetId, mode = 'edit' }) {
  const settings = useStore((s) => s.settings);
  const papers = settings.paperPresets || [];
  const base = presetId ? findQuickPreset(presetId, settings) : null;
  const isNew = mode === 'new' || !base;
  const [d, setD] = useState(() => (isNew
    ? normalizeQuickPreset({ ...(base || QUICK_DEFAULTS), id: '', builtin: false, nameFa: base ? `${base.nameFa} (کپی)` : 'قالب تازه' })
    : base));
  const set = (patch) => setD((x) => normalizeQuickPreset({ ...x, ...patch, id: x.id, builtin: x.builtin, edited: x.edited }));
  const cap = useMemo(() => presetCapacity(d, papers), [d, papers]);
  const warns = quickWarnings(d, cap);
  const paper = quickPaper(d, papers);
  const profiles = [...RULE_PROFILES, ...(settings.customProfiles || [])].filter((r) => sameSize(r, d.widthMm, d.heightMm));
  const factory = d.builtin ? QUICK_PRESETS.find((b) => b.id === d.id) : null;
  const valid = cap.capacity > 0 && d.nameFa.trim().length > 0;
  const each = copiesPerPerson(d, cap.capacity);

  const setPhoto = (id) => {
    if (id === 'custom') { set({ photoId: 'custom', widthMm: d.widthMm, heightMm: d.heightMm, profileId: null }); return; }
    const ph = PHOTO_PRESETS.find((p) => p.id === id);
    set({ photoId: id, profileId: RULE_PROFILES.find((r) => sameSize(r, ph.widthMm, ph.heightMm))?.id ?? null });
  };
  const setCustomSize = (k, v) => set({ photoId: 'custom', [k]: v, profileId: [...RULE_PROFILES, ...(settings.customProfiles || [])].find((r) => sameSize(r, k === 'widthMm' ? v : d.widthMm, k === 'heightMm' ? v : d.heightMm))?.id ?? null });

  const save = () => { const id = saveQuickPreset(d); toast(`قالب «${d.nameFa}» ذخیره شد.`, 'success'); closeDialog(id); };
  const saveNew = () => { const id = saveQuickPresetAsNew(d, d.builtin || !isNew ? `${d.nameFa} (کپی)` : d.nameFa); toast('قالب تازه ذخیره شد.', 'success'); closeDialog(id); };
  const reset = async () => {
    if (!(await confirmDialog({ title: 'بازگشت به تنظیمات اصلی', body: `تغییرات شما در «${factory.nameFa}» پاک شود؟`, confirmLabel: 'بازگشت به اصلی' }))) return;
    resetQuickPreset(d.id); toast('قالب به تنظیمات اصلی برگشت.', 'success');
  };
  const remove = async () => {
    if (!(await confirmDialog({ title: 'حذف قالب', body: `«${d.nameFa}» حذف شود؟`, confirmLabel: 'حذف', danger: true }))) return;
    deleteQuickPreset(d.id); toast('قالب حذف شد.', 'success');
  };

  return (
    <Modal wide class="qp-modal" bodyClass="qp-body" title={isNew ? 'قالب تازهٔ چاپ سریع' : 'تنظیم قالب چاپ سریع'} onCancel={() => closeDialog(null)} footer={<>
      <Button variant="primary" icon="save" disabled={!valid} onClick={save}>{isNew ? 'ذخیرهٔ قالب' : 'ذخیره'}</Button>
      {!isNew ? <Button icon="copy" disabled={!valid} onClick={saveNew}>ذخیره به‌عنوان قالب تازه</Button> : null}
      <Button variant="ghost" onClick={() => closeDialog(null)}>انصراف</Button>
      <span class="toolbar-spacer" />
      {!isNew && d.builtin && d.edited ? <Button variant="ghost" icon="rotate-ccw" onClick={reset}>بازگشت به تنظیمات اصلی</Button> : null}
      {!isNew && !d.builtin ? <Button variant="danger" icon="trash-2" onClick={remove}>حذف قالب</Button> : null}
    </>}>
        <div class="qp-form">
          <label class="field"><span class="field-label">نام قالب</span>
            <input class="input" data-autofocus value={d.nameFa} maxLength={80} onInput={(e) => { const v = e.currentTarget.value; setD((x) => ({ ...x, nameFa: v })); }} onBlur={() => set({ nameFa: d.nameFa })} />
          </label>
          {d.builtin ? <p class="hint">{d.edited ? <Badge kind="gold" icon="pencil">تنظیم‌شده</Badge> : <Badge>قالب آماده</Badge>} تغییرات روی همین قالب ذخیره می‌شود و هر وقت بخواهید به تنظیمات اصلی برمی‌گردد.</p> : null}

          <Group title="اندازهٔ عکس">
            <Select label="اندازه" value={d.photoId} onChange={setPhoto} options={[...PHOTO_PRESETS.map((p) => ({ value: p.id, label: p.nameFa })), { value: 'custom', label: 'سفارشی…' }]} />
            {d.photoId === 'custom' ? (
              <div class="grid-2">
                <NumberInput label="عرض عکس" unit="ملی‌متر" value={d.widthMm} min={5} max={300} step={0.5} onChange={(v) => setCustomSize('widthMm', v)} />
                <NumberInput label="ارتفاع عکس" unit="ملی‌متر" value={d.heightMm} min={5} max={300} step={0.5} onChange={(v) => setCustomSize('heightMm', v)} />
              </div>
            ) : null}
            <Select label="قاعدهٔ کادر (اندازهٔ سر و خط چشم)" value={d.profileId || 'generic'} onChange={(v) => set({ profileId: v === 'generic' ? null : v })} options={[
              { value: 'generic', label: 'نسبت عمومی' },
              ...profiles.map((r) => ({ value: r.id, label: `${r.nameFa} (تأییدنشده)` })),
            ]} />
          </Group>

          <Group title="مراحل خودکار">
            <Switch label="تغییر پس‌زمینه با هوش مصنوعی محلی" checked={d.whiteBg} onChange={(v) => set({ whiteBg: v })} />
            {d.whiteBg ? (
              <div class="swatches" role="group" aria-label="رنگ پس‌زمینه">
                {BACKGROUND_PRESETS.map((b) => (
                  <button type="button" key={b.id} class="swatch" style={{ background: b.color }} aria-pressed={String(d.bgColor === b.color)} aria-label={b.nameFa} data-tip={b.nameFa} onClick={() => set({ bgColor: b.color })} />
                ))}
                <label class="swatch custom" data-tip="رنگ دلخواه">
                  <input type="color" value={d.bgColor} aria-label="رنگ دلخواه" onChange={(ev) => set({ bgColor: ev.currentTarget.value })} />
                </label>
                <span class="small muted">{bgColorName(d.bgColor)}</span>
              </div>
            ) : null}
            <Switch label="کادر و اندازهٔ سر از روی چهره" checked={d.autoCrop} onChange={(v) => set({ autoCrop: v })} />
            <Switch label="اصلاح نور چهرهٔ خیلی تاریک یا خیلی روشن" checked={d.autoLight} onChange={(v) => set({ autoLight: v })} hint="فقط چهره‌ای که بررسی کیفیت آن را تاریک/پرنور می‌داند؛ رنگ طبیعی پوست عوض نمی‌شود." />
          </Group>

          {d.whiteBg ? (
            <Group title="اصلاح لبه‌ها و سایه">
              <Switch label="چسباندن لبه به جزئیات عکس (فیلتر هدایت‌شده)" checked={d.edgeAware} onChange={(v) => set({ edgeAware: v })} />
              <Slider label="جمع/گسترش لبه" min={-100} max={100} value={d.edgeShift} defaultValue={0} format={(v) => formatNumber(v)} onInput={(v) => set({ edgeShift: v })} />
              <Slider label="نرمی لبه" min={0} max={100} value={d.edgeSoftness} defaultValue={40} format={(v) => formatNumber(v)} onInput={(v) => set({ edgeSoftness: v })} />
              <Slider label="محو لبه (پیکسل)" min={0} max={12} value={d.edgeFeather} defaultValue={1} format={(v) => formatNumber(v)} onInput={(v) => set({ edgeFeather: v })} />
              <Switch label="پاک‌سازی رنگ قدیمی در لبهٔ مو" checked={d.decontaminate} onChange={(v) => set({ decontaminate: v })} />
              <Switch label="سایهٔ نرم پشت شخص" checked={d.shadow} onChange={(v) => set({ shadow: v })} />
              {d.shadow ? (
                <>
                  <Slider label="شدت سایه" min={0} max={80} value={d.shadowOpacity} defaultValue={25} format={(v) => `${formatNumber(v)}٪`} onInput={(v) => set({ shadowOpacity: v })} />
                  <Slider label="پخش سایه (ملی‌متر)" min={0} max={6} step={0.1} value={d.shadowBlur} defaultValue={1.5} format={(v) => formatNumber(v, { maxFraction: 1 })} onInput={(v) => set({ shadowBlur: v })} />
                  <Slider label="فاصلهٔ افقی سایه (ملی‌متر)" min={-4} max={4} step={0.1} value={d.shadowX} defaultValue={0} format={(v) => formatNumber(v, { maxFraction: 1 })} onInput={(v) => set({ shadowX: v })} />
                  <Slider label="فاصلهٔ عمودی سایه (ملی‌متر)" min={-4} max={4} step={0.1} value={d.shadowY} defaultValue={0.8} format={(v) => formatNumber(v, { maxFraction: 1 })} onInput={(v) => set({ shadowY: v })} />
                </>
              ) : null}
              <p class="hint">محو لبه روی ماسک شخص اعمال می‌شود و لبهٔ شخص را بدون حالت «بریده‌شده» با پس‌زمینه ترکیب می‌کند. مقدار ۱ برای همهٔ قالب‌ها پیش‌فرض است؛ عدد بیشتر لبه را تارتر می‌کند. این مقدار روی ماسک پیش‌نمایشِ عکس اعمال می‌شود، نه روی خود پیکسل‌های خروجی.</p>
            </Group>
          ) : null}

          <Group title="کاغذ و چیدمان">
            <Select label="کاغذ" value={d.paperId} onChange={(v) => set({ paperId: v })} options={[
              { group: 'اندازه‌های آماده', options: [...PAPER_PRESETS, ...papers].map((p) => ({ value: p.id, label: `${p.nameFa} (${formatNumber(p.widthMm)}×${formatNumber(p.heightMm)})` })) },
              { group: 'دیگر', options: [{ value: 'custom', label: 'سفارشی…' }] },
            ]} />
            {d.paperId === 'custom' ? (
              <div class="grid-2">
                <NumberInput label="عرض کاغذ" unit="ملی‌متر" value={d.paperWidthMm} min={10} max={2000} step={0.5} onChange={(v) => set({ paperWidthMm: v })} />
                <NumberInput label="ارتفاع کاغذ" unit="ملی‌متر" value={d.paperHeightMm} min={10} max={2000} step={0.5} onChange={(v) => set({ paperHeightMm: v })} />
              </div>
            ) : null}
            <Segmented label="جهت کاغذ" value={d.orientation} onChange={(v) => set({ orientation: v })} options={[
              { value: 'auto', label: 'خودکار (بهترین)' }, { value: 'portrait', label: 'عمودی' }, { value: 'landscape', label: 'افقی' },
            ]} />
            <div class="grid-2">
              <NumberInput label="حاشیهٔ بیرونی" unit="ملی‌متر" value={d.margin} min={0} max={100} step={0.5} onChange={(v) => set({ margin: v })} />
              <NumberInput label="فاصلهٔ بین عکس‌ها" unit="ملی‌متر" value={d.gap} min={0} max={50} step={0.5} onChange={(v) => set({ gap: v })} />
            </div>
            <Select label="ترتیب پر شدن" value={d.fillOrder} onChange={(v) => set({ fillOrder: v })} options={[
              { value: 'col-ltr', label: 'ستون‌به‌ستون از چپ' }, { value: 'col-rtl', label: 'ستون‌به‌ستون از راست' },
              { value: 'rtl', label: 'ردیف‌به‌ردیف از راست' }, { value: 'ltr', label: 'ردیف‌به‌ردیف از چپ' },
            ]} />
          </Group>

          <Group title="تعداد برای هر نفر">
            <Segmented value={d.perPerson} onChange={(v) => set({ perPerson: v })} options={[
              { value: 'sheet', label: `یک برگهٔ کامل${cap.capacity ? ` (${formatNumber(cap.capacity)})` : ''}` }, { value: 'copies', label: 'تعداد ثابت' }, { value: 'share', label: 'تقسیم مساوی برگه' },
            ]} />
            {d.perPerson === 'copies' ? (
              <>
                <NumberInput label="تعداد عکس برای هر نفر" value={d.copies} min={1} max={500} integer onChange={(v) => set({ copies: v })} />
                <div class="chips mini" role="group" aria-label="تعداد عکس">
                  {[...new Set([1, 2, 3, 4, 6, 8, 9, 10, 12, ...(cap.capacity ? [cap.capacity] : [])])].sort((a, b) => a - b).map((c) => (
                    <button type="button" key={c} class="chip" aria-pressed={String(d.copies === c)} onClick={() => set({ copies: c })}>{formatNumber(c)}{c === cap.capacity ? ' (پر)' : ''}</button>
                  ))}
                </div>
              </>
            ) : null}
            <p class="hint">{d.perPerson === 'sheet' ? 'هر نفر یک برگهٔ کامل می‌گیرد (به اندازهٔ ظرفیت برگه).' : d.perPerson === 'copies' ? 'هر نفر دقیقاً همین تعداد؛ جای عکس‌ها ستون‌به‌ستون و بقیهٔ کاغذ یک‌جا خالی می‌ماند.' : 'عکس‌های چند نفر به‌طور مساوی روی برگه پخش می‌شوند.'}</p>
          </Group>

          <Group title="چاپگر و کیفیت">
            <Select label="روشن‌سازی برای چاپ" value={d.printBoost} onChange={(v) => set({ printBoost: v })} options={PRINT_BOOST_IDS.map((id) => ({ value: id, label: `${PRINT_BOOST_FA[id]}${id === 'medium' ? ' (پیشنهادی برای اپسون ۴ رنگ)' : ''}` }))} />
            <Select label="کیفیت (DPI)" value={String(d.dpi)} onChange={(v) => set({ dpi: Number(v) })} options={DPI_PRESETS.map((x) => ({ value: String(x), label: `${formatNumber(x)} DPI${x === 300 ? ' (پیشنهادی)' : ''}` }))} />
            <Switch label="نشانه‌های برش در حاشیه" checked={d.cropMarks} onChange={(v) => set({ cropMarks: v })} />
            <Switch label="خطوط برش کامل (در فاصله‌ها)" checked={d.cutLines} onChange={(v) => set({ cutLines: v })} />
            {d.cropMarks || d.cutLines ? <NumberInput label="فاصلهٔ خط برش از لبهٔ عکس (به سمت سفیدی)" unit="ملی‌متر" value={d.cutOffset} min={0} max={3} step={0.1} maxFraction={2} hint="قیچی در سفیدی بین عکس‌ها می‌افتد نه روی بوردر؛ حداکثر نصف فاصلهٔ عکس‌ها." onChange={(v) => set({ cutOffset: v })} /> : null}
            <Switch label="بوردر (کادر دور هر عکس)" checked={d.border} onChange={(v) => set({ border: v })} hint="داخل لبهٔ هر عکس کشیده می‌شود؛ اندازهٔ عکس تغییر نمی‌کند." />
            {d.border ? (
              <>
                <NumberInput label="ضخامت بوردر" unit="ملی‌متر" value={d.borderWidth} min={0.05} max={2} step={0.05} maxFraction={2} onChange={(v) => set({ borderWidth: v })} />
                <div class="swatches" role="group" aria-label="رنگ بوردر">
                  {BORDER_COLORS.map((b) => (
                    <button type="button" key={b.id} class="swatch" style={{ background: b.color }} aria-pressed={String(d.borderColor === b.color)} aria-label={b.nameFa} data-tip={b.nameFa} onClick={() => set({ borderColor: b.color })} />
                  ))}
                  <label class="swatch custom" data-tip="رنگ دلخواه">
                    <input type="color" value={d.borderColor} aria-label="رنگ دلخواه بوردر" onChange={(ev) => set({ borderColor: ev.currentTarget.value })} />
                  </label>
                </div>
              </>
            ) : null}
            <Switch label="چاپگر بدون حاشیه (Borderless)" checked={d.borderless} onChange={(v) => set({ borderless: v })} />
            {!d.borderless ? <NumberInput label="حاشیهٔ غیرقابل چاپ چاپگر" unit="ملی‌متر" value={d.hardMargin} min={0} max={20} step={0.5} hint="اپسون سری L در حالت عادی معمولاً ۳ ملی‌متر." onChange={(v) => set({ hardMargin: v })} /> : null}
          </Group>
        </div>

        <aside class="qp-preview" aria-live="polite">
          <SheetDiagram layout={cap.layout} preset={d} />
          {cap.capacity ? (
            <div class="qp-summary">
              <div class="qp-cap"><span class="num">{formatNumber(cap.capacity)}</span> عکس در هر برگه</div>
              {d.perPerson !== 'share' ? <p class="small">{d.perPerson === 'copies' && d.copies < cap.capacity ? `${formatNumber(d.copies)} عکس از ${formatNumber(cap.capacity)} جای برگه پر می‌شود؛ بقیهٔ کاغذ یک‌جا سالم می‌ماند.` : null}</p> : null}
              <p class="small">{paper.id === 'custom' ? `کاغذ ${formatNumber(paper.widthMm)}×${formatNumber(paper.heightMm)} ملی‌متر` : paper.nameFa} · {orientationName(cap.orientation)}</p>
              <p class="small">{d.perPerson === 'share' ? 'تقسیم مساوی بین نفرها' : `${formatNumber(each)} عکس برای هر نفر`} · روشن‌سازی {PRINT_BOOST_FA[d.printBoost]} · {d.whiteBg ? `پس‌زمینهٔ ${bgColorName(d.bgColor)}` : 'پس‌زمینه دست نمی‌خورد'}</p>
              <p class="tiny muted">خط‌چین قرمز: مرز ناحیهٔ قابل چاپ چاپگر. شماره‌ها ترتیب پر شدن است.</p>
            </div>
          ) : null}
          {cap.errors.map((er, i) => <Notice key={i} kind="err">{layoutErrorText(er)}</Notice>)}
          {warns.map((w, i) => <Notice key={i} kind="warn">{warningText(w)}</Notice>)}
        </aside>
    </Modal>
  );
}
