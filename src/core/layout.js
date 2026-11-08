// Print layout engine.
//
// All geometry is in millimetres with the origin at the TOP-LEFT corner of the
// physical sheet as it comes out of the printer. The engine never scales,
// stretches or crops a photo: every placement has exactly the requested
// physical width and height (rotated photos swap the two, nothing else).
//
// The same layout object feeds the on-screen preview, the browser print DOM and
// the PDF writer, so preview and output share identical geometry.

import { EPS } from './units.js';

export const LIMITS = Object.freeze({
  paperMin: 10, paperMax: 2000,
  photoMin: 5, photoMax: 1000,
  marginMax: 200, gapMax: 100,
  copiesMax: 5000, pagesMax: 500,
});

const DEFAULTS = Object.freeze({
  orientation: 'auto',
  margins: { top: 5, right: 5, bottom: 5, left: 5 },
  gap: { x: 2, y: 2 },
  mode: 'exact',
  allowRotation: false,
  grid: { cols: null, rows: null, rotated: false },
  align: { mode: 'center', offsetX: 0, offsetY: 0 },
  fillOrder: 'rtl',
  compact: true,
  label: { enabled: false, heightMm: 4, gapMm: 1 },
  printer: { borderless: false, hardMargins: { top: 3, right: 3, bottom: 3, left: 3 } },
});

/** Number of cells of `size` with `gap` between them that fit in `avail`. */
export function fitCount(avail, size, gap) {
  if (!(size > 0) || avail + EPS < size) return 0;
  return Math.floor((avail + gap + EPS) / (size + gap));
}

/** Physical span of n cells with gaps between them. */
export function span(n, size, gap) {
  return n > 0 ? n * size + (n - 1) * gap : 0;
}

/** Sheet dimensions for an orientation. Portrait = short side horizontal. */
export function sheetDims(paper, orientation) {
  const a = Math.min(paper.widthMm, paper.heightMm);
  const b = Math.max(paper.widthMm, paper.heightMm);
  return orientation === 'landscape' ? { widthMm: b, heightMm: a } : { widthMm: a, heightMm: b };
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const inRange = (v, lo, hi) => isNum(v) && v >= lo && v <= hi;

function normalize(input) {
  const errors = [];
  const cfg = {
    paper: input.paper,
    orientation: input.orientation ?? DEFAULTS.orientation,
    margins: { ...DEFAULTS.margins, ...(input.margins || {}) },
    gap: { ...DEFAULTS.gap, ...(input.gap || {}) },
    mode: input.mode ?? DEFAULTS.mode,
    allowRotation: !!(input.allowRotation ?? DEFAULTS.allowRotation),
    grid: { ...DEFAULTS.grid, ...(input.grid || {}) },
    align: { ...DEFAULTS.align, ...(input.align || {}) },
    fillOrder: input.fillOrder ?? DEFAULTS.fillOrder,
    compact: input.compact ?? DEFAULTS.compact,
    label: { ...DEFAULTS.label, ...(input.label || {}) },
    printer: {
      borderless: !!input.printer?.borderless,
      hardMargins: { ...DEFAULTS.printer.hardMargins, ...(input.printer?.hardMargins || {}) },
    },
    items: (input.items || []).map((it) => ({ ...it })),
  };

  const p = cfg.paper;
  if (!p || !inRange(p.widthMm, LIMITS.paperMin, LIMITS.paperMax) || !inRange(p.heightMm, LIMITS.paperMin, LIMITS.paperMax)) {
    errors.push({ code: 'PAPER_INVALID' });
  }
  for (const side of ['top', 'right', 'bottom', 'left']) {
    if (!inRange(cfg.margins[side], 0, LIMITS.marginMax)) errors.push({ code: 'MARGIN_INVALID', side });
  }
  for (const axis of ['x', 'y']) {
    if (!inRange(cfg.gap[axis], 0, LIMITS.gapMax)) errors.push({ code: 'GAP_INVALID', axis });
  }
  if (!['portrait', 'landscape', 'auto'].includes(cfg.orientation)) cfg.orientation = 'auto';
  if (!['exact', 'fill'].includes(cfg.mode)) cfg.mode = 'exact';
  if (!['center', 'top-left', 'top-right', 'custom'].includes(cfg.align.mode)) cfg.align.mode = 'center';
  // rtl/ltr = row by row (from the right / left); col-ltr/col-rtl = column by column,
  // top to bottom, starting at the left / right column.
  if (!['rtl', 'ltr', 'col-ltr', 'col-rtl'].includes(cfg.fillOrder)) cfg.fillOrder = 'rtl';
  if (cfg.label.enabled && (!inRange(cfg.label.heightMm, 1, 50) || !inRange(cfg.label.gapMm, 0, 20))) {
    errors.push({ code: 'LABEL_INVALID' });
  }
  if (cfg.items.length === 0) errors.push({ code: 'NO_ITEMS' });
  let totalCopies = 0;
  for (const it of cfg.items) {
    if (!inRange(it.widthMm, LIMITS.photoMin, LIMITS.photoMax) || !inRange(it.heightMm, LIMITS.photoMin, LIMITS.photoMax)) {
      errors.push({ code: 'ITEM_SIZE_INVALID', itemId: it.id });
    }
    if (cfg.mode === 'exact' && !(Number.isInteger(it.copies) && it.copies >= 0 && it.copies <= LIMITS.copiesMax)) {
      errors.push({ code: 'COPIES_INVALID', itemId: it.id });
    }
    totalCopies += Number.isInteger(it.copies) ? it.copies : 0;
  }
  if (cfg.mode === 'exact' && totalCopies > LIMITS.copiesMax) errors.push({ code: 'COPIES_TOO_MANY', total: totalCopies });
  if (cfg.mode === 'exact' && cfg.items.length > 0 && totalCopies === 0) errors.push({ code: 'COPIES_ZERO' });
  for (const k of ['cols', 'rows']) {
    const v = cfg.grid[k];
    if (v != null && v !== '' && !(Number.isInteger(v) && v >= 1 && v <= 200)) errors.push({ code: 'GRID_INVALID', axis: k });
    if (v === '' || v === 0) cfg.grid[k] = null;
  }
  if (cfg.align.mode === 'custom' && (!isNum(cfg.align.offsetX) || !isNum(cfg.align.offsetY) || cfg.align.offsetX < 0 || cfg.align.offsetY < 0)) {
    errors.push({ code: 'CUSTOM_OFFSET_INVALID' });
  }
  return { cfg, errors };
}

function labelExtra(cfg) {
  return cfg.label.enabled ? cfg.label.gapMm + cfg.label.heightMm : 0;
}

/** Cell = photo footprint (+ label strip). Rotation swaps photo width/height only. */
function cellDims(item, rotated, extra) {
  const pw = rotated ? item.heightMm : item.widthMm;
  const ph = rotated ? item.widthMm : item.heightMm;
  return { w: pw, h: ph + extra, pw, ph, rotated };
}

function gridSlots(cols, rows, cell, gx, gy, x0, y0, block) {
  const slots = [];
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      slots.push({
        x: x0 + c * (cell.w + gx), y: y0 + r * (cell.h + gy), w: cell.w, h: cell.h,
        pw: cell.pw, ph: cell.ph, rotated: cell.rotated, row: r, col: c, block,
      });
    }
  }
  return slots;
}

function bbox(slots) {
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const s of slots) {
    minX = Math.min(minX, s.x); minY = Math.min(minY, s.y);
    maxX = Math.max(maxX, s.x + s.w); maxY = Math.max(maxY, s.y + s.h);
  }
  if (!slots.length) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

const KIND_RANK = { grid: 0, 'grid-rotated': 1, mixed: 2, manual: 0 };

/** All candidate arrangements for a single photo size within an available area. */
export function uniformCandidates(aw, ah, item, gx, gy, extra, allowRotation) {
  const c0 = cellDims(item, false, extra);
  const c1 = cellDims(item, true, extra);
  const cands = [];
  const push = (kind, slots, meta) => {
    if (!slots.length) return;
    cands.push({ kind, slots, capacity: slots.length, rotatedCount: slots.filter((s) => s.rotated).length, ...meta });
  };
  const cols0 = fitCount(aw, c0.w, gx);
  const rows0 = fitCount(ah, c0.h, gy);
  push('grid', gridSlots(cols0, rows0, c0, gx, gy, 0, 0, 0), { cols: cols0, rows: rows0, cell: c0 });
  if (!allowRotation) return cands;

  const cols1 = fitCount(aw, c1.w, gx);
  const rows1 = fitCount(ah, c1.h, gy);
  push('grid-rotated', gridSlots(cols1, rows1, c1, gx, gy, 0, 0, 0), { cols: cols1, rows: rows1, cell: c1 });

  // Two-block guillotine arrangements: a primary grid plus a strip of the other rotation.
  for (const [p, s] of [[c0, c1], [c1, c0]]) {
    const pc = fitCount(aw, p.w, gx);
    const pr = fitCount(ah, p.h, gy);
    if (!pc || !pr) continue;
    for (let k = 1; k <= pr; k += 1) { // k primary rows on top, strip below
      const used = span(k, p.h, gy);
      const rem = ah - used - gy;
      const sc = fitCount(aw, s.w, gx);
      const sr = rem > 0 ? fitCount(rem, s.h, gy) : 0;
      if (!sc || !sr) continue;
      push('mixed', [
        ...gridSlots(pc, k, p, gx, gy, 0, 0, 0),
        ...gridSlots(sc, sr, s, gx, gy, 0, used + gy, 1),
      ], { split: 'horizontal', k });
    }
    for (let k = 1; k <= pc; k += 1) { // k primary columns, strip beside
      const used = span(k, p.w, gx);
      const rem = aw - used - gx;
      const sc = rem > 0 ? fitCount(rem, s.w, gx) : 0;
      const sr = fitCount(ah, s.h, gy);
      if (!sc || !sr) continue;
      push('mixed', [
        ...gridSlots(k, pr, p, gx, gy, 0, 0, 0),
        ...gridSlots(sc, sr, s, gx, gy, used + gx, 0, 1),
      ], { split: 'vertical', k });
    }
  }
  return cands;
}

function compareCandidates(a, b, mode, total) {
  if (mode === 'exact') {
    const pa = Math.ceil(total / a.capacity);
    const pb = Math.ceil(total / b.capacity);
    if (pa !== pb) return pa - pb;
    // Only rotate when it actually reduces the number of sheets.
    const ra = Math.min(a.rotatedCount, Math.max(0, total - (a.capacity - a.rotatedCount)));
    const rb = Math.min(b.rotatedCount, Math.max(0, total - (b.capacity - b.rotatedCount)));
    if (pa === 1 && ra !== rb) return ra - rb;
  } else if (a.capacity !== b.capacity) {
    return b.capacity - a.capacity;
  }
  if (a.rotatedCount !== b.rotatedCount) return a.rotatedCount - b.rotatedCount;
  if (KIND_RANK[a.kind] !== KIND_RANK[b.kind]) return KIND_RANK[a.kind] - KIND_RANK[b.kind];
  return b.capacity - a.capacity;
}

/** Smallest tidy grid for `total` photos inside a maxCols × maxRows grid. */
export function compactGrid(total, maxCols, maxRows) {
  let best = null;
  for (let cols = 1; cols <= Math.min(maxCols, total); cols += 1) {
    const rows = Math.ceil(total / cols);
    if (rows > maxRows) continue;
    const empty = cols * rows - total;
    if (!best || empty < best.empty || (empty === best.empty && cols > best.cols)) best = { cols, rows, empty };
  }
  return best;
}

function alignOffset(cfg, aw, ah, box, errors) {
  const { mode, offsetX, offsetY } = cfg.align;
  if (mode === 'top-left') return { x: -box.x, y: -box.y };
  if (mode === 'top-right') return { x: aw - box.w - box.x, y: -box.y };
  if (mode === 'custom') {
    if (offsetX + box.w > aw + EPS || offsetY + box.h > ah + EPS) {
      errors.push({ code: 'CUSTOM_OFFSET_OUT_OF_RANGE', maxX: Math.max(0, aw - box.w), maxY: Math.max(0, ah - box.h) });
      return { x: (aw - box.w) / 2 - box.x, y: (ah - box.h) / 2 - box.y };
    }
    return { x: offsetX - box.x, y: offsetY - box.y };
  }
  return { x: (aw - box.w) / 2 - box.x, y: (ah - box.h) / 2 - box.y };
}

export const isColumnOrder = (o) => o === 'col-ltr' || o === 'col-rtl';

/**
 * Apply a fill order to grid slots.
 *  rtl: row by row, starting at the right (mirrored positions)
 *  ltr: row by row, starting at the left
 *  col-ltr / col-rtl: column by column (top → bottom), first column at the left / right
 */
export function orderSlots(slots, fillOrder) {
  if (fillOrder === 'rtl') return mirror(slots);
  if (!isColumnOrder(fillOrder)) return slots;
  const dir = fillOrder === 'col-ltr' ? 1 : -1;
  return [...slots].sort((a, b) => (Math.abs(a.x - b.x) > EPS ? dir * (a.x - b.x) : a.y - b.y));
}

/** Mirror slot x coordinates inside their bounding box (right-to-left fill). */
function mirror(slots) {
  const b = bbox(slots);
  return slots.map((s) => ({ ...s, x: b.x + b.x + b.w - s.x - s.w }));
}

function availArea(sheet, m) {
  return { x: m.left, y: m.top, w: sheet.widthMm - m.left - m.right, h: sheet.heightMm - m.top - m.bottom };
}

/** Per-orientation explanation data for the uniform-size case (drives the UI text). */
function analyseOrientation(cfg, orientation, item) {
  const sheet = sheetDims(cfg.paper, orientation);
  const a = availArea(sheet, cfg.margins);
  const extra = labelExtra(cfg);
  const c0 = cellDims(item, false, extra);
  const c1 = cellDims(item, true, extra);
  const cols = fitCount(a.w, c0.w, cfg.gap.x);
  const rows = fitCount(a.h, c0.h, cfg.gap.y);
  const rcols = fitCount(a.w, c1.w, cfg.gap.x);
  const rrows = fitCount(a.h, c1.h, cfg.gap.y);
  const cands = a.w > 0 && a.h > 0 ? uniformCandidates(a.w, a.h, item, cfg.gap.x, cfg.gap.y, extra, cfg.allowRotation) : [];
  const best = cands.length ? Math.max(...cands.map((c) => c.capacity)) : 0;
  return {
    orientation,
    sheetW: sheet.widthMm, sheetH: sheet.heightMm,
    availW: a.w, availH: a.h,
    cols, rows, capacity: cols * rows,
    needWForNextCol: span(cols + 1, c0.w, cfg.gap.x),
    needHForNextRow: span(rows + 1, c0.h, cfg.gap.y),
    usedW: span(cols, c0.w, cfg.gap.x), usedH: span(rows, c0.h, cfg.gap.y),
    rotated: { cols: rcols, rows: rrows, capacity: rcols * rrows },
    bestCapacity: best,
  };
}

function sameSize(items) {
  const f = items[0];
  return items.every((it) => Math.abs(it.widthMm - f.widthMm) < EPS && Math.abs(it.heightMm - f.heightMm) < EPS);
}

function distributeFill(items, totalSlots) {
  const n = items.length;
  const base = Math.floor(totalSlots / n);
  const rem = totalSlots % n;
  return items.map((it, i) => ({ ...it, copies: base + (i < rem ? 1 : 0) }));
}

function expandPieces(items) {
  const pieces = [];
  for (const it of items) for (let c = 0; c < it.copies; c += 1) pieces.push({ item: it, copyIndex: c });
  return pieces;
}

function makePlacement(piece, slot, absX, absY, cfg, globalIndex) {
  const extra = labelExtra(cfg);
  const photo = { x: absX, y: absY, w: slot.pw, h: slot.ph };
  return {
    itemId: piece.item.id,
    copyIndex: piece.copyIndex,
    index: globalIndex,
    rotation: slot.rotated ? 90 : 0,
    cell: { x: absX, y: absY, w: slot.w, h: slot.h },
    photo,
    // The photo's own (unrotated) physical size — what the customer receives.
    photoSizeMm: { w: piece.item.widthMm, h: piece.item.heightMm },
    label: extra > 0 ? { x: absX, y: absY + slot.ph + cfg.label.gapMm, w: slot.w, h: cfg.label.heightMm } : null,
  };
}

function layoutUniform(cfg, sheet, orientation, items, errors, warnings) {
  const a = availArea(sheet, cfg.margins);
  const extra = labelExtra(cfg);
  const item = items[0];
  const gx = cfg.gap.x; const gy = cfg.gap.y;
  let chosen;
  const manual = cfg.grid.cols != null || cfg.grid.rows != null;
  if (manual) {
    const rotated = !!(cfg.grid.rotated && cfg.allowRotation);
    const cell = cellDims(item, rotated, extra);
    const cols = cfg.grid.cols ?? fitCount(a.w, cell.w, gx);
    const rows = cfg.grid.rows ?? fitCount(a.h, cell.h, gy);
    const needW = span(cols, cell.w, gx);
    const needH = span(rows, cell.h, gy);
    if (needW > a.w + EPS) errors.push({ code: 'GRID_TOO_WIDE', cols, need: needW, avail: a.w });
    if (needH > a.h + EPS) errors.push({ code: 'GRID_TOO_TALL', rows, need: needH, avail: a.h });
    if (needW > a.w + EPS || needH > a.h + EPS || !cols || !rows) return null;
    chosen = { kind: 'manual', slots: gridSlots(cols, rows, cell, gx, gy, 0, 0, 0), cols, rows, cell };
    chosen.capacity = chosen.slots.length;
    chosen.rotatedCount = rotated ? chosen.capacity : 0;
  } else {
    const cands = uniformCandidates(a.w, a.h, item, gx, gy, extra, cfg.allowRotation);
    if (!cands.length) return null;
    const total = cfg.mode === 'exact' ? items.reduce((s, it) => s + it.copies, 0) : 0;
    cands.sort((x, y) => compareCandidates(x, y, cfg.mode, total));
    [chosen] = cands;
  }

  const capacity = chosen.capacity;
  let effItems = items;
  if (cfg.mode === 'fill') {
    const pages = Math.max(1, Math.ceil(items.length / capacity));
    effItems = distributeFill(items, pages * capacity);
  }
  const pieces = expandPieces(effItems);
  const total = pieces.length;
  const pageCount = Math.ceil(total / capacity);
  if (pageCount > LIMITS.pagesMax) {
    errors.push({ code: 'TOO_MANY_PAGES', pages: pageCount, max: LIMITS.pagesMax });
    return null;
  }

  let slots = chosen.slots;
  let compacted = false;
  // Column-by-column filling keeps the full-sheet slot positions (no compaction), so a
  // partial sheet uses whole columns and the unused paper stays in one piece.
  const columnMajor = isColumnOrder(cfg.fillOrder);
  if (columnMajor) {
    // keep positions
  } else if (cfg.mode === 'exact' && cfg.compact && pageCount === 1 && total < capacity && (chosen.kind === 'grid' || chosen.kind === 'grid-rotated')) {
    const cg = compactGrid(total, chosen.cols, chosen.rows);
    if (cg && cg.cols * cg.rows < capacity) {
      slots = gridSlots(cg.cols, cg.rows, chosen.cell, gx, gy, 0, 0, 0);
      compacted = true;
    }
  } else if (cfg.mode === 'exact' && cfg.compact && pageCount === 1 && total < capacity && chosen.kind === 'mixed') {
    slots = slots.slice(0, total);
    compacted = true;
  }
  slots = orderSlots(slots, cfg.fillOrder);
  const box = bbox(slots);
  const off = alignOffset(cfg, a.w, a.h, box, errors);

  const pages = [];
  for (let p = 0; p < pageCount; p += 1) {
    const placements = [];
    for (let i = 0; i < slots.length; i += 1) {
      const gi = p * slots.length + i;
      if (gi >= total) break;
      const s = slots[i];
      placements.push(makePlacement(pieces[gi], s, a.x + off.x + s.x, a.y + off.y + s.y, cfg, gi));
    }
    pages.push({ index: p, placements });
  }
  if (chosen.rotatedCount > 0 && pages.some((pg) => pg.placements.some((pl) => pl.rotation === 90))) {
    warnings.push({ code: 'ROTATED_FOR_FIT', count: pages.reduce((s, pg) => s + pg.placements.filter((pl) => pl.rotation === 90).length, 0) });
  }
  const unused = pageCount * slots.length - total;
  return {
    orientation, sheet, pages, capacity, kind: chosen.kind, compacted,
    grid: { cols: chosen.cols ?? null, rows: chosen.rows ?? null, slotsPerPage: slots.length },
    unusedSlots: unused, effItems,
    block: { x: a.x + off.x + box.x, y: a.y + off.y + box.y, w: box.w, h: box.h },
  };
}

function layoutShelf(cfg, sheet, orientation, items, errors, warnings) {
  const a = availArea(sheet, cfg.margins);
  const extra = labelExtra(cfg);
  const gx = cfg.gap.x; const gy = cfg.gap.y;
  const tooLarge = new Set();
  for (const it of items) {
    const opts = [cellDims(it, false, extra)];
    if (cfg.allowRotation) opts.push(cellDims(it, true, extra));
    if (!opts.some((c) => c.w <= a.w + EPS && c.h <= a.h + EPS)) {
      tooLarge.add(it.id);
      errors.push({ code: 'ITEM_TOO_LARGE', itemId: it.id, availW: a.w, availH: a.h });
    }
  }
  if (tooLarge.size) return null;

  let pieces;
  if (cfg.mode === 'fill') {
    // Round-robin copies of every photo until a full cycle no longer fits on one sheet.
    pieces = [];
    const counters = new Map(items.map((it) => [it.id, 0]));
    const probe = (list) => packShelves(list, a, gx, gy, extra, cfg.allowRotation).length <= 1;
    let progress = true;
    while (progress && pieces.length < LIMITS.copiesMax) {
      progress = false;
      for (const it of items) {
        const next = [...pieces, { item: it, copyIndex: counters.get(it.id) }];
        if (probe(next)) {
          pieces = next;
          counters.set(it.id, counters.get(it.id) + 1);
          progress = true;
        }
      }
    }
  } else {
    pieces = expandPieces(items);
  }
  const rawPages = packShelves(pieces, a, gx, gy, extra, cfg.allowRotation);
  if (rawPages.length > LIMITS.pagesMax) {
    errors.push({ code: 'TOO_MANY_PAGES', pages: rawPages.length, max: LIMITS.pagesMax });
    return null;
  }
  const pages = [];
  let gi = 0;
  let rotatedTotal = 0;
  for (let p = 0; p < rawPages.length; p += 1) {
    let slots = rawPages[p];
    // shelves are row-based: column orders map to the matching side
    if (cfg.fillOrder === 'rtl' || cfg.fillOrder === 'col-rtl') slots = mirror(slots);
    const box = bbox(slots);
    const off = alignOffset(cfg, a.w, a.h, box, errors);
    const placements = slots.map((s) => {
      if (s.rotated) rotatedTotal += 1;
      const pl = makePlacement(s.piece, s, a.x + off.x + s.x, a.y + off.y + s.y, cfg, gi);
      gi += 1;
      return pl;
    });
    pages.push({ index: p, placements });
  }
  if (rotatedTotal) warnings.push({ code: 'ROTATED_FOR_FIT', count: rotatedTotal });
  const effItems = items.map((it) => ({ ...it, copies: pieces.filter((pc) => pc.item.id === it.id).length }));
  return { orientation, sheet, pages, capacity: null, kind: 'shelf', compacted: false, grid: null, unusedSlots: 0, effItems, block: null };
}

/** Greedy shelf packing for mixed photo sizes; returns slots per page (relative to area). */
function packShelves(pieces, a, gx, gy, extra, allowRotation) {
  const pages = [];
  let cur = null; let shelfY = 0; let shelfH = 0; let x = 0; let inShelf = 0;
  const newPage = () => { cur = []; pages.push(cur); shelfY = 0; shelfH = 0; x = 0; inShelf = 0; };
  for (const piece of pieces) {
    const opts = [cellDims(piece.item, false, extra)];
    if (allowRotation) opts.push(cellDims(piece.item, true, extra));
    const fitting = opts.filter((c) => c.w <= a.w + EPS && c.h <= a.h + EPS);
    if (!fitting.length) continue;
    if (!cur) newPage();
    let placed = false;
    for (const c of fitting) { // current shelf
      const nx = inShelf ? x + gx : 0;
      if (nx + c.w <= a.w + EPS && shelfY + c.h <= a.h + EPS) {
        cur.push({ ...c, x: nx, y: shelfY, piece });
        x = nx + c.w; shelfH = Math.max(shelfH, c.h); inShelf += 1; placed = true; break;
      }
    }
    if (!placed) { // new shelf on this page
      const ny = inShelf ? shelfY + shelfH + gy : shelfY;
      for (const c of fitting) {
        if (ny + c.h <= a.h + EPS) {
          shelfY = ny; shelfH = c.h; x = c.w; inShelf = 1;
          cur.push({ ...c, x: 0, y: ny, piece }); placed = true; break;
        }
      }
    }
    if (!placed) {
      newPage();
      const c = fitting[0];
      cur.push({ ...c, x: 0, y: 0, piece });
      x = c.w; shelfH = c.h; inShelf = 1;
    }
  }
  return pages;
}

function printerWarnings(result, cfg, warnings) {
  if (cfg.printer.borderless) return;
  const hm = cfg.printer.hardMargins;
  const { widthMm: W, heightMm: H } = result.sheet;
  let clipped = 0;
  for (const pg of result.pages) {
    for (const pl of pg.placements) {
      const r = pl.photo;
      if (r.x < hm.left - EPS || r.y < hm.top - EPS || r.x + r.w > W - hm.right + EPS || r.y + r.h > H - hm.bottom + EPS) clipped += 1;
    }
  }
  if (clipped) warnings.push({ code: 'PRINTER_MARGIN_CLIP', count: clipped, hardMargins: hm });
}

/**
 * Compute a full print layout.
 * @returns {{ok:boolean, errors:Array, warnings:Array, sheet, orientation, pages, totals, analysis, capacity, kind, grid, block}}
 */
export function computeLayout(input) {
  const { cfg, errors } = normalize(input);
  const warnings = [];
  const empty = { ok: false, errors, warnings, pages: [], totals: { requested: 0, placed: 0, sheets: 0, perItem: {} }, analysis: null };
  if (errors.length) return empty;

  const items = cfg.items.filter((it) => cfg.mode === 'fill' || it.copies > 0);
  const uniform = sameSize(items);
  const orientations = cfg.orientation === 'auto' ? ['portrait', 'landscape'] : [cfg.orientation];
  const analysis = uniform ? {
    portrait: analyseOrientation(cfg, 'portrait', items[0]),
    landscape: analyseOrientation(cfg, 'landscape', items[0]),
  } : null;

  const results = [];
  for (const o of orientations) {
    const sheet = sheetDims(cfg.paper, o);
    const a = availArea(sheet, cfg.margins);
    const errs = [];
    const warns = [];
    if (a.w <= EPS || a.h <= EPS) {
      errs.push({ code: 'AREA_TOO_SMALL', orientation: o, availW: a.w, availH: a.h });
      results.push({ o, res: null, errs, warns });
      continue;
    }
    const res = uniform ? layoutUniform(cfg, sheet, o, items, errs, warns) : layoutShelf(cfg, sheet, o, items, errs, warns);
    if (uniform && !res && !errs.length) {
      const c0 = cellDims(items[0], false, labelExtra(cfg));
      errs.push({ code: 'PHOTO_DOES_NOT_FIT', orientation: o, availW: a.w, availH: a.h, needW: c0.w, needH: c0.h });
    }
    results.push({ o, res, errs, warns });
  }

  const valid = results.filter((r) => r.res && !r.errs.length);
  if (!valid.length) {
    const all = results.flatMap((r) => r.errs);
    return { ...empty, errors: dedupe(all), analysis };
  }
  const total = (r) => r.res.pages.reduce((s, pg) => s + pg.placements.length, 0);
  valid.sort((x, y) => {
    const px = x.res.pages.length; const py = y.res.pages.length;
    if (cfg.mode === 'exact' && px !== py) return px - py;
    if (cfg.mode === 'fill' && total(x) !== total(y)) return total(y) - total(x);
    const rx = x.res.pages.flatMap((p) => p.placements).filter((p) => p.rotation).length;
    const ry = y.res.pages.flatMap((p) => p.placements).filter((p) => p.rotation).length;
    if (rx !== ry) return rx - ry;
    if ((x.res.capacity ?? 0) !== (y.res.capacity ?? 0)) return (y.res.capacity ?? 0) - (x.res.capacity ?? 0);
    return x.o === 'portrait' ? -1 : 1;
  });
  const best = valid[0];
  const res = best.res;
  warnings.push(...best.warns);

  if (cfg.orientation !== 'auto' && analysis) {
    const other = cfg.orientation === 'portrait' ? 'landscape' : 'portrait';
    if (analysis[other].bestCapacity > (res.capacity ?? 0)) {
      warnings.push({ code: 'OTHER_ORIENTATION_BETTER', orientation: other, capacity: analysis[other].bestCapacity, current: res.capacity });
    }
  }
  if (cfg.mode === 'exact' && res.unusedSlots > 0 && res.capacity) {
    warnings.push({ code: 'UNUSED_SLOTS', count: res.unusedSlots, capacity: res.capacity });
  }
  const m = cfg.margins; const hm = cfg.printer.hardMargins;
  if (!cfg.printer.borderless && (m.top < hm.top || m.right < hm.right || m.bottom < hm.bottom || m.left < hm.left)) {
    warnings.push({ code: 'MARGINS_BELOW_PRINTER', hardMargins: hm });
  }
  const result = {
    ok: true, errors: [], warnings, analysis,
    orientation: res.orientation, sheet: res.sheet, pages: res.pages,
    capacity: res.capacity, kind: res.kind, grid: res.grid, block: res.block, compacted: res.compacted,
    margins: { ...cfg.margins }, gap: { ...cfg.gap }, label: { ...cfg.label },
  };
  printerWarnings(result, cfg, warnings);
  const perItem = {};
  for (const it of res.effItems) perItem[it.id] = 0;
  for (const pg of res.pages) for (const pl of pg.placements) perItem[pl.itemId] += 1;
  result.totals = {
    requested: res.effItems.reduce((s, it) => s + it.copies, 0),
    placed: res.pages.reduce((s, pg) => s + pg.placements.length, 0),
    sheets: res.pages.length,
    perItem,
  };
  return result;
}

function dedupe(list) {
  const seen = new Set();
  return list.filter((e) => {
    const k = JSON.stringify(e);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Cut guides / crop marks / borders for one page, as line segments in mm.
 * Cut lines run along photo edges and are drawn BEHIND photos, so they are only
 * visible in gaps and margins. Crop marks live in the margins only.
 * Cut guides (lines and crop marks) sit `cutOffset` mm OUTSIDE each photo edge,
 * in the white gap, so scissors cut in the white and never through a border;
 * the offset is limited to half the gap (0 when photos touch).
 * Borders are drawn INSIDE each photo's frame (the photo keeps its exact size);
 * width in mm (0.05..2) and colour (#rrggbb) are configurable.
 */
export function computeMarks(layout, page, opts = {}) {
  const { cutLines = false, cropMarks = false, borders = false, markLength = 4, markOffset = 1 } = opts;
  const borderWidth = Number.isFinite(opts.borderWidth) ? Math.min(2, Math.max(0.05, opts.borderWidth)) : 0.1;
  const borderColor = /^#[0-9a-f]{6}$/i.test(opts.borderColor || '') ? opts.borderColor.toLowerCase() : '#000000';
  const W = layout.sheet.widthMm; const H = layout.sheet.heightMm;
  const under = []; const over = [];
  const rects = page.placements.map((p) => p.photo);
  if (!rects.length) return { under, over };
  const gapX = layout.gap?.x ?? 0; const gapY = layout.gap?.y ?? 0;
  const want = Number.isFinite(opts.cutOffset) ? Math.max(0, opts.cutOffset) : 0.5;
  const offX = Math.min(want, gapX / 2); const offY = Math.min(want, gapY / 2);
  const uniq = (list, lo, hi) => [...new Set(list.map((v) => Math.round(Math.min(hi, Math.max(lo, v)) * 1e4) / 1e4))].sort((a, b) => a - b);
  // left/top edges move away from their photo, right/bottom edges too: the guides lie in the gaps
  const xs = uniq(rects.flatMap((r) => [r.x - offX, r.x + r.w + offX]), 0, W);
  const ys = uniq(rects.flatMap((r) => [r.y - offY, r.y + r.h + offY]), 0, H);
  const minX = Math.min(...rects.map((r) => r.x)); const maxX = Math.max(...rects.map((r) => r.x + r.w));
  const minY = Math.min(...rects.map((r) => r.y)); const maxY = Math.max(...rects.map((r) => r.y + r.h));
  if (cutLines) {
    for (const x of xs) under.push({ x1: x, y1: 0, x2: x, y2: H, kind: 'cut' });
    for (const y of ys) under.push({ x1: 0, y1: y, x2: W, y2: y, kind: 'cut' });
  }
  if (cropMarks) {
    for (const x of xs) {
      if (minY - markOffset > 0) under.push({ x1: x, y1: Math.max(0, minY - markOffset - markLength), x2: x, y2: minY - markOffset, kind: 'crop' });
      if (maxY + markOffset < H) under.push({ x1: x, y1: maxY + markOffset, x2: x, y2: Math.min(H, maxY + markOffset + markLength), kind: 'crop' });
    }
    for (const y of ys) {
      if (minX - markOffset > 0) under.push({ x1: Math.max(0, minX - markOffset - markLength), y1: y, x2: minX - markOffset, y2: y, kind: 'crop' });
      if (maxX + markOffset < W) under.push({ x1: maxX + markOffset, y1: y, x2: Math.min(W, maxX + markOffset + markLength), y2: y, kind: 'crop' });
    }
  }
  if (borders) {
    for (const r of rects) over.push({ rect: { ...r }, kind: 'border', width: borderWidth, color: borderColor });
  }
  return { under, over };
}
