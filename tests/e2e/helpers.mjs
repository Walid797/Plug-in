// Shared Playwright helpers for the E2E suite (uses the preinstalled Playwright).
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';

export const require = createRequire(import.meta.url);
export const { chromium } = require('playwright');
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const outDir = path.join(root, 'tests', 'e2e', 'out');

export async function startServer(port = 8791) {
  await fs.mkdir(outDir, { recursive: true });
  const proc = spawn(process.execPath, [path.join(root, 'server', 'serve.mjs'), '--no-open', '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server start timeout')), 8000);
    proc.stdout.on('data', (d) => { if (String(d).includes('127.0.0.1')) { clearTimeout(t); resolve(); } });
    proc.on('exit', (c) => reject(new Error(`server exited ${c}`)));
  });
  return { url: `http://127.0.0.1:${port}/`, stop: () => proc.kill() };
}

/** New page that records console errors and every non-local network request. */
export async function newPage(browser, opts = {}) {
  const context = await browser.newContext({ viewport: opts.viewport || { width: 1440, height: 900 }, deviceScaleFactor: 1, locale: 'fa-AF', acceptDownloads: true, ...opts.context });
  const page = await context.newPage();
  const log = { errors: [], external: [], console: [] };
  page.on('pageerror', (e) => log.errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') log.errors.push(`console: ${m.text()}`); log.console.push(`${m.type()}: ${m.text()}`); });
  page.on('request', (r) => {
    const u = r.url();
    if (!/^(http:\/\/127\.0\.0\.1|file:|blob:|data:)/.test(u)) log.external.push(u);
  });
  return { context, page, log };
}

export async function dismissOnboarding(page) {
  for (let i = 0; i < 6; i += 1) {
    const btn = page.locator('dialog.modal .modal-foot .btn-primary');
    if (!(await btn.count())) break;
    await btn.first().click();
    await page.waitForTimeout(80);
  }
}

export async function importFiles(page, files) {
  const input = page.locator('input[type=file][multiple]').first();
  await input.setInputFiles(files);
}

export function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

const SECTION_TITLES = {
  home: 'صفحه اصلی / شروع کار', editor: 'ویرایش عکس', smart: 'اصلاح هوشمند عکس پرسنلی', background: 'حذف و تغییر پس‌زمینه',
  clothing: 'تغییر لباس با هوش مصنوعی', print: 'استودیوی چاپ', templates: 'قالب‌های ذخیره‌شده', projects: 'پروژه‌ها و تاریخچه', settings: 'تنظیمات و مدل‌های آفلاین',
};
export async function gotoSection(page, id) {
  const mobile = (page.viewportSize()?.width || 1440) <= 820;
  if (mobile && !['home', 'editor', 'smart', 'background', 'print'].includes(id)) {
    await page.locator('nav.tabbar button[aria-haspopup]').click();
    await page.locator(`.more-menu .rail-item[title="${SECTION_TITLES[id]}"]`).click();
  } else {
    await page.locator(`nav.${mobile ? 'tabbar' : 'rail'} .rail-item[title="${SECTION_TITLES[id]}"]`).click();
  }
  await page.waitForTimeout(350);
}

export async function importAndRetain(page, files, keep = true) {
  await page.locator('input[type=file][multiple]').first().setInputFiles(files);
  for (let i = 0; i < 20; i += 1) {
    await page.waitForTimeout(150);
    if (await page.locator('dialog.modal').count()) {
      await page.locator(`dialog.modal .modal-foot .btn${keep ? '.btn-primary' : ':not(.btn-primary)'}`).first().click();
      break;
    }
    if (await page.locator('.queue-item').count()) break;
  }
  await page.waitForSelector('.queue-item, .sheet-figure, .toast', { timeout: 20000 }).catch(() => {});
}

/** Chromium with a UTF-8 locale (otherwise Linux Chrome renames non-ASCII downloads to "download"). */
export function launchBrowser(opts = {}) {
  return chromium.launch({ ...opts, env: { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', ...(opts.env || {}) } });
}
