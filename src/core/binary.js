// Binary helpers: CRC-32, JPEG/PNG DPI metadata, JPEG header parsing, store-only ZIP,
// and file-type sniffing. Pure functions on Uint8Array (browser + Node).

let CRC_TABLE = null;
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  CRC_TABLE = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    CRC_TABLE[i] = c >>> 0;
  }
  return CRC_TABLE;
}

export function crc32(bytes, start = 0, end = bytes.length) {
  const t = crcTable();
  let c = 0xffffffff;
  for (let i = start; i < end; i += 1) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const u16 = (b, o) => (b[o] << 8) | b[o + 1];
const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

/* ------------------------------------------------------------------ JPEG */

/** Parse JPEG SOF for width, height and component count. */
export function parseJpegInfo(b) {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  let o = 2;
  while (o + 4 <= b.length) {
    if (b[o] !== 0xff) { o += 1; continue; }
    const marker = b[o + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xff) { o += marker === 0xff ? 1 : 2; continue; }
    const len = u16(b, o + 2);
    if ((marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: u16(b, o + 5), width: u16(b, o + 7), components: b[o + 9], progressive: marker === 0xc2 };
    }
    if (marker === 0xda) break;
    o += 2 + len;
  }
  return null;
}

/** Set (or insert) JFIF APP0 density in dots per inch. Returns a new array. */
export function setJpegDpi(b, dpi) {
  const d = Math.max(1, Math.min(65535, Math.round(dpi)));
  if (b[0] !== 0xff || b[1] !== 0xd8) throw new Error('not a JPEG');
  if (b[2] === 0xff && b[3] === 0xe0 && b[6] === 0x4a && b[7] === 0x46 && b[8] === 0x49 && b[9] === 0x46 && b[10] === 0) {
    const out = b.slice();
    out[13] = 1; // units: dots per inch
    out[14] = d >> 8; out[15] = d & 0xff;
    out[16] = d >> 8; out[17] = d & 0xff;
    return out;
  }
  const app0 = new Uint8Array([0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 1, d >> 8, d & 0xff, d >> 8, d & 0xff, 0, 0]);
  const out = new Uint8Array(b.length + app0.length);
  out.set(b.subarray(0, 2), 0);
  out.set(app0, 2);
  out.set(b.subarray(2), 2 + app0.length);
  return out;
}

export function readJpegDpi(b) {
  if (b[2] === 0xff && b[3] === 0xe0 && b[6] === 0x4a && b[7] === 0x46) {
    return { units: b[13], x: u16(b, 14), y: u16(b, 16) };
  }
  return null;
}

/* ------------------------------------------------------------------- PNG */

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function pngChunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

/** Insert/replace pHYs (pixels per metre) so viewers know the intended print size. */
export function setPngDpi(b, dpi) {
  for (let i = 0; i < 8; i += 1) if (b[i] !== PNG_SIG[i]) throw new Error('not a PNG');
  const ppm = Math.round(dpi / 0.0254);
  const data = new Uint8Array(9);
  const dv = new DataView(data.buffer);
  dv.setUint32(0, ppm); dv.setUint32(4, ppm); data[8] = 1;
  const phys = pngChunk('pHYs', data);
  const parts = [b.subarray(0, 8)];
  let o = 8;
  let inserted = false;
  while (o < b.length) {
    const len = u32(b, o);
    const type = String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]);
    const end = o + 12 + len;
    if (type !== 'pHYs') parts.push(b.subarray(o, end));
    if (type === 'IHDR' && !inserted) { parts.push(phys); inserted = true; }
    o = end;
  }
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const part of parts) { out.set(part, p); p += part.length; }
  return out;
}

export function readPngPhys(b) {
  let o = 8;
  while (o < b.length) {
    const len = u32(b, o);
    const type = String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]);
    if (type === 'pHYs') return { x: u32(b, o + 8), y: u32(b, o + 12), unit: b[o + 16] };
    if (type === 'IDAT') return null;
    o += 12 + len;
  }
  return null;
}

/* ------------------------------------------------------------------- ZIP */

function dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/** Store-only ZIP (photos are already compressed). UTF-8 names (flag bit 11). */
export function buildZip(files, now = new Date()) {
  const te = new TextEncoder();
  const { time, date } = dosDateTime(now);
  const locals = []; const centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = te.encode(f.name);
    const data = f.data;
    const crc = crc32(data);
    const lh = new Uint8Array(30 + name.length);
    const dv = new DataView(lh.buffer);
    dv.setUint32(0, 0x04034b50, true); dv.setUint16(4, 20, true); dv.setUint16(6, 0x0800, true);
    dv.setUint16(8, 0, true); dv.setUint16(10, time, true); dv.setUint16(12, date, true);
    dv.setUint32(14, crc, true); dv.setUint32(18, data.length, true); dv.setUint32(22, data.length, true);
    dv.setUint16(26, name.length, true); dv.setUint16(28, 0, true);
    lh.set(name, 30);
    const ch = new Uint8Array(46 + name.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true); cv.setUint16(10, 0, true); cv.setUint16(12, time, true); cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true); cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true); cv.setUint32(42, offset, true);
    ch.set(name, 46);
    locals.push(lh, data); centrals.push(ch);
    offset += lh.length + data.length;
  }
  const cdSize = centrals.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true);
  const all = [...locals, ...centrals, end];
  const out = new Uint8Array(all.reduce((s, a) => s + a.length, 0));
  let p = 0;
  for (const a of all) { out.set(a, p); p += a.length; }
  return out;
}

/* --------------------------------------------------------------- Sniffing */

/** Identify image types by magic bytes, never by extension or MIME alone. */
export function sniffImageType(b) {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && PNG_SIG.every((v, i) => b[i] === v)) return 'image/png';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
    && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  if (b.length >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
    if (/^(heic|heix|hevc|hevx|mif1|msf1)$/.test(brand)) return 'image/heic';
    if (/^avi[fs]$/.test(brand)) return 'image/avif';
  }
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
  if (b.length >= 4 && ((b[0] === 0x49 && b[1] === 0x49) || (b[0] === 0x4d && b[1] === 0x4d)) && (b[2] === 42 || b[3] === 42)) return 'image/tiff';
  return null;
}

export const SUPPORTED_IMAGE_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/webp']);
