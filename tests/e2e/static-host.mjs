// Static-host simulation (like Render): serve ./public with a plain static
// server that sends NO special headers, and check that the service worker makes
// the app cross-origin isolated, the local AI works and nothing leaks out.
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { launchBrowser, newPage, dismissOnboarding, assert, gotoSection, importAndRetain, root, outDir } from './helpers.mjs';

const report = [];
const ok = (n, d = '') => report.push(`PASS ${n}${d ? ` — ${d}` : ''}`);
spawnSync(process.execPath, [path.join(root, 'tools', 'publish-static.mjs')], { stdio: 'inherit' });
const port = 8820;
const srv = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1', '--directory', path.join(root, 'public')], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1200));
const browser = await launchBrowser();
try {
  const { page, log } = await newPage(browser);
  const url = `http://127.0.0.1:${port}/`;
  const first = await page.goto(url);
  assert(!first.headers()['cross-origin-embedder-policy'], 'host sends no COEP header (simulated static host)');
  await page.waitForSelector('.shell');
  await dismissOnboarding(page);
  const isolatedFirst = await page.evaluate(() => crossOriginIsolated);
  await page.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 30000 });
  await page.reload();
  await page.waitForSelector('.shell');
  const isolatedSecond = await page.evaluate(() => crossOriginIsolated);
  assert(isolatedSecond, 'cross-origin isolated after the service worker takes over');
  ok('Cross-origin isolation via service worker', `first visit ${isolatedFirst}, after SW ${isolatedSecond}`);
  for (const p of ['package.json', 'src/main.jsx', 'tests/unit/layout.test.mjs', 'server/serve.mjs', 'node_modules/preact/package.json', '.git/config']) {
    const r = await page.request.get(url + p);
    assert(r.status() === 404, `${p} is not published (${r.status()})`);
  }
  ok('Only runtime files published', 'source, tests, server, node_modules and .git are absent');
  await importAndRetain(page, [path.join(root, 'tests/fixtures/astronaut.png')]);
  await gotoSection(page, 'smart');
  await page.getByRole('button', { name: 'تحلیل چهره' }).click();
  await page.waitForSelector('.quality li', { timeout: 60000 });
  await gotoSection(page, 'print');
  await page.waitForSelector('.sheet-figure');
  await page.getByRole('button', { name: 'PDF با اندازهٔ دقیق' }).click();
  await page.waitForSelector('dialog.modal');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('dialog.modal .btn-primary').click()]);
  await dl.saveAs(path.join(outDir, 'static-host.pdf'));
  await page.screenshot({ path: path.join(outDir, 'static-host.png') });
  assert(log.external.length === 0, 'no external requests');
  ok('App on a plain static host', 'face AI, print layout and exact PDF work; 0 external requests');
} finally {
  console.log(report.join('\n'));
  await browser.close();
  srv.kill();
}
