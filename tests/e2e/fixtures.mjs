// Generates synthetic test images with the local Chromium (no downloads) and
// a set of deliberately broken files for failure-handling tests.
import path from 'node:path';
import zlib from 'node:zlib';
import { promises as fs } from 'node:fs';
import { outDir, root } from './helpers.mjs';

function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td));
  return Buffer.concat([len, td, crc]);
}

export async function makeFixtures(browser) {
  const dir = path.join(outDir, 'fixtures');
  await fs.mkdir(dir, { recursive: true });
  const page = await browser.newPage();
  const make = async (name, w, h, type = 'image/jpeg') => {
    const b64 = await page.evaluate(async ({ w, h, type, name }) => {
      const c = new OffscreenCanvas(w, h);
      const x = c.getContext('2d');
      const g = x.createLinearGradient(0, 0, w, h);
      g.addColorStop(0, '#8fb3d9'); g.addColorStop(1, '#e8dcc8');
      x.fillStyle = g; x.fillRect(0, 0, w, h);
      // simple "person" silhouette for visual orientation checks
      x.fillStyle = '#2b3a55';
      x.beginPath(); x.ellipse(w / 2, h * 0.38, Math.min(w, h) * 0.16, Math.min(w, h) * 0.21, 0, 0, Math.PI * 2); x.fill();
      x.fillRect(w * 0.22, h * 0.62, w * 0.56, h * 0.38);
      x.fillStyle = '#c0392b'; x.fillRect(0, 0, w * 0.06, h * 0.06); // top-left marker
      x.fillStyle = '#111'; x.font = `${Math.round(Math.min(w, h) / 14)}px sans-serif`;
      x.fillText(`${name} ${w}x${h}`, w * 0.08, h * 0.08);
      const blob = await c.convertToBlob({ type, quality: 0.92 });
      const buf = new Uint8Array(await blob.arrayBuffer());
      let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      return btoa(s);
    }, { w, h, type, name });
    const file = path.join(dir, `${name}.${type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg'}`);
    await fs.writeFile(file, Buffer.from(b64, 'base64'));
    return file;
  };
  const out = {
    portrait: await make('portrait', 3000, 4000),
    landscape: await make('landscape', 4000, 3000),
    square: await make('square', 2000, 2000, 'image/png'),
    small: await make('small', 300, 400),
    webp: await make('webp-photo', 1200, 1600, 'image/webp'),
    astronaut: path.join(root, 'tests', 'fixtures', 'astronaut.png'),
    cat: path.join(root, 'tests', 'fixtures', 'chelsea-cat.png'),
  };
  await page.close();
  // broken inputs
  out.corrupt = path.join(dir, 'corrupt.jpg');
  await fs.writeFile(out.corrupt, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('this is not really a jpeg '.repeat(40))]));
  out.text = path.join(dir, 'notes.png');
  await fs.writeFile(out.text, '<script>alert(1)</script> not an image');
  out.heic = path.join(dir, 'iphone.heic');
  await fs.writeFile(out.heic, Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.alloc(64)]));
  out.gif = path.join(dir, 'anim.gif');
  await fs.writeFile(out.gif, Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1'));
  // PNG whose header claims 20000 × 20000 pixels (400 MP) — must be rejected before decoding
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(20000, 0); ihdr.writeUInt32BE(20000, 4); ihdr[8] = 8; ihdr[9] = 2;
  out.huge = path.join(dir, 'huge.png');
  await fs.writeFile(out.huge, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(Buffer.alloc(10))), pngChunk('IEND', Buffer.alloc(0))]));
  return out;
}
