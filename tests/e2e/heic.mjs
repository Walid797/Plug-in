// iPhone HEIC photos are converted on the device (libheif, WebAssembly) and imported like any other photo.
import path from 'node:path';
import { launchBrowser, startServer, newPage, dismissOnboarding, importAndRetain, root, assert } from './helpers.mjs';

const srv = await startServer(8873);
const browser = await launchBrowser();
try {
  const { page } = await newPage(browser, { viewport: { width: 1280, height: 900 } });
  await page.goto(`${srv.url}?e2e=1`);
  await page.waitForSelector('.shell');
  await dismissOnboarding(page);
  await importAndRetain(page, [path.join(root, 'tests/fixtures/sample.heic')]);
  await page.waitForFunction(() => Object.keys(window.__hoshmand.getState().photos).length === 1, null, { timeout: 30000 });
  const ph = await page.evaluate(() => { const p = Object.values(window.__hoshmand.getState().photos)[0]; return { name: p.name, width: p.width, height: p.height }; });
  assert(ph.width > 100 && ph.height > 100 && ph.width <= 400 && ph.height <= 400, `HEIC imported with its own size (${JSON.stringify(ph)})`);
  console.log('heic: OK', JSON.stringify(ph));
} finally { await browser.close(); srv.stop(); }
