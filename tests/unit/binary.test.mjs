import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import {
  crc32, parseJpegInfo, setJpegDpi, readJpegDpi, setPngDpi, readPngPhys, buildZip, sniffImageType,
} from '../../src/core/binary.js';

function minimalJpeg({ withJfif = true, w = 354, h = 472 } = {}) {
  const parts = [[0xff, 0xd8]];
  if (withJfif) parts.push([0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  else parts.push([0xff, 0xe1, 0, 8, 0x45, 0x78, 0x69, 0x66, 0, 0]); // Exif stub
  parts.push([0xff, 0xdb, 0, 4, 0, 0]); // dummy DQT
  parts.push([0xff, 0xc0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  parts.push([0xff, 0xda, 0, 2, 0xff, 0xd9]);
  return new Uint8Array(parts.flat());
}

function minimalPng(w = 2, h = 2) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  return new Uint8Array(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]));
}

function pngChunksValid(b) {
  const buf = Buffer.from(b);
  let o = 8; const types = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o);
    const type = buf.toString('latin1', o + 4, o + 8);
    const crc = buf.readUInt32BE(o + 8 + len);
    assert.equal(crc, zlib.crc32(buf.subarray(o + 4, o + 8 + len)), `CRC of ${type}`);
    types.push(type); o += 12 + len;
  }
  return types;
}

test('crc32 matches zlib', () => {
  const data = new TextEncoder().encode('هوشمند فوتو استودیو 123');
  assert.equal(crc32(data), zlib.crc32(Buffer.from(data)));
  assert.equal(crc32(new Uint8Array(0)), 0);
});

test('JPEG info and DPI patching (existing JFIF and inserted JFIF)', () => {
  const j = minimalJpeg();
  assert.deepEqual(parseJpegInfo(j), { width: 354, height: 472, components: 3, progressive: false });
  const p = setJpegDpi(j, 300);
  assert.deepEqual(readJpegDpi(p), { units: 1, x: 300, y: 300 });
  assert.equal(p.length, j.length);
  const ex = minimalJpeg({ withJfif: false });
  const p2 = setJpegDpi(ex, 600);
  assert.deepEqual(readJpegDpi(p2), { units: 1, x: 600, y: 600 });
  assert.deepEqual(parseJpegInfo(p2).width, 354);
  assert.throws(() => setJpegDpi(new Uint8Array([1, 2, 3]), 300));
});

test('PNG pHYs inserted after IHDR with valid CRCs; replaced not duplicated', () => {
  const png = minimalPng();
  const p = setPngDpi(png, 300);
  assert.deepEqual(pngChunksValid(p), ['IHDR', 'pHYs', 'IDAT', 'IEND']);
  assert.deepEqual(readPngPhys(p), { x: 11811, y: 11811, unit: 1 });
  const again = setPngDpi(p, 600);
  assert.deepEqual(pngChunksValid(again), ['IHDR', 'pHYs', 'IDAT', 'IEND']);
  assert.equal(readPngPhys(again).x, 23622);
});

test('store-only ZIP is structurally valid with UTF-8 Persian names', () => {
  const files = [
    { name: 'عکس-۱.jpg', data: new Uint8Array([1, 2, 3, 4]) },
    { name: 'برگه ۲.pdf', data: new TextEncoder().encode('%PDF-1.4 test') },
  ];
  const zip = Buffer.from(buildZip(files, new Date(2026, 10, 7, 12, 30, 10)));
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd > 0);
  assert.equal(zip.readUInt16LE(eocd + 10), 2);
  let cd = zip.readUInt32LE(eocd + 16);
  for (const f of files) {
    assert.equal(zip.readUInt32LE(cd), 0x02014b50);
    assert.ok(zip.readUInt16LE(cd + 8) & 0x0800, 'UTF-8 flag');
    const nameLen = zip.readUInt16LE(cd + 28);
    assert.equal(zip.toString('utf8', cd + 46, cd + 46 + nameLen), f.name);
    const local = zip.readUInt32LE(cd + 42);
    assert.equal(zip.readUInt32LE(local), 0x04034b50);
    const lNameLen = zip.readUInt16LE(local + 26);
    const dataStart = local + 30 + lNameLen;
    const size = zip.readUInt32LE(local + 18);
    assert.equal(zip.readUInt32LE(local + 14), zlib.crc32(zip.subarray(dataStart, dataStart + size)));
    assert.deepEqual(new Uint8Array(zip.subarray(dataStart, dataStart + size)), f.data);
    cd += 46 + nameLen;
  }
});

test('magic-byte sniffing ignores names and catches unsupported formats', () => {
  assert.equal(sniffImageType(minimalJpeg()), 'image/jpeg');
  assert.equal(sniffImageType(minimalPng()), 'image/png');
  const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
  assert.equal(sniffImageType(webp), 'image/webp');
  const heic = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]);
  assert.equal(sniffImageType(heic), 'image/heic');
  assert.equal(sniffImageType(new TextEncoder().encode('<script>alert(1)</script>')), null);
  assert.equal(sniffImageType(new Uint8Array([0x4d, 0x5a, 0x90, 0])), null); // EXE
});
