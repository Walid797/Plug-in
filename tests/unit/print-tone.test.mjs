import test from 'node:test';
import assert from 'node:assert/strict';
import { printBoostLut, printBoostValue, applyLut, PRINT_BOOST_IDS, PRINT_BOOST_LEVELS, isPrintBoost } from '../../src/core/adjust.js';
import { autoExposureDelta, AUTO_LIGHT, QUALITY_THRESHOLDS } from '../../src/core/idphoto.js';
import { QUICK_PRESETS, QUICK_DEFAULTS, presetCapacity, quickSheetPatch, quickLayoutInput, findQuickPreset, normalizeQuickPreset, allQuickPresets, quickFields, quickWarnings, copiesPerPerson, quickPaper } from '../../src/core/quickpresets.js';
import { computeLayout, computeMarks } from '../../src/core/layout.js';
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
  assert.equal(caps['q-3x4-4r'].capacity, 8);
  assert.equal(caps['q-3x4-4r'].orientation, 'landscape');
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
    assert.equal(p.printBoost, 'medium'); assert.equal(p.fillOrder, 'col-ltr'); assert.equal(p.margin, 5); assert.equal(p.bgColor, '#ffffff');
    assert.ok(p.builtin && p.whiteBg && p.autoCrop && p.autoLight);
  }
  assert.equal(findPaper('4x6in').widthMm, 101.6);
});

test('quick preset sheet: 4 photos for the 3x4 template, a full sheet per person for the others, even share on A4', () => {
  let n = 0; const id = (p) => `${p}${(n += 1)}`;
  const p34 = findQuickPreset('q-3x4-4r');
  assert.equal(presetCapacity(p34).capacity, 8, 'the sheet still has 8 slots');
  assert.equal(p34.perPerson, 'copies'); assert.equal(p34.copies, 4);
  const four = quickSheetPatch(p34, ['A', 'B'], id);
  assert.equal(four.mode, 'exact');
  assert.deepEqual(four.items.map((i) => [i.photoId, i.copies]), [['A', 4], ['B', 4]]);
  assert.equal(four.paperId, '4x6in');
  assert.equal(four.label.enabled, false);
  // one person → 4 photos in the two left columns, rest of the paper untouched
  const one = computeLayout(quickLayoutInput(p34, [{ id: 'a', copies: 4 }], 'exact'));
  assert.equal(one.totals.placed, 4); assert.equal(one.totals.sheets, 1);
  const pos = one.pages[0].placements.map((pl) => [pl.photo.x, pl.photo.y]);
  const expected = [[5, 5], [5, 47], [37, 5], [37, 47]]; // 152.4×101.6 landscape, top-left (5 mm margin), columns 1-2
  pos.forEach(([x, y], i) => { assert.ok(Math.abs(x - expected[i][0]) < 1e-6 && Math.abs(y - expected[i][1]) < 1e-6, `slot ${i}: ${x},${y}`); });
  assert.ok(pos[3][0] + 30 < 70 && 152.4 - (pos[3][0] + 30) > 80, 'the right half of the paper stays untouched');
  // two people share the 8-slot sheet (A in columns 1-2, B in 3-4)
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
  assert.equal(p.dpi, 300); assert.equal(p.printBoost, 'medium'); assert.equal(p.fillOrder, 'col-ltr');
  assert.equal(p.orientation, 'auto'); assert.equal(p.perPerson, 'sheet'); assert.equal(p.bgColor, '#ffffff');
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
    quickOverrides: { 'q-3x4-4r': { margin: 3, orientation: 'portrait' } },
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
  for (const p of QUICK_PRESETS) { assert.equal(p.border, true, 'on in every template'); assert.equal(p.borderWidth, 0.1, 'thin by default'); assert.equal(p.borderColor, '#000000'); assert.equal(p.cutOffset, 0.5); }
  assert.equal(normalizeQuickPreset({ photoId: '3x4' }).border, true, 'new templates too');
  assert.equal(normalizeQuickPreset({ border: false }).border, false, 'can still be turned off');
  const p = normalizeQuickPreset({ border: true, borderWidth: 9, borderColor: 'red', photoId: '3x4' });
  assert.equal(p.border, true); assert.equal(p.borderWidth, 2); assert.equal(p.borderColor, '#000000');
  assert.equal(normalizeQuickPreset({ borderWidth: 0.001 }).borderWidth, 0.05);
  assert.equal(normalizeQuickPreset({ borderColor: '#AABBCC' }).borderColor, '#aabbcc');
  const preset = normalizeQuickPreset({ photoId: '3x4', border: true, borderWidth: 0.5, borderColor: '#404040', perPerson: 'sheet' });
  const patch = quickSheetPatch(preset, ['A'], (x) => `${x}1`);
  assert.deepEqual(patch.marks, { cutLines: false, cropMarks: true, borders: true, borderWidth: 0.5, borderColor: '#404040', cutOffset: 0.5, cutUsedOnly: true });
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

test('cut guides sit in the white gap, outside the border, never beyond half the gap', () => {
  const preset = normalizeQuickPreset({ photoId: '3x4', paperId: '4x6in', margin: 5, gap: 2, cutLines: true, cropMarks: true, border: true, borderWidth: 0.1 });
  const patch = quickSheetPatch(preset, ['A'], (x) => `${x}1`);
  const layout = computeLayout(quickLayoutInput(preset, patch.items, 'exact'));
  const page = layout.pages[0];
  const cut = computeMarks(layout, page, patch.marks).under.filter((m) => m.kind === 'cut');
  const vx = [...new Set(cut.filter((m) => m.x1 === m.x2).map((m) => m.x1))].sort((a, b) => a - b);
  const photos = page.placements.map((pl) => pl.photo);
  const cols = [...new Set(photos.map((r) => Math.round(r.x * 1e4) / 1e4))].sort((a, b) => a - b);
  assert.equal(vx.length, cols.length * 2, 'a guide on each side of every column');
  cols.forEach((x, i) => {
    assert.ok(Math.abs(vx[2 * i] - (x - 0.5)) < 1e-6, `left guide of column ${i} is 0.5 mm outside the photo (${vx[2 * i]} vs ${x})`);
    assert.ok(Math.abs(vx[2 * i + 1] - (x + 30 + 0.5)) < 1e-6, `right guide of column ${i}`);
  });
  // adjacent guides across a 2 mm gap are 1 mm apart: scissors have white on both sides, no guide touches a border
  const gapBetween = vx[2] - vx[1];
  assert.ok(Math.abs(gapBetween - 1) < 1e-6, `1 mm of white between neighbouring guides (${gapBetween})`);
  for (const x of vx) for (const r of photos) assert.ok(x <= r.x - 0.1 + 1e-9 || x >= r.x + r.w + 0.1 - 1e-9, 'guide outside every photo frame');
  // offset 0 reproduces the old (edge) positions; a big offset is capped at half the gap
  const edge = computeMarks(layout, page, { cutLines: true, cutOffset: 0 }).under.filter((m) => m.x1 === m.x2).map((m) => m.x1);
  assert.ok(edge.includes(cols[0]) && edge.includes(cols[0] + 30));
  const capped = computeMarks(layout, page, { cutLines: true, cutOffset: 9 }).under.filter((m) => m.x1 === m.x2).map((m) => m.x1);
  assert.ok(Math.abs(Math.min(...capped) - (cols[0] - 1)) < 1e-6, 'capped to half the 2 mm gap');
  // touching photos (gap 0): no offset possible
  const flat = normalizeQuickPreset({ photoId: '3x4', paperId: 'a4', margin: 5, gap: 0, cutLines: true });
  const fl = computeLayout(quickLayoutInput(flat, [{ id: 'a', copies: 4 }], 'exact'));
  const fx = computeMarks(fl, fl.pages[0], { cutLines: true, cutOffset: 0.5 }).under.map((m) => m.x1);
  assert.ok(fl.pages[0].placements.every((pl) => fx.includes(Math.round(pl.photo.x * 1e4) / 1e4)), 'with no gap the guides stay on the photo edges');
  assert.equal(normalizeQuickPreset({ cutOffset: 99 }).cutOffset, 3);
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
    for (const x of [m.x1, m.x2]) assert.ok(x <= right + 0.5 + 1e-6 && x >= left - 0.5 - 1e-6, `cut line x ${x} stays around the printed photos (right edge ${right})`);
    for (const y of [m.y1, m.y2]) assert.ok(y <= bottom + 0.5 + 1e-6 && y >= top - 0.5 - 1e-6, `cut line y ${y} stays around the printed photos`);
  }
  // crop marks also stay next to the printed block (nothing over the empty right half)
  for (const m of under.filter((q) => q.kind === 'crop')) for (const x of [m.x1, m.x2]) assert.ok(x <= right + 0.5 + 1 + 4 + 1e-6, `crop mark x ${x}`);
  // the old behaviour is still available: lines across the whole sheet
  const full = computeMarks(layout, page, { ...patch.marks, cutUsedOnly: false }).under.filter((m) => m.kind === 'cut');
  assert.ok(full.some((m) => m.x2 === layout.sheet.widthMm) && full.some((m) => m.y2 === layout.sheet.heightMm));
  // legacy projects without the option behave as "used only"
  const legacy = computeMarks(layout, page, { cutLines: true }).under.filter((m) => m.kind === 'cut');
  assert.ok(legacy.every((m) => m.x2 <= right + 0.5 + 1e-6));
  assert.equal(normalizeQuickPreset({}).cutUsedOnly, true);
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
  const horiz = marks.filter((m) => m.y1 === m.y2);
  const right = Math.max(...four.pages[0].placements.map((pl) => pl.photo.x + pl.photo.w));
  assert.ok(horiz.length > 0, 'left-side marks stay');
  assert.ok(horiz.every((m) => m.x2 <= first.x), 'no horizontal mark to the right of the printed photos (the free paper)');
  assert.ok(horiz.every((m) => m.x2 < right));
  assert.ok(marks.some((m) => m.x1 === m.x2 && m.y1 > four.pages[0].placements[1].photo.y), 'bottom marks stay (both rows are printed)');
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
