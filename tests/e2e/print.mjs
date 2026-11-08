// Print accuracy E2E: preview/print DOM geometry vs. layout engine, browser
// print-to-PDF page count/size, app PDF export, raster sheet + photo export.
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { chromium, launchBrowser, startServer, newPage, dismissOnboarding, root, outDir, assert, gotoSection, importAndRetain } from './helpers.mjs';
import { makeFixtures } from './fixtures.mjs';

const PX_PER_MM = 96 / 25.4;
const PT_PER_MM = 72 / 25.4;
const report = [];
const ok = (name, detail = '') => { report.push(`PASS ${name}${detail ? ` — ${detail}` : ''}`); };

function readPdf(buf) {
  const text = buf.toString('latin1');
  const pages = [...text.matchAll(/\/Type \/Page\b(?!s)[^]*?\/MediaBox \[\s*([\d.\s-]+)\]/g)].map((m) => m[1].trim().split(/\s+/).map(Number));
  return { text, pages };
}

const srv = await startServer(8794);
const browser = await launchBrowser();
try {
  const fixtures = await makeFixtures(browser);
  const { page, log } = await newPage(browser);
  await page.goto(`${srv.url}?e2e=1`);
  await page.waitForSelector('.shell');
  await dismissOnboarding(page);
  await importAndRetain(page, [fixtures.portrait]);
  await page.waitForTimeout(600);
  await gotoSection(page, 'print');
  await page.waitForSelector('.sheet-figure');

  const setSheet = (patch) => page.evaluate((p) => {
    const h = window.__hoshmand;
    const s = h.getState();
    h.setState({ project: { ...s.project, sheet: { ...s.project.sheet, ...p, items: s.project.sheet.items.map((it) => ({ ...it, copies: p.copies ?? it.copies })) } } });
  }, patch);
  const layoutNow = () => page.evaluate(() => {
    const h = window.__hoshmand;
    const l = h.sheet.computeSheetLayout(h.getState());
    return { ok: l.ok, sheet: l.sheet, orientation: l.orientation, capacity: l.capacity, totals: l.totals, pages: l.pages.map((p) => p.placements.map((pl) => ({ ...pl.photo, rotation: pl.rotation }))) };
  });

  const cases = [
    { name: '10×15 auto, margins 5, gap 2, 8 copies', patch: { paperId: '10x15', orientation: 'auto', margins: { top: 5, right: 5, bottom: 5, left: 5 }, gap: { x: 2, y: 2 }, mode: 'exact', copies: 8, allowRotation: false }, expect: { orientation: 'landscape', sheets: 1, capacity: 8 } },
    { name: '10×15 portrait, 21 copies (pagination)', patch: { paperId: '10x15', orientation: 'portrait', mode: 'exact', copies: 21 }, expect: { orientation: 'portrait', sheets: 4, capacity: 6 } },
    { name: '10×15 portrait, margins 3 → 9 per sheet', patch: { paperId: '10x15', orientation: 'portrait', margins: { top: 3, right: 3, bottom: 3, left: 3 }, gap: { x: 2, y: 2 }, mode: 'fill' }, expect: { orientation: 'portrait', sheets: 1, capacity: 9 } },
    { name: '10×15 zero margins + rotation → 11', patch: { paperId: '10x15', orientation: 'portrait', margins: { top: 0, right: 0, bottom: 0, left: 0 }, gap: { x: 0, y: 0 }, mode: 'fill', allowRotation: true }, expect: { sheets: 1, capacity: 11 } },
    { name: 'A4 portrait, margins 10, gap 3, 30 copies', patch: { paperId: 'a4', orientation: 'portrait', margins: { top: 10, right: 10, bottom: 10, left: 10 }, gap: { x: 3, y: 3 }, mode: 'exact', copies: 30, allowRotation: false }, expect: { sheets: 1, capacity: 30 } },
    { name: 'A5 landscape, 12 copies', patch: { paperId: 'a5', orientation: 'landscape', margins: { top: 5, right: 5, bottom: 5, left: 5 }, gap: { x: 2, y: 2 }, mode: 'exact', copies: 12 }, expect: { orientation: 'landscape', sheets: 1 } },
  ];

  for (const c of cases) {
    await setSheet(c.patch);
    await page.waitForTimeout(400);
    const L = await layoutNow();
    assert(L.ok, `${c.name}: layout ok`);
    if (c.expect.orientation) assert(L.orientation === c.expect.orientation, `${c.name}: orientation ${L.orientation}`);
    if (c.expect.sheets) assert(L.totals.sheets === c.expect.sheets, `${c.name}: sheets ${L.totals.sheets}`);
    if (c.expect.capacity) assert(L.capacity === c.expect.capacity, `${c.name}: capacity ${L.capacity}`);

    // --- preview DOM geometry (same builder as print) ---
    const prev = await page.evaluate(() => [...document.querySelectorAll('.sheets .print-sheet')].map((sh) => {
      const sr = sh.getBoundingClientRect();
      const scale = sr.width / sh.offsetWidth;
      return { scale, photos: [...sh.querySelectorAll('.print-photo')].map((img) => { const r = img.getBoundingClientRect(); return { x: (r.left - sr.left) / scale, y: (r.top - sr.top) / scale, w: r.width / scale, h: r.height / scale }; }) };
    }));
    assert(prev.length === L.pages.length, `${c.name}: preview sheet count ${prev.length}`);
    let maxErr = 0;
    // on-screen preview is scaled: allow one rendered screen pixel of rounding
    const previewTol = Math.max(0.03, 1 / (Math.min(...prev.map((p) => p.scale)) * PX_PER_MM));
    prev.forEach((pg, i) => pg.photos.forEach((r, j) => {
      const e = L.pages[i][j];
      maxErr = Math.max(maxErr, Math.abs(r.x / PX_PER_MM - e.x), Math.abs(r.y / PX_PER_MM - e.y), Math.abs(r.w / PX_PER_MM - e.w), Math.abs(r.h / PX_PER_MM - e.h));
    }));
    assert(maxErr < previewTol, `${c.name}: preview geometry error ${maxErr} mm (tolerance ${previewTol})`);

    // --- print DOM in print media + Chromium print-to-PDF ---
    await page.evaluate(() => { window.print = () => {}; });
    const printing = page.evaluate(() => window.__hoshmand.sheet.runPrint());
    await page.waitForFunction(() => document.querySelectorAll('#print-root .print-sheet').length > 0, null, { timeout: 30000 });
    await page.emulateMedia({ media: 'print' });
    const pr = await page.evaluate(() => [...document.querySelectorAll('#print-root .print-sheet')].map((sh) => {
      const sr = sh.getBoundingClientRect();
      return { w: sr.width, h: sr.height, photos: [...sh.querySelectorAll('.print-photo')].map((img) => { const r = img.getBoundingClientRect(); return { x: r.left - sr.left, y: r.top - sr.top, w: r.width, h: r.height, done: img.complete && img.naturalWidth > 0 }; }) };
    }));
    let maxPrintErr = 0;
    pr.forEach((sh, i) => {
      assert(Math.abs(sh.w / PX_PER_MM - L.sheet.widthMm) < 0.02 && Math.abs(sh.h / PX_PER_MM - L.sheet.heightMm) < 0.02, `${c.name}: print sheet size`);
      sh.photos.forEach((r, j) => {
        const e = L.pages[i][j];
        assert(r.done, `${c.name}: photo image decoded`);
        maxPrintErr = Math.max(maxPrintErr, Math.abs(r.x / PX_PER_MM - e.x), Math.abs(r.y / PX_PER_MM - e.y), Math.abs(r.w / PX_PER_MM - e.w), Math.abs(r.h / PX_PER_MM - e.h));
      });
    });
    assert(maxPrintErr < 0.03, `${c.name}: print geometry error ${maxPrintErr} mm`);
    const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
    const parsed = readPdf(Buffer.from(pdf));
    assert(parsed.pages.length === L.totals.sheets, `${c.name}: browser print produced ${parsed.pages.length} pages, expected ${L.totals.sheets} (no blank pages)`);
    for (const box of parsed.pages) {
      const wmm = (box[2] - box[0]) / PT_PER_MM; const hmm = (box[3] - box[1]) / PT_PER_MM;
      assert(Math.abs(wmm - L.sheet.widthMm) < 0.5 && Math.abs(hmm - L.sheet.heightMm) < 0.5, `${c.name}: browser PDF page ${wmm.toFixed(2)}×${hmm.toFixed(2)} mm`);
    }
    await page.emulateMedia({ media: 'screen' });
    await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
    await printing;
    ok(c.name, `${L.totals.placed} photos / ${L.totals.sheets} sheet(s) ${L.sheet.widthMm}×${L.sheet.heightMm} mm, preview err ${maxErr.toExponential(1)} mm (≤1 screen px), print err ${maxPrintErr.toExponential(1)} mm, Chromium PDF pages ${parsed.pages.length}`);
    if (c === cases[0]) await page.screenshot({ path: path.join(outDir, 'print-10x15.png') });
    if (c === cases[3]) await page.screenshot({ path: path.join(outDir, 'print-rotated-11.png') });
  }

  // --- app PDF export via UI (exact page size, images placed once) ---
  await setSheet(cases[0].patch);
  await page.waitForTimeout(300);
  const L0 = await layoutNow();
  await page.getByRole('button', { name: 'PDF با اندازهٔ دقیق' }).click();
  await page.waitForSelector('dialog.modal');
  await page.screenshot({ path: path.join(outDir, 'print-preprint-dialog.png') });
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.locator('dialog.modal .btn-primary').click()]);
  const pdfPath = path.join(outDir, 'export-sheet.pdf');
  await dl.saveAs(pdfPath);
  const buf = await fs.readFile(pdfPath);
  const p = readPdf(buf);
  assert(p.pages.length === 1, 'app PDF page count');
  assert(Math.abs(p.pages[0][2] - 150 * PT_PER_MM) < 0.01 && Math.abs(p.pages[0][3] - 100 * PT_PER_MM) < 0.01, `app PDF MediaBox ${p.pages[0]}`);
  const draws = [...p.text.matchAll(/q ([\d.\- ]+) cm \/Im\d+ Do Q/g)].map((m) => m[1].split(' ').map(Number));
  assert(draws.length === L0.totals.placed, `app PDF draws ${draws.length}`);
  for (const [i, d] of draws.entries()) {
    const e = L0.pages[0][i];
    assert(Math.abs(d[0] / PT_PER_MM - 30) < 0.001 && Math.abs(d[3] / PT_PER_MM - 40) < 0.001, 'PDF photo size 30×40 mm');
    assert(Math.abs(d[4] / PT_PER_MM - e.x) < 0.001 && Math.abs(100 - d[5] / PT_PER_MM - d[3] / PT_PER_MM - e.y) < 0.001, 'PDF photo position');
  }
  const imgDims = [...p.text.matchAll(/\/Subtype \/Image \/Width (\d+) \/Height (\d+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
  assert(imgDims.length === 1 && imgDims[0][0] === 354 && imgDims[0][1] === 472, `embedded image ${JSON.stringify(imgDims)} (one image for 8 copies, 354×472 px @300DPI)`);
  assert(p.text.includes('/PrintScaling /None'), 'PrintScaling None');
  assert(/\.pdf$/.test(dl.suggestedFilename()) && /پروژهٔ/.test(dl.suggestedFilename()), `PDF name ${dl.suggestedFilename()}`);
  ok('App PDF export', `MediaBox ${p.pages[0].join(' ')} pt = 150×100 mm; 8 placements exact to 0.001 mm; 1 embedded 354×472 image`);
  const toast1 = await page.locator('.toast').last().textContent();
  assert(/ساخته شد/.test(toast1), 'success toast only after file');

  // --- raster sheet export ---
  const [dl2] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.getByRole('button', { name: 'تصویر برگه (JPEG)' }).click()]);
  const jpgPath = path.join(outDir, 'export-sheet.jpg');
  await dl2.saveAs(jpgPath);
  const jb = await fs.readFile(jpgPath);
  const sof = (() => { let o = 2; while (o < jb.length) { if (jb[o] !== 0xff) { o += 1; continue; } const m = jb[o + 1]; const len = jb.readUInt16BE(o + 2); if (m >= 0xc0 && m <= 0xc2) return { h: jb.readUInt16BE(o + 5), w: jb.readUInt16BE(o + 7) }; o += 2 + len; } return null; })();
  assert(sof.w === 1772 && sof.h === 1181, `sheet JPEG ${sof.w}×${sof.h}`);
  assert(jb[13] === 1 && jb.readUInt16BE(14) === 300, 'sheet JPEG JFIF 300 dpi');
  ok('Sheet JPEG export', `${sof.w}×${sof.h} px = 150×100 mm @300 DPI, JFIF density 300`);

  // --- single photo exports ---
  await gotoSection(page, 'editor');
  const [dl3] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.getByRole('button', { name: 'ذخیرهٔ فایل' }).click()]);
  const photoPath = path.join(outDir, 'export-photo.jpg');
  await dl3.saveAs(photoPath);
  const pb = await fs.readFile(photoPath);
  let o = 2; let dims = null;
  while (o < pb.length) { if (pb[o] !== 0xff) { o += 1; continue; } const m = pb[o + 1]; const len = pb.readUInt16BE(o + 2); if (m >= 0xc0 && m <= 0xc2) { dims = [pb.readUInt16BE(o + 7), pb.readUInt16BE(o + 5)]; break; } o += 2 + len; }
  assert(dims[0] === 354 && dims[1] === 472, `photo export ${dims}`);
  assert(/^portrait-۳x۴-۳?300dpi\.jpg$|^portrait-۳x۴-300dpi\.jpg$/.test(dl3.suggestedFilename()), `Persian-friendly file name: ${dl3.suggestedFilename()}`);
  ok('Single photo JPEG export', `${dims.join('×')} px (3×4 cm @300 DPI), file name: ${dl3.suggestedFilename()}`);

  // --- calibration PDF ---
  await gotoSection(page, 'settings');
  const [dl4] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.getByRole('button', { name: 'PDF کالیبراسیون' }).click()]);
  const calPath = path.join(outDir, 'calibration.pdf');
  await dl4.saveAs(calPath);
  const cb = readPdf(await fs.readFile(calPath));
  assert(Math.abs(cb.pages[0][2] - 210 * PT_PER_MM) < 0.01 && Math.abs(cb.pages[0][3] - 297 * PT_PER_MM) < 0.01, 'A4 calibration page');
  const sq = /([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+) re S/.exec(cb.text);
  assert(sq && Math.abs(Number(sq[3]) / PT_PER_MM - 100) < 0.001 && Math.abs(Number(sq[4]) / PT_PER_MM - 100) < 0.001, 'calibration square 100 mm');
  ok('Calibration PDF', 'A4 page, 100.000 × 100.000 mm square, 50 mm ruler');

  report.push(`errors: ${JSON.stringify(log.errors.filter((e) => !/404|XNNPACK/.test(e)))}`);
  report.push(`external requests: ${log.external.length}`);
  assert(log.external.length === 0, 'no external requests');
} finally {
  console.log(report.join('\n'));
  await browser.close();
  srv.stop();
}
