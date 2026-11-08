// A PC without a graphics card (studio report: WebGL2 «ندارد», AI stuck or failing). MediaPipe Tasks needs WebGL even
// on its CPU path, so the app must switch to the WebGL-free ONNX engine by itself and give the same result.
// Runs the one-click 3×4 preset twice on the same photo: normal browser (MediaPipe) and a browser with WebGL disabled.
import path from 'node:path';
import { launchBrowser, startServer, newPage, dismissOnboarding, root, outDir, assert } from './helpers.mjs';

const NO_GL = {
  args: ['--disable-gpu', '--disable-software-rasterizer', '--disable-webgl'],
  ignoreDefaultArgs: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader-webgl'],
};

async function oneClick(browser, label) {
  const { page, log, context } = await newPage(browser, { viewport: { width: 1280, height: 900 } });
  await page.goto(`${srv.url}?e2e=1`);
  await page.waitForSelector('.shell');
  await dismissOnboarding(page);
  const webgl2 = await page.evaluate(() => !!document.createElement('canvas').getContext('webgl2'));
  const card = page.locator('.quick-card').first();
  await card.waitFor();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), card.locator('.quick-main').click()]);
  await chooser.setFiles(path.join(root, 'tests/fixtures/astronaut.png'));
  const retain = page.locator('dialog.modal:has-text("عکس‌های اصلی ذخیره شوند")');
  await retain.waitFor({ timeout: 15000 });
  await retain.locator('.btn-primary').click();
  const t0 = Date.now();
  const ready = page.locator('dialog.modal:has(h2:text-is("آماده برای چاپ"))');
  await ready.waitFor({ timeout: 180000 });
  const secs = (Date.now() - t0) / 1000;
  const text = await ready.innerText();
  await page.screenshot({ path: path.join(outDir, `no-webgl-${label}.png`) });
  const st = await page.evaluate(() => {
    const h = window.__hoshmand; const s = h.getState(); const ph = Object.values(s.photos)[0];
    const f = h.media.getFace(ph.id);
    return {
      backends: { face: s.models['face-landmarker']?.backend, seg: s.models['selfie-multiclass']?.backend },
      lm: f?.landmarks ? f.landmarks.map((p) => [p.x, p.y]) : null,
      crop: ph.edit.crop, bg: ph.edit.bg.enabled,
    };
  });
  await context.close();
  return { webgl2, text, secs, st, log };
}

const srv = await startServer(8874);
const report = [];
let normal; let nogl;
try {
  const b1 = await launchBrowser();
  try { normal = await oneClick(b1, 'normal'); } finally { await b1.close(); }
  const b2 = await launchBrowser(NO_GL);
  try { nogl = await oneClick(b2, 'off'); } finally { await b2.close(); }

  assert(normal.webgl2 && !nogl.webgl2, `WebGL2 on in the normal run, off in the test run (${normal.webgl2}/${nogl.webgl2})`);
  assert(/^WASM/.test(normal.st.backends.face || ''), `normal run uses MediaPipe (${normal.st.backends.face})`);
  for (const k of ['face', 'seg']) assert(/ONNX WASM.*بدون گرافیک/.test(nogl.st.backends[k] || ''), `no-WebGL run uses the ONNX engine for ${k} (${nogl.st.backends[k]})`);
  for (const r of [normal, nogl]) {
    assert(r.text.includes('پس‌زمینه سفید شد'), 'white background applied');
    assert(r.text.includes('کادر و اندازهٔ سر تنظیم شد'), 'face-based crop applied');
    assert(!/WebGL|activeTexture|ناموفق/.test(r.text), `no failure shown (${r.text.slice(0, 300)})`);
    assert(r.log.external.length === 0, `no external requests ${r.log.external}`);
  }
  let err = 0;
  for (let i = 0; i < 478; i += 1) err += Math.abs(normal.st.lm[i][0] - nogl.st.lm[i][0]) + Math.abs(normal.st.lm[i][1] - nogl.st.lm[i][1]);
  err /= 956;
  assert(err < 0.003, `landmarks match MediaPipe (mean error ${err.toFixed(5)} of the image)`);
  const dc = Math.max(...['cx', 'cy', 'cw'].map((k) => Math.abs(normal.st.crop[k] - nogl.st.crop[k])));
  const dr = Math.abs(normal.st.crop.rotation - nogl.st.crop.rotation);
  assert(dc < 0.01 && dr < 0.75, `same crop (${JSON.stringify(normal.st.crop)} vs ${JSON.stringify(nogl.st.crop)})`);
  report.push(`PASS No WebGL (PC without a graphics card) — ONNX engine used automatically; one-click preset in ${nogl.secs.toFixed(1)}s (MediaPipe ${normal.secs.toFixed(1)}s); white background + face crop; landmarks differ from MediaPipe by ${(err * 100).toFixed(3)}% of the image; crop within ${(dc * 100).toFixed(2)}% of the frame and ${dr.toFixed(2)}° rotation`);
} finally {
  console.log(report.join('\n'));
  srv.stop();
}
