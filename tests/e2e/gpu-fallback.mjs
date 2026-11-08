// Regression for the Android report "says the background was removed, but it
// wasn't": mobile GPU paths can return EMPTY masks without any error, or throw
// "No full support of FP16". Both are simulated here; the app must fall back to
// the CPU and only report success for a real person/background split.
import path from 'node:path';
import { launchBrowser, startServer, newPage, dismissOnboarding, assert, gotoSection, importAndRetain, root, outDir } from './helpers.mjs';

const report = [];
const ok = (n, d = '') => report.push(`PASS ${n}${d ? ` — ${d}` : ''}`);
const browser = await launchBrowser();
const srv = await startServer(8831);

const SIMULATIONS = {
  // GPU masks read back as zeros (no error) — exactly the reported symptom
  emptyMasks: () => {
    let V;
    Object.defineProperty(window, 'Vision', {
      configurable: true,
      get: () => V,
      set: (v) => {
        V = v;
        const proto = v?.MPMask?.prototype;
        if (proto && !proto.__patched) {
          const orig = proto.getAsFloat32Array;
          proto.getAsFloat32Array = function () {
            const a = orig.call(this);
            return this.hasWebGLTexture() && !window.__cpuRun ? new Float32Array(a.length) : a;
          };
          proto.__patched = true;
        }
      },
    });
  },
  // GPU without float render targets → "No full support of FP16 on this GPU"
  noFp16: () => {
    for (const C of [WebGL2RenderingContext, WebGLRenderingContext]) {
      const orig = C.prototype.getExtension;
      C.prototype.getExtension = function (n) { return /color_buffer_(half_)?float|texture_float_linear/i.test(n) ? null : orig.call(this, n); };
      const sup = C.prototype.getSupportedExtensions;
      C.prototype.getSupportedExtensions = function () { return (sup.call(this) || []).filter((n) => !/color_buffer_(half_)?float|texture_float_linear/i.test(n)); };
    }
  },
};

async function runCase(name, sim, delegate) {
  const { context, page, log } = await newPage(browser);
  if (sim) await context.addInitScript(SIMULATIONS[sim]);
  await page.goto(srv.url);
  await page.waitForSelector('.shell');
  await dismissOnboarding(page);
  await gotoSection(page, 'settings');
  const labels = { auto: 'خودکار (پایدار)', gpu: 'کارت گرافیک (GPU)', cpu: 'پردازنده (CPU)' };
  await page.getByRole('button', { name: labels[delegate], exact: true }).click();
  await gotoSection(page, 'home');
  await importAndRetain(page, [path.join(root, 'tests/fixtures/astronaut.png')]);
  await gotoSection(page, 'background');
  await page.locator('.toast button').evaluateAll((bs) => bs.forEach((b) => b.click()));
  await page.getByRole('button', { name: 'حذف پس‌زمینه', exact: true }).click();
  await page.waitForSelector('.toast.success:has-text("پس‌زمینه جدا شد"), .toast.error', { timeout: 90000 });
  const t = (await page.locator('.toast').allTextContents()).join(' | ');
  assert(/پس‌زمینه جدا شد: حدود/.test(t), `${name}: real success expected, got: ${t}`);
  const pct = Number((/حدود ([۰-۹]+)٪/.exec(t) || [])[1]?.replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)));
  assert(pct > 5 && pct < 95, `${name}: plausible person share ${pct}%`);
  // the new background must really be visible: pick light blue and sample the wall above the head
  await page.locator('button.swatch[aria-label="آبی روشن"]').click();
  await page.waitForTimeout(1500);
  const blueShare = await page.evaluate(() => {
    const c = document.querySelector('.photo-canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let blue = 0; let total = 0;
    for (let y = Math.round(c.height * 0.06); y < c.height * 0.3; y += 6) {
      for (let x = Math.round(c.width * 0.25); x < c.width * 0.75; x += 6) {
        const i = (y * c.width + x) * 4;
        total += 1;
        if (Math.abs(d[i] - 207) < 25 && Math.abs(d[i + 1] - 227) < 25 && Math.abs(d[i + 2] - 245) < 25) blue += 1;
      }
    }
    return blue / total;
  });
  const px = [Math.round(blueShare * 100)];
  const isBlue = blueShare > 0.15;
  await page.screenshot({ path: path.join(outDir, `gpu-fallback-${name}.png`) });
  assert(isBlue, `${name}: new background visible in result (${px}% of the upper frame is the new blue)`);
  const backend = /مدل محلی، (WASM \(CPU\)|WebGL \(GPU\))/.exec(t)?.[1] || "?";
  ok(name, `success with ~${pct}% person; new light-blue background covers ${px}% of the upper frame; backend ${backend}${log.errors.some((e) => /FP16/.test(e)) ? '; GPU error caught' : ''}`);
  await context.close();
}

async function staleMaskCase() {
  const { context, page } = await newPage(browser);
  await page.goto(`${srv.url}?e2e=1`);
  await page.waitForSelector('.shell');
  await dismissOnboarding(page);
  await importAndRetain(page, [path.join(root, 'tests/fixtures/astronaut.png')]);
  await gotoSection(page, 'background');
  await page.getByRole('button', { name: 'حذف پس‌زمینه', exact: true }).click();
  await page.waitForSelector('.toast.success:has-text("پس‌زمینه جدا شد")', { timeout: 90000 });
  // overwrite the stored mask with an all-person mask, like the old failed run saved
  await page.evaluate(async () => {
    const h = window.__hoshmand; const s = h.getState(); const ph = s.photos[s.selectedPhotoId];
    const c = new OffscreenCanvas(256, 256); const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, 256, 256);
    if (!ph.maskKey) throw new Error('mask key missing');
    await h.db.putBlob(ph.maskKey, await c.convertToBlob({ type: 'image/png' }));
  });
  await page.waitForTimeout(1200);
  await page.reload();
  await page.waitForSelector('.shell');
  await gotoSection(page, 'background');
  await page.waitForSelector('.toast.warn', { timeout: 20000 });
  const t = (await page.locator('.toast').allTextContents()).join(' | ');
  assert(/نامعتبر بود/.test(t), `stale mask reported: ${t}`);
  const enabled = await page.evaluate(() => { const s = window.__hoshmand.getState(); return s.photos[s.selectedPhotoId].edit.bg.enabled; });
  assert(enabled === false, 'background replacement switched off for the invalid mask');
  ok('Stale invalid mask from an earlier failed run', 'detected on load, discarded, user told to run again');
  await context.close();
}

try {
  await staleMaskCase();
  await runCase('default (auto → CPU)', null, 'auto');
  await runCase('GPU returns empty masks → CPU retry', 'emptyMasks', 'gpu');
  await runCase('GPU throws "No FP16" → CPU retry', 'noFp16', 'gpu');
} finally {
  console.log(report.join('\n'));
  await browser.close();
  srv.stop();
}
