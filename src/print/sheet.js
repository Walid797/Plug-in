// Print studio: layout input, sheet DOM (shared by preview and print), browser
// print, exact-size PDF, raster sheet export and the calibration sheet.
import { getState, startTask, toast, logEvent } from '../state/store.js';
import { computeLayout, computeMarks, nineModeInput } from '../core/layout.js';
import { PAPER_PRESETS } from '../core/presets.js';
import { printBoostLut, applyLut, PRINT_BOOST_IDS } from '../core/adjust.js';
import { mmToPx, mmToPt } from '../core/units.js';
import { layoutToPdfPages, buildPdf } from '../core/pdf.js';
import { parseJpegInfo, setJpegDpi, setPngDpi, setPngSrgb } from '../core/binary.js';
import { renderForOutput } from '../render/export.js';
import { canvasToBlob, makeDomCanvas } from '../platform/image.js';
import { runTask } from '../platform/worker.js';
import { saveBlob } from '../platform/download.js';
import { safeFileName } from '../core/filenames.js';
import { dateStampFa } from '../core/dates.js';
import { formatNumber, toFaDigits } from '../core/digits.js';

export function allPaperPresets(settings) {
  return [...PAPER_PRESETS, ...(settings?.paperPresets || [])];
}

export function resolvePaper(sheet, settings) {
  if (sheet.paperId === 'custom') return { id: 'custom', nameFa: 'سفارشی', ...sheet.customPaper };
  return allPaperPresets(settings).find((p) => p.id === sheet.paperId) || PAPER_PRESETS.find((p) => p.id === '10x15');
}

export function activeCalibration(settings) {
  const p = (settings.calibrationProfiles || []).find((c) => c.id === settings.activeCalibrationId);
  return p || null;
}

/** Build the layout engine input from project + photos. */
export function layoutInput(project, photos, settings) {
  const sh = project.sheet;
  const items = sh.items
    .filter((it) => photos[it.photoId])
    .map((it) => ({ id: it.id, widthMm: photos[it.photoId].edit.widthMm, heightMm: photos[it.photoId].edit.heightMm, copies: it.copies }));
  const base = {
    paper: resolvePaper(sh, settings),
    orientation: sh.orientation,
    margins: sh.margins,
    gap: sh.gap,
    items,
    mode: sh.mode,
    allowRotation: sh.allowRotation,
    rotateAll: !!sh.rotateAll,
    grid: sh.grid,
    align: sh.align,
    fillOrder: sh.fillOrder,
    compact: sh.compact,
    label: { enabled: sh.label.enabled, heightMm: sh.label.heightMm, gapMm: sh.label.gapMm },
    printer: sh.printer,
  };
  return nineModeInput(sh.nine, base) || base;
}

export function computeSheetLayout(state = getState()) {
  if (!state.project) return null;
  return computeLayout(layoutInput(state.project, state.photos, state.settings));
}

export function labelTextFor(placement, project, photos) {
  const sh = project.sheet;
  const item = sh.items.find((it) => it.id === placement.itemId);
  const photo = item ? photos[item.photoId] : null;
  if (sh.label.content === 'number') return toFaDigits(String(placement.index + 1));
  if (sh.label.content === 'custom') return sh.label.custom || '';
  return photo?.name || '';
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgLayer(W, H, cls) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', cls);
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', `${W}mm`);
  svg.setAttribute('height', `${H}mm`);
  svg.setAttribute('aria-hidden', 'true');
  return svg;
}

/**
 * The one sheet renderer used by both the on-screen preview and printing.
 * @param {object} layout computeLayout result
 * @param {object} page one of layout.pages
 * @param {{urlFor:(itemId)=>string|null, labelFor?:(pl)=>string, marks:object, calibration?:object|null}} ctx
 */
export function createSheetElement(layout, page, ctx) {
  const W = layout.sheet.widthMm; const H = layout.sheet.heightMm;
  const sheet = document.createElement('div');
  sheet.className = 'print-sheet';
  sheet.style.width = `${W}mm`;
  sheet.style.height = `${H}mm`;
  const content = document.createElement('div');
  content.className = 'print-content';
  content.style.width = `${W}mm`;
  content.style.height = `${H}mm`;
  const cal = ctx.calibration;
  if (cal && (cal.scaleX !== 1 || cal.scaleY !== 1 || cal.offsetXmm || cal.offsetYmm)) {
    content.style.transformOrigin = '50% 50%';
    content.style.transform = `translate(${cal.offsetXmm || 0}mm, ${cal.offsetYmm || 0}mm) scale(${cal.scaleX}, ${cal.scaleY})`;
  }
  const marks = computeMarks(layout, page, ctx.marks || {});
  if (marks.under.length) {
    const svg = svgLayer(W, H, 'marks marks-under');
    for (const s of marks.under) {
      const l = document.createElementNS(SVG_NS, 'line');
      l.setAttribute('x1', s.x1); l.setAttribute('y1', s.y1); l.setAttribute('x2', s.x2); l.setAttribute('y2', s.y2);
      l.setAttribute('stroke', s.kind === 'cut' ? '#999' : '#000');
      l.setAttribute('stroke-width', s.kind === 'cut' ? '0.1' : '0.15');
      svg.appendChild(l);
    }
    content.appendChild(svg);
  }
  for (const pl of page.placements) {
    const url = ctx.urlFor(pl.itemId);
    const img = document.createElement('img');
    img.className = 'print-photo';
    img.alt = '';
    img.draggable = false;
    if (url) img.src = url;
    img.style.width = `${pl.photoSizeMm.w}mm`;
    img.style.height = `${pl.photoSizeMm.h}mm`;
    if (pl.rotation === 90) {
      img.style.left = `${pl.photo.x + pl.photo.w}mm`;
      img.style.top = `${pl.photo.y}mm`;
      img.style.transformOrigin = '0 0';
      img.style.transform = 'rotate(90deg)';
    } else {
      img.style.left = `${pl.photo.x}mm`;
      img.style.top = `${pl.photo.y}mm`;
    }
    img.dataset.index = String(pl.index);
    if (ctx.onImageError) img.addEventListener('error', () => ctx.onImageError(pl.itemId), { once: true });
    content.appendChild(img);
    if (ctx.showOrder) {
      // preview only: fill-order number (never part of print or PDF output)
      const badge = document.createElement('span');
      badge.className = 'order-badge';
      badge.textContent = toFaDigits(String(pl.index + 1));
      badge.style.left = `${pl.photo.x + 1}mm`;
      badge.style.top = `${pl.photo.y + 1}mm`;
      content.appendChild(badge);
    }
    if (pl.label && ctx.labelFor) {
      const lab = document.createElement('div');
      lab.className = 'print-label';
      lab.textContent = ctx.labelFor(pl);
      lab.style.left = `${pl.label.x}mm`; lab.style.top = `${pl.label.y}mm`;
      lab.style.width = `${pl.label.w}mm`; lab.style.height = `${pl.label.h}mm`;
      lab.style.fontSize = `${pl.label.h * 0.72}mm`;
      lab.style.lineHeight = `${pl.label.h}mm`;
      content.appendChild(lab);
    }
  }
  if (marks.over.length) {
    const svg = svgLayer(W, H, 'marks marks-over');
    for (const o of marks.over) {
      const r = document.createElementNS(SVG_NS, 'rect');
      const bw = o.width || 0.1;
      r.setAttribute('x', o.rect.x + bw / 2); r.setAttribute('y', o.rect.y + bw / 2);
      r.setAttribute('width', o.rect.w - bw); r.setAttribute('height', o.rect.h - bw);
      r.setAttribute('fill', 'none'); r.setAttribute('stroke', o.color || '#000000'); r.setAttribute('stroke-width', bw);
      svg.appendChild(r);
    }
    content.appendChild(svg);
  }
  sheet.appendChild(content);
  return sheet;
}

/* ------------------------------------------------------------ rendering */

/**
 * Render each distinct sheet item once at the sheet DPI.
 * @returns {Promise<{byItem: Map<string,{blob,url,bytes,width,height,photo}>, warnings:string[]}>}
 */
/**
 * Brighten a rendered photo for print (in place). Pure white stays pure white.
 * @returns {boolean} whether anything was applied
 */
export function applyPrintBoost(canvas, level) {
  const lut = printBoostLut(level);
  if (!lut || !canvas?.width || !canvas?.height) return false;
  const cx = canvas.getContext('2d', { willReadFrequently: true });
  const img = cx.getImageData(0, 0, canvas.width, canvas.height);
  applyLut(img.data, lut);
  cx.putImageData(img, 0, 0);
  return true;
}

export const PRINT_BOOST_FA = Object.freeze({ off: 'خاموش', low: 'کم', medium: 'متوسط', high: 'زیاد' });

export async function renderSheetAssets(state, layout, task) {
  const sh = state.project.sheet;
  const dpi = sh.dpi || 300;
  const usedItems = [...new Set(layout.pages.flatMap((p) => p.placements.map((pl) => pl.itemId)))];
  const byItem = new Map();
  const warnings = [];
  for (let i = 0; i < usedItems.length; i += 1) {
    if (task?.signal.aborted) throw Object.assign(new Error('CANCELLED'), { code: 'CANCELLED' });
    task?.update(i / usedItems.length, `آماده‌سازی عکس ${formatNumber(i + 1)} از ${formatNumber(usedItems.length)}`);
    const item = sh.items.find((it) => it.id === usedItems[i]);
    const photo = state.photos[item.photoId];
    const r = await renderForOutput(photo, { dpi });
    // per-item override is used only by the brightness test sheet
    applyPrintBoost(r.canvas, item.boost ?? sh.printBoost ?? 'off');
    if (r.upscaled) warnings.push(`«${photo.name}»: وضوح مؤثر ${formatNumber(r.effectiveDpi, { maxFraction: 0 })} DPI (کمتر از ${formatNumber(dpi)})`);
    const blob = await canvasToBlob(r.canvas, 'image/jpeg', state.settings.jpegQuality);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    byItem.set(item.id, { blob, url: URL.createObjectURL(blob), bytes, width: r.outW, height: r.outH, photo });
  }
  return { byItem, warnings };
}

export function releaseAssets(assets) {
  for (const a of assets.byItem.values()) URL.revokeObjectURL(a.url);
}

/* --------------------------------------------------------------- printing */

// The page-size rule must survive a strict CSP (no inline <style>): use a
// constructable stylesheet, or a blob: stylesheet on older browsers.
let pageSheet = null;
let pageLink = null;
function setPageSize(W, H) {
  const css = `@page { size: ${W}mm ${H}mm; margin: 0; }`;
  try {
    if ('adoptedStyleSheets' in document && typeof CSSStyleSheet === 'function' && 'replaceSync' in CSSStyleSheet.prototype) {
      if (!pageSheet) {
        pageSheet = new CSSStyleSheet();
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, pageSheet];
      }
      pageSheet.replaceSync(css);
      return;
    }
  } catch { /* fall back below */ }
  const url = URL.createObjectURL(new Blob([css], { type: 'text/css' }));
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = url;
  link.onload = () => URL.revokeObjectURL(url);
  if (pageLink) pageLink.remove();
  document.head.appendChild(link);
  pageLink = link;
}

/** Fill #print-root with sheets and open the browser print dialog. */
export async function printSheets({ layout, assets, project, photos, settings, calibration = null, labelFor = null }) {
  const root = document.getElementById('print-root');
  root.replaceChildren();
  const sh = project.sheet;
  for (const page of layout.pages) {
    root.appendChild(createSheetElement(layout, page, {
      urlFor: (id) => assets.byItem.get(id)?.url || null,
      labelFor: labelFor || ((pl) => labelTextFor(pl, project, photos)),
      marks: sh.marks,
      calibration,
    }));
  }
  setPageSize(layout.sheet.widthMm, layout.sheet.heightMm);
  const imgs = [...root.querySelectorAll('img')];
  const decoded = await Promise.all(imgs.map((img) => img.decode().then(() => img.naturalWidth > 0, () => false)));
  if (decoded.some((okDecoded) => !okDecoded)) {
    root.replaceChildren();
    throw Object.assign(new Error('IMAGE_DECODE'), { code: 'IMAGE_DECODE' });
  }
  if (document.fonts?.ready) await document.fonts.ready;
  return new Promise((resolve) => {
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      window.removeEventListener('afterprint', done);
      setTimeout(() => { root.replaceChildren(); resolve(true); }, 300);
    };
    window.addEventListener('afterprint', done);
    window.print();
    // Some browsers (iOS) return immediately and never fire afterprint.
    setTimeout(done, 60_000);
  });
}

export async function runPrint() {
  const state = getState();
  const layout = computeSheetLayout(state);
  if (!layout?.ok) { toast('چیدمان معتبر نیست؛ ابتدا خطاها را برطرف کنید.', 'error'); return false; }
  const task = startTask('آماده‌سازی چاپ…', { cancellable: true });
  let assets = null;
  try {
    assets = await renderSheetAssets(state, layout, task);
    if (assets.warnings.length) toast(`هشدار وضوح:\n${assets.warnings.join('\n')}`, 'warn', 10000);
    task.update(1, 'باز کردن پنجرهٔ چاپ…');
    const cal = state.project.sheet.applyCalibrationPrint ? activeCalibration(state.settings) : null;
    task.done();
    await printSheets({ layout, assets, project: state.project, photos: state.photos, settings: state.settings, calibration: cal });
    logEvent('print', `${layout.totals.sheets} برگه`);
    toast('پنجرهٔ چاپ باز شد. مرورگر نتیجهٔ چاپ را به برنامه اطلاع نمی‌دهد؛ اندازه را با خط‌کش بررسی کنید.', 'info', 8000);
    return true;
  } catch (e) {
    if (e.code === 'CANCELLED') toast('چاپ لغو شد.', 'info');
    else { console.error(e); toast(e.code === 'NO_ORIGINAL' ? 'عکس اصلی یکی از عکس‌ها در دسترس نیست.' : e.code === 'IMAGE_DECODE' ? 'بعضی عکس‌ها برای چاپ آماده نشدند (حافظهٔ دستگاه). چیزی چاپ نشد؛ دوباره امتحان کنید.' : 'آماده‌سازی چاپ ناموفق بود.', 'error', 9000); }
    return false;
  } finally {
    task.done();
    if (assets) setTimeout(() => releaseAssets(assets), 65_000);
  }
}

/* -------------------------------------------------------------------- PDF */

async function deflate(bytes) {
  if (typeof CompressionStream === 'undefined') return null;
  const cs = new CompressionStream('deflate');
  const stream = new Blob([bytes]).stream().pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Rasterise a label to an RGB FlateDecode (or JPEG fallback) PDF image. */
async function labelImage(text, wMm, hMm) {
  const dpi = 600;
  const w = mmToPx(wMm, dpi); const h = mmToPx(hMm, dpi);
  const c = makeDomCanvas(w, h);
  const cx = c.getContext('2d', { willReadFrequently: true });
  cx.fillStyle = '#fff'; cx.fillRect(0, 0, w, h);
  cx.fillStyle = '#000';
  cx.direction = 'rtl';
  cx.textAlign = 'center';
  cx.textBaseline = 'middle';
  cx.font = `${Math.round(h * 0.72)}px Vazirmatn, sans-serif`;
  cx.fillText(text, w / 2, h / 2, w * 0.98);
  const rgba = cx.getImageData(0, 0, w, h).data;
  const rgb = new Uint8Array(w * h * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) { rgb[j] = rgba[i]; rgb[j + 1] = rgba[i + 1]; rgb[j + 2] = rgba[i + 2]; }
  const z = await deflate(rgb);
  if (z) return { width: w, height: h, colorSpace: 'DeviceRGB', filter: 'FlateDecode', data: z };
  const jb = new Uint8Array(await (await canvasToBlob(c, 'image/jpeg', 0.95)).arrayBuffer());
  return { width: w, height: h, colorSpace: 'DeviceRGB', filter: 'DCTDecode', data: jb };
}

export async function buildSheetPdf(state, layout, assets, { labelFor = null } = {}) {
  const textFor = labelFor || ((pl) => labelTextFor(pl, state.project, state.photos));
  const images = {};
  const names = new Map();
  let k = 1;
  for (const [itemId, a] of assets.byItem) {
    const info = parseJpegInfo(a.bytes);
    const name = `Im${k++}`;
    names.set(itemId, name);
    images[name] = { width: info.width, height: info.height, colorSpace: info.components === 1 ? 'DeviceGray' : 'DeviceRGB', filter: 'DCTDecode', data: a.bytes };
  }
  const sh = state.project.sheet;
  const labelNames = new Map();
  if (sh.label.enabled) {
    if (document.fonts?.load) await document.fonts.load('16px Vazirmatn').catch(() => {});
    for (const page of layout.pages) {
      for (const pl of page.placements) {
        const text = textFor(pl);
        const key = `${text}|${pl.label.w}|${pl.label.h}`;
        if (!text || labelNames.has(key)) continue;
        const name = `Lb${k++}`;
        images[name] = await labelImage(text, pl.label.w, pl.label.h);
        labelNames.set(key, name);
      }
    }
  }
  const cal = sh.applyCalibrationPdf ? activeCalibration(state.settings) : null;
  const pages = layoutToPdfPages(layout, {
    imageName: (id) => names.get(id),
    marks: (page) => computeMarks(layout, page, sh.marks),
    labelImage: (pl) => labelNames.get(`${textFor(pl)}|${pl.label.w}|${pl.label.h}`) || null,
    calibration: cal,
  });
  const doc = { title: `${state.project.name} — هوشمند فوتو استودیو`, pages, images };
  try {
    const { pdf } = await runTask('pdf', { doc });
    return pdf;
  } catch {
    return buildPdf(doc);
  }
}

export async function runPdfExport() {
  const state = getState();
  const layout = computeSheetLayout(state);
  if (!layout?.ok) { toast('چیدمان معتبر نیست؛ ابتدا خطاها را برطرف کنید.', 'error'); return false; }
  const task = startTask('ساخت PDF با اندازهٔ دقیق…', { cancellable: true });
  let assets = null;
  try {
    assets = await renderSheetAssets(state, layout, task);
    task.update(0.95, 'نوشتن فایل PDF…');
    const pdf = await buildSheetPdf(state, layout, assets);
    const paper = layout.sheet;
    const name = safeFileName(`${state.project.name}-${formatNumber(paper.widthMm)}x${formatNumber(paper.heightMm)}mm-${dateStampFa()}`, 'pdf');
    await saveBlob(new Blob([pdf], { type: 'application/pdf' }), name);
    logEvent('pdf', name);
    toast(`PDF «${name}» ساخته شد: ${formatNumber(layout.totals.sheets)} صفحه، هر صفحه دقیقاً ${formatNumber(paper.widthMm)} × ${formatNumber(paper.heightMm)} ملی‌متر. هنگام چاپ «Actual size / ۱۰۰٪» را انتخاب کنید.`, 'success', 10000);
    if (assets.warnings.length) toast(`هشدار وضوح:\n${assets.warnings.join('\n')}`, 'warn', 10000);
    return true;
  } catch (e) {
    if (e.code === 'CANCELLED') toast('ساخت PDF لغو شد.', 'info');
    else { console.error(e); toast(e.code === 'NO_ORIGINAL' ? 'عکس اصلی یکی از عکس‌ها در دسترس نیست.' : 'ساخت PDF ناموفق بود.', 'error'); }
    return false;
  } finally {
    task.done();
    if (assets) releaseAssets(assets);
  }
}

/* ------------------------------------------------- brightness test sheet */

/**
 * Sheet state for the brightness test: the same photo once per print-boost
 * level (off, low, medium, high), each labelled, on the current paper.
 */
export function boostTestState(state, photoId) {
  const sh = state.project.sheet;
  const items = PRINT_BOOST_IDS.map((lv) => ({ id: `boost-${lv}`, photoId, copies: 1, boost: lv }));
  const sheet = {
    ...sh, mode: 'exact', items, compact: false, fillOrder: 'col-ltr', allowRotation: false,
    grid: { cols: null, rows: null, rotated: false },
    label: { ...sh.label, enabled: true, heightMm: 4, gapMm: 1, content: 'custom', custom: '' },
  };
  return { ...state, project: { ...state.project, sheet } };
}

export const boostTestLabel = (pl) => `روشن‌سازی: ${PRINT_BOOST_FA[pl.itemId.slice(6)] || ''}`;

/** Print (or save as PDF) the brightness test sheet for one photo. */
export async function runBoostTest(photoId, mode = 'print') {
  const base = getState();
  if (!base.project || !base.photos[photoId]) { toast('ابتدا یک عکس روی برگه بگذارید.', 'error'); return false; }
  const state = boostTestState(base, photoId);
  const layout = computeLayout(layoutInput(state.project, state.photos, state.settings));
  if (!layout.ok) { toast('برگهٔ آزمایش روی این کاغذ جا نمی‌شود؛ کاغذ بزرگ‌تر یا حاشیهٔ کمتر انتخاب کنید.', 'error'); return false; }
  const task = startTask('ساخت برگهٔ آزمایش روشنایی…', { cancellable: true });
  let assets = null;
  try {
    assets = await renderSheetAssets(state, layout, task);
    if (mode === 'pdf') {
      const pdf = await buildSheetPdf(state, layout, assets, { labelFor: boostTestLabel });
      const name = safeFileName(`آزمایش-روشنایی-${formatNumber(layout.sheet.widthMm)}x${formatNumber(layout.sheet.heightMm)}mm`, 'pdf');
      await saveBlob(new Blob([pdf], { type: 'application/pdf' }), name);
      toast(`PDF «${name}» ساخته شد. با «Actual size / ۱۰۰٪» چاپ کنید.`, 'success', 8000);
    } else {
      task.done();
      const cal = state.project.sheet.applyCalibrationPrint ? activeCalibration(state.settings) : null;
      await printSheets({ layout, assets, project: state.project, photos: state.photos, settings: state.settings, calibration: cal, labelFor: boostTestLabel });
    }
    logEvent('boost-test', mode);
    return true;
  } catch (e) {
    if (e.code === 'CANCELLED') toast('لغو شد.', 'info');
    else { console.error(e); toast(e.code === 'NO_ORIGINAL' ? 'عکس اصلی در دسترس نیست.' : 'ساخت برگهٔ آزمایش ناموفق بود.', 'error'); }
    return false;
  } finally {
    task.done();
    if (assets) setTimeout(() => releaseAssets(assets), mode === 'pdf' ? 0 : 65_000);
  }
}

/* ---------------------------------------------------------- raster sheets */

export async function renderSheetCanvas(state, layout, page, assets, dpi) {
  const W = layout.sheet.widthMm; const H = layout.sheet.heightMm;
  const pw = mmToPx(W, dpi); const ph = mmToPx(H, dpi);
  const limit = state.caps?.maxCanvasPixels || 120_000_000;
  if (pw * ph > limit) throw Object.assign(new Error('CANVAS_TOO_LARGE'), { code: 'CANVAS_TOO_LARGE' });
  const k = pw / W;
  const c = makeDomCanvas(pw, ph);
  const cx = c.getContext('2d');
  cx.fillStyle = '#fff'; cx.fillRect(0, 0, pw, ph);
  const sh = state.project.sheet;
  const marks = computeMarks(layout, page, sh.marks);
  for (const s of marks.under) {
    cx.strokeStyle = s.kind === 'cut' ? '#999' : '#000';
    cx.lineWidth = Math.max(1, (s.kind === 'cut' ? 0.1 : 0.15) * k);
    cx.beginPath(); cx.moveTo(s.x1 * k, s.y1 * k); cx.lineTo(s.x2 * k, s.y2 * k); cx.stroke();
  }
  const imgs = new Map();
  for (const [id, a] of assets.byItem) {
    const im = new Image();
    im.src = a.url;
    await im.decode();
    imgs.set(id, im);
  }
  cx.imageSmoothingQuality = 'high';
  for (const pl of page.placements) {
    const im = imgs.get(pl.itemId);
    const w = pl.photoSizeMm.w * k; const h = pl.photoSizeMm.h * k;
    if (pl.rotation === 90) {
      cx.save();
      cx.translate((pl.photo.x + pl.photo.w) * k, pl.photo.y * k);
      cx.rotate(Math.PI / 2);
      cx.drawImage(im, 0, 0, w, h);
      cx.restore();
    } else {
      cx.drawImage(im, pl.photo.x * k, pl.photo.y * k, w, h);
    }
    if (pl.label) {
      cx.fillStyle = '#000';
      cx.direction = 'rtl'; cx.textAlign = 'center'; cx.textBaseline = 'middle';
      cx.font = `${Math.round(pl.label.h * 0.72 * k)}px Vazirmatn, sans-serif`;
      cx.fillText(labelTextFor(pl, state.project, state.photos), (pl.label.x + pl.label.w / 2) * k, (pl.label.y + pl.label.h / 2) * k, pl.label.w * k);
    }
  }
  for (const o of marks.over) {
    const bw = o.width || 0.1;
    cx.strokeStyle = o.color || '#000000'; cx.lineWidth = Math.max(1, bw * k);
    cx.strokeRect((o.rect.x + bw / 2) * k, (o.rect.y + bw / 2) * k, (o.rect.w - bw) * k, (o.rect.h - bw) * k);
  }
  return c;
}

export async function runSheetImageExport(format = 'jpeg') {
  const state = getState();
  const layout = computeSheetLayout(state);
  if (!layout?.ok) { toast('چیدمان معتبر نیست.', 'error'); return false; }
  const dpi = state.project.sheet.dpi || 300;
  const task = startTask('ساخت تصویر برگه…', { cancellable: true });
  let assets = null;
  try {
    assets = await renderSheetAssets(state, layout, task);
    if (document.fonts?.load) await document.fonts.load('16px Vazirmatn').catch(() => {});
    const files = [];
    for (const page of layout.pages) {
      task.update(page.index / layout.pages.length, `برگهٔ ${formatNumber(page.index + 1)}`);
      const c = await renderSheetCanvas(state, layout, page, assets, dpi);
      const blob = await canvasToBlob(c, format === 'png' ? 'image/png' : 'image/jpeg', state.settings.jpegQuality);
      const raw = new Uint8Array(await blob.arrayBuffer());
      const data = format === 'png' ? setPngSrgb(setPngDpi(raw, dpi)) : setJpegDpi(raw, dpi);
      files.push({ name: safeFileName(`${state.project.name}-برگه-${toFaDigits(page.index + 1)}`, format === 'png' ? 'png' : 'jpg'), data });
      c.width = 0; c.height = 0;
    }
    if (files.length === 1) {
      await saveBlob(new Blob([files[0].data], { type: format === 'png' ? 'image/png' : 'image/jpeg' }), files[0].name);
      toast(`تصویر برگه «${files[0].name}» ساخته شد (${formatNumber(dpi)} DPI).`, 'success');
    } else {
      const { zip } = await runTask('zip', { files }, files.map((f) => f.data.buffer));
      const name = safeFileName(`${state.project.name}-برگه‌ها-${dateStampFa()}`, 'zip');
      await saveBlob(new Blob([zip], { type: 'application/zip' }), name);
      toast(`${formatNumber(files.length)} برگه در «${name}» ذخیره شد.`, 'success');
    }
    logEvent('sheet-image', `${files.length}`);
    return true;
  } catch (e) {
    if (e.code === 'CANCELLED') toast('لغو شد.', 'info');
    else if (e.code === 'CANVAS_TOO_LARGE') toast('این برگه در این DPI برای حافظهٔ این دستگاه بسیار بزرگ است. DPI را کم کنید یا از PDF استفاده کنید.', 'error', 9000);
    else { console.error(e); toast('ساخت تصویر برگه ناموفق بود.', 'error'); }
    return false;
  } finally {
    task.done();
    if (assets) releaseAssets(assets);
  }
}

/* ------------------------------------------------------- calibration sheet */

/** Geometry of the calibration sheet for a paper (mm). */
export function calibrationGeometry(paper, orientation = 'portrait') {
  const W = orientation === 'landscape' ? Math.max(paper.widthMm, paper.heightMm) : Math.min(paper.widthMm, paper.heightMm);
  const H = orientation === 'landscape' ? Math.min(paper.widthMm, paper.heightMm) : Math.max(paper.widthMm, paper.heightMm);
  const margin = 10;
  const square = [100, 80, 60, 40].find((s) => s + 2 * margin <= W && s + 2 * margin + 70 <= H) || 40;
  return { W, H, margin, square, squareX: (W - square) / 2, squareY: margin + 14, rulerY: margin + 14 + square + 14, rulerLen: 50 };
}

export function createCalibrationElement(paper, orientation) {
  const g = calibrationGeometry(paper, orientation);
  const sheet = document.createElement('div');
  sheet.className = 'print-sheet';
  sheet.style.width = `${g.W}mm`; sheet.style.height = `${g.H}mm`;
  const svg = svgLayer(g.W, g.H, 'marks calibration');
  const add = (tag, attrs, text) => {
    const e = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (text != null) e.textContent = text;
    svg.appendChild(e);
    return e;
  };
  const txt = (x, y, size, text, anchor = 'middle') => add('text', { x, y, 'font-size': size, 'text-anchor': anchor, 'font-family': 'Vazirmatn, sans-serif', direction: 'rtl', fill: '#000' }, text);
  txt(g.W / 2, g.margin + 4, 4.2, 'برگهٔ کالیبراسیون چاپ — هوشمند فوتو استودیو');
  txt(g.W / 2, g.margin + 9, 2.8, `کاغذ ${toFaDigits(g.W)} × ${toFaDigits(g.H)} ملی‌متر — در پنجرهٔ چاپ «اندازهٔ واقعی / ۱۰۰٪» را انتخاب کنید`);
  add('rect', { x: g.squareX, y: g.squareY, width: g.square, height: g.square, fill: 'none', stroke: '#000', 'stroke-width': 0.2 });
  add('line', { x1: g.squareX, y1: g.squareY + g.square / 2, x2: g.squareX + g.square, y2: g.squareY + g.square / 2, stroke: '#888', 'stroke-width': 0.1 });
  add('line', { x1: g.squareX + g.square / 2, y1: g.squareY, x2: g.squareX + g.square / 2, y2: g.squareY + g.square, stroke: '#888', 'stroke-width': 0.1 });
  txt(g.W / 2, g.squareY + g.square / 2 - 2, 3.4, `مربع ${toFaDigits(g.square)} × ${toFaDigits(g.square)} ملی‌متر`);
  // 50 mm horizontal ruler
  const rx = (g.W - g.rulerLen) / 2; const ry = g.rulerY;
  add('line', { x1: rx, y1: ry, x2: rx + g.rulerLen, y2: ry, stroke: '#000', 'stroke-width': 0.15 });
  for (let i = 0; i <= g.rulerLen; i += 1) {
    const len = i % 10 === 0 ? 4 : i % 5 === 0 ? 2.8 : 1.6;
    add('line', { x1: rx + i, y1: ry, x2: rx + i, y2: ry + len, stroke: '#000', 'stroke-width': 0.1 });
    if (i % 10 === 0) txt(rx + i, ry + 7.5, 2.6, toFaDigits(i / 10));
  }
  txt(g.W / 2, ry + 12, 3, 'خط‌کش ۵۰ ملی‌متری (اعداد به سانتی‌متر)');
  // 10 mm offset references from the paper edges
  add('line', { x1: 10, y1: 0, x2: 10, y2: 6, stroke: '#000', 'stroke-width': 0.15 });
  add('line', { x1: 0, y1: 10, x2: 6, y2: 10, stroke: '#000', 'stroke-width': 0.15 });
  txt(12, 5, 2.2, '۱۰ ملی‌متر از لبهٔ چپ', 'start');
  if (ry + 30 < g.H) {
    txt(g.W / 2, ry + 20, 2.6, 'طول ضلع مربع و خط‌کش را با خط‌کش واقعی اندازه بگیرید و در تنظیمات کالیبراسیون وارد کنید.');
  }
  sheet.appendChild(svg);
  return { element: sheet, geometry: g };
}

export async function printCalibration(paper, orientation) {
  const root = document.getElementById('print-root');
  root.replaceChildren();
  const { element, geometry } = createCalibrationElement(paper, orientation);
  root.appendChild(element);
  setPageSize(geometry.W, geometry.H);
  if (document.fonts?.ready) await document.fonts.ready;
  await new Promise((resolve) => {
    const done = () => { window.removeEventListener('afterprint', done); setTimeout(() => { root.replaceChildren(); resolve(); }, 300); };
    window.addEventListener('afterprint', done);
    window.print();
    setTimeout(done, 60_000);
  });
  return geometry;
}

/** Calibration sheet as vector PDF (lines exact; text rasterised). */
export async function calibrationPdf(paper, orientation) {
  const g = calibrationGeometry(paper, orientation);
  const y = (mm) => mmToPt(g.H - mm);
  const P = (v) => (Math.round(mmToPt(v) * 10000) / 10000);
  const ops = [];
  const line = (x1, y1, x2, y2, w = 0.15) => ops.push(`${P(w)} w ${P(x1)} ${y(y1)} m ${P(x2)} ${y(y2)} l S`);
  ops.push('0 G');
  ops.push(`${P(0.2)} w ${P(g.squareX)} ${y(g.squareY + g.square)} ${P(g.square)} ${P(g.square)} re S`);
  const rx = (g.W - g.rulerLen) / 2;
  line(rx, g.rulerY, rx + g.rulerLen, g.rulerY);
  for (let i = 0; i <= g.rulerLen; i += 1) line(rx + i, g.rulerY, rx + i, g.rulerY + (i % 10 === 0 ? 4 : i % 5 === 0 ? 2.8 : 1.6), 0.1);
  line(10, 0, 10, 6); line(0, 10, 6, 10);
  const images = {};
  const texts = [
    ['T1', 'برگهٔ کالیبراسیون چاپ — هوشمند فوتو استودیو', g.W - 2 * g.margin, 6, g.margin, g.margin],
    ['T2', `مربع ${toFaDigits(g.square)} × ${toFaDigits(g.square)} ملی‌متر — خط‌کش ۵۰ ملی‌متر — چاپ با اندازهٔ واقعی (۱۰۰٪)`, g.W - 2 * g.margin, 5, g.margin, g.rulerY + 9],
  ];
  if (document.fonts?.load) await document.fonts.load('16px Vazirmatn').catch(() => {});
  for (const [name, text, w, h, x, top] of texts) {
    images[name] = await labelImage(text, w, h);
    ops.push(`q ${P(w)} 0 0 ${P(h)} ${P(x)} ${y(top + h)} cm /${name} Do Q`);
  }
  return buildPdf({ title: 'کالیبراسیون چاپ', pages: [{ widthPt: mmToPt(g.W), heightPt: mmToPt(g.H), content: ops.join('\n'), images: Object.keys(images) }], images });
}
