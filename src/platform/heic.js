// HEIC / HEIF (iPhone) photos: browsers on Windows cannot open them, so the file is decoded here, on this device, with
// libheif (WebAssembly, loaded only when such a file arrives) and handed on as a JPEG of the same pixels.
import { makeCanvas, canvasToBlob } from './image.js';

let libPromise = null;
function loadLib() {
  if (!libPromise) {
    const url = new URL('vendor/libheif/libheif-bundle.mjs', document.baseURI).href;
    libPromise = import(/* @vite-ignore */ url).then((m) => m.default()).catch((e) => { libPromise = null; throw e; });
  }
  return libPromise;
}

/**
 * Convert a HEIC/HEIF file to a JPEG File (quality 0.95, same size in pixels, upright).
 * @param {File|Blob} file
 * @param {{maxPixels?:number}} [opt]
 * @returns {Promise<File>}
 */
export async function heicToJpeg(file, { maxPixels = 60_000_000 } = {}) {
  const lib = await loadLib();
  const decoder = new lib.HeifDecoder();
  const images = decoder.decode(new Uint8Array(await file.arrayBuffer()));
  if (!images || !images.length) throw Object.assign(new Error('HEIC_DECODE'), { code: 'HEIC_DECODE' });
  const im = images[0];
  try {
    const w = im.get_width(); const h = im.get_height();
    if (!(w > 0 && h > 0) || w * h > maxPixels) throw Object.assign(new Error('HEIC_SIZE'), { code: 'HEIC_SIZE' });
    const c = makeCanvas(w, h); const cx = c.getContext('2d');
    const img = cx.createImageData(w, h);
    await new Promise((resolve, reject) => { im.display(img, (d) => (d ? resolve() : reject(Object.assign(new Error('HEIC_DECODE'), { code: 'HEIC_DECODE' })))); });
    cx.putImageData(img, 0, 0);
    const blob = await canvasToBlob(c, 'image/jpeg', 0.95);
    c.width = 0; c.height = 0;
    const name = String(file.name || 'photo.heic').replace(/\.(heic|heif)$/i, '') + '.jpg';
    return new File([blob], name, { type: 'image/jpeg', lastModified: file.lastModified || Date.now() });
  } finally {
    for (const x of images) { try { x.free(); } catch { /* already freed */ } }
  }
}
