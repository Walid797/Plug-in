import test from 'node:test';
import assert from 'node:assert/strict';
import { printBoostLut, printBoostValue, applyLut, PRINT_BOOST_IDS, PRINT_BOOST_LEVELS, isPrintBoost } from '../../src/core/adjust.js';
import { autoExposureDelta, AUTO_LIGHT, QUALITY_THRESHOLDS } from '../../src/core/idphoto.js';
import { QUICK_PRESETS, QUICK_SHEET, presetCapacity, quickSheetPatch, quickLayoutInput, findQuickPreset } from '../../src/core/quickpresets.js';
import { computeLayout } from '../../src/core/layout.js';
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
    const hm = QUICK_SHEET.printer.hardMargins;
    for (const pl of l.pages[0].placements) {
      assert.equal(pl.photoSizeMm.w, photo.widthMm); assert.equal(pl.photoSizeMm.h, photo.heightMm);
      assert.ok(pl.photo.x >= hm.left && pl.photo.y >= hm.top);
      assert.ok(pl.photo.x + pl.photo.w <= l.sheet.widthMm - hm.right + 1e-9 && pl.photo.y + pl.photo.h <= l.sheet.heightMm - hm.bottom + 1e-9);
    }
  }
  assert.equal(findPaper('4x6in').widthMm, 101.6);
  assert.equal(QUICK_SHEET.printBoost, 'medium');
  assert.equal(QUICK_SHEET.fillOrder, 'col-ltr');
});

test('quick preset sheet: one full sheet per person, or an even share on A4', () => {
  let n = 0; const id = (p) => `${p}${(n += 1)}`;
  const per = quickSheetPatch(findQuickPreset('q-3x4-4r'), ['A', 'B'], id);
  assert.equal(per.mode, 'exact');
  assert.deepEqual(per.items.map((i) => [i.photoId, i.copies]), [['A', 8], ['B', 8]]);
  assert.equal(per.paperId, '4x6in');
  assert.equal(per.label.enabled, false);
  const l = computeLayout(quickLayoutInput(findQuickPreset('q-3x4-4r'), per.items, 'exact'));
  assert.equal(l.totals.sheets, 2);
  for (const page of l.pages) assert.equal(new Set(page.placements.map((pl) => pl.itemId)).size, 1, 'each sheet holds one person');
  const share = quickSheetPatch(findQuickPreset('q-3x4-a4'), ['A', 'B', 'C'], id);
  assert.equal(share.mode, 'fill');
  const l2 = computeLayout(quickLayoutInput(findQuickPreset('q-3x4-a4'), share.items, 'fill'));
  assert.deepEqual(Object.values(l2.totals.perItem), [12, 12, 12]);
});
