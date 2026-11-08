// Optional runtimes: (1) ONNX Runtime Web path with a TEST-ONLY model that has
// MODNet's I/O signature, installed through the in-app "install from file" flow;
// (2) generative clothing via a MOCK local companion that implements the
// AUTOMATIC1111 API subset the app uses. Neither proves real model quality.
import http from 'node:http';
import zlib from 'node:zlib';
import path from 'node:path';
import { launchBrowser, startServer, newPage, dismissOnboarding, root, outDir, assert, gotoSection, importAndRetain } from './helpers.mjs';

const report = [];
const ok = (n, d = '') => report.push(`PASS ${n}${d ? ` — ${d}` : ''}`);

function solidPng(w, h, rgb) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) raw.set(rgb, y * (w * 3 + 1) + 1 + x * 3);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const calls = [];
const mock = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.url === '/sdapi/v1/sd-models') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify([{ model_name: 'mock-inpainting' }])); return; }
  if (req.url === '/sdapi/v1/img2img' && req.method === 'POST') {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const j = JSON.parse(body);
      calls.push({ width: j.width, height: j.height, hasMask: typeof j.mask === 'string' && j.mask.startsWith('data:image/png'), prompt: j.prompt, denoise: j.denoising_strength });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ images: [solidPng(j.width, j.height, [30, 40, 70]).toString('base64')] }));
    });
    return;
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => mock.listen(7861, '127.0.0.1', r));

const srv = await startServer(8798);
const browser = await launchBrowser();
try {
  const { page, log } = await newPage(browser);
  await page.goto(srv.url);
  await page.waitForSelector('.shell');
  await dismissOnboarding(page);
  await importAndRetain(page, [path.join(root, 'tests/fixtures/astronaut.png')]);

  // ---- (1) ONNX Runtime Web with the test-only signature model ----
  await gotoSection(page, 'settings');
  const modnetCard = page.locator('.model').filter({ hasText: 'MODNet' });
  assert((await modnetCard.locator('.badge').first().textContent()).includes('نصب نشده'), 'MODNet reported missing before install');
  await modnetCard.locator('input[type=file]').setInputFiles(path.join(root, 'tests/fixtures/test-only-matting-signature.onnx'));
  await page.waitForSelector('text=نصب‌شده در مرورگر', { timeout: 15000 });
  ok('Model install from file', 'stored in browser storage; status → «نصب‌شده در مرورگر»; unknown checksum warned');
  await gotoSection(page, 'background');
  await page.getByLabel('مدل جداسازی').selectOption('modnet');
  const t0 = Date.now();
  await page.getByRole('button', { name: 'حذف پس‌زمینه', exact: true }).click();
  await page.waitForSelector('text=جداسازی دوباره', { timeout: 120000 });
  const ms = Date.now() - t0;
  await gotoSection(page, 'settings');
  const backend = await page.locator('.model').filter({ hasText: 'MODNet' }).locator('.badge').first().textContent();
  assert(/WASM|WebGPU/.test(backend), `ORT backend reported: ${backend}`);
  ok('ONNX Runtime Web inference', `${ms} ms incl. runtime+model load; backend «${backend.trim()}» (test-only model — pipeline check, not quality)`);
  // uninstall
  await page.locator('.model').filter({ hasText: 'MODNet' }).getByRole('button', { name: 'حذف از مرورگر' }).click();
  await page.waitForSelector('.model:has-text("MODNet") .badge:has-text("نصب نشده")', { timeout: 15000 });
  ok('Model uninstall', 'removed from browser storage');

  // ---- (2) mock local companion for generative clothing ----
  await gotoSection(page, 'clothing');
  await page.getByRole('button', { name: /^تشخیص (ناحیهٔ|دوبارهٔ) لباس$/ }).click();
  await page.waitForSelector('.toast:has-text("ناحیهٔ لباس با مدل محلی")', { timeout: 60000 });
  const genBtn = page.getByRole('button', { name: 'ساخت', exact: true });
  await page.getByLabel('استفاده از موتور محلی').check();
  assert(await genBtn.isDisabled(), 'generate disabled before connection test');
  const url = page.locator('input.ltr').first();
  await url.fill('https://api.example.com');
  await url.press('Tab');
  assert(await page.locator('text=فقط نشانی‌های همین کمپیوتر').count(), 'non-loopback URL rejected');
  await url.fill('http://127.0.0.1:7861');
  await url.press('Tab');
  await page.getByRole('button', { name: 'آزمایش اتصال' }).click();
  await page.waitForSelector('text=متصل است', { timeout: 10000 });
  await genBtn.click();
  await page.waitForSelector('button:has-text("پذیرش")', { timeout: 30000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(outDir, 'runtimes-companion.png') });
  assert(calls.length === 1 && calls[0].hasMask && calls[0].width % 8 === 0 && calls[0].height % 8 === 0, `companion request ${JSON.stringify(calls[0])}`);
  await page.getByRole('button', { name: 'پذیرش', exact: true }).click();
  assert(await page.locator('.stage-note.gold').count(), 'AI-edited notice shown');
  assert(await page.locator('.queue-flag.ai').count(), 'AI-edited flag in queue');
  ok('Generative clothing via mock local companion', `request ${calls[0].width}×${calls[0].height} with mask; result accepted; photo marked AI-edited`);
  // export file name carries the AI marker
  await gotoSection(page, 'editor');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'ذخیرهٔ فایل' }).click()]);
  assert(dl.suggestedFilename().includes('ویرایش-هوش-مصنوعی'), `AI marker in file name: ${dl.suggestedFilename()}`);
  ok('AI-edited export name', dl.suggestedFilename());
  const external = log.external.filter((u) => !u.startsWith('http://127.0.0.1:7861'));
  assert(external.length === 0, `no external requests (${external})`);
  report.push(`errors: ${JSON.stringify(log.errors.filter((e) => !/404|XNNPACK|ERR_CONNECTION|Failed to fetch/.test(e)))}`);
} finally {
  console.log(report.join('\n'));
  await browser.close();
  srv.stop();
  mock.close();
}
