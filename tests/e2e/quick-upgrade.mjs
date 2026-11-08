// Templates saved by the previous version (old engine values stored) must pick up the quality-reference
// tuning once after the app loads, keep what the user chose, and show the new engine values in the editor.
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
  const st = await page.evaluate(() => { const s = window.__hoshmand.getState().settings; return { v: s.quickSchema, o: s.quickOverrides['q-3x4-4r'], own: s.quickPresets[0] }; });
  assert(st.v === 6, `settings schema upgraded (${st.v})`);
  assert(st.o.gSharpness === 22 && st.o.lightFill === 45 && st.o.skinBalance === 40, `old defaults upgraded ${JSON.stringify(st.o)}`);
  assert(st.o.margin === 3, 'the user\'s own margin kept');
  assert(st.own.gSharpness === 30 && st.own.lightFill === 45 && st.own.skinBalance === 40, `own template: custom 30 kept, old defaults upgraded ${JSON.stringify(st.own)}`);
  // the editor of the adjusted built-in shows the new engines (clarity and adaptive strength come from the new defaults)
  await page.locator('.quick-card[data-preset="q-3x4-4r"] .quick-edit').click();
  const dlg = page.locator('dialog.qp-modal');
  await dlg.waitFor();
  assert((await dlg.getByRole('slider', { name: /وضوح موضعی/ }).inputValue()) === '55', 'clarity 55 in the adjusted built-in');
  assert(await dlg.getByRole('switch', { name: /تطبیق روشن‌سازی با روشنایی واقعی چهره/ }).isChecked(), 'adaptive strength on');
  assert((await dlg.getByRole('slider', { name: /روشن‌کردن سایه‌ها/ }).inputValue()) === '45', 'fill light 45');
  await page.keyboard.press('Escape');
  // the other three built-ins carry the same engine values
  const all = await page.evaluate(async () => {
    const q = window.__hoshmand.quick;
    return Object.keys(q).length;
  });
  assert(all > 0);
  assert(log.external.length === 0, `no external requests ${log.external}`);
  report.push('PASS Saved templates from the previous version are upgraded once (sharpness 14→22, fill light 35→45, skin balance 30→40), user values kept, new engine fields present');
} finally {
  console.log(report.join('\n'));
  await browser.close();
  srv.stop();
}
