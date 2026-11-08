// One-click print presets ("چاپ سریع"): photo size + rule profile + a sheet
// setup that is known to print well on a 4-colour Epson inkjet (EcoTank
// L-series) on 4R / 10×15 glossy photo paper. Pure data + layout math.

import { computeLayout } from './layout.js';
import { findPaper, findPhoto } from './presets.js';

/**
 * Sheet settings shared by every quick preset.
 * - Paper 4×6 in (101.6 × 152.4 mm) is the real size of "10×15 / 4R" photo paper.
 * - 5 mm margins stay clear of the 3 mm non-printable edge of most Epson
 *   inkjets in normal (bordered) mode, with room for crop marks.
 * - Column-by-column fill keeps the unused paper in one piece.
 */
export const QUICK_SHEET = Object.freeze({
  orientation: 'auto',
  margins: Object.freeze({ top: 5, right: 5, bottom: 5, left: 5 }),
  marginsLinked: true,
  gap: Object.freeze({ x: 2, y: 2 }),
  gapLinked: true,
  allowRotation: false,
  grid: Object.freeze({ cols: null, rows: null, rotated: false }),
  align: Object.freeze({ mode: 'center', offsetX: 0, offsetY: 0 }),
  fillOrder: 'col-ltr',
  compact: true,
  marks: Object.freeze({ cutLines: false, cropMarks: true, borders: false }),
  dpi: 300,
  printer: Object.freeze({ borderless: false, hardMargins: Object.freeze({ top: 3, right: 3, bottom: 3, left: 3 }) }),
  printBoost: 'medium',
});

/**
 * perPerson: 'sheet' → every photo gets its own full sheet (studio use: one
 * customer, one sheet); 'share' → all photos share the sheet(s) evenly.
 */
export const QUICK_PRESETS = Object.freeze([
  { id: 'q-3x4-4r', nameFa: '۳×۴ — تذکره، مکتب، کارمندی', photoId: '3x4', profileId: 'generic-3x4', paperId: '4x6in', perPerson: 'sheet' },
  { id: 'q-35x45-4r', nameFa: '۳٫۵×۴٫۵ — پاسپورت و ویزا', photoId: '3.5x4.5', profileId: 'icao-35x45', paperId: '4x6in', perPerson: 'sheet' },
  { id: 'q-4x6-4r', nameFa: '۴×۶ — عکس شخصی', photoId: '4x6', profileId: 'generic-4x6', paperId: '4x6in', perPerson: 'sheet' },
  { id: 'q-3x4-a4', nameFa: '۳×۴ — چند نفر روی A4', photoId: '3x4', profileId: 'generic-3x4', paperId: 'a4', perPerson: 'share' },
].map((p) => Object.freeze(p)));

export const findQuickPreset = (id) => QUICK_PRESETS.find((p) => p.id === id) || null;

/** Layout-engine input for a preset with the given photo items. */
export function quickLayoutInput(preset, items, mode = 'fill') {
  const paper = findPaper(preset.paperId);
  const photo = findPhoto(preset.photoId);
  return {
    paper,
    orientation: QUICK_SHEET.orientation,
    margins: QUICK_SHEET.margins,
    gap: QUICK_SHEET.gap,
    items: items.map((it) => ({ id: it.id, widthMm: photo.widthMm, heightMm: photo.heightMm, copies: it.copies ?? 1 })),
    mode,
    allowRotation: QUICK_SHEET.allowRotation,
    grid: QUICK_SHEET.grid,
    align: QUICK_SHEET.align,
    fillOrder: QUICK_SHEET.fillOrder,
    compact: QUICK_SHEET.compact,
    label: { enabled: false, heightMm: 4, gapMm: 1 },
    printer: QUICK_SHEET.printer,
  };
}

/** Photos per sheet for a preset, with the orientation the engine picks. */
export function presetCapacity(preset) {
  const l = computeLayout(quickLayoutInput(preset, [{ id: 'x', copies: 1 }], 'fill'));
  return l.ok ? { capacity: l.capacity, orientation: l.orientation, sheet: l.sheet } : { capacity: 0, orientation: null, sheet: null };
}

/**
 * The sheet patch a preset applies for the given photo ids.
 * @param {(prefix:string)=>string} makeId id generator for sheet items
 */
export function quickSheetPatch(preset, photoIds, makeId) {
  const { capacity } = presetCapacity(preset);
  const perSheet = preset.perPerson === 'sheet';
  return {
    ...structuredClone(QUICK_SHEET),
    paperId: preset.paperId,
    mode: perSheet ? 'exact' : 'fill',
    label: { enabled: false, heightMm: 4, gapMm: 1, content: 'name', custom: '' },
    items: photoIds.map((pid) => ({ id: makeId('it'), photoId: pid, copies: perSheet ? Math.max(1, capacity) : 1 })),
    quickPresetId: preset.id,
  };
}
