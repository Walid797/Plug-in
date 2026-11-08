// Offline acceptance: (A) internet blocked, (B) PWA/service worker with the local
// server STOPPED, (C) opened directly from disk (file://).
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { launchBrowser, startServer, newPage, dismissOnboarding, root, outDir, assert, gotoSection, importAndRetain } from './helpers.mjs';
import { makeFixtures } from './fixtures.mjs';

const report = [];
const ok = (n, d = '') => report.push(`PASS ${n}${d ? ` — ${d}` : ''}`);
const browser = await launchBrowser();
const fx = await makeFixtures(browser);

async function pdfRoundTrip(page, label) {
  await gotoSection(page, 'print');
  await page.waitForSelector('.sheet-figure', { timeout: 30000 });
  await page.getByRole('button', { name: 'PDF با اندازهٔ دقیق' }).click();
  await page.waitForSelector('dialog.modal');
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.locator('dialog.modal .btn-primary').click()]);
  const file = path.join(outDir, `offline-${label}.pdf`);
  await dl.saveAs(file);
  const head = (await fs.readFile(file)).subarray(0, 8).toString('latin1');
  assert(head.startsWith('%PDF-1.4'), `${label}: valid PDF`);
}

try {
  // ---------------- (A) internet blocked at the network layer ----------------
  {
    const srv = await startServer(8801);
    const { context, page, log } = await newPage(browser);
    const blocked = [];
    await context.route('**/*', (route) => {
      const u = route.request().url();
      if (u.startsWith('http://127.0.0.1:8801/')) return route.continue();
      blocked.push(u);
      return route.abort('internetdisconnected');
    });
    await page.goto(srv.url);
    await page.waitForSelector('.shell');
    await dismissOnboarding(page);
    await importAndRetain(page, [fx.portrait]);
    await gotoSection(page, 'editor');
    await page.locator('.slider').filter({ hasText: 'روشنایی' }).locator('input[type=range]').focus();
    await page.keyboard.press('ArrowRight');
    await page.getByRole('button', { name: 'بازنشانی کادر' }).click();
    await page.getByRole('button', { name: 'بزرگ‌نمایی', exact: true }).click();
    await pdfRoundTrip(page, 'blocked');
    assert(blocked.length === 0, `requests to the internet: ${blocked.join(', ')}`);
    assert(log.external.length === 0, 'no external request observed');
    ok('A. Internet blocked', 'import → edit → crop → print layout → exact PDF; 0 requests left the computer');
    await context.close();
    srv.stop();
  }

  // ---------------- (B) service worker, server stopped ----------------
  {
    const srv = await startServer(8802);
    const { context, page, log } = await newPage(browser);
    await page.goto(srv.url);
    await page.waitForSelector('.shell');
    await dismissOnboarding(page);
    await page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller, null, { timeout: 30000 }).catch(async () => {
      await page.reload(); await page.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 30000 });
    });
    await importAndRetain(page, [fx.astronaut]);
    // use the face model once so it is cached for offline use
    await gotoSection(page, 'smart');
    await page.getByRole('button', { name: 'تحلیل چهره' }).click();
    await page.waitForSelector('.quality li', { timeout: 60000 });
    const cached = await page.evaluate(async () => (await caches.keys()));
    srv.stop();
    await new Promise((r) => setTimeout(r, 500));
    await page.reload();
    await page.waitForSelector('.shell', { timeout: 20000 });
    const isolated = await page.evaluate(() => crossOriginIsolated);
    const count = await page.locator('.queue-item').count().catch(() => 0);
    await gotoSection(page, 'editor');
    const queue = await page.locator('.queue-item').count();
    assert(queue === 1, `project restored offline (${queue} photo)`);
    await gotoSection(page, 'smart');
    await page.getByRole('button', { name: 'تحلیل چهره' }).click();
    await page.waitForSelector('.quality li', { timeout: 60000 });
    await pdfRoundTrip(page, 'sw');
    await page.screenshot({ path: path.join(outDir, 'offline-sw.png') });
    ok('B. PWA with local server stopped', `caches ${JSON.stringify(cached)}; crossOriginIsolated=${isolated}; project restored; face AI and PDF export work offline`);
    void count; void log;
    await context.close();
  }

  // ---------------- (C) file:// ----------------
  {
    const { context, page, log } = await newPage(browser);
    await page.goto(`file://${path.join(root, 'index.html')}`);
    await page.waitForSelector('.shell', { timeout: 20000 });
    await dismissOnboarding(page);
    const font = await page.evaluate(async () => { await document.fonts.ready; return document.fonts.check('16px Vazirmatn'); });
    await importAndRetain(page, [fx.portrait]);
    await gotoSection(page, 'editor');
    await page.waitForTimeout(600);
    await pdfRoundTrip(page, 'file');
    await gotoSection(page, 'smart');
    const reason = await page.locator('.notice').first().textContent();
    assert(/file:\/\//.test(reason), 'AI disabled with Persian file:// reason');
    assert(await page.getByRole('button', { name: 'تحلیل چهره' }).isDisabled(), 'AI button disabled in file://');
    await gotoSection(page, 'settings');
    const storage = await page.locator('.caps dt:has-text("ذخیره‌سازی") + dd').textContent();
    await page.screenshot({ path: path.join(outDir, 'offline-file.png') });
    const errors = log.errors.filter((e) => !/404|net::ERR_FILE_NOT_FOUND/.test(e));
    assert(font, 'Vazirmatn font loaded from embedded data');
    ok('C. Opened from disk (file://)', `font ok; storage «${storage.trim()}»; import/edit/print/PDF ok; AI disabled with reason; errors ${JSON.stringify(errors)}`);
    await context.close();
  }
} finally {
  console.log(report.join('\n'));
  await browser.close();
}
