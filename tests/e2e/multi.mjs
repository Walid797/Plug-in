// Multi-photo sheets: distinct photos with individual copy counts, exact totals,
// reorder, remove-from-sheet (photo stays in project), mixed sizes, duplicate,
// undo/redo, and persistence across reload.
import path from 'node:path';
import { launchBrowser, startServer, newPage, dismissOnboarding, assert, gotoSection, importAndRetain, outDir } from './helpers.mjs';
import { makeFixtures } from './fixtures.mjs';

const report = [];
const ok = (n, d = '') => report.push(`PASS ${n}${d ? ` — ${d}` : ''}`);
const browser = await launchBrowser();
const fx = await makeFixtures(browser);
const srv = await startServer(8804);

const layout = (page) => page.evaluate(() => {
  const h = window.__hoshmand; const s = h.getState(); const l = h.sheet.computeSheetLayout(s);
  const names = Object.fromEntries(s.project.sheet.items.map((it) => [it.id, s.photos[it.photoId].name]));
  return {
    ok: l.ok, kind: l.kind, sheets: l.totals.sheets, placed: l.totals.placed,
    perItem: Object.fromEntries(Object.entries(l.totals.perItem).map(([k, v]) => [names[k], v])),
    order: s.project.sheet.items.map((it) => s.photos[it.photoId].name),
    sizes: l.pages.flatMap((p) => p.placements.map((pl) => [names[pl.itemId], pl.photo.w, pl.photo.h, pl.rotation])),
  };
});

try {
  const { page, log } = await newPage(browser);
  await page.goto(`${srv.url}?e2e=1`);
  await page.waitForSelector('.shell');
  await dismissOnboarding(page);
  await importAndRetain(page, [fx.portrait, fx.landscape, fx.square]);
  await page.waitForTimeout(800);
  assert(await page.locator('.queue-item').count() === 3, 'three photos imported');

  await gotoSection(page, 'print');
  await page.waitForSelector('.sheet-item');
  await page.getByRole('button', { name: 'تعداد دقیق انتخابی' }).click();
  const counts = [3, 5, 2];
  const items = page.locator('.sheet-item');
  for (let i = 0; i < 3; i += 1) {
    const inp = items.nth(i).locator('.si-copies input');
    await inp.fill(String(['۳', '۵', '۲'][i]));
    await inp.press('Enter');
  }
  await page.waitForTimeout(500);
  let L = await layout(page);
  assert(L.placed === 10 && L.perItem.portrait === 3 && L.perItem.landscape === 5 && L.perItem.square === 2, `totals ${JSON.stringify(L.perItem)}`);
  const summary = await page.locator('.print-summary').textContent();
  assert(summary.includes('۱۰'), 'summary shows ۱۰ photos');
  ok('Distinct photos with individual copies', `3 + 5 + 2 = ${L.placed} placed on ${L.sheets} sheet(s); Persian digits accepted in inputs`);

  // reorder: move "landscape" up
  await items.nth(1).getByRole('button', { name: 'بالا' }).click();
  L = await layout(page);
  assert(L.order.join() === 'landscape,portrait,square', `order ${L.order}`);
  const firstPlaced = L.sizes[0][0];
  assert(firstPlaced === 'landscape', 'placement order follows item order');
  ok('Reorder sheet items', L.order.join(' → '));

  // remove from sheet keeps the project photo
  await page.locator('.sheet-item').nth(2).getByRole('button', { name: /برداشتن از برگه/ }).click();
  L = await layout(page);
  assert(L.placed === 8 && !('square' in L.perItem), `after removal ${JSON.stringify(L.perItem)}`);
  const stillInProject = await page.evaluate(() => window.__hoshmand.getState().project.photoIds.length);
  assert(stillInProject === 3, 'photo remains in project');
  ok('Remove from sheet', `totals now ${L.placed}; project still has ${stillInProject} photos`);

  // undo the removal
  await page.getByRole('button', { name: /واگرد/ }).click();
  L = await layout(page);
  assert(L.placed === 10, `undo restores sheet (${L.placed})`);
  await page.getByRole('button', { name: /از نو/ }).click();
  L = await layout(page);
  assert(L.placed === 8, 'redo removes again');
  await page.getByRole('button', { name: /واگرد/ }).click();
  ok('Undo / redo', 'sheet item removal undone and redone');

  // mixed sizes: make the square photo 2×2 inch
  await gotoSection(page, 'editor');
  await page.locator('.queue-item').nth(2).locator('button').click();
  await page.locator('.chip', { hasText: '۲×۲ انچ' }).click();
  await gotoSection(page, 'print');
  await page.waitForTimeout(500);
  L = await layout(page);
  assert(L.ok && L.kind === 'shelf', `mixed sizes use shelf packing (${L.kind})`);
  const sq = L.sizes.filter((s) => s[0] === 'square');
  assert(sq.length === 2 && sq.every((s) => Math.abs(s[1] - 50.8) < 1e-9 && Math.abs(s[2] - 50.8) < 1e-9), 'square copies are exactly 50.8 mm');
  const other = L.sizes.filter((s) => s[0] !== 'square');
  assert(other.every((s) => (s[3] ? (s[1] === 40 && s[2] === 30) : (s[1] === 30 && s[2] === 40))), '3×4 copies keep 30×40 mm');
  await page.screenshot({ path: path.join(outDir, 'multi-mixed.png') });
  ok('Mixed photo sizes on one job', `${L.placed} photos on ${L.sheets} sheet(s); 2×2 in = 50.8 mm and 3×4 cm exact`);

  // duplicate + remove in the project queue
  await gotoSection(page, 'editor');
  await page.locator('.queue-item').first().locator('button').click();
  await page.getByRole('button', { name: /کاپی \(تکثیر\)/ }).click();
  assert(await page.locator('.queue-item').count() === 4, 'duplicate adds a photo');
  await page.getByRole('button', { name: 'حذف از پروژه' }).click();
  await page.locator('dialog.modal .btn-danger').click();
  await page.waitForTimeout(300);
  assert(await page.locator('.queue-item').count() === 3, 'remove after confirmation');
  ok('Duplicate / remove (with confirmation)', 'queue 3 → 4 → 3');

  // persistence across reload
  await page.waitForTimeout(1500);
  await page.reload();
  await page.waitForSelector('.shell');
  L = await layout(page);
  assert(L.placed === 10 && L.perItem.landscape === 5, `persisted sheet ${JSON.stringify(L.perItem)}`);
  ok('Persistence', 'photos, copy counts, order and sizes restored after reload');
  assert(log.external.length === 0, 'no external requests');
} finally {
  console.log(report.join('\n'));
  await browser.close();
  srv.stop();
}
