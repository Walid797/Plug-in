// One-click print presets ("چاپ سریع"): photo size + rule profile + automatic
// steps + a sheet setup. Built-in presets are tuned for a 4-colour Epson inkjet
// (EcoTank L-series) on 4R / 10×15 glossy photo paper; the user can adjust them
// (overrides, resettable) or create their own. Pure data + layout math.

import { computeLayout } from './layout.js';
import { PAPER_PRESETS, PHOTO_PRESETS, DPI_PRESETS, RULE_PROFILES, findPaper, findPhoto } from './presets.js';
import { PRINT_BOOST_IDS } from './adjust.js';
import { formatNumber } from './digits.js';

export const FILL_ORDERS = Object.freeze(['col-ltr', 'col-rtl', 'rtl', 'ltr']);
export const PER_PERSON = Object.freeze(['sheet', 'copies', 'share']);

/**
 * Every editable field with its default.
 * - Paper 4×6 in (101.6 × 152.4 mm) is the real size of "10×15 / 4R" photo paper.
 * - 5 mm margins stay clear of the ~3 mm non-printable edge of most Epson
 *   inkjets in normal (bordered) mode, with room for crop marks.
 * - perPerson: 'sheet' = one full sheet per person; 'copies' = a fixed number
 *   of copies per person; 'share' = all photos share the sheet(s) evenly.
 */
export const QUICK_DEFAULTS = Object.freeze({
  nameFa: 'قالب تازه',
  photoId: '3x4', widthMm: 30, heightMm: 40, profileId: 'generic-3x4',
  paperId: '4x6in', paperWidthMm: 101.6, paperHeightMm: 152.4,
  orientation: 'auto', margin: 5, gap: 2, fillOrder: 'col-ltr',
  perPerson: 'sheet', copies: 8,
  whiteBg: true, bgColor: '#ffffff', autoCrop: true, autoLight: true,
  // background edge clean-up (same meaning as the Background section; feather in mask pixels)
  edgeAware: true, edgeShift: 0, edgeSoftness: 40, edgeFeather: 1, decontaminate: true,
  shadow: false, shadowOpacity: 25, shadowBlur: 1.5, shadowX: 0, shadowY: 0.8,
  printBoost: 'medium', dpi: 300, cropMarks: true, cutLines: false, borderless: false, hardMargin: 3,
  // frame drawn inside each photo (photo size unchanged): off by default, width in mm
  border: false, borderWidth: 0.1, borderColor: '#000000',
  // cut lines / crop marks sit this far outside each photo, in the white gap (limited to half the gap)
  cutOffset: 0.5,
});

export const QUICK_FIELDS = Object.freeze(Object.keys(QUICK_DEFAULTS));

const BUILTIN = [
  // 4 photos per person (the left two columns); the rest of the 8-slot sheet stays in one piece
  { id: 'q-3x4-4r', nameFa: '۳×۴ — تذکره، مکتب، کارمندی', photoId: '3x4', profileId: 'generic-3x4', paperId: '4x6in', perPerson: 'copies', copies: 4 },
  { id: 'q-35x45-4r', nameFa: '۳٫۵×۴٫۵ — پاسپورت و ویزا', photoId: '3.5x4.5', profileId: 'icao-35x45', paperId: '4x6in', perPerson: 'sheet' },
  { id: 'q-4x6-4r', nameFa: '۴×۶ — عکس شخصی', photoId: '4x6', profileId: 'generic-4x6', paperId: '4x6in', perPerson: 'sheet' },
  { id: 'q-3x4-a4', nameFa: '۳×۴ — چند نفر روی A4', photoId: '3x4', profileId: 'generic-3x4', paperId: 'a4', perPerson: 'share' },
];

const num = (v, lo, hi, d) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const pick = (v, list, d) => (list.includes(v) ? v : d);
const bool = (v, d) => (typeof v === 'boolean' ? v : d);

/** A complete, validated preset from any (possibly untrusted) object. */
export function normalizeQuickPreset(raw = {}) {
  const D = QUICK_DEFAULTS;
  const p = { ...D };
  p.id = typeof raw.id === 'string' && raw.id ? raw.id.slice(0, 60) : '';
  p.builtin = !!raw.builtin;
  p.edited = !!raw.edited;
  const name = typeof raw.nameFa === 'string' ? raw.nameFa.trim().slice(0, 80) : '';
  p.nameFa = name || D.nameFa;
  const photo = findPhoto(raw.photoId);
  if (photo) {
    p.photoId = photo.id; p.widthMm = photo.widthMm; p.heightMm = photo.heightMm;
  } else if (raw.photoId === 'custom') {
    p.photoId = 'custom';
    p.widthMm = num(raw.widthMm, 5, 300, D.widthMm);
    p.heightMm = num(raw.heightMm, 5, 300, D.heightMm);
  }
  // undefined → the first built-in rule profile for this size (null → generic proportions)
  p.profileId = typeof raw.profileId === 'string' && raw.profileId ? raw.profileId.slice(0, 60)
    : raw.profileId === null ? null : (RULE_PROFILES.find((r) => r.photoId === p.photoId)?.id ?? null);
  if (typeof raw.paperId === 'string' && raw.paperId) p.paperId = raw.paperId.slice(0, 60);
  p.paperWidthMm = num(raw.paperWidthMm, 10, 2000, D.paperWidthMm);
  p.paperHeightMm = num(raw.paperHeightMm, 10, 2000, D.paperHeightMm);
  p.orientation = pick(raw.orientation, ['auto', 'portrait', 'landscape'], D.orientation);
  p.margin = num(raw.margin, 0, 100, D.margin);
  p.gap = num(raw.gap, 0, 50, D.gap);
  p.fillOrder = pick(raw.fillOrder, FILL_ORDERS, D.fillOrder);
  p.perPerson = pick(raw.perPerson, PER_PERSON, D.perPerson);
  p.copies = Math.round(num(raw.copies, 1, 500, D.copies));
  p.whiteBg = bool(raw.whiteBg, D.whiteBg);
  p.bgColor = typeof raw.bgColor === 'string' && /^#[0-9a-f]{6}$/i.test(raw.bgColor) ? raw.bgColor.toLowerCase() : D.bgColor;
  p.autoCrop = bool(raw.autoCrop, D.autoCrop);
  p.autoLight = bool(raw.autoLight, D.autoLight);
  p.edgeAware = bool(raw.edgeAware, D.edgeAware);
  p.edgeShift = Math.round(num(raw.edgeShift, -100, 100, D.edgeShift));
  p.edgeSoftness = Math.round(num(raw.edgeSoftness, 0, 100, D.edgeSoftness));
  p.edgeFeather = Math.round(num(raw.edgeFeather, 0, 12, D.edgeFeather));
  p.decontaminate = bool(raw.decontaminate, D.decontaminate);
  p.shadow = bool(raw.shadow, D.shadow);
  p.shadowOpacity = Math.round(num(raw.shadowOpacity, 0, 80, D.shadowOpacity));
  p.shadowBlur = Math.round(num(raw.shadowBlur, 0, 6, D.shadowBlur) * 10) / 10;
  p.shadowX = Math.round(num(raw.shadowX, -4, 4, D.shadowX) * 10) / 10;
  p.shadowY = Math.round(num(raw.shadowY, -4, 4, D.shadowY) * 10) / 10;
  p.printBoost = pick(raw.printBoost, PRINT_BOOST_IDS, D.printBoost);
  p.dpi = pick(raw.dpi, DPI_PRESETS, D.dpi);
  p.cropMarks = bool(raw.cropMarks, D.cropMarks);
  p.cutLines = bool(raw.cutLines, D.cutLines);
  p.cutOffset = Math.round(num(raw.cutOffset, 0, 3, D.cutOffset) * 100) / 100;
  p.border = bool(raw.border, D.border);
  p.borderWidth = Math.round(num(raw.borderWidth, 0.05, 2, D.borderWidth) * 100) / 100;
  p.borderColor = typeof raw.borderColor === 'string' && /^#[0-9a-f]{6}$/i.test(raw.borderColor) ? raw.borderColor.toLowerCase() : D.borderColor;
  p.borderless = bool(raw.borderless, D.borderless);
  p.hardMargin = num(raw.hardMargin, 0, 20, D.hardMargin);
  return p;
}

/** Built-in presets with their factory settings. */
export const QUICK_PRESETS = Object.freeze(BUILTIN.map((b) => Object.freeze(normalizeQuickPreset({ ...b, builtin: true }))));

/** Only the editable fields (what is stored for an override or a user preset). */
export function quickFields(p) {
  const out = {};
  for (const k of QUICK_FIELDS) out[k] = p[k];
  return out;
}

/** Built-ins (with the user's adjustments applied) followed by the user's own presets. */
export function allQuickPresets(settings = {}) {
  const ov = settings.quickOverrides || {};
  // an override is layered over the factory preset, so partial overrides are safe
  const builtins = QUICK_PRESETS.map((b) => (ov[b.id] && typeof ov[b.id] === 'object' ? normalizeQuickPreset({ ...b, ...ov[b.id], id: b.id, builtin: true, edited: true }) : b));
  const own = (settings.quickPresets || []).map((p) => normalizeQuickPreset({ ...p, builtin: false }));
  return [...builtins, ...own];
}

export const findQuickPreset = (id, settings = {}) => allQuickPresets(settings).find((p) => p.id === id) || null;

/** The paper a preset prints on (user-saved papers are passed in). */
export function quickPaper(preset, papers = []) {
  if (preset.paperId === 'custom') return { id: 'custom', nameFa: 'سفارشی', widthMm: preset.paperWidthMm, heightMm: preset.paperHeightMm };
  return [...PAPER_PRESETS, ...papers].find((p) => p.id === preset.paperId) || findPaper('4x6in');
}

export function quickSizeLabel(preset) {
  return findPhoto(preset.photoId)?.nameFa || `${formatNumber(preset.widthMm / 10, { maxFraction: 2 })}×${formatNumber(preset.heightMm / 10, { maxFraction: 2 })} سانتی‌متر`;
}

const sides = (v) => ({ top: v, right: v, bottom: v, left: v });

/** Layout-engine input for a preset with the given photo items. */
export function quickLayoutInput(preset, items, mode = 'fill', papers = []) {
  return {
    paper: quickPaper(preset, papers),
    orientation: preset.orientation,
    margins: sides(preset.margin),
    gap: { x: preset.gap, y: preset.gap },
    items: items.map((it) => ({ id: it.id, widthMm: preset.widthMm, heightMm: preset.heightMm, copies: it.copies ?? 1 })),
    mode,
    allowRotation: false,
    grid: { cols: null, rows: null, rotated: false },
    align: { mode: 'center', offsetX: 0, offsetY: 0 },
    fillOrder: preset.fillOrder,
    compact: true,
    label: { enabled: false, heightMm: 4, gapMm: 1 },
    printer: { borderless: preset.borderless, hardMargins: sides(preset.hardMargin) },
  };
}

/** Photos per sheet for a preset, with the orientation the engine picks (and the full layout for previews). */
export function presetCapacity(preset, papers = []) {
  const l = computeLayout(quickLayoutInput(preset, [{ id: 'x', copies: 1 }], 'fill', papers));
  return l.ok
    ? { capacity: l.capacity, orientation: l.orientation, sheet: l.sheet, layout: l, errors: [] }
    : { capacity: 0, orientation: null, sheet: null, layout: l, errors: l.errors || [] };
}

/** Copies each person gets on the sheet. */
export function copiesPerPerson(preset, capacity) {
  if (preset.perPerson === 'sheet') return Math.max(1, capacity);
  if (preset.perPerson === 'copies') return preset.copies;
  return 1;
}

/** Practical warnings for a preset (codes; texts live in the UI). */
export function quickWarnings(preset, cap) {
  const w = [];
  if (!preset.borderless && preset.margin < preset.hardMargin) w.push({ code: 'MARGIN_IN_HARD', margin: preset.margin, hard: preset.hardMargin });
  if (preset.perPerson === 'copies' && cap.capacity && preset.copies > cap.capacity) w.push({ code: 'COPIES_MULTI_SHEET', copies: preset.copies, capacity: cap.capacity, sheets: Math.ceil(preset.copies / cap.capacity) });
  if (preset.whiteBg && !preset.autoCrop) w.push({ code: 'NO_AUTO_CROP' });
  return w;
}

/**
 * The sheet patch a preset applies for the given photo ids.
 * @param {(prefix:string)=>string} makeId id generator for sheet items
 */
export function quickSheetPatch(preset, photoIds, makeId, papers = []) {
  const { capacity } = presetCapacity(preset, papers);
  const each = copiesPerPerson(preset, capacity);
  return {
    paperId: preset.paperId,
    ...(preset.paperId === 'custom' ? { customPaper: { widthMm: preset.paperWidthMm, heightMm: preset.paperHeightMm } } : {}),
    orientation: preset.orientation,
    margins: sides(preset.margin),
    marginsLinked: true,
    gap: { x: preset.gap, y: preset.gap },
    gapLinked: true,
    allowRotation: false,
    grid: { cols: null, rows: null, rotated: false },
    align: { mode: 'center', offsetX: 0, offsetY: 0 },
    fillOrder: preset.fillOrder,
    compact: true,
    marks: { cutLines: preset.cutLines, cropMarks: preset.cropMarks, borders: preset.border, borderWidth: preset.borderWidth, borderColor: preset.borderColor, cutOffset: preset.cutOffset },
    dpi: preset.dpi,
    printer: { borderless: preset.borderless, hardMargins: sides(preset.hardMargin) },
    printBoost: preset.printBoost,
    mode: preset.perPerson === 'share' ? 'fill' : 'exact',
    label: { enabled: false, heightMm: 4, gapMm: 1, content: 'name', custom: '' },
    items: photoIds.map((pid) => ({ id: makeId('it'), photoId: pid, copies: each })),
    quickPresetId: preset.id,
  };
}

export { PHOTO_PRESETS };
