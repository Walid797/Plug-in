// Manual settings for one-click presets (studio request): adjust a built-in
// preset, keep it after reload, create an own preset, run it, then reset/delete
// from the Templates view. Also checks the editor on a phone-sized screen.
import path from 'node:path';
import { launchBrowser, startServer, newPage, dismissOnboarding, gotoSection, root, outDir, assert } from './helpers.mjs';

const srv = await startServer(8873);
const browser = await launchBrowser();
const report = [];
const editor = (page) => page.locator('dialog.qp-modal');
async function setNumber(dlg, label, value) {
  const input = dlg.getByLabel(label, { exact: true });
  await input.fill(value);
  await input.press('Enter');
}
try {
  const { page, log } = await newPage(browser, { viewport: { width: 1280, height: 900 } });
  await page.goto(`${srv.url}?e2e=1`);
  await page.waitForSelector('.shell');
  await dismissOnboarding(page);

  // 1) adjust the built-in 3×4 preset: 3 mm margin, portrait (already the default) → 10 per sheet with turned photos
  const card = page.locator('.quick-card[data-preset="q-3x4-4r"]');
  await card.locator('.quick-edit').click();
  const dlg = editor(page);
  await dlg.waitFor();
  assert((await dlg.locator('.qp-cap .num').innerText()) === '۹', 'editor starts with the factory capacity 9');
  await setNumber(dlg, 'حاشیهٔ بیرونی', '۳');
  await dlg.getByRole('group', { name: 'جهت کاغذ' }).getByRole('button', { name: 'عمودی' }).click();
  await page.waitForTimeout(150);
  const cap9 = await dlg.locator('.qp-cap .num').innerText();
  assert(cap9 === '۱۰', `live preview shows 10 (3 mm margin, some photos turned 90°) (${cap9})`);
  assert((await dlg.locator('svg.qp-diagram > g').count()) === 10, '10 slots drawn in the diagram');
  await page.screenshot({ path: path.join(outDir, 'quick-edit-dialog.png') });
  await dlg.getByRole('button', { name: 'ذخیره', exact: true }).click();
  await dlg.waitFor({ state: 'detached' });
  const cardText = await card.innerText();
  assert(cardText.includes('۴ عکس برای هر نفر') && cardText.includes('تنظیم‌شده') && cardText.includes('عمودی'), `card: 4 per person, portrait, "adjusted" (${cardText})`);

  // 2) survives a reload (settings are stored locally)
  await page.waitForTimeout(1500);
  await page.reload();
  await page.waitForSelector('.quick-card[data-preset="q-3x4-4r"]');
  const after = await page.locator('.quick-card[data-preset="q-3x4-4r"]').innerText();
  assert(after.includes('تنظیم‌شده') && after.includes('عمودی'), `adjustment kept after reload (${after})`);
  await page.locator('.quick-card[data-preset="q-3x4-4r"] .quick-edit').click();
  await editor(page).waitFor();
  assert((await editor(page).locator('.qp-cap .num').innerText()) === '۱۰', 'reopened editor shows 10 slots');
  await page.keyboard.press('Escape');
  await editor(page).waitFor({ state: 'detached' });

  // 3) a new own preset: 4 copies per person, light-blue background, no auto light
  await page.locator('.quick-new').click();
  const nd = editor(page);
  await nd.waitFor();
  await nd.getByLabel('نام قالب').fill('۳×۴ آبی — ۴ نسخه');
  await nd.getByRole('button', { name: 'تعداد ثابت' }).click();
  await setNumber(nd, 'تعداد عکس برای هر نفر', '۴');
  await nd.locator('button.swatch[aria-label="آبی روشن"]').click();
  await nd.getByRole('switch', { name: /اصلاح خودکار صورت/ }).setChecked(false, { force: true });
  // engines are part of the template: skin engine and colour grading switched off here
  await nd.getByRole('switch', { name: /اصلاح پوست/ }).setChecked(false, { force: true });
  await nd.getByRole('switch', { name: /اعمال مقادیر تنظیم رنگ/ }).setChecked(false, { force: true });
  // edge group is part of the template: feather starts at 1 px; set 3 and enable a shadow
  assert((await nd.getByRole('slider', { name: /محو لبه/ }).inputValue()) === '1', 'feather defaults to 1 px in a new template');
  await nd.getByRole('slider', { name: /محو لبه/ }).fill('3');
  await nd.getByRole('switch', { name: /سایهٔ نرم/ }).setChecked(true, { force: true });
  await nd.getByRole('button', { name: '۶', exact: true }).click(); // count chip
  await page.waitForTimeout(150);
  const counted = await nd.getByLabel('تعداد عکس برای هر نفر', { exact: true }).inputValue();
  assert(counted === '۶', `chip sets the count (${counted})`);
  await nd.getByRole('button', { name: '۴', exact: true }).click();
  // border: off by default, configurable width/colour
  assert((await nd.getByRole('switch', { name: /بوردر/ }).isChecked()) === true, 'border is on by default in a new template');
  assert((await nd.getByLabel('ضخامت بوردر', { exact: true }).inputValue()) === '۰٫۱', 'default width 0.1 mm');
  await setNumber(nd, 'ضخامت بوردر', '۰٫۵');
  await nd.locator('button.swatch[aria-label="خاکستری تیره"]').click();
  await page.waitForTimeout(150);
  const summary = await nd.locator('.qp-summary').innerText();
  assert(summary.includes('۴ عکس برای هر نفر') && summary.includes('آبی روشن'), `summary (${summary})`);
  await nd.getByRole('button', { name: 'ذخیرهٔ قالب' }).click();
  await nd.waitFor({ state: 'detached' });
  const own = page.locator('.quick-card:has-text("۳×۴ آبی — ۴ نسخه")');
  await own.waitFor();
  assert((await own.innerText()).includes('قالب شما'), 'own preset tagged');

  // 4) run it on a photo
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), own.locator('.quick-main').click()]);
  await chooser.setFiles(path.join(root, 'tests/fixtures/astronaut.png'));
  const retain = page.locator('dialog.modal:has-text("عکس‌های اصلی ذخیره شوند")');
  await retain.waitFor({ timeout: 15000 });
  await retain.locator('.btn-primary').click();
  const ready = page.locator('dialog.modal:has(h2:text-is("آماده برای چاپ"))');
  await ready.waitFor({ timeout: 180000 });
  const rt = await ready.innerText();
  assert(rt.includes('پس‌زمینه آبی روشن شد'), 'background in the preset colour');
  assert(rt.includes('برای هر نفر ۴ عکس'), 'four copies per person');
  const st = await page.evaluate(() => {
    const h = window.__hoshmand; const s = h.getState(); const ph = Object.values(s.photos)[0]; const l = h.sheet.computeSheetLayout(s);
    return { color: ph.edit.bg.color, enabled: ph.edit.bg.enabled, adjust: ph.edit.adjust, face: ph.edit.face, refine: ph.edit.bg.refine, shadow: ph.edit.bg.shadow, marks: s.project.sheet.marks, exposure: ph.edit.adjust.exposure, items: s.project.sheet.items.map((i) => i.copies), mode: s.project.sheet.mode, paper: s.project.sheet.paperId, margins: s.project.sheet.margins.top, placed: l.totals.placed, cap: l.capacity, boost: s.project.sheet.printBoost };
  });
  assert(st.enabled && st.color === '#cfe3f5', `bg ${st.color}`);
  assert(st.adjust.brightness === 0 && st.adjust.whites === 0 && st.adjust.exposure === 0, `grading off → neutral adjustments (${JSON.stringify(st.adjust)})`);
  assert(st.face.skin.enabled === false && st.face.light.enabled === true, `skin engine off, lighting on (${JSON.stringify(st.face)})`);
  assert(st.marks.borders === true && st.marks.borderWidth === 0.5 && st.marks.borderColor === '#404040', `border applied from the template ${JSON.stringify(st.marks)}`);
  assert(st.refine.feather === 3 && st.shadow.enabled === true, `own edge settings applied (${JSON.stringify(st.refine)} ${JSON.stringify(st.shadow)})`);
  assert(JSON.stringify(st.items) === '[4]' && st.mode === 'exact' && st.placed === 4 && st.cap === 9, `sheet ${JSON.stringify(st)}`);
  assert(st.paper === '4x6in' && st.margins === 3.7 && st.boost === 'medium', 'paper/margins/boost from the preset');
  await ready.getByRole('button', { name: 'اول پیش‌نمایش را ببینم' }).click();
  await page.waitForTimeout(500);
  const frames = await page.evaluate(() => [...document.querySelectorAll('.sheets .marks-over rect')].map((r) => [r.getAttribute('stroke'), r.getAttribute('stroke-width')]));
  assert(frames.length === 4 && frames.every(([c, w]) => c === '#404040' && Number(w) === 0.5), `4 bordered photos in the preview (${JSON.stringify(frames)})`);
  // the print studio exposes the same setting for any sheet
  const sw = page.getByRole('switch', { name: /بوردر/ });
  assert(await sw.isChecked(), 'print studio shows the border switch on');
  assert((await page.getByLabel('ضخامت بوردر', { exact: true }).inputValue()) === '۰٫۵', 'print studio shows the width');
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(outDir, 'quick-edit-print.png') });

  // 5) Templates view: list, reset the built-in, delete the own preset
  await gotoSection(page, 'templates');
  const table = page.locator('#quick-presets');
  await table.waitFor();
  assert((await table.locator('tbody tr').count()) === 5, '4 built-in + 1 own preset listed');
  await page.screenshot({ path: path.join(outDir, 'quick-edit-templates.png') });
  await table.locator('tr[data-preset="q-3x4-4r"]').getByRole('button', { name: 'بازگشت به تنظیمات اصلی' }).click();
  await page.locator('dialog.modal .modal-foot .btn-primary').click();
  await page.waitForTimeout(200);
  const ownRow = table.locator('tbody tr', { hasText: '۳×۴ آبی — ۴ نسخه' });
  await ownRow.getByRole('button', { name: 'حذف' }).click();
  await page.locator('dialog.modal .modal-foot .btn-danger').click();
  await page.waitForTimeout(200);
  const settings = await page.evaluate(() => { const s = window.__hoshmand.getState().settings; return { o: s.quickOverrides, q: s.quickPresets }; });
  assert(Object.keys(settings.o).length === 0 && settings.q.length === 0, `reset + delete (${JSON.stringify(settings)})`);

  // 6) phone: the editor fits without horizontal scrolling
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoSection(page, 'home');
  await page.locator('.quick-card[data-preset="q-35x45-4r"] .quick-edit').click();
  await editor(page).waitFor();
  await page.waitForTimeout(200);
  const ov = await page.evaluate(() => { const b = document.querySelector('dialog.qp-modal .modal-body'); return b.scrollWidth - b.clientWidth; });
  assert(ov <= 1, `editor has no horizontal scroll on a phone (${ov}px)`);
  await page.screenshot({ path: path.join(outDir, 'quick-edit-mobile.png') });

  assert(log.external.length === 0, `no external requests ${log.external}`);
  report.push('PASS Template editor — built-in 3×4 adjusted to 3 mm/portrait (live preview 9, kept after reload); own preset (4 copies, light-blue background, no auto light) created and run; reset + delete from Templates; editor fits a phone screen');
} finally {
  console.log(report.join('\n'));
  await browser.close();
  srv.stop();
}
