// High-resolution export of individual photos at exact physical size.
import { getState, startTask, toast, logEvent } from '../state/store.js';
import { getWorking, gatherAssets } from '../state/media.js';
import { renderPhoto } from './renderPhoto.js';
import { mmToPx } from '../core/units.js';
import { defaultCrop, sourcePixelsPerOutputPixel } from '../core/crop.js';
import { setJpegDpi, setPngDpi, setPngSrgb } from '../core/binary.js';
import { canvasToBlob, releaseDrawable } from '../platform/image.js';
import { safeFileName } from '../core/filenames.js';
import { dateStampFa } from '../core/dates.js';
import { formatNumber } from '../core/digits.js';
import { runTask } from '../platform/worker.js';
import { saveBlob } from '../platform/download.js';

/** Pixel size and effective DPI for a photo at a target DPI (no rendering). */
export function outputInfo(photo, dpi, workingDims = null) {
  const e = photo.edit;
  const outW = mmToPx(e.widthMm, dpi);
  const outH = mmToPx(e.heightMm, dpi);
  // an enhanced (upscaled) version is what gets printed, so its pixels count
  const srcW = workingDims?.width || (photo.edit.enhance?.enabled && photo.enhanced?.width) || photo.width;
  const crop = e.crop || defaultCrop(photo.width, photo.height, e.widthMm / e.heightMm);
  const ratio = sourcePixelsPerOutputPixel(crop, srcW, outW);
  return { outW, outH, ratio, effectiveDpi: dpi * ratio, upscaled: ratio < 1 };
}

/**
 * Render a photo at full working resolution.
 * @returns {Promise<{canvas, outW, outH, effectiveDpi, upscaled}>}
 */
export async function renderForOutput(photo, { dpi = 300, transparent = false } = {}) {
  const work = await getWorking(photo);
  if (!work) throw Object.assign(new Error('NO_ORIGINAL'), { code: 'NO_ORIGINAL' });
  try {
    const info = outputInfo(photo, dpi, work);
    const assets = await gatherAssets(photo, work);
    const canvas = renderPhoto(photo.edit, assets, info.outW, info.outH, {
      transparent, pxPerMm: info.outW / photo.edit.widthMm, frameWidthPx: info.outW,
    });
    return { canvas, ...info };
  } finally {
    releaseDrawable(work.image);
  }
}

export async function encodeCanvas(canvas, format, dpi, quality) {
  const type = format === 'png' ? 'image/png' : 'image/jpeg';
  const blob = await canvasToBlob(canvas, type, quality);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const patched = format === 'png' ? setPngSrgb(setPngDpi(bytes, dpi)) : setJpegDpi(bytes, dpi);
  return new Blob([patched], { type });
}

export function photoFileBase(photo, dpi) {
  const e = photo.edit;
  const size = `${formatNumber(e.widthMm / 10, { maxFraction: 2 })}x${formatNumber(e.heightMm / 10, { maxFraction: 2 })}`;
  return `${photo.name}-${size}-${dpi}dpi${e.aiEdited ? '-ویرایش-هوش-مصنوعی' : ''}`;
}

/** Export one photo; success is reported only after the file exists. */
export async function exportPhoto(photo, { format = 'jpeg', dpi, transparent = false } = {}) {
  const s = getState();
  const d = dpi || s.settings.defaultDpi;
  const task = startTask('در حال ساخت فایل عکس…');
  try {
    const r = await renderForOutput(photo, { dpi: d, transparent: format === 'png' && transparent });
    const blob = await encodeCanvas(r.canvas, format, d, s.settings.jpegQuality);
    const name = safeFileName(photoFileBase(photo, d), format === 'png' ? 'png' : 'jpg');
    await saveBlob(blob, name);
    logEvent('export', name);
    toast(`فایل «${name}» ساخته شد (${formatNumber(r.outW)}×${formatNumber(r.outH)} پیکسل).${r.upscaled ? ' هشدار: وضوح عکس اصلی کم است و بزرگ‌نمایی شده است.' : ''}`, r.upscaled ? 'warn' : 'success', 8000);
    return true;
  } catch (e) {
    console.error(e);
    toast(e.code === 'NO_ORIGINAL' ? 'عکس اصلی در دسترس نیست؛ آن را دوباره انتخاب کنید.' : 'ساخت فایل خروجی ناموفق بود.', 'error');
    return false;
  } finally {
    task.done();
  }
}

/** Export many photos into one ZIP. */
export async function exportBatch(photos, { format = 'jpeg', dpi } = {}) {
  const s = getState();
  const d = dpi || s.settings.defaultDpi;
  const task = startTask('خروجی گروهی…', { cancellable: true });
  try {
    const files = [];
    const used = new Set();
    for (let i = 0; i < photos.length; i += 1) {
      if (task.signal.aborted) throw Object.assign(new Error('CANCELLED'), { code: 'CANCELLED' });
      task.update(i / photos.length, `خروجی ${formatNumber(i + 1)} از ${formatNumber(photos.length)}`);
      const r = await renderForOutput(photos[i], { dpi: d });
      const blob = await encodeCanvas(r.canvas, format, d, s.settings.jpegQuality);
      let name = safeFileName(photoFileBase(photos[i], d), format === 'png' ? 'png' : 'jpg');
      let k = 2;
      while (used.has(name)) { name = safeFileName(`${photoFileBase(photos[i], d)}-${k}`, format === 'png' ? 'png' : 'jpg'); k += 1; }
      used.add(name);
      files.push({ name, data: new Uint8Array(await blob.arrayBuffer()) });
    }
    const { zip } = await runTask('zip', { files }, files.map((f) => f.data.buffer));
    const name = safeFileName(`عکس‌ها-${dateStampFa()}`, 'zip');
    await saveBlob(new Blob([zip], { type: 'application/zip' }), name);
    toast(`فایل فشرده «${name}» با ${formatNumber(files.length)} عکس ساخته شد.`, 'success');
    logEvent('export', name);
    return true;
  } catch (e) {
    if (e.code !== 'CANCELLED') { console.error(e); toast('خروجی گروهی ناموفق بود.', 'error'); } else toast('خروجی لغو شد.', 'info');
    return false;
  } finally {
    task.done();
  }
}
