// AI E2E: local face landmarks + segmentation on a public-domain portrait.
import path from 'node:path';
import { chromium, launchBrowser, startServer, newPage, dismissOnboarding, root, outDir, assert, gotoSection } from './helpers.mjs';

const srv = await startServer(8793);
const browser = await launchBrowser();
const results = {};
try {
  const { page, log } = await newPage(browser);
  await page.goto(srv.url);
  await page.waitForSelector('.shell');
  await dismissOnboarding(page);
  await page.locator('.dropzone input[type=file][multiple]').setInputFiles(path.join(root, 'tests/fixtures/astronaut.png'));
  await page.waitForTimeout(300);
  if (await page.locator('dialog.modal').count()) await page.locator('dialog.modal .btn-primary').click();
  await page.waitForTimeout(800);
  // Smart ID: analyse face
  await gotoSection(page, 'smart');
  await page.waitForTimeout(400);
  const t0 = Date.now();
  await page.getByRole('button', { name: 'تحلیل چهره' }).click();
  await page.waitForSelector('.quality li', { timeout: 60000 });
  results.faceMs = Date.now() - t0;
  results.quality = await page.locator('.quality li b').allTextContents();
  results.faceBackend = await page.evaluate(() => document.body.innerText.includes('WebGL') ? 'gpu?' : 'n/a');
  await page.screenshot({ path: path.join(outDir, 'ai-smart.png') });
  const acceptEnabled = await page.getByRole('button', { name: 'پذیرش پیشنهاد' }).isEnabled();
  results.suggestion = acceptEnabled;
  if (acceptEnabled) {
    await page.getByRole('button', { name: 'پذیرش پیشنهاد' }).click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(outDir, 'ai-smart-accepted.png') });
    results.qualityAfter = await page.locator('.quality li').evaluateAll((els) => els.map((e) => `${e.className}:${e.querySelector('b').textContent}`));
  }
  // Background: segment
  await gotoSection(page, 'background');
  await page.waitForTimeout(400);
  const t1 = Date.now();
  await page.getByRole('button', { name: 'حذف پس‌زمینه', exact: true }).click();
  await page.waitForSelector('text=جداسازی دوباره', { timeout: 90000 });
  results.segMs = Date.now() - t1;
  await page.waitForTimeout(1500);
  await page.locator('button.swatch[aria-label="آبی روشن"]').click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(outDir, 'ai-background.png') });
  await page.getByRole('button', { name: 'ماسک', exact: true }).click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(outDir, 'ai-mask.png') });
  // Smart ID again: with a person mask the shoulder check becomes available
  await gotoSection(page, 'smart');
  await page.waitForSelector('.quality li:has-text("دیده شدن شانه‌ها")', { timeout: 20000 });
  results.shoulders = await page.locator('.quality li:has-text("دیده شدن شانه‌ها")').getAttribute('class');
  await page.waitForSelector('.hint:has-text("از ماسک پس‌زمینه")', { timeout: 10000 });
  results.crownSource = await page.locator('.hint:has-text("بالای سر")').first().textContent();
  results.qualityWithMask = await page.locator('.quality li').evaluateAll((els) => els.map((e) => `${e.className}:${e.querySelector('b').textContent}`));
  // Settings: backend reported
  await gotoSection(page, 'settings');
  await page.waitForTimeout(500);
  results.models = await page.locator('.model .badge').allTextContents();
  results.errors = log.errors.filter((e) => !e.includes('404'));
  results.external = log.external;
  console.log(JSON.stringify(results, null, 1));
  assert(results.quality.length > 3, 'quality checklist rendered');
  assert(results.external.length === 0, 'no external requests');
} finally {
  await browser.close();
  srv.stop();
}
