// Failure handling: bad/unsupported/huge files, missing & corrupted models,
// storage unavailable, storage full, export failure, persistence after reload.
import path from 'node:path';
import { launchBrowser, startServer, newPage, dismissOnboarding, assert, gotoSection, importAndRetain, outDir } from './helpers.mjs';
import { makeFixtures } from './fixtures.mjs';

const report = [];
const ok = (n, d = '') => report.push(`PASS ${n}${d ? ` — ${d}` : ''}`);
const browser = await launchBrowser();
const fx = await makeFixtures(browser);
const srv = await startServer(8803);
const toastText = (page) => page.locator('.toast').allTextContents().then((t) => t.join(' | '));

try {
  // 1. bad inputs mixed with a good one
  {
    const { context, page, log } = await newPage(browser);
    await page.goto(srv.url);
    await page.waitForSelector('.shell');
    await dismissOnboarding(page);
    await importAndRetain(page, [fx.corrupt, fx.text, fx.heic, fx.gif, fx.huge, fx.small]);
    await page.waitForTimeout(1200);
    const t = await toastText(page);
    assert(/خراب/.test(t), 'corrupt file message');
    assert(/HEIC/.test(t), 'HEIC message');
    assert(/پشتیبانی نمی‌شود/.test(t), 'unsupported message');
    assert(/مگاپیکسل/.test(t), 'oversized dimensions message');
    const queue = await page.locator('.queue-item').count();
    assert(queue === 1, `only the valid photo imported (${queue})`);
    assert(!log.errors.some((e) => e.startsWith('pageerror')), 'no uncaught exceptions');
    await page.screenshot({ path: path.join(outDir, 'fail-imports.png') });
    ok('Corrupt / unsupported / HEIC / GIF / 400 MP header', 'each rejected with a specific Persian message; valid file imported; no crash');
    // low resolution warning on the 300×400 photo
    await gotoSection(page, 'editor');
    const badge = await page.locator('.kv .badge').first().textContent();
    assert(/DPI/.test(badge), 'effective DPI badge');
    ok('Low-resolution warning', `300×400 px at 3×4 cm → ${badge.trim()} shown before export`);

    // 2. export failure (encoder refuses) → error, never a success message
    await page.evaluate(() => {
      const fail = () => Promise.reject(new Error('encode failed'));
      if (globalThis.OffscreenCanvas) OffscreenCanvas.prototype.convertToBlob = fail;
      HTMLCanvasElement.prototype.toBlob = function (cb) { cb(null); };
    });
    await page.locator('.toast button').evaluateAll((bs) => bs.forEach((b) => b.click()));
    await page.getByRole('button', { name: 'ذخیرهٔ فایل' }).click();
    await page.waitForSelector('.toast.error', { timeout: 20000 });
    const t2 = await toastText(page);
    assert(/ناموفق/.test(t2) && !/ساخته شد/.test(t2), 'export failure reported, no false success');
    ok('Export failure', 'encoder failure → «ساخت فایل خروجی ناموفق بود»; no success message');
    await context.close();
  }

  // 3. missing face model (404) and corrupted model (hash mismatch)
  {
    const { context, page } = await newPage(browser);
    await context.route('**/models/mediapipe/face_landmarker.task', (r) => r.fulfill({ status: 404, body: '' }));
    await page.goto(srv.url);
    await page.waitForSelector('.shell');
    await dismissOnboarding(page);
    await importAndRetain(page, [fx.astronaut]);
    await gotoSection(page, 'smart');
    assert(await page.getByRole('button', { name: 'تحلیل چهره' }).isDisabled(), 'analyse disabled when model missing');
    const reason = await page.locator('.notice').first().textContent();
    assert(/نصب نشده/.test(reason), `missing-model reason shown: ${reason}`);
    ok('Missing model', 'button disabled; Persian reason «نصب نشده» with link to settings; manual crop still available');
    await context.close();
  }
  {
    const { context, page } = await newPage(browser);
    await context.route('**/models/mediapipe/face_landmarker.task', (r) => r.fulfill({ status: 200, body: Buffer.alloc(4096, 7), contentType: 'application/octet-stream' }));
    await page.goto(srv.url);
    await page.waitForSelector('.shell');
    await dismissOnboarding(page);
    await importAndRetain(page, [fx.astronaut]);
    await gotoSection(page, 'smart');
    await page.getByRole('button', { name: 'تحلیل چهره' }).click();
    await page.waitForSelector('.toast.error', { timeout: 30000 });
    const t = await toastText(page);
    assert(/چکسام/.test(t), `hash mismatch reported: ${t}`);
    ok('Corrupted model file', 'SHA-256 mismatch detected before inference; Persian error');
    await context.close();
  }

  // 4. storage unavailable (private-mode-like) → memory mode, still usable
  {
    const { context, page } = await newPage(browser);
    await context.addInitScript(() => { Object.defineProperty(window, 'indexedDB', { get() { throw new DOMException('blocked', 'SecurityError'); } }); });
    await page.goto(srv.url);
    await page.waitForSelector('.shell');
    await dismissOnboarding(page);
    const state = await page.locator('.save-state').textContent();
    assert(/حافظهٔ موقت/.test(state), `memory mode shown: ${state}`);
    await importAndRetain(page, [fx.small]);
    assert(await page.locator('.queue-item').count() === 1, 'import still works without storage');
    ok('Storage unavailable', 'memory-only mode announced in Persian; editing still works');
    await context.close();
  }

  // 5. storage full while saving
  {
    const { context, page } = await newPage(browser);
    await page.goto(srv.url);
    await page.waitForSelector('.shell');
    await dismissOnboarding(page);
    await page.evaluate(() => {
      const orig = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...a) { if (window.__full) throw new DOMException('full', 'QuotaExceededError'); return orig.apply(this, a); };
      window.__full = true;
    });
    await importAndRetain(page, [fx.small]);
    await page.waitForTimeout(1500);
    const t = await toastText(page);
    assert(/فضای ذخیره‌سازی مرورگر پر است/.test(t), `quota message: ${t}`);
    ok('Storage full', 'QuotaExceededError → Persian guidance; app keeps working');
    await context.close();
  }

  // 6. persistence across reload (interrupted session)
  {
    const { context, page } = await newPage(browser);
    await page.goto(srv.url);
    await page.waitForSelector('.shell');
    await dismissOnboarding(page);
    await importAndRetain(page, [fx.portrait]);
    await gotoSection(page, 'editor');
    await page.locator('.chip', { hasText: '۵×۵ سانتی‌متر' }).click();
    const slider = page.locator('.slider').filter({ hasText: 'کنتراست' }).locator('input[type=range]');
    await slider.focus();
    for (let i = 0; i < 5; i += 1) await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(1500);
    await page.reload();
    await page.waitForSelector('.shell');
    await gotoSection(page, 'editor');
    const pressed = await page.locator('.chip[aria-pressed="true"]').first().textContent();
    const contrast = await page.locator('.slider').filter({ hasText: 'کنتراست' }).locator('output').textContent();
    assert(/۵×۵/.test(pressed), `size persisted: ${pressed}`);
    assert(contrast.trim() !== '۰', `contrast persisted: ${contrast}`);
    ok('Interrupted session', `after reload: size «${pressed.trim()}», contrast ${contrast.trim()} restored from local storage`);
    await context.close();
  }
} finally {
  console.log(report.join('\n'));
  await browser.close();
  srv.stop();
}
