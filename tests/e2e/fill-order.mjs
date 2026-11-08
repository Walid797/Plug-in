// Studio request: fill the sheet column by column (1 top-left, 2 below it, 3 next
// column…), keeping full-sheet positions so a partial sheet leaves the unused paper
// in one piece. Also checks the preview-only order numbers never reach the print DOM.
import path from 'node:path';
import { launchBrowser, startServer, newPage, dismissOnboarding, importAndRetain, gotoSection, root, outDir, assert } from './helpers.mjs';

const srv = await startServer(8860);
const browser = await launchBrowser();
const report = [];
try {
  const { page, log } = await newPage(browser, { viewport: { width: 1280, height: 900 } });
  await page.goto(`${srv.url}?e2e=1`);
  await page.waitForSelector('.shell');
  await dismissOnboarding(page);
  await importAndRetain(page, [path.join(root, 'tests/fixtures/astronaut.png')]);
  await gotoSection(page, 'print');
  await page.waitForSelector('.sheet-item');
  await page.getByRole('button', { name: 'تعداد دقیق انتخابی' }).click();
  const inp = page.locator('.sheet-item .si-copies input');
  await inp.fill('۴');
  await inp.press('Enter');
  await page.waitForTimeout(1200);
  const order = await page.evaluate(() => [...document.querySelectorAll('.sheets .print-sheet')][0]
    .querySelectorAll('.order-badge').length);
  const pos = await page.evaluate(() => {
    const h = window.__hoshmand; const l = h.sheet.computeSheetLayout(h.getState());
    return { fill: h.getState().project.sheet.fillOrder, orientation: l.orientation, p: l.pages[0].placements.map((pl) => [pl.photo.x, pl.photo.y]) };
  });
  assert(pos.fill === 'col-ltr', `default fill order is column by column (${pos.fill})`);
  assert(JSON.stringify(pos.p) === JSON.stringify([[12, 9], [12, 51], [44, 9], [44, 51]]), `positions ${JSON.stringify(pos.p)}`);
  assert(order === 4, `4 order badges in preview (${order})`);
  await page.screenshot({ path: path.join(outDir, 'fill-order-4.png') });
  // print DOM must not contain the badges
  await page.evaluate(() => { window.print = () => {}; window.__hoshmand.sheet.runPrint(); });
  await page.waitForFunction(() => document.querySelectorAll('#print-root .print-sheet').length > 0, null, { timeout: 30000 });
  const badgesInPrint = await page.evaluate(() => document.querySelectorAll('#print-root .order-badge').length);
  assert(badgesInPrint === 0, 'order numbers are preview-only');
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  report.push(`PASS Column-by-column fill — 4 photos on 10×15 landscape at ${JSON.stringify(pos.p)} (mm); order numbers shown in preview only`);
  assert(log.external.length === 0, 'no external requests');
} finally {
  console.log(report.join('\n'));
  await browser.close();
  srv.stop();
}
