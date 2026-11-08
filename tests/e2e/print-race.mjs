// Regression for the Android report "only one column of photos appears on the sheet":
// a photo edit that changes while the print preview renders (here: an invalid stored
// mask being discarded) used to let an older render revoke the newer preview URL on
// slow devices, leaving blank slots. Runs 3 times on a 6x throttled CPU.
import path from 'node:path';
import { launchBrowser, startServer, newPage, dismissOnboarding, importAndRetain, gotoSection, root, outDir, assert } from './helpers.mjs';

const srv = await startServer(8841);
const browser = await launchBrowser();
const results = [];
try {
 for (let run = 1; run <= 3; run += 1) {
  const { page } = await newPage(browser, { viewport: { width: 980, height: 1400 } });
  await page.goto(`${srv.url}?e2e=1`);
  await page.waitForSelector('.shell');
  await dismissOnboarding(page);
  await importAndRetain(page, [path.join(root, 'tests/fixtures/astronaut.png')]);
  await gotoSection(page, 'background');
  await page.getByRole('button', { name: 'حذف پس‌زمینه', exact: true }).click();
  await page.waitForSelector('.toast.success:has-text("پس‌زمینه جدا شد")', { timeout: 90000 });
  await page.evaluate(async () => {
    const h = window.__hoshmand; const s = h.getState(); const ph = s.photos[s.selectedPhotoId];
    const c = new OffscreenCanvas(256, 256); const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, 256, 256);
    await h.db.putBlob(ph.maskKey, await c.convertToBlob({ type: 'image/png' }));
  });
  await page.waitForTimeout(1200);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
  await page.reload();
  await page.waitForSelector('.shell', { timeout: 60000 });
  await gotoSection(page, 'print');
  await page.waitForSelector('.sheet-figure', { timeout: 60000 });
  await page.waitForTimeout(8000);
  const imgs = await page.evaluate(() => [...document.querySelectorAll('.sheets .print-photo')].map((i) => `${(i.getAttribute('src') || 'NOSRC').slice(-5)}:${i.complete ? i.naturalWidth : 'loading'}`));
  const broken = imgs.filter((s) => s.endsWith(':0') || s.startsWith('NOSRC')).length;
  results.push(broken);
  await page.screenshot({ path: path.join(outDir, `print-race-${run}.png`) });
  await page.context().close();
  assert(imgs.length === 8 && broken === 0, `run ${run}: ${broken}/${imgs.length} preview photos failed to load (${imgs.join(' ')})`);
 }
 console.log(`PASS Print preview under slow CPU while the photo changes — 3 runs, broken images per run: ${results.join(', ')}`);
} finally {
  await browser.close();
  srv.stop();
}
