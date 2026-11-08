import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPdf, imageMatrix, layoutToPdfPages, calibrationMatrix } from '../../src/core/pdf.js';
import { computeLayout, computeMarks } from '../../src/core/layout.js';
import { mmToPt, ptToMm } from '../../src/core/units.js';

const dec = new TextDecoder('latin1');

/** Tiny structural PDF reader for verification (independent of the writer). */
function readPdf(bytes) {
  const text = dec.decode(bytes);
  const startxref = Number(/startxref\s+(\d+)/.exec(text)[1]);
  const xref = text.slice(startxref);
  assert.ok(xref.startsWith('xref'), 'startxref points at xref table');
  const [, , count] = /xref\n(\d+) (\d+)\n/.exec(xref);
  const entries = xref.split('\n').slice(2, 2 + Number(count));
  const offsets = entries.map((e) => Number(e.slice(0, 10)));
  for (let id = 1; id < offsets.length; id += 1) {
    assert.ok(text.startsWith(`${id} 0 obj`, offsets[id]), `xref offset for object ${id}`);
  }
  const pages = [...text.matchAll(/\/Type \/Page \/Parent[^]*?\/MediaBox \[([^\]]+)\]/g)].map((mm) => mm[1].split(' ').map(Number));
  const pageCount = Number(/\/Type \/Pages \/Kids \[[^\]]*\] \/Count (\d+)/.exec(text)[1]);
  const contents = [...text.matchAll(/<<  \/Length (\d+) >>\nstream\n/g)].map((mm) => text.substr(mm.index + mm[0].length, Number(mm[1])));
  return { text, pages, pageCount, contents };
}

test('page MediaBox equals exact paper size in points', () => {
  const pdf = buildPdf({ title: 'برگهٔ عکس', pages: [
    { widthPt: mmToPt(100), heightPt: mmToPt(150), content: '', images: [] },
    { widthPt: mmToPt(210), heightPt: mmToPt(297), content: '', images: [] },
  ], images: {} });
  const r = readPdf(pdf);
  assert.equal(r.pageCount, 2);
  assert.deepEqual(r.pages[0], [0, 0, 283.4646, 425.1969]);
  assert.ok(Math.abs(ptToMm(r.pages[1][2]) - 210) < 0.001);
  assert.ok(Math.abs(ptToMm(r.pages[1][3]) - 297) < 0.001);
  assert.ok(r.text.includes('/PrintScaling /None'));
  assert.ok(r.text.startsWith('%PDF-1.4'));
  assert.ok(r.text.trimEnd().endsWith('%%EOF'));
  // Persian title encoded as UTF-16BE with BOM
  assert.ok(r.text.includes('/Title <FEFF'));
});

function apply(mt, u, v) {
  return { x: mt[0] * u + mt[2] * v + mt[4], y: mt[1] * u + mt[3] * v + mt[5] };
}

test('image matrix maps the unit square exactly onto the placement rectangle', () => {
  const H = 150;
  const rect = { x: 12, y: 9, w: 30, h: 40 };
  const mt = imageMatrix(rect, H, 0);
  const bl = apply(mt, 0, 0); const tr = apply(mt, 1, 1);
  assert.ok(Math.abs(ptToMm(bl.x) - 12) < 1e-9);
  assert.ok(Math.abs(H - ptToMm(bl.y) - (9 + 40)) < 1e-9); // bottom edge
  assert.ok(Math.abs(ptToMm(tr.x) - 42) < 1e-9);
  assert.ok(Math.abs(H - ptToMm(tr.y) - 9) < 1e-9); // top edge
  // image top-left (u=0, v=1) lands at the rect's top-left
  const tl = apply(mt, 0, 1);
  assert.ok(Math.abs(ptToMm(tl.x) - 12) < 1e-9 && Math.abs(H - ptToMm(tl.y) - 9) < 1e-9);
});

test('rotated (90°) image matrix: photo top points right, footprint swaps w/h only', () => {
  const H = 150;
  const rect = { x: 10, y: 20, w: 40, h: 30 }; // footprint of a 30×40 photo rotated
  const mt = imageMatrix(rect, H, 90);
  const toMm = (p) => ({ x: ptToMm(p.x), y: H - ptToMm(p.y) });
  const imgTopLeft = toMm(apply(mt, 0, 1)); // image (left, top)
  const imgTopRight = toMm(apply(mt, 1, 1));
  const imgBottomLeft = toMm(apply(mt, 0, 0));
  // top edge of image is the right edge of the rect
  assert.ok(Math.abs(imgTopLeft.x - 50) < 1e-9 && Math.abs(imgTopLeft.y - 20) < 1e-9);
  assert.ok(Math.abs(imgTopRight.x - 50) < 1e-9 && Math.abs(imgTopRight.y - 50) < 1e-9);
  assert.ok(Math.abs(imgBottomLeft.x - 10) < 1e-9 && Math.abs(imgBottomLeft.y - 20) < 1e-9);
  // determinant magnitude = area → no distortion
  const det = Math.abs(mt[0] * mt[3] - mt[1] * mt[2]);
  assert.ok(Math.abs(det - mmToPt(40) * mmToPt(30)) < 1e-6);
});

test('layout → PDF pages: one PDF page per sheet, placements identical to layout', () => {
  const layout = computeLayout({ paper: { widthMm: 100, heightMm: 150 }, orientation: 'landscape', margins: { top: 5, right: 5, bottom: 5, left: 5 }, gap: { x: 2, y: 2 }, items: [{ id: 'a', widthMm: 30, heightMm: 40, copies: 11 }] });
  const pages = layoutToPdfPages(layout, { imageName: () => 'Im1', marks: (pg) => computeMarks(layout, pg, { cutLines: true, borders: true }) });
  assert.equal(pages.length, layout.pages.length);
  const fakeJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const pdf = buildPdf({ pages, images: { Im1: { width: 354, height: 472, colorSpace: 'DeviceRGB', filter: 'DCTDecode', data: fakeJpeg } } });
  const r = readPdf(pdf);
  assert.equal(r.pageCount, 2);
  for (const box of r.pages) {
    assert.ok(Math.abs(ptToMm(box[2]) - 150) < 0.001 && Math.abs(ptToMm(box[3]) - 100) < 0.001);
  }
  // Parse the image placements back out of the content streams and compare to layout.
  const content = r.text;
  const cms = [...content.matchAll(/q ([\d.\- ]+) cm \/Im1 Do Q/g)].map((mm) => mm[1].split(' ').map(Number));
  assert.equal(cms.length, 11);
  const all = layout.pages.flatMap((p) => p.placements);
  cms.forEach((mt, i) => {
    const pl = all[i];
    const x = ptToMm(mt[4]); const w = ptToMm(mt[0]); const h = ptToMm(mt[3]);
    const yTop = 100 - ptToMm(mt[5]) - h;
    assert.ok(Math.abs(x - pl.photo.x) < 0.001 && Math.abs(yTop - pl.photo.y) < 0.001);
    assert.ok(Math.abs(w - 30) < 0.001 && Math.abs(h - 40) < 0.001);
  });
});

test('calibration matrix scales about the page centre and offsets in mm', () => {
  assert.equal(calibrationMatrix(100, 150, { scaleX: 1, scaleY: 1 }), null);
  const c = calibrationMatrix(100, 150, { scaleX: 1.02, scaleY: 0.99, offsetXmm: 1, offsetYmm: 2 });
  const centre = apply(c, mmToPt(50), mmToPt(75));
  assert.ok(Math.abs(centre.x - mmToPt(51)) < 1e-9);
  assert.ok(Math.abs(centre.y - mmToPt(73)) < 1e-9); // +2 mm down = −2 mm in PDF y
});
