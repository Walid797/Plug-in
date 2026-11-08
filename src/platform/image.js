// Image probing, safe decoding, previews, thumbnails and memory-bounded caches.
import { sniffImageType, SUPPORTED_IMAGE_TYPES } from '../core/binary.js';

export const LIMITS = {
  maxFileBytes: 60 * 1024 * 1024,
  maxSourcePixels: 150_000_000,
  minSide: 64,
  previewMax: 1400,
  thumbMax: 320,
};

export function workingPixelLimit(caps) {
  if (caps?.ios) return 12_000_000;
  if (caps?.deviceMemoryGb && caps.deviceMemoryGb <= 2) return 12_000_000;
  return 36_000_000;
}

const u16be = (b, o) => (b[o] << 8) | b[o + 1];
const u16le = (b, o) => b[o] | (b[o + 1] << 8);
const u32be = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

function jpegOrientation(b, start, len) {
  // APP1 Exif → TIFF → IFD0 tag 0x0112
  if (!(b[start] === 0x45 && b[start + 1] === 0x78 && b[start + 2] === 0x69 && b[start + 3] === 0x66)) return 1;
  const t = start + 6;
  const le = b[t] === 0x49;
  const r16 = (o) => (le ? u16le(b, o) : u16be(b, o));
  const r32 = (o) => (le ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0 : u32be(b, o));
  const ifd = t + r32(t + 4);
  if (ifd + 2 > start + len) return 1;
  const count = r16(ifd);
  for (let i = 0; i < count; i += 1) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > b.length) break;
    if (r16(e) === 0x0112) return r16(e + 8) || 1;
  }
  return 1;
}

/** Header-only probe: intrinsic size, EXIF orientation and displayed size. */
export function probeImage(b, mime) {
  let w = 0; let h = 0; let orientation = 1;
  if (mime === 'image/png') {
    w = u32be(b, 16); h = u32be(b, 20);
  } else if (mime === 'image/jpeg') {
    let o = 2;
    while (o + 4 < b.length) {
      if (b[o] !== 0xff) { o += 1; continue; }
      const m = b[o + 1];
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { o += 2; continue; }
      const len = u16be(b, o + 2);
      if (m === 0xe1) orientation = jpegOrientation(b, o + 4, len - 2);
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) { h = u16be(b, o + 5); w = u16be(b, o + 7); break; }
      if (m === 0xda) break;
      o += 2 + len;
    }
  } else if (mime === 'image/webp') {
    const fourcc = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (fourcc === 'VP8 ') { w = u16le(b, 26) & 0x3fff; h = u16le(b, 28) & 0x3fff; }
    else if (fourcc === 'VP8L') { const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24); w = (bits & 0x3fff) + 1; h = ((bits >> 14) & 0x3fff) + 1; }
    else if (fourcc === 'VP8X') { w = 1 + (b[24] | (b[25] << 8) | (b[26] << 16)); h = 1 + (b[27] | (b[28] << 8) | (b[29] << 16)); }
  }
  const swap = orientation >= 5 && orientation <= 8;
  return { width: w, height: h, orientation, displayWidth: swap ? h : w, displayHeight: swap ? w : h };
}

/**
 * Validate a File before decoding. Never trusts the extension or browser MIME.
 * @returns {{ok:true, mime, probe} | {ok:false, code, extra}}
 */
export async function validateImageFile(file, caps) {
  const name = file.name || '';
  if (file.size > LIMITS.maxFileBytes) return { ok: false, code: 'TOO_LARGE_FILE', extra: { name, limitMb: LIMITS.maxFileBytes / 1048576 } };
  const head = new Uint8Array(await file.slice(0, Math.min(file.size, 256 * 1024)).arrayBuffer());
  const mime = sniffImageType(head);
  if (mime === 'image/heic') return { ok: false, code: 'HEIC', extra: { name } };
  if (!mime || !SUPPORTED_IMAGE_TYPES.includes(mime)) return { ok: false, code: 'UNSUPPORTED', extra: { name } };
  if (mime === 'image/webp' && caps && !caps.webp) return { ok: false, code: 'WEBP_UNSUPPORTED', extra: { name } };
  const probe = probeImage(head, mime);
  if (probe.width && probe.height) {
    const px = probe.width * probe.height;
    if (px > LIMITS.maxSourcePixels) return { ok: false, code: 'TOO_MANY_PIXELS', extra: { name, mp: px / 1e6 } };
    if (Math.min(probe.width, probe.height) < LIMITS.minSide) return { ok: false, code: 'TOO_SMALL', extra: { name, w: probe.width, h: probe.height } };
  }
  return { ok: true, mime, probe };
}

export function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') {
    try { const c = new OffscreenCanvas(w, h); if (c.getContext('2d')) return c; } catch { /* fallback */ }
  }
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

export function makeDomCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

async function decodeWithImageElement(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    const c = makeDomCanvas(img.naturalWidth, img.naturalHeight);
    c.getContext('2d').drawImage(img, 0, 0);
    return c;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Downscale any drawable to fit `maxSide` using stepwise halving (good quality). */
export function downscale(src, srcW, srcH, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(srcW, srcH));
  const tw = Math.max(1, Math.round(srcW * scale)); const th = Math.max(1, Math.round(srcH * scale));
  let cur = src; let cw = srcW; let ch = srcH;
  while (cw / 2 > tw * 1.0 && ch / 2 > th * 1.0) {
    const nw = Math.max(tw, Math.round(cw / 2)); const nh = Math.max(th, Math.round(ch / 2));
    const c = makeCanvas(nw, nh);
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(cur, 0, 0, nw, nh);
    cur = c; cw = nw; ch = nh;
  }
  const out = makeCanvas(tw, th);
  const ctx = out.getContext('2d');
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(cur, 0, 0, tw, th);
  return out;
}

/**
 * Decode to a drawable in display orientation, capped at maxPixels.
 * Verifies the aspect ratio so a resize can never distort the photo.
 */
export async function decodeImage(blob, { maxPixels, expected } = {}) {
  let bmp = null;
  const expAspect = expected?.displayWidth && expected?.displayHeight ? expected.displayWidth / expected.displayHeight : null;
  const tooBig = expected && maxPixels && expected.displayWidth * expected.displayHeight > maxPixels;
  try {
    if (typeof createImageBitmap === 'function') {
      if (tooBig) {
        const s = Math.sqrt(maxPixels / (expected.displayWidth * expected.displayHeight));
        const rw = Math.max(1, Math.floor(expected.displayWidth * s)); const rh = Math.max(1, Math.floor(expected.displayHeight * s));
        try {
          bmp = await createImageBitmap(blob, { imageOrientation: 'from-image', resizeWidth: rw, resizeHeight: rh, resizeQuality: 'high' });
          if (expAspect && Math.abs(bmp.width / bmp.height - expAspect) / expAspect > 0.01) { bmp.close(); bmp = null; }
        } catch { bmp = null; }
      }
      if (!bmp) bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    }
  } catch (e) {
    if (e && /memory/i.test(String(e.message))) throw Object.assign(new Error('MEMORY'), { code: 'MEMORY' });
    bmp = null;
  }
  let drawable = bmp;
  if (!drawable) drawable = await decodeWithImageElement(blob);
  let w = drawable.width; let h = drawable.height;
  if (!w || !h) throw Object.assign(new Error('DECODE'), { code: 'DECODE' });
  if (maxPixels && w * h > maxPixels) {
    const c = downscale(drawable, w, h, Math.floor(Math.sqrt(maxPixels * (w / h))));
    if (drawable.close) drawable.close();
    drawable = c; w = c.width; h = c.height;
  }
  return { image: drawable, width: w, height: h };
}

export async function canvasToBlob(canvas, type = 'image/jpeg', quality = 0.92) {
  if (canvas.convertToBlob) return canvas.convertToBlob({ type, quality });
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('ENCODE'))), type, quality));
}

/** Release GPU/CPU memory held by a drawable. */
export function releaseDrawable(d) {
  if (!d) return;
  if (typeof d.close === 'function') { try { d.close(); } catch { /* ignore */ } }
  if ('width' in d && d instanceof (globalThis.HTMLCanvasElement || function X() {})) { d.width = 0; d.height = 0; }
}

/** Small LRU cache that releases evicted drawables. */
export class DrawableCache {
  constructor(limit) { this.limit = limit; this.map = new Map(); }
  get(key) {
    const v = this.map.get(key);
    if (v) { this.map.delete(key); this.map.set(key, v); }
    return v || null;
  }
  set(key, value) {
    if (this.map.has(key)) this.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.limit) {
      const [k] = this.map.keys();
      this.delete(k);
    }
  }
  delete(key) {
    const v = this.map.get(key);
    if (v) { releaseDrawable(v.image); this.map.delete(key); }
  }
  clear() { for (const k of [...this.map.keys()]) this.delete(k); }
}
