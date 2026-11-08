// One-click quick preset (studio request): pick a template, choose a photo, and
// the app sets size → white background → face crop → light → 4R sheet with
// print brightening; then a single "چاپ" button. Uses the real local models.
import path from 'node:path';
import { launchBrowser, startServer, newPage, dismissOnboarding, root, outDir, assert } from './helpers.mjs';

const srv = await startServer(8871);
const browser = await launchBrowser();
const report = [];
try {
  const { page, log } = await newPage(browser, { viewport: { width: 1280, height: 900 } });
  await page.goto(`${srv.url}?e2e=1`);
  await page.waitForSelector('.shell');
  await dismissOnboarding(page);
  // Home: the 3×4 template card shows the engine's capacity for real 4R paper
  const card = page.locator('.quick-card').first();
  await card.waitFor();
  const cardText = await card.innerText();
  assert(cardText.includes('۴ عکس برای هر نفر') && cardText.includes('۱۰×۱۵'), `3×4 card shows 4 photos on 10×15 (${cardText})`);
  await page.screenshot({ path: path.join(outDir, 'quick-home.png') });
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), card.locator('.quick-main').click()]);
  await chooser.setFiles(path.join(root, 'tests/fixtures/astronaut.png'));
  // first import asks whether to keep originals
  const retain = page.locator('dialog.modal:has-text("عکس‌های اصلی ذخیره شوند")');
  await retain.waitFor({ timeout: 15000 });
  await retain.locator('.btn-primary').click();
  const t0 = Date.now();
  const ready = page.locator('dialog.modal:has(h2:text-is("آماده برای چاپ"))');
  await ready.waitFor({ timeout: 180000 });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const readyText = await ready.innerText();
  await page.screenshot({ path: path.join(outDir, 'quick-ready.png') });
  assert(readyText.includes('پس‌زمینه سفید شد'), 'white background really applied');
  assert(readyText.includes('کادر و اندازهٔ سر تنظیم شد'), 'face-based crop applied');
  assert(readyText.includes('۴ عکس') && readyText.includes('۱ برگهٔ'), `4 photos on 1 sheet (${readyText.slice(0, 200)})`);
  assert(readyText.includes('روشن‌سازی چاپ: متوسط'), 'print brightening shown');

  const st = await page.evaluate(() => {
    const h = window.__hoshmand; const s = h.getState(); const ph = Object.values(s.photos)[0];
    const l = h.sheet.computeSheetLayout(s);
    return {
      size: ph.edit.sizeId, profile: ph.edit.profileId, bg: ph.edit.bg, refine: ph.edit.bg.refine, crop: !!ph.edit.crop, exposure: ph.edit.adjust.exposure,
      sheet: { marks: s.project.sheet.marks, paperId: s.project.sheet.paperId, printBoost: s.project.sheet.printBoost, mode: s.project.sheet.mode, items: s.project.sheet.items.map((i) => i.copies), fill: s.project.sheet.fillOrder },
      layout: { ok: l.ok, cap: l.capacity, orient: l.orientation, w: l.sheet.widthMm, h: l.sheet.heightMm, sheets: l.totals.sheets, placed: l.totals.placed },
    };
  });
  assert(st.size === '3x4' && st.profile === 'generic-3x4', 'size + profile');
  assert(st.bg.enabled && st.bg.mode === 'color' && st.bg.color === '#ffffff', 'white colour background enabled');
  assert(st.crop, 'crop set');
  assert(st.sheet.marks.borders === true && st.sheet.marks.borderWidth === 0.1, `border on in the built-in template (${JSON.stringify(st.sheet.marks)})`);
  assert(st.refine.feather === 1 && st.refine.edgeAware === true && st.refine.shift === 0 && Math.abs(st.refine.softness - 0.4) < 1e-9, `edge feather 1 px by default (${JSON.stringify(st.refine)})`);
  assert(st.sheet.paperId === '4x6in' && st.sheet.printBoost === 'medium' && st.sheet.mode === 'exact' && st.sheet.fill === 'col-ltr', `sheet ${JSON.stringify(st.sheet)}`);
  assert(JSON.stringify(st.sheet.items) === '[4]', '4 photos for the person');
  assert(st.layout.ok && st.layout.cap === 8 && st.layout.placed === 4 && st.layout.orient === 'landscape' && st.layout.w === 152.4 && st.layout.h === 101.6, `layout ${JSON.stringify(st.layout)}`);

  // Print output: brightening lifts the face but the white background stays pure white
  const tone = await page.evaluate(async () => {
    const h = window.__hoshmand; const s = h.getState(); const l = h.sheet.computeSheetLayout(s);
    const measure = async (state) => {
      const a = await h.sheet.renderSheetAssets(state, l, null);
      const blob = [...a.byItem.values()][0].blob;
      const bmp = await createImageBitmap(blob);
      const c = new OffscreenCanvas(bmp.width, bmp.height); const cx = c.getContext('2d');
      cx.drawImage(bmp, 0, 0);
      const d = cx.getImageData(0, 0, bmp.width, bmp.height).data;
      const px = (x, y) => { const i = (y * bmp.width + x) * 4; return [d[i], d[i + 1], d[i + 2]]; };
      // centre region (face) mean luma
      let sum = 0; let n = 0;
      for (let y = Math.round(bmp.height * 0.35); y < bmp.height * 0.55; y += 2) {
        for (let x = Math.round(bmp.width * 0.4); x < bmp.width * 0.6; x += 2) { const [r, g, b] = px(x, y); sum += 0.2126 * r + 0.7152 * g + 0.0722 * b; n += 1; }
      }
      h.sheet.releaseAssets(a);
      return { corner: px(3, 3), face: sum / n, w: bmp.width, hgt: bmp.height };
    };
    const boosted = await measure(s);
    const off = await measure({ ...s, project: { ...s.project, sheet: { ...s.project.sheet, printBoost: 'off' } } });
    return { boosted, off };
  });
  assert(tone.boosted.w === 354 && tone.boosted.hgt === 472, `3×4 at 300 DPI = 354×472 px (${tone.boosted.w}×${tone.boosted.hgt})`);
  assert(tone.boosted.corner.every((v) => v >= 252) && tone.off.corner.every((v) => v >= 252), `white background corner stays white ${tone.boosted.corner} / ${tone.off.corner}`);
  assert(tone.boosted.face > tone.off.face + 4, `face brighter for print (${tone.off.face.toFixed(1)} → ${tone.boosted.face.toFixed(1)})`);

  // One click: «چاپ» opens the print dialog with exactly one 4R landscape page of 8 photos
  await page.evaluate(() => { window.__printed = 0; window.print = () => { window.__printed += 1; }; });
  await ready.getByRole('button', { name: 'چاپ', exact: true }).click();
  await page.waitForFunction(() => window.__printed > 0, null, { timeout: 60000 });
  const printed = await page.evaluate(() => ({
    sheets: document.querySelectorAll('#print-root .print-sheet').length,
    imgs: document.querySelectorAll('#print-root .print-photo').length,
    size: [...document.adoptedStyleSheets].map((x) => [...x.cssRules].map((r) => r.cssText).join(' ')).join(' '),
  }));
  assert(printed.sheets === 1 && printed.imgs === 4, `print DOM ${JSON.stringify(printed)}`);
  // crop marks sit 0.5 mm outside the photos (in the white gap), not on the photo edge
  const guides = await page.evaluate(() => [...document.querySelectorAll('#print-root .marks-under line')].filter((l) => l.getAttribute('x1') === l.getAttribute('x2')).map((l) => Number(l.getAttribute('x1'))));
  assert(guides.some((x) => Math.abs(x - 12.7) < 1e-6) && guides.some((x) => Math.abs(x - 43.7) < 1e-6 || Math.abs(x - 44.7) < 1e-6) && !guides.some((x) => Math.abs(x - 13.2) < 1e-6), `crop marks offset into the white gap (${guides})`);
  assert(/size:\s*152\.4mm 101\.6mm/.test(printed.size), `@page size is 4R landscape (${printed.size})`);
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  await page.waitForTimeout(500);
  // full cut lines on: they surround only the 4 printed photos, the right half of the paper stays white
  await page.evaluate(() => window.__hoshmand.setState((s) => ({ ...s, project: { ...s.project, sheet: { ...s.project.sheet, marks: { ...s.project.sheet.marks, cutLines: true } } } })));
  await page.waitForTimeout(600);
  const cutX = await page.evaluate(() => [...document.querySelectorAll('.sheets .marks-under line')].filter((l) => l.getAttribute('stroke') === '#999').flatMap((l) => [Number(l.getAttribute('x1')), Number(l.getAttribute('x2'))]));
  assert(cutX.length > 0 && Math.max(...cutX) <= 76 && Math.min(...cutX) >= 12, `cut lines stay around the printed photos (x ${Math.min(...cutX)}..${Math.max(...cutX)} mm of 152.4)`);
  await page.screenshot({ path: path.join(outDir, 'quick-print-studio.png') });
  await page.evaluate(() => window.__hoshmand.setState((s) => ({ ...s, project: { ...s.project, sheet: { ...s.project.sheet, marks: { ...s.project.sheet.marks, cutLines: false } } } })));

  // Brightness test sheet: the same photo at off / low / medium / high, labelled
  await page.evaluate(() => { window.__printed = 0; });
  await page.getByRole('button', { name: 'برگهٔ آزمایش روشنایی' }).click();
  await page.waitForFunction(() => window.__printed > 0, null, { timeout: 60000 });
  const test = await page.evaluate(() => ({
    imgs: document.querySelectorAll('#print-root .print-photo').length,
    labels: [...document.querySelectorAll('#print-root .print-label')].map((e) => e.textContent),
  }));
  assert(test.imgs === 4, `4 test photos (${test.imgs})`);
  assert(['خاموش', 'کم', 'متوسط', 'زیاد'].every((w) => test.labels.some((t) => t.endsWith(w))), `labels ${test.labels}`);
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  // the real sheet is unchanged by the test
  const after = await page.evaluate(() => window.__hoshmand.getState().project.sheet.items.map((i) => i.copies));
  assert(JSON.stringify(after) === '[4]', 'test sheet does not alter the project sheet');

  // Mobile width: cards fit without horizontal scroll
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('nav.tabbar .rail-item[title="صفحه اصلی / شروع کار"]').click();
  await page.waitForTimeout(400);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert(overflow <= 1, `no horizontal scroll on phone (${overflow}px)`);
  await page.locator('.quick-section h3').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(outDir, 'quick-home-mobile.png') });

  assert(log.external.length === 0, `no external requests ${log.external}`);
  report.push(`PASS One-click 3×4 preset in ${secs}s — white background, face crop, 4 photos on 4R landscape (152.4×101.6 mm), print brightening medium (face ${tone.off.face.toFixed(1)} → ${tone.boosted.face.toFixed(1)}, white corner ${tone.boosted.corner.join(',')}), single print page (4 photos in the left two columns); brightness test sheet with 4 labelled levels`);
} finally {
  console.log(report.join('\n'));
  await browser.close();
  srv.stop();
}
