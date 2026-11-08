// Studio request: all templates use the quality-reference values only. Templates and adjustments saved by the
// previous version are removed once on load (a backup is kept and can be downloaded or deleted).
import { launchBrowser, startServer, newPage, dismissOnboarding, assert } from './helpers.mjs';

const srv = await startServer(8875);
const browser = await launchBrowser();
const report = [];
try {
  const { page, log } = await newPage(browser, { viewport: { width: 1280, height: 900 } });
  await page.goto(`${srv.url}?e2e=1`);
  await page.waitForSelector('.shell');
  await dismissOnboarding(page);
  // pretend the previous version saved: an adjusted built-in (margin 3 chosen by the user) and an own template
  await page.evaluate(async () => {
    const h = window.__hoshmand; const s = h.getState().settings;
    // set through the app state so its own autosave writes it (a direct DB write would be overwritten)
    h.setState((st) => ({ ...st, settings: {
      ...s, quickSchema: 5, onboardingDone: true,
      quickOverrides: { 'q-3x4-4r': { photoId: '3x4', margin: 3, gSharpness: 14, lightFill: 35, skinBalance: 30, gBrightness: 8, gExposure: 7.5, cutLines: true, border: true } },
      quickPresets: [{ id: 'qp_old', nameFa: 'قالب قدیمی من', photoId: '3x4', perPerson: 'copies', copies: 4, gSharpness: 30, lightFill: 35, skinBalance: 30 }],
    } }));
  });
  await page.waitForTimeout(2500); // autosave
  await page.reload();
  await page.waitForSelector('.quick-card[data-preset="q-3x4-4r"]');
  const st = await page.evaluate(() => { const s = window.__hoshmand.getState().settings; return { v: s.quickSchema, o: s.quickOverrides, own: s.quickPresets, backup: s.quickBackup }; });
  assert(st.v === 7, `settings schema ${st.v}`);
  assert(Object.keys(st.o).length === 0 && st.own.length === 0, `saved templates and adjustments removed ${JSON.stringify([st.o, st.own])}`);
  assert(st.backup && st.backup.quickPresets.length === 1 && st.backup.quickOverrides['q-3x4-4r'].margin === 3 && st.backup.quickPresets[0].gSharpness === 30, 'backup holds exactly what was removed');
  // only the four factory templates, none marked as adjusted, carrying the reference values
  assert((await page.locator('.quick-card[data-preset]').count()) === 4, 'four ready-made templates');
  assert((await page.locator('.quick-card .quick-tag').count()) === 0, 'no adjusted / own tags');
  await page.locator('.quick-card[data-preset="q-3x4-4r"] .quick-edit').click();
  const dlg = page.locator('dialog.qp-modal');
  await dlg.waitFor();
  assert((await dlg.getByRole('slider', { name: /وضوح موضعی/ }).inputValue()) === '55', 'clarity 55');
  assert((await dlg.getByRole('slider', { name: /روشن‌کردن سایه‌ها/ }).inputValue()) === '45', 'fill light 45');
  assert((await dlg.getByLabel('حاشیهٔ بیرونی', { exact: true }).inputValue()) === '۵', 'the old margin 3 is gone: factory margin 5');
  await page.keyboard.press('Escape');
  // Templates view: the notice with the backup, which can be downloaded and deleted
  await page.locator('nav.rail .rail-item[title="قالب‌های ذخیره‌شده"]').click();
  await page.waitForSelector('#quick-presets');
  const notice = page.locator('#quick-presets .notice', { hasText: 'مقدارهای مرجع کیفیت' });
  await notice.waitFor();
  const [dl] = await Promise.all([page.waitForEvent('download'), notice.getByRole('button', { name: 'دانلود پشتیبان' }).click()]);
  assert(/\.json$/.test(dl.suggestedFilename()), `backup file ${dl.suggestedFilename()}`);
  await notice.getByRole('button', { name: 'حذف پشتیبان' }).click();
  await page.locator('dialog.modal .modal-foot .btn-danger').click();
  await page.waitForTimeout(300);
  assert((await page.evaluate(() => window.__hoshmand.getState().settings.quickBackup)) === null, 'backup deleted on request');
  assert(log.external.length === 0, `no external requests ${log.external}`);
  report.push('PASS Saved templates/adjustments removed with a downloadable backup; only the four reference-valued ready-made templates remain');
} finally {
  console.log(report.join('\n'));
  await browser.close();
  srv.stop();
}
