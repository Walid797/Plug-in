// AI enhancement with the real offline models: a small photo (512×512) goes through a one-click template and comes out
// rendered from its enhanced version (×4 upscaled; face restored when the optional GFPGAN model is in models/onnx/).
// Checks: the report is true to what happened, the enhanced version is stored and survives a reload, the original
// stays available, switching it off returns to the original, and nothing leaves the device.
import path from 'node:path';
import { existsSync } from 'node:fs';
import { launchBrowser, startServer, newPage, dismissOnboarding, importAndRetain, root, outDir, assert } from './helpers.mjs';

const hasGfpgan = existsSync(path.join(root, 'models/onnx/gfpgan-v1.4.onnx'));
const srv = await startServer(8874);
const browser = await launchBrowser();
try {
  const { page, log } = await newPage(browser, { viewport: { width: 1280, height: 900 } });
  await page.goto(`${srv.url}?e2e=1`);
  await page.waitForSelector('.shell');
  await dismissOnboarding(page);
  await importAndRetain(page, [path.join(root, 'tests/fixtures/astronaut.png')]);
  const models = await page.evaluate(async () => { for (let i = 0; i < 50 && window.__hoshmand.getState().models.realesr?.status === 'checking'; i += 1) await new Promise((r) => setTimeout(r, 100)); const m = window.__hoshmand.getState().models; return { up: m.realesr?.status, fr: m.gfpgan?.status }; });
  assert(models.up === 'available', `the upscaler ships with the app (${models.up})`);
  assert((models.fr === 'available') === hasGfpgan, `face model status matches the folder (${models.fr}, file ${hasGfpgan})`);
  const t0 = Date.now();
  const res = await page.evaluate(async () => {
    const h = window.__hoshmand; const ph0 = Object.values(h.getState().photos)[0];
    const sum = await h.quick.runQuickPreset('q-3x4-4r', [ph0.id], { openReady: false });
    const ph = h.getState().photos[ph0.id]; const r = sum.results[0];
    const pv = await h.media.getPreview(ph);
    const orig = await h.media.getOriginal(ph, { raw: true }); const used = await h.media.getOriginal(ph);
    return { enhance: r.enhance, err: r.enhanceError || null, relit: r.relit || null, enhanced: ph.enhanced, edit: ph.edit.enhance, face: ph.edit.face, dims: [ph.width, ph.height], pv: [pv.width, pv.height], origSize: orig.size, usedSize: used.size, usedType: used.type, issues: r.issues.map((q) => q.code) };
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  assert(!res.err, `no enhancement error (${res.err})`);
  const e = res.enhance;
  assert(e && e.scale === 4 && e.srcW === 512 && e.outW === 2048 && e.outH === 2048 && e.tiles >= 1, `512×512 upscaled ×4 (${JSON.stringify(e)})`);
  assert(e.restored === hasGfpgan, `face restoration ran exactly when its model is installed (${e.restored})`);
  if (hasGfpgan) assert(e.share > 0.3 && e.share <= 0.75, `restoration share follows the template's strength (${e.share})`);
  assert(res.enhanced?.key && res.enhanced.width === 2048 && res.enhanced.height === 2048 && res.edit?.enabled === true, 'enhanced version stored and switched on');
  assert(e.relit === true && res.enhanced.relit === true && res.face.relight?.enabled === true, 'the relight is baked into the enhanced version');
  assert(res.dims[0] === 512 && res.dims[1] === 512, 'the photo record keeps the original size');
  assert(res.usedSize !== res.origSize && res.usedType === 'image/jpeg', 'rendering reads the enhanced picture, the original file is kept as it was');
  assert(res.pv[0] > 512, `preview comes from the enhanced picture (${res.pv})`);

  // the detail is real: the same crop rendered from the enhanced version is sharper than from the original
  const sharp = await page.evaluate(async () => {
    const h = window.__hoshmand; const id = Object.keys(h.getState().photos)[0];
    const measure = async () => {
      const ph = h.getState().photos[id]; const pv = await h.media.getPreview(ph); const assets = await h.media.gatherAssets(ph, pv);
      const c = h.render.renderPhoto(ph.edit, assets, 600, 800, {}); const d = c.getContext('2d').getImageData(150, 200, 300, 400).data;
      let s = 0; for (let y = 1; y < 399; y += 1) for (let x = 1; x < 299; x += 1) { const i = (y * 300 + x) * 4 + 1; const lap = 4 * d[i] - d[i - 4] - d[i + 4] - d[i - 1200] - d[i + 1200]; s += lap * lap; }
      return s / (398 * 298);
    };
    const on = await measure();
    const { setEnhanceEnabled } = h.enhance; setEnhanceEnabled(id, false);
    const pvOff = await h.media.getPreview(h.getState().photos[id]); const off = await measure();
    setEnhanceEnabled(id, true);
    const pvOn = await h.media.getPreview(h.getState().photos[id]);
    return { on, off, pvOff: pvOff.width, pvOn: pvOn.width };
  });
  assert(sharp.pvOff === 512 && sharp.pvOn > 512, `switching the enhanced version off returns to the original (${sharp.pvOff}/${sharp.pvOn})`);
  assert(sharp.on > sharp.off * 1.3, `the enhanced render carries more fine detail (${sharp.on.toFixed(1)} vs ${sharp.off.toFixed(1)})`);
  await page.screenshot({ path: path.join(outDir, 'enhance.png') });

  // survives a reload (the field and the enhanced picture are stored locally; landmarks are not needed)
  await page.evaluate(() => window.__hoshmand.flushSave?.());
  await page.waitForTimeout(1200);
  await page.reload();
  await page.waitForSelector('.shell');
  const after = await page.evaluate(async () => {
    const h = window.__hoshmand; for (let i = 0; i < 60 && !Object.keys(h.getState().photos).length; i += 1) await new Promise((r) => setTimeout(r, 100));
    const ph = Object.values(h.getState().photos)[0]; if (!ph) return null;
    const pv = await h.media.getPreview(ph);
    return { enhanced: ph.enhanced, on: ph.edit.enhance?.enabled, pv: pv?.width };
  });
  assert(after && after.enhanced?.width === 2048 && after.on === true && after.pv > 512, `enhanced version still used after a reload (${JSON.stringify(after)})`);
  assert(log.external.length === 0, `no request left the device (${log.external.join(', ')})`);
  const errs = log.errors.filter((x) => !/404|XNNPACK|favicon|WebGL|GPU|net::ERR/i.test(x)); // the same harmless lines the other suites ignore (optional-model probe, TFLite info)
  assert(errs.length === 0, `no console errors (${errs.slice(0, 3).join(' | ')})`);
  console.log(`PASS AI enhancement in ${secs}s — 512×512 → 2048×2048 (${e.tiles} tiles, ${e.upscaleMs} ms)${hasGfpgan ? `, face restored in ${e.restoreMs} ms (share ${e.share.toFixed(2)})` : ', face model not installed (upscaling only)'}; relight baked; detail ${sharp.off.toFixed(0)} → ${sharp.on.toFixed(0)}; stored, kept after reload, original untouched, no network`);
} finally { await browser.close(); srv.stop(); }
