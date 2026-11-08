// Manual repair brush (studio request: marks must disappear completely): paint on the Smart canvas,
// the stroke is stored in the edit, the canvas changes, undo / clear remove it again, and it survives a reload.
import path from 'node:path';
import { launchBrowser, startServer, newPage, dismissOnboarding, gotoSection, importAndRetain, root, assert } from './helpers.mjs';

const srv = await startServer(8877);
const browser = await launchBrowser();
try {
  const { page, log } = await newPage(browser, { viewport: { width: 1280, height: 900 } });
  await page.goto(`${srv.url}?e2e=1`);
  await page.waitForSelector('.shell');
  await dismissOnboarding(page);
  await importAndRetain(page, [path.join(root, 'tests/fixtures/astronaut.png')]);
  await gotoSection(page, 'smart');
  await page.waitForTimeout(800);
  const fixes = () => page.evaluate(() => { const s = window.__hoshmand.getState(); const p = s.photos[s.selectedPhotoId]; return (p.edit.face && p.edit.face.fixes) || []; });
  assert((await fixes()).length === 0, 'no strokes at start');

  const canvas = page.locator('.stage canvas').first();
  const before = await canvas.screenshot();
  await page.getByRole('button', { name: /فعال‌کردن قلم/ }).click();
  await page.getByRole('slider', { name: /اندازهٔ قلم/ }).fill('12');
  const box = await canvas.boundingBox();
  const cx = box.x + box.width * 0.5; const cy = box.y + box.height * 0.45;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 12, cy + 8, { steps: 4 });
  await page.mouse.move(cx + 24, cy + 10, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(700);
  const f1 = await fixes();
  assert(f1.length === 1 && f1[0].points.length >= 3 && f1[0].size > 0, `one stroke stored (${JSON.stringify(f1).slice(0, 120)})`);
  assert(f1[0].points.every(([x, y]) => x >= 0 && x <= 1 && y >= 0 && y <= 1), 'stroke points are normalised to the source');
  const after = await canvas.screenshot();
  assert(!before.equals(after), 'the canvas changed where the brush was used');

  // tap = single dot
  await page.mouse.click(cx - 60, cy + 40);
  await page.waitForTimeout(300);
  assert((await fixes()).length === 2, 'a tap also paints');

  // survives a reload (autosave)
  await page.waitForTimeout(2500);
  await page.reload();
  await page.waitForSelector('.shell');
  await page.waitForTimeout(800);
  const kept = await page.evaluate(() => { const s = window.__hoshmand.getState(); const p = Object.values(s.photos)[0]; return p && p.edit.face && p.edit.face.fixes ? p.edit.face.fixes.length : -1; });
  assert(kept === 2, `strokes kept after reload (${kept})`);

  await gotoSection(page, 'smart');
  await page.getByRole('button', { name: 'برداشتن آخرین ضربه' }).click();
  await page.waitForTimeout(200);
  assert((await fixes()).length === 1, 'last stroke removed');
  await page.getByRole('button', { name: 'پاک‌کردن همهٔ ضربه‌ها' }).click();
  await page.waitForTimeout(500);
  assert((await fixes()).length === 0, 'all strokes cleared');
  const real = log.errors.filter((l) => !/404|favicon|WebGL|GPU|net::ERR/i.test(l));
  assert(!real.length, `no page errors ${real.join(' | ').slice(0, 300)}`);
  assert(log.external.length === 0, `no external requests ${log.external}`);
  console.log('heal-brush: OK');
} finally { await browser.close(); srv.stop(); }
