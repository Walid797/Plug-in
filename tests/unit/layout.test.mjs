import test from 'node:test';
import assert from 'node:assert/strict';
import { computeLayout, fitCount, span, compactGrid, computeMarks, sheetDims } from '../../src/core/layout.js';

const P10x15 = { widthMm: 100, heightMm: 150 };
const A4 = { widthMm: 210, heightMm: 297 };
const A5 = { widthMm: 148, heightMm: 210 };
const m = (v) => ({ top: v, right: v, bottom: v, left: v });
const g = (v) => ({ x: v, y: v });
const photo34 = (copies, id = 'p1') => ({ id, widthMm: 30, heightMm: 40, copies });

/** Independent brute-force reference for the plain grid capacity. */
function refGrid(W, H, margin, gap, pw, ph) {
  let cols = 0;
  while ((cols + 1) * pw + cols * gap <= W - 2 * margin + 1e-9) cols += 1;
  let rows = 0;
  while ((rows + 1) * ph + rows * gap <= H - 2 * margin + 1e-9) rows += 1;
  return cols * rows;
}

function assertGeometry(layout, item) {
  const { widthMm: W, heightMm: H } = layout.sheet;
  for (const page of layout.pages) {
    const rects = page.placements.map((p) => p.photo);
    for (const [i, pl] of page.placements.entries()) {
      const r = pl.photo;
      // exact physical size (never shrunk or stretched)
      const expectW = pl.rotation === 90 ? item.heightMm : item.widthMm;
      const expectH = pl.rotation === 90 ? item.widthMm : item.heightMm;
      assert.ok(Math.abs(r.w - expectW) < 1e-9, `width ${r.w} != ${expectW}`);
      assert.ok(Math.abs(r.h - expectH) < 1e-9, `height ${r.h} != ${expectH}`);
      // inside margins
      assert.ok(r.x >= layout.margins.left - 1e-6, `x ${r.x} < margin`);
      assert.ok(r.y >= layout.margins.top - 1e-6, `y ${r.y} < margin`);
      assert.ok(r.x + r.w <= W - layout.margins.right + 1e-6, `right edge ${r.x + r.w} beyond ${W - layout.margins.right}`);
      assert.ok(r.y + r.h <= H - layout.margins.bottom + 1e-6, `bottom edge ${r.y + r.h}`);
      // no overlaps and gaps respected
      for (let j = i + 1; j < rects.length; j += 1) {
        const o = rects[j];
        const sepX = Math.max(o.x - (r.x + r.w), r.x - (o.x + o.w));
        const sepY = Math.max(o.y - (r.y + r.h), r.y - (o.y + o.h));
        assert.ok(sepX >= layout.gap.x - 1e-6 || sepY >= layout.gap.y - 1e-6, 'photos overlap or violate gap');
      }
    }
  }
}

test('fitCount / span basics including exact-edge tolerance', () => {
  assert.equal(fitCount(94, 30, 2), 3); // 3*30 + 2*2 = 94 exactly
  assert.equal(fitCount(93.999, 30, 2), 2);
  assert.equal(fitCount(29.9, 30, 2), 0);
  assert.equal(fitCount(0.1 + 0.2 + 29.7, 30, 0), 1); // floating noise must not lose a cell
  assert.equal(span(3, 30, 2), 94);
  assert.equal(span(0, 30, 2), 0);
});

test('sheetDims orientation', () => {
  assert.deepEqual(sheetDims(P10x15, 'portrait'), { widthMm: 100, heightMm: 150 });
  assert.deepEqual(sheetDims(P10x15, 'landscape'), { widthMm: 150, heightMm: 100 });
  assert.deepEqual(sheetDims({ widthMm: 150, heightMm: 100 }, 'portrait'), { widthMm: 100, heightMm: 150 });
});

test('10×15 cm with 3×4 cm photos: portrait vs landscape are computed, never hard-coded', () => {
  const cases = [];
  for (const margin of [0, 2, 3, 4, 5, 6, 8]) {
    for (const gap of [0, 1, 2, 3, 4]) {
      for (const orientation of ['portrait', 'landscape']) {
        const r = computeLayout({ paper: P10x15, orientation, margins: m(margin), gap: g(gap), items: [photo34(1)], mode: 'fill' });
        const dims = sheetDims(P10x15, orientation);
        const expected = refGrid(dims.widthMm, dims.heightMm, margin, gap, 30, 40);
        if (expected === 0) {
          assert.equal(r.ok, false);
        } else {
          assert.equal(r.ok, true, JSON.stringify(r.errors));
          assert.equal(r.capacity, expected, `margin ${margin} gap ${gap} ${orientation}`);
          assertGeometry(r, { widthMm: 30, heightMm: 40 });
        }
        cases.push({ margin, gap, orientation, expected });
      }
    }
  }
  // Known facts that follow from the arithmetic (documented in the print guide):
  const cap = (margin, gap, o) => cases.find((c) => c.margin === margin && c.gap === gap && c.orientation === o).expected;
  assert.equal(cap(5, 2, 'portrait'), 6); // 2 cols (3rd needs 94 mm > 90 mm) × 3 rows
  assert.equal(cap(5, 2, 'landscape'), 8); // 4 cols × 2 rows
  assert.equal(cap(3, 2, 'portrait'), 9); // 94 mm needed, 94 mm available → 3 cols
  assert.equal(cap(3, 2, 'landscape'), 8);
  assert.equal(cap(0, 0, 'landscape'), 10);
  assert.equal(cap(8, 2, 'landscape'), 8);
  assert.equal(cap(8, 4, 'landscape'), 8); // 4×30+3×4 = 132 ≤ 134 and 2×40+4 = 84 ≤ 84 (exact edge)
  assert.equal(cap(8, 4, 'portrait'), 6); // 2 cols (3rd needs 98 > 84) × 3 rows (3×40+2×4 = 128 ≤ 134)
});

test('10×15 auto orientation picks the better fit and explains both', () => {
  const r = computeLayout({ paper: P10x15, orientation: 'auto', margins: m(5), gap: g(2), items: [photo34(8)] });
  assert.equal(r.ok, true);
  assert.equal(r.orientation, 'landscape');
  assert.equal(r.capacity, 8);
  assert.equal(r.totals.placed, 8);
  assert.equal(r.totals.sheets, 1);
  assert.equal(r.analysis.portrait.capacity, 6);
  assert.equal(r.analysis.portrait.needWForNextCol, 94);
  assert.equal(r.analysis.portrait.availW, 90);
  assert.equal(r.analysis.landscape.capacity, 8);
  // centred: equal left/right and top/bottom residual margins
  const xs = r.pages[0].placements.map((p) => p.photo.x);
  const right = 150 - Math.max(...r.pages[0].placements.map((p) => p.photo.x + p.photo.w));
  assert.ok(Math.abs(Math.min(...xs) - right) < 1e-9);
});

test('10×15 portrait with 5 mm margins cannot fit 8 unrotated → warns other orientation is better', () => {
  const r = computeLayout({ paper: P10x15, orientation: 'portrait', margins: m(5), gap: g(2), items: [photo34(8)] });
  assert.equal(r.ok, true);
  assert.equal(r.capacity, 6);
  assert.equal(r.totals.sheets, 2); // paginates instead of shrinking
  assert.equal(r.totals.placed, 8);
  assert.ok(r.warnings.some((w) => w.code === 'OTHER_ORIENTATION_BETTER' && w.capacity === 8));
});

test('rotation only used when it improves the fit, never changes photo size', () => {
  const r = computeLayout({ paper: P10x15, orientation: 'portrait', margins: m(5), gap: g(2), items: [photo34(8)], allowRotation: true });
  assert.equal(r.ok, true);
  assert.equal(r.totals.sheets, 1);
  assert.equal(r.totals.placed, 8);
  assertGeometry(r, { widthMm: 30, heightMm: 40 });
  // with 4 copies the plain grid suffices → no rotation
  const r4 = computeLayout({ paper: P10x15, orientation: 'portrait', margins: m(5), gap: g(2), items: [photo34(4)], allowRotation: true });
  assert.equal(r4.pages[0].placements.filter((p) => p.rotation).length, 0);
  // zero margins: mixed block packs 11
  const r0 = computeLayout({ paper: P10x15, orientation: 'portrait', margins: m(0), gap: g(0), items: [photo34(1)], allowRotation: true, mode: 'fill' });
  assert.equal(r0.capacity, 11);
  assertGeometry(r0, { widthMm: 30, heightMm: 40 });
});

test('exact counts 2/4/6/8/12 and custom on A4, A5 and 10×15', () => {
  for (const paper of [A4, A5, P10x15]) {
    for (const copies of [1, 2, 4, 6, 8, 12, 16, 20, 37]) {
      for (const orientation of ['portrait', 'landscape', 'auto']) {
        const r = computeLayout({ paper, orientation, margins: m(5), gap: g(2), items: [photo34(copies)] });
        assert.equal(r.ok, true);
        assert.equal(r.totals.placed, copies, `${copies} on ${paper.widthMm}`);
        assert.equal(r.totals.sheets, Math.ceil(copies / r.capacity));
        assert.ok(r.pages.every((p) => p.placements.length > 0), 'no blank pages');
        assertGeometry(r, { widthMm: 30, heightMm: 40 });
      }
    }
  }
});

test('A4 3×4 capacity matches arithmetic', () => {
  const r = computeLayout({ paper: A4, orientation: 'portrait', margins: m(10), gap: g(3), items: [photo34(1)], mode: 'fill' });
  assert.equal(r.capacity, refGrid(210, 297, 10, 3, 30, 40)); // 5 × 6 = 30
  assert.equal(r.capacity, 30);
});

test('over-capacity pagination: exact sheet count and last page holds remainder', () => {
  const r = computeLayout({ paper: P10x15, orientation: 'landscape', margins: m(5), gap: g(2), items: [photo34(21)] });
  assert.equal(r.capacity, 8);
  assert.equal(r.totals.sheets, 3);
  assert.deepEqual(r.pages.map((p) => p.placements.length), [8, 8, 5]);
  // last page uses the same slot positions as full pages (consistent cutting)
  const first = r.pages[0].placements.slice(0, 5).map((p) => [p.photo.x, p.photo.y]);
  const last = r.pages[2].placements.map((p) => [p.photo.x, p.photo.y]);
  assert.deepEqual(last, first);
});

test('compact grid for small exact counts', () => {
  assert.deepEqual(compactGrid(4, 3, 3), { cols: 2, rows: 2, empty: 0 });
  assert.deepEqual(compactGrid(6, 3, 3), { cols: 3, rows: 2, empty: 0 });
  assert.deepEqual(compactGrid(2, 4, 2), { cols: 2, rows: 1, empty: 0 });
  const r = computeLayout({ paper: P10x15, orientation: 'portrait', margins: m(3), gap: g(2), items: [photo34(4)] });
  assert.equal(r.pages[0].placements.length, 4);
  assert.equal(r.compacted, true);
});

test('multiple distinct photos with individual copy counts — exact totals and order', () => {
  const items = [photo34(3, 'a'), photo34(5, 'b'), photo34(2, 'c')];
  const r = computeLayout({ paper: P10x15, orientation: 'landscape', margins: m(5), gap: g(2), items });
  assert.equal(r.ok, true);
  assert.deepEqual(r.totals.perItem, { a: 3, b: 5, c: 2 });
  assert.equal(r.totals.placed, 10);
  assert.equal(r.totals.sheets, 2);
  const order = r.pages.flatMap((p) => p.placements.map((pl) => pl.itemId));
  assert.deepEqual(order, ['a', 'a', 'a', 'b', 'b', 'b', 'b', 'b', 'c', 'c']);
  // removing an item from the sheet just drops its copies
  const r2 = computeLayout({ paper: P10x15, orientation: 'landscape', margins: m(5), gap: g(2), items: [items[0], items[2]] });
  assert.deepEqual(r2.totals.perItem, { a: 3, c: 2 });
  // zero copies of one item is allowed
  const r3 = computeLayout({ paper: P10x15, orientation: 'landscape', margins: m(5), gap: g(2), items: [photo34(0, 'a'), photo34(2, 'b')] });
  assert.equal(r3.totals.placed, 2);
});

test('fill mode distributes a full sheet across photos', () => {
  const r = computeLayout({ paper: P10x15, orientation: 'landscape', margins: m(5), gap: g(2), items: [photo34(1, 'a'), photo34(1, 'b'), photo34(1, 'c')], mode: 'fill' });
  assert.deepEqual(r.totals.perItem, { a: 3, b: 3, c: 2 });
  assert.equal(r.totals.sheets, 1);
});

test('RTL fill order starts at the right; LTR at the left', () => {
  const base = { paper: P10x15, orientation: 'landscape', margins: m(5), gap: g(2), items: [photo34(8)] };
  const rtl = computeLayout({ ...base, fillOrder: 'rtl' });
  const ltr = computeLayout({ ...base, fillOrder: 'ltr' });
  const xr = rtl.pages[0].placements.map((p) => p.photo.x);
  const xl = ltr.pages[0].placements.map((p) => p.photo.x);
  assert.ok(xr[0] > xr[1]);
  assert.ok(xl[0] < xl[1]);
});

test('manual rows/columns validated, never shrunk', () => {
  const ok = computeLayout({ paper: P10x15, orientation: 'landscape', margins: m(5), gap: g(2), items: [photo34(6)], grid: { cols: 3, rows: 2 } });
  assert.equal(ok.ok, true);
  assert.equal(ok.capacity, 6);
  const bad = computeLayout({ paper: P10x15, orientation: 'landscape', margins: m(5), gap: g(2), items: [photo34(6)], grid: { cols: 5, rows: 2 } });
  assert.equal(bad.ok, false);
  const e = bad.errors.find((x) => x.code === 'GRID_TOO_WIDE');
  assert.ok(e);
  assert.equal(e.need, 5 * 30 + 4 * 2);
  assert.equal(e.avail, 140);
});

test('alignment modes and custom offset validation', () => {
  const base = { paper: P10x15, orientation: 'landscape', margins: m(5), gap: g(2), items: [photo34(2)], fillOrder: 'ltr' };
  const tl = computeLayout({ ...base, align: { mode: 'top-left' } });
  assert.equal(tl.pages[0].placements[0].photo.x, 5);
  assert.equal(tl.pages[0].placements[0].photo.y, 5);
  const tr = computeLayout({ ...base, align: { mode: 'top-right' } });
  const maxRight = Math.max(...tr.pages[0].placements.map((p) => p.photo.x + p.photo.w));
  assert.ok(Math.abs(maxRight - 145) < 1e-9);
  const custom = computeLayout({ ...base, align: { mode: 'custom', offsetX: 10, offsetY: 7 } });
  assert.equal(custom.pages[0].placements[0].photo.x, 15);
  assert.equal(custom.pages[0].placements[0].photo.y, 12);
  const bad = computeLayout({ ...base, align: { mode: 'custom', offsetX: 200, offsetY: 0 } });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((x) => x.code === 'CUSTOM_OFFSET_OUT_OF_RANGE'));
});

test('photo that cannot fit is reported, not shrunk', () => {
  const r = computeLayout({ paper: P10x15, orientation: 'portrait', margins: m(5), gap: g(2), items: [{ id: 'big', widthMm: 120, heightMm: 160, copies: 1 }] });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'PHOTO_DOES_NOT_FIT'));
  const r2 = computeLayout({ paper: P10x15, margins: m(60), gap: g(2), items: [photo34(1)] });
  assert.equal(r2.ok, false);
  assert.ok(r2.errors.some((e) => e.code === 'AREA_TOO_SMALL'));
});

test('input validation', () => {
  assert.ok(computeLayout({ paper: P10x15, items: [] }).errors.some((e) => e.code === 'NO_ITEMS'));
  assert.ok(computeLayout({ paper: { widthMm: -1, heightMm: 10 }, items: [photo34(1)] }).errors.some((e) => e.code === 'PAPER_INVALID'));
  assert.ok(computeLayout({ paper: P10x15, items: [photo34(1.5)] }).errors.some((e) => e.code === 'COPIES_INVALID'));
  assert.ok(computeLayout({ paper: P10x15, margins: m(-2), items: [photo34(1)] }).errors.some((e) => e.code === 'MARGIN_INVALID'));
  assert.ok(computeLayout({ paper: P10x15, gap: g(NaN), items: [photo34(1)] }).errors.some((e) => e.code === 'GAP_INVALID'));
  assert.ok(computeLayout({ paper: P10x15, items: [photo34(0)] }).errors.some((e) => e.code === 'COPIES_ZERO'));
  assert.ok(computeLayout({ paper: P10x15, items: [photo34(6000)] }).errors.some((e) => e.code === 'COPIES_INVALID'));
});

test('too many pages is refused', () => {
  const r = computeLayout({ paper: P10x15, orientation: 'landscape', margins: m(5), gap: g(2), items: [{ id: 'x', widthMm: 90, heightMm: 130, copies: 4000 }] });
  assert.equal(r.ok, false);
});

test('mixed photo sizes on one sheet (shelf packing) keep exact sizes', () => {
  const items = [
    { id: 'a', widthMm: 30, heightMm: 40, copies: 4 },
    { id: 'b', widthMm: 50.8, heightMm: 50.8, copies: 2 },
    { id: 'c', widthMm: 35, heightMm: 45, copies: 3 },
  ];
  const r = computeLayout({ paper: A4, orientation: 'portrait', margins: m(8), gap: g(3), items });
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'shelf');
  assert.deepEqual(r.totals.perItem, { a: 4, b: 2, c: 3 });
  for (const pg of r.pages) {
    for (const pl of pg.placements) {
      const it = items.find((i) => i.id === pl.itemId);
      assert.ok(Math.abs(pl.photo.w - it.widthMm) < 1e-9 && Math.abs(pl.photo.h - it.heightMm) < 1e-9);
    }
  }
  const fill = computeLayout({ paper: P10x15, orientation: 'portrait', margins: m(5), gap: g(2), items: items.map((i) => ({ ...i, copies: 1 })), mode: 'fill' });
  assert.equal(fill.ok, true);
  assert.equal(fill.totals.sheets, 1);
  assert.ok(fill.totals.placed >= 3);
});

test('labels add height below each photo and are accounted for in capacity', () => {
  const r = computeLayout({ paper: P10x15, orientation: 'landscape', margins: m(5), gap: g(2), items: [photo34(8)], label: { enabled: true, heightMm: 4, gapMm: 1 } });
  // cell height 45 → rows = floor((90+2)/47) = 1 → 4 per sheet
  assert.equal(r.capacity, 4);
  const pl = r.pages[0].placements[0];
  assert.equal(pl.label.y, pl.photo.y + 40 + 1);
  assert.equal(pl.label.h, 4);
});

test('printer hard-margin warnings', () => {
  const r = computeLayout({ paper: P10x15, orientation: 'landscape', margins: m(1), gap: g(0), items: [photo34(10)], align: { mode: 'top-left' }, printer: { borderless: false, hardMargins: m(3) } });
  assert.ok(r.warnings.some((w) => w.code === 'MARGINS_BELOW_PRINTER'));
  assert.ok(r.warnings.some((w) => w.code === 'PRINTER_MARGIN_CLIP'));
  const b = computeLayout({ paper: P10x15, orientation: 'landscape', margins: m(1), gap: g(0), items: [photo34(10)], align: { mode: 'top-left' }, printer: { borderless: true, hardMargins: m(3) } });
  assert.ok(!b.warnings.some((w) => w.code === 'PRINTER_MARGIN_CLIP'));
});

test('marks: cut lines along edges, crop marks stay in margins', () => {
  const r = computeLayout({ paper: P10x15, orientation: 'landscape', margins: m(5), gap: g(2), items: [photo34(8)] });
  const marks = computeMarks(r, r.pages[0], { cutLines: true, cropMarks: true, borders: true });
  assert.ok(marks.under.some((s) => s.kind === 'cut'));
  const rects = r.pages[0].placements.map((p) => p.photo);
  for (const s of marks.under.filter((x) => x.kind === 'crop')) {
    for (const rc of rects) {
      const inside = (x, y) => x > rc.x + 1e-6 && x < rc.x + rc.w - 1e-6 && y > rc.y + 1e-6 && y < rc.y + rc.h - 1e-6;
      assert.ok(!inside((s.x1 + s.x2) / 2, (s.y1 + s.y2) / 2), 'crop mark over a photo');
    }
  }
  assert.equal(marks.over.length, 8);
});

test('column-by-column fill (studio request): 1 top-left, 2 below it, 3 next column…', () => {
  const base = { paper: P10x15, orientation: 'landscape', margins: m(5), gap: g(2), items: [photo34(4)] };
  const pos = (r) => r.pages[0].placements.map((p) => [p.photo.x, p.photo.y]);
  // full-sheet positions are kept (no compaction): unused paper stays in one piece
  assert.deepEqual(pos(computeLayout({ ...base, fillOrder: 'col-ltr' })), [[12, 9], [12, 51], [44, 9], [44, 51]]);
  assert.deepEqual(pos(computeLayout({ ...base, fillOrder: 'col-ltr', align: { mode: 'top-left' } })), [[5, 5], [5, 47], [37, 5], [37, 47]]);
  assert.deepEqual(pos(computeLayout({ ...base, fillOrder: 'col-rtl' })), [[108, 9], [108, 51], [76, 9], [76, 51]]);
  const full = computeLayout({ ...base, fillOrder: 'col-ltr', items: [photo34(8)] });
  assert.deepEqual(pos(full).map(([x]) => x), [12, 12, 44, 44, 76, 76, 108, 108]);
  // pagination keeps the same order on the last page
  const many = computeLayout({ ...base, orientation: 'landscape', fillOrder: 'col-ltr', items: [photo34(21)] });
  assert.deepEqual(many.pages[2].placements.map((p) => [p.photo.x, p.photo.y]), [[12, 9], [12, 51], [44, 9], [44, 51], [76, 9]]);
  // row orders are unchanged
  assert.equal(computeLayout({ ...base, fillOrder: 'rtl' }).compacted, true);
});
