import path from 'node:path';
import { chromium, startServer, newPage, dismissOnboarding, root, outDir } from './helpers.mjs';

const srv = await startServer(8791);
const browser = await chromium.launch();
try {
  const { page, log } = await newPage(browser);
  await page.goto(srv.url);
  await page.waitForSelector('.shell', { timeout: 15000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(outDir, 'smoke-onboarding.png') });
  await dismissOnboarding(page);
  await page.screenshot({ path: path.join(outDir, 'smoke-home.png') });
  // retain dialog appears on first import
  const input = page.locator('.dropzone input[type=file][multiple]');
  await input.setInputFiles(path.join(root, 'tests/fixtures/astronaut.png'));
  await page.waitForTimeout(400);
  if (await page.locator('dialog.modal').count()) {
    await page.screenshot({ path: path.join(outDir, 'smoke-retain.png') });
    await page.locator('dialog.modal .btn-primary').click();
  }
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(outDir, 'smoke-editor.png') });
  for (const s of ['smart', 'background', 'clothing', 'print', 'templates', 'projects', 'settings']) {
    await page.evaluate((id) => { location.hash = id; }, s);
    await page.locator(`.rail-item[title]`).nth(['home','editor','smart','background','clothing','print','templates','projects','settings'].indexOf(s)).click();
    await page.waitForTimeout(900);
    await page.screenshot({ path: path.join(outDir, `smoke-${s}.png`) });
  }
  console.log('errors:', JSON.stringify(log.errors, null, 1));
  console.log('external requests:', JSON.stringify(log.external));
} finally {
  await browser.close();
  srv.stop();
}
