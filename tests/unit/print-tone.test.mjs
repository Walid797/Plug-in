import test from 'node:test';
import assert from 'node:assert/strict';
import { printBoostLut, printBoostValue, applyLut, PRINT_BOOST_IDS, PRINT_BOOST_LEVELS, isPrintBoost } from '../../src/core/adjust.js';
import { autoExposureDelta, AUTO_LIGHT, QUALITY_THRESHOLDS } from '../../src/core/idphoto.js';
import { resetSavedQuick, upgradeSavedQuickFields, gradeStrength, detailStrength, presetAdjustFor, presetAdjust, GRADE_FULL_BELOW_L, DETAIL_FULL_BELOW_SHARPNESS, QUICK_PRESETS, QUICK_DEFAULTS, presetCapacity, quickSheetPatch, quickLayoutInput, findQuickPreset, normalizeQuickPreset, allQuickPresets, quickFields, quickWarnings, copiesPerPerson, quickPaper } from '../../src/core/quickpresets.js';
import { computeLayout, computeMarks, nineModeInput } from '../../src/core/layout.js';
import { layoutToPdfPages } from '../../src/core/pdf.js';
import { findPaper, findPhoto, findProfile } from '../../src/core/presets.js';

const lin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

test('print brightening keeps pure white and black, is monotonic and ordered by level', () => {
  assert.equal(printBoostLut('off'), null, 'off means no LUT');
  assert.equal(printBoostLut('nonsense'), null);
  assert.equal(isPrintBoost('off'), false);
  let prevMid = 128;
  for (const lv of ['low', 'medium', 'high']) {
    const L = printBoostLut(lv);
    assert.equal(L[255], 255, `${lv}: white stays white (no ink on the background)`);
    assert.equal(L[0], 0, `${lv}: black stays black`);
    for (let v = 1; v < 256; v += 1) assert.ok(L[v] >= L[v - 1], `${lv}: monotonic at ${v}`);
    assert.ok(L[128] > prevMid, `${lv}: brighter mid-tones than the previous level`);
    prevMid = L[128];
    for (let v = 1; v < 255; v += 1) assert.ok(L[v] >= v, `${lv}: never darkens (${v})`);
  }
  // mid-grey lift in stops (linear light): low ≈ ¼, medium ≈ ½, high ≈ ⅔
  const stops = (lv) => Math.log2(lin(printBoostValue(0.5, lv)) / lin(0.5));
  assert.ok(stops('low') > 0.15 && stops('low') < 0.35, `low ${stops('low')}`);
  assert.ok(stops('medium') > 0.35 && stops('medium') < 0.6, `medium ${stops('medium')}`);
  assert.ok(stops('high') > 0.55 && stops('high') < 0.85, `high ${stops('high')}`);
  assert.deepEqual(PRINT_BOOST_IDS, Object.keys(PRINT_BOOST_LEVELS));
});

test('applyLut changes RGB only and leaves a white background untouched', () => {
  const px = new Uint8ClampedArray([255, 255, 255, 255, 120, 90, 70, 200, 0, 0, 0, 255]);
  applyLut(px, printBoostLut('medium'));
  assert.deepEqual([...px.slice(0, 4)], [255, 255, 255, 255]);
  assert.ok(px[4] > 120 && px[5] > 90 && px[6] > 70, 'skin-like tone brightened');
  assert.equal(px[7], 200, 'alpha untouched');
  assert.deepEqual([...px.slice(8)], [0, 0, 0, 255]);
  const same = new Uint8ClampedArray([10, 20, 30, 40]);
  applyLut(same, null);
  assert.deepEqual([...same], [10, 20, 30, 40]);
});

test('auto light corrects only clearly dark or bright faces, within limits', () => {
  assert.equal(AUTO_LIGHT.darkBelow, QUALITY_THRESHOLDS.darkL, 'same threshold as the lighting warning');
  for (const v of [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, QUALITY_THRESHOLDS.darkL, QUALITY_THRESHOLDS.brightL]) assert.equal(autoExposureDelta(v), 0, `well-exposed ${v} left alone`);
  for (const v of [null, undefined, NaN, 0, 1]) assert.equal(autoExposureDelta(v), 0);
  const d = autoExposureDelta(0.2);
  assert.ok(d > 0 && d <= (AUTO_LIGHT.maxEv / 2) * 100, `dark face brightened within cap (${d})`);
  assert.ok(autoExposureDelta(0.27) <= autoExposureDelta(0.2), 'darker → at least as much correction');
  const b = autoExposureDelta(0.95);
  assert.ok(b < 0 && b >= (AUTO_LIGHT.minEv / 2) * 100, `bright face darkened within cap (${b})`);
});

test('quick presets: real 4R paper, capacities from the layout engine, studio settings', () => {
  const caps = Object.fromEntries(QUICK_PRESETS.map((p) => [p.id, presetCapacity(p)]));
  assert.equal(caps['q-3x4-4r'].capacity, 8, 'portrait sheet, every photo turned 90°: 2 columns × 4 rows');
  assert.equal(caps['q-3x4-4r'].orientation, 'portrait');
  assert.equal(caps['q-35x45-4r'].capacity, 6);
  assert.equal(caps['q-4x6-4r'].capacity, 4);
  assert.equal(caps['q-3x4-a4'].capacity, 36);
  for (const p of QUICK_PRESETS) {
    const paper = findPaper(p.paperId); const photo = findPhoto(p.photoId); const prof = findProfile(p.profileId);
    assert.ok(paper && photo && prof, `${p.id} refers to known paper, photo and profile`);
    assert.equal(prof.widthMm, photo.widthMm); assert.equal(prof.heightMm, photo.heightMm);
    // every photo inside the printable area (hard margins) and never resized
    const l = computeLayout(quickLayoutInput(p, [{ id: 'a', copies: caps[p.id].capacity }], 'exact'));
    assert.ok(l.ok);
    const hm = p.hardMargin;
    for (const pl of l.pages[0].placements) {
      assert.equal(pl.photoSizeMm.w, photo.widthMm); assert.equal(pl.photoSizeMm.h, photo.heightMm);
      assert.ok(pl.photo.x >= hm && pl.photo.y >= hm);
      assert.ok(pl.photo.x + pl.photo.w <= l.sheet.widthMm - hm + 1e-9 && pl.photo.y + pl.photo.h <= l.sheet.heightMm - hm + 1e-9);
    }
    assert.equal(p.printBoost, 'medium'); assert.equal(p.fillOrder, 'ltr'); assert.equal(p.margin, 5); assert.equal(p.orientation, 'portrait'); assert.equal(p.bgColor, '#ffffff');
    assert.ok(p.builtin && p.whiteBg && p.autoCrop && p.autoLight);
  }
  assert.equal(findPaper('4x6in').widthMm, 101.6);
});

test('quick preset sheet: 4 photos for the 3x4 template, a full sheet per person for the others, even share on A4', () => {
  let n = 0; const id = (p) => `${p}${(n += 1)}`;
  const p34 = findQuickPreset('q-3x4-4r');
  assert.equal(presetCapacity(p34).capacity, 8, 'the sheet has 8 slots (portrait, photos turned 90°)');
  assert.equal(p34.perPerson, 'copies'); assert.equal(p34.copies, 4);
  const four = quickSheetPatch(p34, ['A', 'B'], id);
  assert.equal(four.mode, 'exact');
  assert.deepEqual(four.items.map((i) => [i.photoId, i.copies]), [['A', 4], ['B', 4]]);
  assert.equal(four.paperId, '4x6in');
  assert.equal(four.label.enabled, false);
  // one person → 4 photos at the top-left (column 1 full, then column 2), rest of the paper untouched
  const one = computeLayout(quickLayoutInput(p34, [{ id: 'a', copies: 4 }], 'exact'));
  assert.equal(one.totals.placed, 4); assert.equal(one.totals.sheets, 1);
  const pos = one.pages[0].placements.map((pl) => [pl.photo.x, pl.photo.y]);
  const expected = [[5, 5], [47, 5], [5, 37], [47, 37]]; // 101.6×152.4 portrait, photos turned 90° (40×30), top-left (5 mm margin), filled row by row
  pos.forEach(([x, y], i) => { assert.ok(Math.abs(x - expected[i][0]) < 1e-6 && Math.abs(y - expected[i][1]) < 1e-6, `slot ${i}: ${x},${y}`); });
  assert.ok(pos[3][1] + 30 < 80 && 152.4 - (pos[3][1] + 30) > 70, 'the lower half of the paper stays untouched');
  // two people share the 8-slot sheet (4 + 4 photos)
  const two = computeLayout(quickLayoutInput(p34, four.items, 'exact'));
  assert.equal(two.totals.sheets, 1); assert.equal(two.totals.placed, 8);
  const p35 = findQuickPreset('q-35x45-4r');
  const full = quickSheetPatch(p35, ['A', 'B'], id);
  assert.deepEqual(full.items.map((i) => i.copies), [6, 6]);
  const l = computeLayout(quickLayoutInput(p35, full.items, 'exact'));
  assert.equal(l.totals.sheets, 2);
  for (const page of l.pages) assert.equal(new Set(page.placements.map((pl) => pl.itemId)).size, 1, 'each sheet holds one person');
  const share = quickSheetPatch(findQuickPreset('q-3x4-a4'), ['A', 'B', 'C'], id);
  assert.equal(share.mode, 'fill');
  const l2 = computeLayout(quickLayoutInput(findQuickPreset('q-3x4-a4'), share.items, 'fill'));
  assert.deepEqual(Object.values(l2.totals.perItem), [12, 12, 12]);
});

test('preset editor values are validated: clamped numbers, known enums, safe colour, custom sizes', () => {
  const p = normalizeQuickPreset({
    nameFa: '  آزمایش  ', photoId: 'custom', widthMm: 1000, heightMm: -3, margin: -5, gap: 999, copies: 2.6, dpi: 123,
    printBoost: 'ultra', fillOrder: 'zigzag', orientation: 'diagonal', perPerson: 'many', bgColor: 'red;}', hardMargin: 50,
    paperId: 'custom', paperWidthMm: 5, paperHeightMm: 99999, whiteBg: 'yes', autoCrop: false, extra: 'dropped',
  });
  assert.equal(p.nameFa, 'آزمایش');
  assert.equal(p.widthMm, 300); assert.equal(p.heightMm, 5);
  assert.equal(p.margin, 0); assert.equal(p.gap, 50); assert.equal(p.copies, 3);
  assert.equal(p.dpi, 300); assert.equal(p.printBoost, 'medium'); assert.equal(p.fillOrder, 'ltr');
  assert.equal(p.orientation, 'portrait'); assert.equal(p.perPerson, 'sheet'); assert.equal(p.bgColor, '#ffffff');
  assert.equal(p.hardMargin, 20); assert.equal(p.paperWidthMm, 10); assert.equal(p.paperHeightMm, 2000);
  assert.equal(p.whiteBg, QUICK_DEFAULTS.whiteBg, 'non-boolean ignored'); assert.equal(p.autoCrop, false);
  assert.equal('extra' in quickFields(p), false);
  assert.equal(normalizeQuickPreset({ nameFa: '' }).nameFa, QUICK_DEFAULTS.nameFa);
  // a preset size picks its own rule profile; custom sizes fall back to generic
  assert.equal(normalizeQuickPreset({ photoId: '3.5x4.5' }).profileId, 'icao-35x45');
  assert.equal(normalizeQuickPreset({ photoId: 'custom', widthMm: 33, heightMm: 48 }).profileId, null);
  assert.equal(normalizeQuickPreset({ photoId: '4x6', profileId: null }).profileId, null);
});

test('built-in presets can be adjusted (and reset) and user presets are listed after them', () => {
  const base = findQuickPreset('q-3x4-4r');
  assert.equal(presetCapacity(base).capacity, 8);
  const settings = {
    quickOverrides: { 'q-3x4-4r': { margin: 3, orientation: 'portrait', allowRotation: false } },
    quickPresets: [{ id: 'qp_mine', nameFa: 'قالب من', photoId: '3x4', perPerson: 'copies', copies: 4, bgColor: '#cfe3f5', autoLight: false }],
  };
  const list = allQuickPresets(settings);
  assert.deepEqual(list.map((p) => p.id), ['q-3x4-4r', 'q-35x45-4r', 'q-4x6-4r', 'q-3x4-a4', 'qp_mine']);
  const edited = list[0];
  assert.ok(edited.edited && edited.builtin);
  assert.equal(edited.nameFa, base.nameFa, 'partial override keeps the factory name');
  assert.equal(edited.paperId, '4x6in');
  const cap = presetCapacity(edited);
  assert.equal(cap.capacity, 9, '3 mm margin, portrait 4R → 3 × 3');
  assert.equal(cap.orientation, 'portrait');
  assert.deepEqual(quickWarnings(edited, cap), [], 'margin equal to the printer edge is allowed');
  assert.equal(quickWarnings({ ...edited, margin: 2 }, cap)[0].code, 'MARGIN_IN_HARD');
  // factory preset untouched
  assert.equal(QUICK_PRESETS[0].margin, 5);
  assert.equal(allQuickPresets({}).find((p) => p.id === 'q-3x4-4r').edited, false);
  const mine = list[4];
  assert.equal(mine.builtin, false);
  assert.equal(copiesPerPerson(mine, 8), 4);
  let n = 0; const id = (x) => `${x}${(n += 1)}`;
  const patch = quickSheetPatch(mine, ['A', 'B'], id);
  assert.equal(patch.mode, 'exact');
  assert.deepEqual(patch.items.map((i) => i.copies), [4, 4]);
  const l = computeLayout(quickLayoutInput(mine, patch.items, 'exact'));
  assert.equal(l.totals.sheets, 1, 'two people × 4 copies share one 8-slot sheet');
  assert.equal(quickWarnings({ ...mine, copies: 20 }, presetCapacity(mine))[0].code, 'COPIES_MULTI_SHEET');
});

test('custom paper and user-saved papers are honoured', () => {
  const custom = normalizeQuickPreset({ photoId: '3x4', paperId: 'custom', paperWidthMm: 130, paperHeightMm: 180, margin: 5, gap: 2 });
  assert.equal(quickPaper(custom).widthMm, 130);
  const patch = quickSheetPatch(custom, ['A'], (x) => `${x}1`);
  assert.deepEqual(patch.customPaper, { widthMm: 130, heightMm: 180 });
  assert.equal(patch.paperId, 'custom');
  const saved = normalizeQuickPreset({ photoId: '3x4', paperId: 'paper_x' });
  assert.equal(quickPaper(saved, [{ id: 'paper_x', nameFa: 'کاغذ من', widthMm: 89, heightMm: 127 }]).widthMm, 89);
  assert.equal(quickPaper(saved).id, '4x6in', 'unknown paper falls back to 4R');
  const tooBig = normalizeQuickPreset({ photoId: 'custom', widthMm: 200, heightMm: 250, paperId: '4x6in' });
  assert.equal(presetCapacity(tooBig).capacity, 0);
  assert.ok(presetCapacity(tooBig).errors.length > 0);
});

test('edge clean-up defaults: 1 px feather in every template, fully editable and clamped', () => {
  for (const p of QUICK_PRESETS) {
    assert.equal(p.edgeFeather, 1, `${p.id}: edge feather 1 px`);
    assert.equal(p.edgeAware, true); assert.equal(p.decontaminate, true);
    assert.equal(p.edgeShift, 0); assert.equal(p.edgeSoftness, 40); assert.equal(p.shadow, false);
  }
  // a user preset or an old override without the new fields also gets 1 px
  assert.equal(normalizeQuickPreset({ photoId: '3x4' }).edgeFeather, 1);
  const list = allQuickPresets({ quickOverrides: { 'q-3x4-4r': { margin: 3 } } });
  assert.equal(list[0].edgeFeather, 1, 'old override keeps the 1 px default');
  const p = normalizeQuickPreset({ edgeFeather: 40, edgeShift: -500, edgeSoftness: 7.6, edgeAware: 'x', shadow: true, shadowOpacity: 999, shadowBlur: 2.26, shadowX: -9, shadowY: 'a' });
  assert.equal(p.edgeFeather, 12); assert.equal(p.edgeShift, -100); assert.equal(p.edgeSoftness, 8);
  assert.equal(p.edgeAware, true); assert.equal(p.shadow, true); assert.equal(p.shadowOpacity, 80);
  assert.equal(p.shadowBlur, 2.3); assert.equal(p.shadowX, -4); assert.equal(p.shadowY, 0.8);
  assert.equal(normalizeQuickPreset({ edgeFeather: 0 }).edgeFeather, 0, '0 (off) is allowed');
});

test('border: configurable width/colour inside every photo frame, in marks, PDF and defaults', () => {
  for (const p of QUICK_PRESETS) { assert.equal(p.border, true, 'on in every template'); assert.equal(p.borderWidth, 0.1, 'thin by default'); assert.equal(p.borderColor, '#000000'); assert.equal(p.cutOffset, 2, 'cut guides 2 mm from the photos'); }
  assert.equal(normalizeQuickPreset({ photoId: '3x4' }).border, true, 'new templates too');
  assert.equal(normalizeQuickPreset({ border: false }).border, false, 'can still be turned off');
  const p = normalizeQuickPreset({ border: true, borderWidth: 9, borderColor: 'red', photoId: '3x4' });
  assert.equal(p.border, true); assert.equal(p.borderWidth, 2); assert.equal(p.borderColor, '#000000');
  assert.equal(normalizeQuickPreset({ borderWidth: 0.001 }).borderWidth, 0.05);
  assert.equal(normalizeQuickPreset({ borderColor: '#AABBCC' }).borderColor, '#aabbcc');
  const preset = normalizeQuickPreset({ photoId: '3x4', border: true, borderWidth: 0.5, borderColor: '#404040', perPerson: 'sheet' });
  const patch = quickSheetPatch(preset, ['A'], (x) => `${x}1`);
  assert.deepEqual(patch.marks, { cutLines: true, cropMarks: true, borders: true, borderWidth: 0.5, borderColor: '#404040', cutOffset: 2, cutUsedOnly: true });
  const layout = computeLayout(quickLayoutInput(preset, patch.items, 'exact'));
  const page = layout.pages[0];
  const on = computeMarks(layout, page, patch.marks);
  assert.equal(on.over.length, page.placements.length);
  assert.ok(on.over.every((o) => o.width === 0.5 && o.color === '#404040'));
  for (const [o, pl] of on.over.map((o, i) => [o, page.placements[i]])) assert.deepEqual(o.rect, pl.photo, 'border follows the exact photo frame');
  assert.equal(computeMarks(layout, page, { ...patch.marks, borders: false }).over.length, 0);
  // old projects (no width/colour) fall back to 0.1 mm black; bad values are clamped
  const legacy = computeMarks(layout, page, { borders: true }).over[0];
  assert.equal(legacy.width, 0.1); assert.equal(legacy.color, '#000000');
  assert.equal(computeMarks(layout, page, { borders: true, borderWidth: 50, borderColor: 'x' }).over[0].width, 2);
  // the PDF draws it in the chosen colour and width
  const pages = layoutToPdfPages(layout, { imageName: () => 'Im1', marks: (pg) => computeMarks(layout, pg, patch.marks) });
  const op = pages[0].content;
  assert.ok(/0\.251 0\.251 0\.251 RG/.test(op), 'stroke colour #404040 in the PDF');
  assert.equal((op.match(/ re S Q/g) || []).length, page.placements.length);
});

test('cut guides: the same distance from the photos on all four sides and between photos', () => {
  const preset = normalizeQuickPreset({ photoId: '3x4', paperId: '4x6in', orientation: 'landscape', allowRotation: false, margin: 5, gap: 2, cutLines: true, cropMarks: true, border: true, borderWidth: 0.1 });
  assert.equal(preset.cutOffset, 2, 'setting 2 mm; limited to half the 2 mm gap = 1 mm');
  const patch = quickSheetPatch(preset, ['A'], (x) => `${x}1`);
  const layout = computeLayout(quickLayoutInput(preset, patch.items, 'exact'));
  const page = layout.pages[0];
  const near = (a, b) => Math.abs(a - b) < 1e-6;
  const cut = computeMarks(layout, page, patch.marks).under.filter((m) => m.kind === 'cut');
  const vx = [...new Set(cut.filter((m) => m.x1 === m.x2).map((m) => m.x1))].sort((a, b) => a - b);
  const hy = [...new Set(cut.filter((m) => m.y1 === m.y2).map((m) => m.y1))].sort((a, b) => a - b);
  const photos = page.placements.map((pl) => pl.photo);
  const cols = [...new Set(photos.map((r) => Math.round(r.x * 1e4) / 1e4))].sort((a, b) => a - b);
  const rows = [...new Set(photos.map((r) => Math.round(r.y * 1e4) / 1e4))].sort((a, b) => a - b);
  // 4 columns x 2 rows: columns+1 vertical lines and rows+1 horizontal lines, every one 1 mm from its photo edge
  assert.equal(vx.length, cols.length + 1); assert.equal(hy.length, rows.length + 1);
  assert.ok(near(vx[0], cols[0] - 1), `left guide 1 mm outside (${vx[0]})`);
  assert.ok(near(vx[vx.length - 1], cols[cols.length - 1] + 30 + 1), 'right guide 1 mm outside');
  assert.ok(near(hy[0], rows[0] - 1), 'top guide 1 mm outside');
  assert.ok(near(hy[hy.length - 1], rows[rows.length - 1] + 40 + 1), 'bottom guide 1 mm outside');
  for (let i = 0; i < cols.length - 1; i += 1) assert.ok(near(vx[i + 1], cols[i] + 31) && near(vx[i + 1], cols[i + 1] - 1), `middle line of gap ${i} is 1 mm from both photos`);
  assert.ok(near(hy[1], rows[0] + 41) && near(hy[1], rows[1] - 1));
  for (const x of vx) for (const r of photos) assert.ok(x <= r.x - 0.1 + 1e-9 || x >= r.x + r.w + 0.1 - 1e-9, 'guide outside every photo frame');
  // wider gap (4 mm): 2 mm everywhere, still equal on the outer sides and in the middle
  const wide = normalizeQuickPreset({ photoId: '3x4', paperId: '4x6in', orientation: 'landscape', allowRotation: false, margin: 5, gap: 4, cutLines: true });
  const wl = computeLayout(quickLayoutInput(wide, [{ id: 'a', copies: 8 }], 'exact'));
  const wx = computeMarks(wl, wl.pages[0], { cutLines: true, cutOffset: 2 }).under.filter((m) => m.x1 === m.x2).map((m) => m.x1);
  const wc = [...new Set(wl.pages[0].placements.map((pl) => pl.photo.x))].sort((a, b) => a - b);
  assert.ok(wx.some((x) => near(x, wc[0] - 2)) && wx.some((x) => near(x, wc[0] + 32)) && wx.some((x) => near(x, wc[wc.length - 1] + 32)), '4 mm gap: 2 mm outside and in the middle');
  // a smaller setting is used as is; 0 reproduces the edge positions
  const half = computeMarks(layout, page, { cutLines: true, cutOffset: 0.4 }).under.filter((m) => m.x1 === m.x2).map((m) => m.x1);
  assert.ok(near(Math.min(...half), cols[0] - 0.4));
  const edge = computeMarks(layout, page, { cutLines: true, cutOffset: 0 }).under.filter((m) => m.x1 === m.x2).map((m) => m.x1);
  assert.ok(edge.includes(cols[0]) && edge.includes(cols[0] + 30));
  // touching photos: no room, guides stay on the edges on every side
  const flat = normalizeQuickPreset({ photoId: '3x4', paperId: '4x6in', margin: 5, gap: 0, cutLines: true });
  const fl = computeLayout(quickLayoutInput(flat, [{ id: 'a', copies: 8 }], 'exact'));
  const fx = computeMarks(fl, fl.pages[0], { cutLines: true, cutOffset: 2 }).under.map((m) => m.x1);
  const fc = [...new Set(fl.pages[0].placements.map((pl) => pl.photo.x))].sort((a, b) => a - b);
  assert.ok(fx.some((x) => near(x, fc[0])) && fx.some((x) => near(x, fc[1])));
  assert.equal(normalizeQuickPreset({ cutOffset: 99 }).cutOffset, 5);
  assert.equal(normalizeQuickPreset({ cutOffset: -1 }).cutOffset, 0);
});

test('with fewer photos than the sheet holds, no cut line enters the unused paper', () => {
  const p34 = normalizeQuickPreset({ ...findQuickPreset('q-3x4-4r'), cutLines: true, cropMarks: true });
  const patch = quickSheetPatch(p34, ['A'], (x) => `${x}1`);
  assert.equal(patch.marks.cutUsedOnly, true);
  const layout = computeLayout(quickLayoutInput(p34, patch.items, 'exact'));
  assert.equal(layout.totals.placed, 4);
  const page = layout.pages[0];
  const right = Math.max(...page.placements.map((pl) => pl.photo.x + pl.photo.w));
  const bottom = Math.max(...page.placements.map((pl) => pl.photo.y + pl.photo.h));
  const top = Math.min(...page.placements.map((pl) => pl.photo.y)); const left = Math.min(...page.placements.map((pl) => pl.photo.x));
  const under = computeMarks(layout, page, patch.marks).under;
  const cuts = under.filter((m) => m.kind === 'cut');
  assert.ok(cuts.length > 0);
  for (const m of cuts) {
    for (const x of [m.x1, m.x2]) assert.ok(x <= right + 1 + 1e-6 && x >= left - 1 - 1e-6, `cut line x ${x} stays around the printed photos (right edge ${right})`);
    for (const y of [m.y1, m.y2]) assert.ok(y <= bottom + 1 + 1e-6 && y >= top - 1 - 1e-6, `cut line y ${y} stays around the printed photos`);
  }
  // crop marks also stay next to the printed block (nothing over the empty right half)
  for (const m of under.filter((q) => q.kind === 'crop')) for (const x of [m.x1, m.x2]) assert.ok(x <= right + 1 + 1 + 4 + 1e-6, `crop mark x ${x}`);
  // the old behaviour is still available: lines across the whole sheet
  const full = computeMarks(layout, page, { ...patch.marks, cutUsedOnly: false }).under.filter((m) => m.kind === 'cut');
  assert.ok(full.some((m) => m.x2 === layout.sheet.widthMm) && full.some((m) => m.y2 === layout.sheet.heightMm));
  // legacy projects without the option behave as "used only"
  const legacy = computeMarks(layout, page, { cutLines: true }).under.filter((m) => m.kind === 'cut');
  assert.ok(legacy.every((m) => m.x2 <= right + 1 + 1e-6));
  assert.equal(normalizeQuickPreset({}).cutUsedOnly, true);
});

test('adaptive grading: dark faces get the whole table, reference-bright faces get no brightening', () => {
  const p = findQuickPreset('q-3x4-4r');
  assert.equal(p.gradeAdaptive, true);
  assert.equal(gradeStrength(0.40), 1); assert.equal(gradeStrength(GRADE_FULL_BELOW_L), 1);
  assert.equal(gradeStrength(0.668), 0, 'the quality reference portrait (mean luma 0.668) is not brightened');
  assert.equal(gradeStrength(0.80), 0);
  assert.ok(Math.abs(gradeStrength(0.555) - 0.5) < 0.01, 'halfway');
  assert.equal(gradeStrength(null), 1); assert.equal(gradeStrength(NaN), 1);
  const dark = presetAdjustFor(p, 0.4); const full = presetAdjust(p);
  assert.deepEqual(dark, full);
  const ref = presetAdjustFor(p, 0.668);
  for (const k of ['exposure', 'brightness', 'shadows', 'whites']) assert.equal(ref[k], 0, `${k} not applied to a bright face`);
  // the subtle part is always applied in full (detail values depend on sharpness, see below)
  for (const k of ['contrast', 'saturation', 'temperature', 'highlights', 'blacks', 'denoise']) assert.equal(ref[k], full[k], k);
  // detail: soft photo gets all of it, a photo as crisp as the reference gets none, unknown sharpness = all
  assert.equal(detailStrength(789), 1, 'the soft original (measured 789)'); assert.equal(detailStrength(DETAIL_FULL_BELOW_SHARPNESS), 1);
  assert.equal(detailStrength(1977), 0, 'the quality reference (measured 1977) gets no extra detail'); assert.equal(detailStrength(3000), 0);
  assert.ok(Math.abs(detailStrength(1350) - 0.5) < 0.01); assert.equal(detailStrength(null), 1);
  const crisp = presetAdjustFor(p, 0.668, 1977); const soft = presetAdjustFor(p, 0.54, 789); const unknown = presetAdjustFor(p, 0.668);
  assert.equal(crisp.sharpness, 0); assert.equal(crisp.clarity, 0);
  assert.equal(soft.sharpness, full.sharpness); assert.equal(soft.clarity, full.clarity);
  assert.equal(unknown.sharpness, full.sharpness);
  assert.equal(presetAdjustFor(normalizeQuickPreset({ photoId: '3x4', gradeAdaptive: false }), 0.7, 3000).clarity, full.clarity, 'non-adaptive: always full');
  const half = presetAdjustFor(p, 0.555);
  assert.ok(Math.abs(half.brightness - 4) < 0.1 && Math.abs(half.exposure - 3.8) < 0.15);
  // switched off: always the full table
  assert.deepEqual(presetAdjustFor(normalizeQuickPreset({ photoId: '3x4', gradeAdaptive: false }), 0.7), full);
  assert.equal(presetAdjustFor(normalizeQuickPreset({ photoId: '3x4', grade: false }), 0.4), null);
});

test('the 3x4 profile follows the quality reference framing', () => {
  const prof = findProfile('generic-3x4');
  assert.ok(prof.headHeight.target >= 25 && prof.headHeight.target <= 26.5, 'head ≈ 25.5 mm (62–64% of the 40 mm height)');
  assert.ok(prof.eyeFromBottom.target >= 25.5 && prof.eyeFromBottom.target <= 26.5, 'eye line ≈ 26 mm from the bottom');
  assert.ok(prof.headHeight.min <= 25 && prof.headHeight.max >= 26 && prof.eyeFromBottom.min <= 26.05 && prof.eyeFromBottom.max >= 26.05, 'the reference (head ≈ 25.8–25.9, eye ≈ 26.05) is inside the allowed ranges');
});

test('full cut lines are on in every template (and can be turned off)', () => {
  for (const p of QUICK_PRESETS) { assert.equal(p.cutLines, true); assert.equal(p.cutUsedOnly, true); }
  assert.equal(normalizeQuickPreset({ photoId: '3x4' }).cutLines, true);
  assert.equal(normalizeQuickPreset({ cutLines: false }).cutLines, false);
  const patch = quickSheetPatch(findQuickPreset('q-3x4-4r'), ['A'], (x) => `${x}1`);
  assert.equal(patch.marks.cutLines, true);
});

test('templates place the photos at the top-left; no crop marks run toward unused paper', () => {
  for (const p of QUICK_PRESETS) assert.equal(p.align, 'top-left');
  assert.equal(normalizeQuickPreset({ align: 'middle' }).align, 'top-left');
  assert.equal(normalizeQuickPreset({ align: 'center' }).align, 'center');
  const p34 = findQuickPreset('q-3x4-4r');
  const patch = quickSheetPatch(p34, ['A'], (x) => `${x}1`);
  assert.equal(patch.align.mode, 'top-left');
  const four = computeLayout(quickLayoutInput(p34, [{ id: 'a', copies: 4 }], 'exact'));
  const first = four.pages[0].placements[0].photo;
  assert.ok(Math.abs(first.x - 5) < 1e-6 && Math.abs(first.y - 5) < 1e-6, 'first photo in the top-left corner of the printable area');
  const marks = computeMarks(four, four.pages[0], patch.marks).under.filter((m) => m.kind === 'crop');
  // 4 photos (2 × 2, turned 90°) in the top two rows of the 2 × 4 sheet: marks stay on the top, left and right (the printed
  // block reaches those edges of the full grid) but NONE runs down into the free lower part of the paper
  const phs = four.pages[0].placements.map((pl) => pl.photo);
  const by1 = Math.max(...phs.map((r) => r.y + r.h));
  assert.ok(marks.length > 0);
  assert.ok(marks.filter((m) => m.x1 === m.x2).every((m) => m.y2 <= first.y), 'vertical marks only above the photos, none below (toward the free paper)');
  assert.ok(marks.every((m) => Math.max(m.y1, m.y2) <= by1 + 1e-6 + 4), 'nothing below the printed rows');
  assert.ok(marks.some((m) => m.y1 === m.y2 && m.x1 > phs[1].x + phs[1].w), 'right-side marks stay (both columns are printed)');
  // a full sheet keeps marks on all four sides
  const full = computeLayout(quickLayoutInput(p34, [{ id: 'a', copies: 8 }], 'exact'));
  const fm = computeMarks(full, full.pages[0], patch.marks).under.filter((m) => m.kind === 'crop' && m.y1 === m.y2);
  const fr = Math.max(...full.pages[0].placements.map((pl) => pl.photo.x + pl.photo.w));
  assert.ok(fm.some((m) => m.x1 > fr), 'full sheet: marks on the right side as before');
  // 1 photo: only the top and left sides touch the block edge... right/bottom marks are not drawn
  const one = computeLayout(quickLayoutInput(p34, [{ id: 'a', copies: 1 }], 'exact'));
  const om = computeMarks(one, one.pages[0], patch.marks).under.filter((m) => m.kind === 'crop');
  const ph = one.pages[0].placements[0].photo;
  assert.ok(om.length > 0 && om.every((m) => (m.y1 === m.y2 ? m.x2 <= ph.x + 1e-6 : m.y2 <= ph.y + 1e-6)), 'single photo: marks only on the top and left, none toward the rest of the sheet');
});

test('every ready-made template carries the quality-reference engine settings; saved templates are upgraded once', () => {
  const keys = ['grade', 'gradeAdaptive', 'gExposure', 'gBrightness', 'gContrast', 'gSaturation', 'gTemperature', 'gTint', 'gHighlights', 'gShadows', 'gWhites', 'gBlacks', 'gSharpness', 'gClarity', 'gDenoise', 'skinOn', 'skinRedness', 'skinBalance', 'lightOn', 'lightFill', 'lightEven', 'lightProtect', 'cropShoulders', 'autoCrop', 'autoLight', 'whiteBg'];
  assert.equal(QUICK_PRESETS.length, 4);
  for (const p of QUICK_PRESETS) for (const k of keys) assert.deepEqual(p[k], QUICK_DEFAULTS[k], `${p.id}.${k}`);
  assert.equal(QUICK_DEFAULTS.gSharpness, 22); assert.equal(QUICK_DEFAULTS.gClarity, 55); assert.equal(QUICK_DEFAULTS.lightFill, 45); assert.equal(QUICK_DEFAULTS.skinBalance, 40);
  // framing: the two 3x4 templates use the reference-based rule, the others keep their own
  assert.equal(findProfile(findQuickPreset('q-3x4-4r').profileId).headHeight.target, 25.5);
  assert.equal(findProfile(findQuickPreset('q-3x4-a4').profileId).eyeFromBottom.target, 26);
  assert.equal(findProfile(findQuickPreset('q-35x45-4r').profileId).headHeight.target, 34);
  // an adjustment saved by the previous version (old defaults stored) is upgraded; user's own values stay
  const old = { photoId: '3x4', margin: 3, gSharpness: 14, lightFill: 35, skinBalance: 30, gExposure: 7.5 };
  const up = upgradeSavedQuickFields(old);
  assert.equal(up.gSharpness, 22); assert.equal(up.lightFill, 45); assert.equal(up.skinBalance, 40); assert.equal(up.margin, 3);
  const custom = upgradeSavedQuickFields({ gSharpness: 30, lightFill: 60, skinBalance: 10 });
  assert.deepEqual([custom.gSharpness, custom.lightFill, custom.skinBalance], [30, 60, 10], 'values the user chose are kept');
  const n = normalizeQuickPreset(up);
  assert.equal(n.gClarity, 55, 'fields the old version did not have get the new defaults'); assert.equal(n.gradeAdaptive, true);
  const list = allQuickPresets({ quickOverrides: { 'q-3x4-4r': up } });
  assert.equal(list[0].gClarity, 55); assert.equal(list[0].gradeAdaptive, true); assert.equal(list[0].margin, 3); assert.equal(list[0].edited, true);
  assert.equal(upgradeSavedQuickFields(null), null);
});

test('reset to the reference: saved adjustments and own templates are removed, a backup keeps them; 4x6 follows the reference proportions', () => {
  const saved = { quickPresets: [{ id: 'qp_a', nameFa: 'من' }], quickOverrides: { 'q-3x4-4r': { margin: 3, gSharpness: 30 } } };
  const r = resetSavedQuick(saved, 123);
  assert.deepEqual(r.quickPresets, []); assert.deepEqual(r.quickOverrides, {});
  assert.deepEqual(r.backup, { at: 123, quickPresets: saved.quickPresets, quickOverrides: saved.quickOverrides }, 'nothing is lost: backup holds exactly what was removed');
  assert.equal(resetSavedQuick({ quickPresets: [], quickOverrides: {} }).backup, null, 'nothing saved → no backup');
  assert.equal(resetSavedQuick(null).backup, null); assert.equal(resetSavedQuick({ quickPresets: 'x', quickOverrides: 5 }).backup, null);
  const list = allQuickPresets(resetSavedQuick(saved));
  assert.equal(list.length, 4); assert.ok(list.every((p) => p.builtin && !p.edited), 'only factory templates remain');
  const p46 = findProfile('generic-4x6');
  assert.ok(Math.abs(p46.headHeight.target / 60 - 25.5 / 40) < 0.005, 'head proportion = reference');
  assert.ok(Math.abs(p46.eyeFromBottom.target / 60 - 26 / 40) < 0.005, 'eye-line proportion = reference');
  assert.equal(findProfile('icao-35x45').headHeight.target, 34, 'passport rule untouched (ICAO)');
});

test('3x4 template: 8-photo form (every photo turned 90°, 2 × 4, row by row); exactly 9 photos use the compact upright 3 × 3', () => {
  const p = findQuickPreset('q-3x4-4r');
  assert.equal(p.orientation, 'portrait'); assert.equal(p.allowRotation, true); assert.equal(p.fillOrder, 'ltr'); assert.equal(p.margin, 5); assert.equal(p.gap, 2);
  assert.equal(p.nine, true); assert.equal(p.nineMargin, 3.7); assert.equal(p.nineGap, 2);
  // 8 photos: 2 columns × 4 rows, ALL turned (40 × 30), numbered row by row, top-left
  const base8 = quickLayoutInput(p, [{ id: 'a', copies: 8 }], 'exact');
  const l8 = computeLayout(base8);
  assert.equal(l8.totals.sheets, 1); assert.equal(l8.totals.placed, 8);
  const pl8 = l8.pages[0].placements;
  assert.ok(pl8.every((q) => q.photo.w === 40 && q.photo.h === 30), 'every photo turned 90°, none upright');
  assert.deepEqual(pl8.slice(0, 4).map((q) => [q.photo.x, q.photo.y]), [[5, 5], [47, 5], [5, 37], [47, 37]]);
  // any count other than 9 keeps that form (4, 6, 7, 8, 10, 12 photos)
  for (const n of [4, 6, 7, 8, 10, 12]) {
    const l = computeLayout(quickLayoutInput(p, [{ id: 'a', copies: n }], 'exact'));
    assert.ok(l.pages[0].placements.every((q) => q.photo.w === 40), `${n} photos: turned form`);
    assert.equal(nineModeInput({ margin: p.nineMargin, gap: p.nineGap }, quickLayoutInput(p, [{ id: 'a', copies: n }], 'exact')), null, `${n}: nine mode not used`);
  }
  // exactly 9: one sheet, upright 3 × 3, margin 3.7 and gap 2 (still ≥ the printer's 3 mm edge), row by row
  const base9 = quickLayoutInput(p, [{ id: 'a', copies: 9 }], 'exact');
  assert.equal(computeLayout(base9).totals.sheets, 2, 'without the nine mode 9 photos would need two sheets');
  const alt = nineModeInput({ margin: p.nineMargin, gap: p.nineGap }, base9);
  assert.ok(alt, 'nine mode applies');
  const l9 = computeLayout(alt);
  assert.equal(l9.totals.sheets, 1); assert.equal(l9.totals.placed, 9);
  const pl9 = l9.pages[0].placements;
  assert.ok(pl9.every((q) => q.photo.w === 30 && q.photo.h === 40), 'upright');
  assert.deepEqual(pl9.slice(0, 4).map((q) => [q.photo.x, q.photo.y]), [[3.7, 3.7], [35.7, 3.7], [67.7, 3.7], [3.7, 45.7]]);
  const right = Math.max(...pl9.map((q) => q.photo.x + q.photo.w)); const bottom = Math.max(...pl9.map((q) => q.photo.y + q.photo.h));
  assert.ok(right <= 101.6 - 3 + 1e-9 && bottom <= 152.4 - 3 + 1e-9, 'inside the printer edge (3 mm)');
  assert.equal(l9.warnings.some((w) => w.code === 'MARGINS_BELOW_PRINTER' || w.code === 'PRINTER_MARGIN_CLIP'), false);
  // two people 4 + 5 = 9 photos also use it; 'fill' mode never does
  assert.ok(nineModeInput({ margin: 3.7, gap: 2 }, quickLayoutInput(p, [{ id: 'a', copies: 4 }, { id: 'b', copies: 5 }], 'exact')));
  assert.equal(nineModeInput({ margin: 3.7, gap: 2 }, quickLayoutInput(p, [{ id: 'a', copies: 9 }], 'fill')), null);
  assert.equal(nineModeInput(null, base9), null);
  // a size where nine cannot fit on one sheet keeps the normal layout instead of a broken one
  const big = findQuickPreset('q-4x6-4r');
  assert.equal(nineModeInput({ margin: 3.7, gap: 2 }, quickLayoutInput(big, [{ id: 'a', copies: 9 }], 'exact')), null);
});

test('crop marks never point at the free part of a partly filled sheet, also when the photos are compacted', () => {
  const p = findQuickPreset('q-3x4-4r');
  const patch = quickSheetPatch(p, ['A'], (x) => `${x}1`);
  for (const n of [1, 2, 3, 4, 5, 6, 7]) {
    const l = computeLayout(quickLayoutInput(p, [{ id: 'a', copies: n }], 'exact'));
    const phs = l.pages[0].placements.map((q) => q.photo);
    const bottom = Math.max(...phs.map((r) => r.y + r.h));
    const full = l.fullBlock || l.block;
    assert.ok(full, `${n} photos: the grid is known`);
    const marks = computeMarks(l, l.pages[0], patch.marks).under.filter((m) => m.kind === 'crop');
    const rowsUsed = new Set(phs.map((r) => r.y)).size;
    if (bottom < full.y + full.h - 1e-6) {
      assert.ok(marks.every((m) => Math.max(m.y1, m.y2) <= bottom + 1.01), `${n} photos (${rowsUsed} rows of 4): no mark below the printed rows (${Math.max(...marks.map((m) => Math.max(m.y1, m.y2)))} vs ${bottom})`);
    }
  }
  // a full sheet still has marks on every side
  const l8 = computeLayout(quickLayoutInput(p, [{ id: 'a', copies: 8 }], 'exact'));
  const m8 = computeMarks(l8, l8.pages[0], patch.marks).under.filter((m) => m.kind === 'crop');
  assert.ok(m8.some((m) => m.x1 === m.x2 && m.y1 > 100), 'full sheet: bottom marks');
});
