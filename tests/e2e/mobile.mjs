// Mobile layouts (Chromium device emulation: Android phone, small iPhone-sized
// viewport, tablet). Real iOS Safari/WebKit is NOT available in this environment.
import path from 'node:path';
import { launchBrowser, startServer, newPage, dismissOnboarding, assert, gotoSection, importAndRetain, outDir, require } from './helpers.mjs';
import { makeFixtures } from './fixtures.mjs';

const { devices } = require('playwright');
const report = [];
const ok = (n, d = '') => report.push(`PASS ${n}${d ? ` — ${d}` : ''}`);
const browser = await launchBrowser();
const fx = await makeFixtures(browser);
const srv = await startServer(8805);
const targets = [
  ['Pixel 7', devices['Pixel 7']],
  ['iPhone SE (emulated in Chromium)', { ...devices['iPhone SE'], defaultBrowserType: undefined }],
  ['iPad Mini landscape', devices['iPad Mini landscape']],
];
try {
  for (const [name, dev] of targets) {
    const { defaultBrowserType, ...ctxOpts } = dev;
    void defaultBrowserType;
    const { context, page, log } = await newPage(browser, { viewport: dev.viewport, context: { ...ctxOpts, deviceScaleFactor: 1 } });
    await page.goto(srv.url);
    await page.waitForSelector('.shell');
    await dismissOnboarding(page);
    const slug = name.split(' ')[0].toLowerCase();
    await page.screenshot({ path: path.join(outDir, `mobile-${slug}-home.png`) });
    await importAndRetain(page, [fx.portrait]);
    await gotoSection(page, 'editor');
    await page.waitForTimeout(700);
    await page.screenshot({ path: path.join(outDir, `mobile-${slug}-editor.png`) });
    // touch pan on the canvas
    const canvas = page.locator('.photo-canvas');
    const box = await canvas.boundingBox();
    const before = await page.evaluate(() => JSON.stringify(document.querySelector('.photo-canvas') && 1));
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2 + 20, { steps: 4 });
    await page.mouse.up();
    void before;
    await gotoSection(page, 'print');
    await page.waitForSelector('.sheet-figure');
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(outDir, `mobile-${slug}-print.png`), fullPage: false });
    await gotoSection(page, 'settings');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert(overflow <= 1, `${name}: no horizontal page overflow (${overflow}px)`);
    const targetsSmall = await page.evaluate(() => [...document.querySelectorAll('nav:not([hidden]) .rail-item, .icon-btn')].filter((e) => e.offsetParent && (e.getBoundingClientRect().width < 32 || e.getBoundingClientRect().height < 32)).length);
    assert(log.external.length === 0, 'no external requests');
    ok(name, `${dev.viewport.width}×${dev.viewport.height}: home/editor/print usable, no horizontal overflow, ${targetsSmall} touch targets < 32px`);
    await context.close();
  }
} finally {
  console.log(report.join('\n'));
  await browser.close();
  srv.stop();
}
