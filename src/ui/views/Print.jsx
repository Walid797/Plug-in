import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useStore, updateSheet, openDialog, updateSettings, uid, setSection, toast } from '../../state/store.js';
import { thumbUrl, getPreview, gatherAssets, originalAvailable } from '../../state/media.js';
import { computeLayout } from '../../core/layout.js';
import { COPY_PRESETS, DPI_PRESETS } from '../../core/presets.js';
import { layoutInput, resolvePaper, allPaperPresets, createSheetElement, labelTextFor, runPrint, runPdfExport, runSheetImageExport, activeCalibration } from '../../print/sheet.js';
import { renderPhoto } from '../../render/renderPhoto.js';
import { canvasToBlob } from '../../platform/image.js';
import { formatNumber } from '../../core/digits.js';
import { layoutErrorText, layoutWarningText, orientationName } from '../../i18n/fa.js';
import { CSS_PX_PER_MM } from '../../core/units.js';
import { Icon, IconButton, Button, Group, NumberInput, Select, Segmented, Switch, Notice, Badge, Empty } from '../kit.jsx';

/* ------------------------------------------------ preview photo renders */
const previewCache = new Map(); // key -> url
const inflight = new Map(); // key -> Promise<url>
const latestKey = new Map(); // photoId -> newest requested key

/** Drop cached previews (used when an image failed to load) so they are rebuilt. */
function forgetPreviews(photoIds) {
  for (const [k, u] of previewCache) {
    if (photoIds.some((id) => k.startsWith(`["${id}"`))) { previewCache.delete(k); retireLater(u); }
  }
}

function editKey(photo, rev) {
  return JSON.stringify([photo.id, photo.origKey, photo.edit, rev]);
}

/** Revoke later, never while an <img> may still be loading the URL. */
function retireLater(url) {
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * Preview image URL for a photo's current edit. Race-safe: a render that was
 * superseded while it ran (the photo changed meanwhile) never retires the newer
 * URL, identical requests share one render, and old URLs are revoked only after
 * a delay so slow devices never lose images that are still loading.
 */
export function previewUrl(photo, rev) {
  const key = editKey(photo, rev);
  latestKey.set(photo.id, key);
  if (previewCache.has(key)) return Promise.resolve(previewCache.get(key));
  if (inflight.has(key)) return inflight.get(key);
  const job = (async () => {
    const pv = await getPreview(photo);
    if (!pv) return null;
    const assets = await gatherAssets(photo, pv);
    const outW = 360;
    const outH = Math.round((outW * photo.edit.heightMm) / photo.edit.widthMm);
    const c = renderPhoto(photo.edit, assets, outW, outH, { pxPerMm: outW / photo.edit.widthMm, frameWidthPx: outW });
    const blob = await canvasToBlob(c, 'image/jpeg', 0.9);
    const url = URL.createObjectURL(blob);
    if (latestKey.get(photo.id) !== key) { retireLater(url); return url; } // superseded: leave newer entries alone
    for (const [k, u] of previewCache) {
      if (k.startsWith(`["${photo.id}"`) && k !== key) { previewCache.delete(k); retireLater(u); }
    }
    previewCache.set(key, url);
    return url;
  })();
  inflight.set(key, job);
  job.finally(() => inflight.delete(key)).catch(() => {});
  return job;
}

/* ------------------------------------------------------------- pieces */

function SheetPreview({ layout, project, photos, zoom }) {
  const hostRef = useRef(null);
  const rev = useStore((s) => s.rev);
  const [urls, setUrls] = useState({});
  const [retry, setRetry] = useState(0);
  const [box, setBox] = useState({ w: 600, h: 600 });

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth; const h = el.clientHeight;
      setBox((b) => (Math.abs(b.w - w) > 2 || Math.abs(b.h - h) > 2 ? { w, h } : b));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      const out = {};
      if (retry > 0) forgetPreviews(project.sheet.items.map((it) => it.photoId));
      for (const it of project.sheet.items) {
        const p = photos[it.photoId];
        if (!p) continue;
        try { out[it.id] = await previewUrl(p, rev[p.id] || 0); } catch { out[it.id] = null; }
      }
      if (alive) setUrls(out);
    })();
    return () => { alive = false; };
  }, [project.sheet.items, photos, rev, retry]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.replaceChildren();
    if (!layout?.ok) return;
    const W = layout.sheet.widthMm; const H = layout.sheet.heightMm;
    const pxW = W * CSS_PX_PER_MM;
    const availW = Math.max(120, box.w - 48);
    const availH = Math.max(160, box.h - 70);
    const pxH = H * CSS_PX_PER_MM;
    const scale = zoom === 'actual' ? 1 : Math.min(2, availW / pxW, availH / pxH);
    for (const page of layout.pages) {
      const fig = document.createElement('figure');
      fig.className = 'sheet-figure';
      const frame = document.createElement('div');
      frame.className = 'sheet-frame';
      frame.style.width = `${pxW * scale}px`;
      frame.style.height = `${H * CSS_PX_PER_MM * scale}px`;
      const el = createSheetElement(layout, page, {
        urlFor: (id) => urls[id] || null,
        labelFor: (pl) => labelTextFor(pl, project, photos),
        marks: project.sheet.marks,
        // a failed image load rebuilds the preview (bounded) instead of leaving a blank slot
        onImageError: () => setRetry((r) => (r < 3 ? r + 1 : r)),
      });
      el.style.transform = `scale(${scale})`;
      el.style.transformOrigin = '0 0';
      el.classList.add('is-preview');
      // printer non-printable area overlay (preview only)
      if (!project.sheet.printer.borderless) {
        const hm = project.sheet.printer.hardMargins;
        const z = document.createElement('div');
        z.className = 'hard-margin';
        z.style.borderWidth = `${hm.top}mm ${hm.right}mm ${hm.bottom}mm ${hm.left}mm`;
        el.appendChild(z);
      }
      frame.appendChild(el);
      const cap = document.createElement('figcaption');
      cap.textContent = `برگهٔ ${formatNumber(page.index + 1)} از ${formatNumber(layout.pages.length)} — ${formatNumber(page.placements.length)} عکس`;
      fig.appendChild(frame);
      fig.appendChild(cap);
      host.appendChild(fig);
    }
  }, [layout, urls, box, zoom, project.sheet.marks, project.sheet.printer]);

  return <div class="sheets" ref={hostRef} aria-label="پیش‌نمایش برگه‌ها" />;
}

function Analysis({ layout, sheet }) {
  if (!layout?.analysis) return null;
  const a = layout.analysis;
  const row = (o) => {
    const x = a[o];
    const chosen = layout.ok && layout.orientation === o;
    return (
      <div class={`orient ${chosen ? 'chosen' : ''}`} key={o}>
        <div class="orient-head"><b>{orientationName(o)}</b> <span class="faint tiny">{formatNumber(x.sheetW)}×{formatNumber(x.sheetH)} ملی‌متر</span>{chosen ? <Badge kind="accent">انتخاب‌شده</Badge> : null}</div>
        <div class="orient-cap"><span class="num">{formatNumber(x.bestCapacity)}</span> عکس در هر برگه</div>
        <p class="tiny muted">
          ناحیهٔ قابل استفاده {formatNumber(x.availW, { maxFraction: 1 })}×{formatNumber(x.availH, { maxFraction: 1 })} ملی‌متر →
          {' '}{formatNumber(x.cols)} ستون × {formatNumber(x.rows)} ردیف = {formatNumber(x.capacity)}.
          {' '}ستون بعدی {formatNumber(x.needWForNextCol, { maxFraction: 1 })} ملی‌متر عرض و ردیف بعدی {formatNumber(x.needHForNextRow, { maxFraction: 1 })} ملی‌متر ارتفاع لازم دارد.
          {sheet.allowRotation && x.bestCapacity > x.capacity ? ` با چرخاندن بعضی عکس‌ها: ${formatNumber(x.bestCapacity)}.` : ''}
        </p>
      </div>
    );
  };
  return <div class="analysis">{row('portrait')}{row('landscape')}</div>;
}

function Items({ project, photos }) {
  const items = project.sheet.items;
  const onSheet = new Set(items.map((i) => i.photoId));
  const available = project.photoIds.filter((id) => photos[id] && !onSheet.has(id));
  const set = (fn) => updateSheet((sh) => ({ ...sh, items: fn(sh.items) }));
  const mode = project.sheet.mode;
  return (
    <Group title="عکس‌های روی برگه" actions={available.length ? <Button size="sm" variant="ghost" icon="plus" onClick={() => set((list) => [...list, ...available.map((pid) => ({ id: uid('it'), photoId: pid, copies: 1 }))])}>افزودن همه</Button> : null}>
      {!items.length ? <p class="hint">هنوز عکسی روی برگه نیست.</p> : null}
      <ul class="sheet-items">
        {items.map((it, i) => {
          const p = photos[it.photoId];
          if (!p) return null;
          return (
            <li key={it.id} class="sheet-item">
              <span class="si-thumb">{thumbUrl(p.id) ? <img src={thumbUrl(p.id)} alt="" /> : <Icon name="image" />}</span>
              <div class="si-main">
                <div class="si-name" title={p.name}>{p.name}</div>
                <div class="faint tiny">{formatNumber(p.edit.widthMm / 10, { maxFraction: 2 })}×{formatNumber(p.edit.heightMm / 10, { maxFraction: 2 })} سانتی‌متر</div>
                {mode === 'exact' ? (
                  <div class="si-copies">
                    <NumberInput ariaLabel={`تعداد نسخهٔ ${p.name}`} value={it.copies} min={0} max={5000} integer onChange={(v) => set((list) => list.map((x) => (x.id === it.id ? { ...x, copies: v } : x)))} />
                    <div class="chips mini">
                      {COPY_PRESETS.map((c) => <button type="button" key={c} class="chip" aria-pressed={String(it.copies === c)} onClick={() => set((list) => list.map((x) => (x.id === it.id ? { ...x, copies: c } : x)))}>{formatNumber(c)}</button>)}
                    </div>
                  </div>
                ) : null}
              </div>
              <div class="si-actions">
                <IconButton small icon="arrow-up" label="بالا" disabled={i === 0} onClick={() => set((list) => { const l = [...list]; [l[i - 1], l[i]] = [l[i], l[i - 1]]; return l; })} />
                <IconButton small icon="arrow-down" label="پایین" disabled={i === items.length - 1} onClick={() => set((list) => { const l = [...list]; [l[i + 1], l[i]] = [l[i], l[i + 1]]; return l; })} />
                <IconButton small icon="x" label="برداشتن از برگه (عکس در پروژه می‌ماند)" onClick={() => set((list) => list.filter((x) => x.id !== it.id))} />
              </div>
            </li>
          );
        })}
      </ul>
      {available.length ? (
        <Select label="افزودن عکس به برگه" value="" onChange={(pid) => pid && set((list) => [...list, { id: uid('it'), photoId: pid, copies: 1 }])} options={[{ value: '', label: 'انتخاب عکس…' }, ...available.map((id) => ({ value: id, label: photos[id].name }))]} />
      ) : null}
    </Group>
  );
}

function Margins({ sheet }) {
  const m = sheet.margins;
  const setM = (side, v) => updateSheet((sh) => ({ ...sh, margins: sh.marginsLinked ? { top: v, right: v, bottom: v, left: v } : { ...sh.margins, [side]: v } }));
  return (
    <Group title="حاشیه و فاصله">
      <Switch label="حاشیهٔ یکسان برای همهٔ لبه‌ها" checked={sheet.marginsLinked} onChange={(v) => updateSheet({ marginsLinked: v, ...(v ? { margins: { top: m.top, right: m.top, bottom: m.top, left: m.top } } : {}) })} />
      {sheet.marginsLinked ? (
        <NumberInput label="حاشیهٔ بیرونی" unit="ملی‌متر" value={m.top} min={0} max={100} step={0.5} onChange={(v) => setM('top', v)} />
      ) : (
        <div class="grid-2">
          <NumberInput label="بالا" unit="ملی‌متر" value={m.top} min={0} max={100} step={0.5} onChange={(v) => setM('top', v)} />
          <NumberInput label="پایین" unit="ملی‌متر" value={m.bottom} min={0} max={100} step={0.5} onChange={(v) => setM('bottom', v)} />
          <NumberInput label="راست" unit="ملی‌متر" value={m.right} min={0} max={100} step={0.5} onChange={(v) => setM('right', v)} />
          <NumberInput label="چپ" unit="ملی‌متر" value={m.left} min={0} max={100} step={0.5} onChange={(v) => setM('left', v)} />
        </div>
      )}
      <div class="grid-2">
        <NumberInput label="فاصلهٔ افقی بین عکس‌ها" unit="ملی‌متر" value={sheet.gap.x} min={0} max={50} step={0.5} onChange={(v) => updateSheet((sh) => ({ ...sh, gap: sh.gapLinked ? { x: v, y: v } : { ...sh.gap, x: v } }))} />
        <NumberInput label="فاصلهٔ عمودی" unit="ملی‌متر" value={sheet.gap.y} min={0} max={50} step={0.5} disabled={sheet.gapLinked} onChange={(v) => updateSheet((sh) => ({ ...sh, gap: { ...sh.gap, y: v } }))} />
      </div>
      <Switch label="فاصلهٔ افقی و عمودی یکسان" checked={sheet.gapLinked} onChange={(v) => updateSheet((sh) => ({ ...sh, gapLinked: v, gap: v ? { x: sh.gap.x, y: sh.gap.x } : sh.gap }))} />
    </Group>
  );
}

export function PrintView() {
  const project = useStore((s) => s.project);
  const photos = useStore((s) => s.photos);
  const settings = useStore((s) => s.settings);
  const [zoom, setZoom] = useState('fit');
  const autoAdded = useRef(false);

  useEffect(() => {
    if (!project || autoAdded.current) return;
    autoAdded.current = true;
    if (!project.sheet.items.length && project.photoIds.length) {
      updateSheet((sh) => ({ ...sh, items: project.photoIds.filter((id) => photos[id]).map((pid) => ({ id: uid('it'), photoId: pid, copies: 1 })), mode: project.photoIds.length === 1 ? 'fill' : sh.mode }), { history: false });
    }
  }, [project?.id]);

  const layout = useMemo(() => (project ? computeLayout(layoutInput(project, photos, settings)) : null), [project?.sheet, photos, settings.paperPresets]);
  if (!project) return null;
  const sheet = project.sheet;
  const paper = resolvePaper(sheet, settings);
  const papers = allPaperPresets(settings);
  const missingOriginals = sheet.items.some((it) => photos[it.photoId] && !originalAvailable(photos[it.photoId]));
  const cal = activeCalibration(settings);

  const doPrint = async (mode) => {
    if (!layout?.ok) return;
    const ok = await openDialog('preprint', { layout, paper, mode });
    if (!ok) return;
    if (mode === 'pdf') runPdfExport(); else runPrint();
  };

  const savePreset = async () => {
    const name = await openDialog('prompt', { title: 'ذخیرهٔ تنظیمات چیدمان', label: 'نام قالب', value: `${paper.nameFa} — ${formatNumber(layout?.capacity || 0)} عکس` });
    if (!name) return;
    const { items, ...rest } = sheet;
    updateSettings((s) => ({ layoutPresets: [...s.layoutPresets, { id: uid('lp'), name, sheet: structuredClone(rest), at: Date.now() }] }));
    toast('قالب چیدمان ذخیره شد.', 'success');
  };

  return (
    <div class="view">
      <div class="workspace no-queue print-ws">
        <section class="stage print-stage" aria-label="پیش‌نمایش چاپ">
          <div class="stage-toolbar" role="toolbar">
            <Button variant="primary" icon="printer" disabled={!layout?.ok} onClick={() => doPrint('print')}>چاپ</Button>
            <Button icon="file-down" disabled={!layout?.ok} onClick={() => doPrint('pdf')}>PDF با اندازهٔ دقیق</Button>
            <Button icon="file-image" disabled={!layout?.ok} onClick={() => runSheetImageExport('jpeg')}>تصویر برگه (JPEG)</Button>
            <Button variant="ghost" icon="image" disabled={!layout?.ok} onClick={() => runSheetImageExport('png')}>PNG</Button>
            <span class="toolbar-spacer" />
            <Segmented value={zoom} onChange={setZoom} options={[{ value: 'fit', label: 'جا در صفحه' }, { value: 'actual', label: 'اندازهٔ تقریبی واقعی' }]} />
          </div>
          <div class="print-summary" role="status" aria-live="polite">
            {layout?.ok ? (
              <>
                <span><b>{formatNumber(layout.totals.placed)}</b> عکس</span>
                <span><b>{formatNumber(layout.totals.sheets)}</b> برگه</span>
                {layout.capacity ? <span>ظرفیت هر برگه: <b>{formatNumber(layout.capacity)}</b></span> : null}
                <span>{paper.nameFa} · {orientationName(layout.orientation)} · {formatNumber(layout.sheet.widthMm)}×{formatNumber(layout.sheet.heightMm)} ملی‌متر</span>
                {cal && sheet.applyCalibrationPrint ? <Badge kind="gold" icon="ruler">کالیبراسیون: {cal.name}</Badge> : null}
              </>
            ) : <span>چیدمان آماده نیست</span>}
          </div>
          {layout && !layout.ok ? (
            <div class="print-errors">{layout.errors.map((er, i) => <Notice key={i} kind="err">{layoutErrorText(er)}</Notice>)}</div>
          ) : null}
          {!project.photoIds.length ? <Empty icon="images" title="عکسی در پروژه نیست" action={<Button variant="primary" icon="upload" onClick={() => setSection('home')}>وارد کردن عکس</Button>}>برای چیدمان چاپ، ابتدا عکس وارد کنید.</Empty> : null}
          <SheetPreview layout={layout} project={project} photos={photos} zoom={zoom} />
        </section>
        <aside class="panel" aria-label="تنظیمات چاپ">
          <div class="panel-inner">
            {layout?.warnings?.filter((w) => layoutWarningText(w)).map((w, i) => <Notice key={i} kind={w.code === 'UNUSED_SLOTS' || w.code === 'ROTATED_FOR_FIT' ? 'info' : 'warn'}>{layoutWarningText(w)}</Notice>)}
            {missingOriginals ? <Notice kind="err">عکس اصلی بعضی موارد موجود نیست؛ آن‌ها را جایگزین کنید.</Notice> : null}
            <Group title="کاغذ">
              <Select label="اندازهٔ کاغذ" value={sheet.paperId} onChange={(v) => updateSheet({ paperId: v })} options={[
                { group: 'اندازه‌های آماده', options: papers.map((p) => ({ value: p.id, label: `${p.nameFa} (${formatNumber(p.widthMm)}×${formatNumber(p.heightMm)})` })) },
                { group: 'دیگر', options: [{ value: 'custom', label: 'سفارشی…' }] },
              ]} />
              {paper.noteFa ? <p class="hint">{paper.noteFa}</p> : null}
              {sheet.paperId === 'custom' ? (
                <div class="grid-2">
                  <NumberInput label="عرض کاغذ" unit="ملی‌متر" value={sheet.customPaper.widthMm} min={10} max={2000} step={1} onChange={(v) => updateSheet((sh) => ({ ...sh, customPaper: { ...sh.customPaper, widthMm: v } }))} />
                  <NumberInput label="ارتفاع کاغذ" unit="ملی‌متر" value={sheet.customPaper.heightMm} min={10} max={2000} step={1} onChange={(v) => updateSheet((sh) => ({ ...sh, customPaper: { ...sh.customPaper, heightMm: v } }))} />
                </div>
              ) : null}
              {sheet.paperId === 'custom' ? <Button size="sm" variant="ghost" icon="save" onClick={async () => {
                const name = await openDialog('prompt', { title: 'ذخیرهٔ اندازهٔ کاغذ', label: 'نام کاغذ', value: `${formatNumber(sheet.customPaper.widthMm)}×${formatNumber(sheet.customPaper.heightMm)}` });
                if (!name) return;
                const id = uid('paper');
                updateSettings((s) => ({ paperPresets: [...s.paperPresets, { id, nameFa: name, ...sheet.customPaper }] }));
                updateSheet({ paperId: id });
              }}>ذخیره به‌عنوان کاغذ آماده</Button> : null}
              <Segmented label="جهت کاغذ" value={sheet.orientation} onChange={(v) => updateSheet({ orientation: v })} options={[
                { value: 'auto', label: 'خودکار (بهترین)' }, { value: 'portrait', label: 'عمودی' }, { value: 'landscape', label: 'افقی' },
              ]} />
            </Group>
            <Items project={project} photos={photos} />
            <Group title="تعداد">
              <Segmented value={sheet.mode} onChange={(v) => updateSheet({ mode: v })} options={[
                { value: 'fill', label: 'پر کردن برگه (بیشترین تعداد)' }, { value: 'exact', label: 'تعداد دقیق انتخابی' },
              ]} />
              <p class="hint">{sheet.mode === 'fill' ? 'برگه با بیشترین تعداد ممکن پر می‌شود؛ اگر چند عکس باشد، به‌طور مساوی تقسیم می‌شود.' : 'دقیقاً همان تعداد چاپ می‌شود؛ اگر از ظرفیت یک برگه بیشتر باشد، برگه‌های بعدی ساخته می‌شوند.'}</p>
              {sheet.mode === 'exact' ? <Switch label="چیدمان فشرده برای تعداد کم" checked={sheet.compact} onChange={(v) => updateSheet({ compact: v })} /> : null}
            </Group>
            <Margins sheet={sheet} />
            <Group title="چیدمان">
              <Switch label="چرخاندن ۹۰ درجهٔ بعضی عکس‌ها برای جا شدن بیشتر" checked={sheet.allowRotation} onChange={(v) => updateSheet({ allowRotation: v })} hint="فقط وقتی به کار می‌رود که واقعاً تعداد بیشتری جا شود. اندازهٔ عکس تغییر نمی‌کند." />
              <div class="grid-2">
                <NumberInput label="ستون‌ها (دستی)" placeholder="خودکار" allowEmpty integer min={1} max={200} value={sheet.grid.cols} onChange={(v) => updateSheet((sh) => ({ ...sh, grid: { ...sh.grid, cols: v } }))} />
                <NumberInput label="ردیف‌ها (دستی)" placeholder="خودکار" allowEmpty integer min={1} max={200} value={sheet.grid.rows} onChange={(v) => updateSheet((sh) => ({ ...sh, grid: { ...sh.grid, rows: v } }))} />
              </div>
              {sheet.grid.cols || sheet.grid.rows ? <Button size="sm" variant="ghost" icon="refresh-cw" onClick={() => updateSheet((sh) => ({ ...sh, grid: { cols: null, rows: null, rotated: false } }))}>بازگشت به خودکار</Button> : null}
              <Select label="تراز" value={sheet.align.mode} onChange={(v) => updateSheet((sh) => ({ ...sh, align: { ...sh.align, mode: v } }))} options={[
                { value: 'center', label: 'وسط برگه' }, { value: 'top-right', label: 'بالا — راست' }, { value: 'top-left', label: 'بالا — چپ' }, { value: 'custom', label: 'سفارشی (فاصله از گوشهٔ بالا-چپ ناحیهٔ چاپ)' },
              ]} />
              {sheet.align.mode === 'custom' ? (
                <div class="grid-2">
                  <NumberInput label="فاصلهٔ افقی" unit="ملی‌متر" value={sheet.align.offsetX} min={0} max={1000} step={0.5} onChange={(v) => updateSheet((sh) => ({ ...sh, align: { ...sh.align, offsetX: v } }))} />
                  <NumberInput label="فاصلهٔ عمودی" unit="ملی‌متر" value={sheet.align.offsetY} min={0} max={1000} step={0.5} onChange={(v) => updateSheet((sh) => ({ ...sh, align: { ...sh.align, offsetY: v } }))} />
                </div>
              ) : null}
              <Segmented label="ترتیب پر شدن" value={sheet.fillOrder} onChange={(v) => updateSheet({ fillOrder: v })} options={[{ value: 'rtl', label: 'از راست به چپ' }, { value: 'ltr', label: 'از چپ به راست' }]} />
            </Group>
            <Analysis layout={layout} sheet={sheet} />
            <Group title="خطوط برش و برچسب">
              <Switch label="نشانه‌های برش در حاشیه" checked={sheet.marks.cropMarks} onChange={(v) => updateSheet((sh) => ({ ...sh, marks: { ...sh.marks, cropMarks: v } }))} />
              <Switch label="خطوط برش کامل (در فاصله‌ها)" checked={sheet.marks.cutLines} onChange={(v) => updateSheet((sh) => ({ ...sh, marks: { ...sh.marks, cutLines: v } }))} />
              <Switch label="کادر نازک دور هر عکس" checked={sheet.marks.borders} onChange={(v) => updateSheet((sh) => ({ ...sh, marks: { ...sh.marks, borders: v } }))} />
              <Switch label="برچسب زیر عکس" checked={sheet.label.enabled} onChange={(v) => updateSheet((sh) => ({ ...sh, label: { ...sh.label, enabled: v } }))} hint="به‌طور پیش‌فرض خاموش؛ ارتفاع برچسب به ظرفیت برگه اضافه می‌شود." />
              {sheet.label.enabled ? (
                <>
                  <Select label="متن برچسب" value={sheet.label.content} onChange={(v) => updateSheet((sh) => ({ ...sh, label: { ...sh.label, content: v } }))} options={[{ value: 'name', label: 'نام عکس' }, { value: 'number', label: 'شماره' }, { value: 'custom', label: 'متن دلخواه' }]} />
                  {sheet.label.content === 'custom' ? <label class="field"><span class="field-label">متن</span><input class="input" maxLength={60} value={sheet.label.custom} onChange={(e) => updateSheet((sh) => ({ ...sh, label: { ...sh.label, custom: e.currentTarget.value } }))} /></label> : null}
                  <NumberInput label="ارتفاع برچسب" unit="ملی‌متر" value={sheet.label.heightMm} min={2} max={20} step={0.5} onChange={(v) => updateSheet((sh) => ({ ...sh, label: { ...sh.label, heightMm: v } }))} />
                </>
              ) : null}
            </Group>
            <Group title="چاپگر و کیفیت">
              <Select label="کیفیت (DPI) برای چاپ و PDF" value={String(sheet.dpi)} onChange={(v) => updateSheet({ dpi: Number(v) })} options={DPI_PRESETS.map((d) => ({ value: String(d), label: `${formatNumber(d)} DPI${d === 300 ? ' (پیشنهادی)' : ''}` }))} />
              <Switch label="چاپگر بدون حاشیه (Borderless)" checked={sheet.printer.borderless} onChange={(v) => updateSheet((sh) => ({ ...sh, printer: { ...sh.printer, borderless: v } }))} />
              {!sheet.printer.borderless ? (
                <NumberInput label="حاشیهٔ غیرقابل چاپ چاپگر" unit="ملی‌متر" value={sheet.printer.hardMargins.top} min={0} max={20} step={0.5} hint="ناحیهٔ هاشورخورده در پیش‌نمایش. مقدار دقیق را از مشخصات چاپگر یا با برگهٔ کالیبراسیون پیدا کنید." onChange={(v) => updateSheet((sh) => ({ ...sh, printer: { ...sh.printer, hardMargins: { top: v, right: v, bottom: v, left: v } } }))} />
              ) : null}
              <Switch label={`اعمال کالیبراسیون در چاپ مرورگر${cal ? ` (${cal.name})` : ''}`} checked={sheet.applyCalibrationPrint} disabled={!cal} onChange={(v) => updateSheet({ applyCalibrationPrint: v })} hint={cal ? `ضریب افقی ${formatNumber(cal.scaleX, { maxFraction: 4 })}، عمودی ${formatNumber(cal.scaleY, { maxFraction: 4 })}` : 'هنوز کالیبراسیونی ثبت نشده است (تنظیمات ← کالیبراسیون).'} />
              <Switch label="اعمال کالیبراسیون در PDF" checked={sheet.applyCalibrationPdf} disabled={!cal} onChange={(v) => updateSheet({ applyCalibrationPdf: v })} />
            </Group>
            <div class="btn-row">
              <Button size="sm" variant="ghost" icon="save" onClick={savePreset}>ذخیرهٔ این چیدمان به‌عنوان قالب</Button>
              <Button size="sm" variant="ghost" icon="ruler" onClick={() => setSection('settings')}>برگهٔ کالیبراسیون</Button>
            </div>
            <Notice kind="warn">پیش‌نمایش و چاپ از یک محاسبهٔ هندسی استفاده می‌کنند، اما مرورگر یا درایور چاپگر ممکن است اندازه را تغییر دهد. در پنجرهٔ چاپ مقیاس را ۱۰۰٪ بگذارید و نتیجه را با خط‌کش بسنجید.</Notice>
          </div>
        </aside>
      </div>
    </div>
  );
}
