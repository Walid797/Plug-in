// One-click print presets ("چاپ سریع"): photo size + rule profile + automatic
// steps + a sheet setup. Built-in presets are tuned for a 4-colour Epson inkjet
// (EcoTank L-series) on 4R / 10×15 glossy photo paper; the user can adjust them
// (overrides, resettable) or create their own. Pure data + layout math.

import { computeLayout } from './layout.js';
import { PAPER_PRESETS, PHOTO_PRESETS, DPI_PRESETS, RULE_PROFILES, findPaper, findPhoto } from './presets.js';
import { PRINT_BOOST_IDS, ADJUSTMENT_DEFAULTS } from './adjust.js';
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
  // portrait sheet; every photo turned 90° (3×4 on 10×15: 2 columns × 4 rows = 8), filled row by row from the top-left
  orientation: 'portrait', allowRotation: true, margin: 5, gap: 2, fillOrder: 'ltr',
  // exactly 9 photos on one sheet: the margin and the gap shrink (never below the printer's 3 mm edge) and the photos
  // stand upright in 3 × 3 so that all nine fit; every other count keeps the 8-photo form above
  nine: true, nineMargin: 3.7, nineGap: 2,
  align: 'top-left', // where the photo grid sits on the sheet: top-left | center | top-right
  perPerson: 'sheet', copies: 8,
  whiteBg: true, bgColor: '#ffffff', autoCrop: true, autoLight: true,
  // colour-grading engine: suggested starting values for a natural personnel look (not measured data)
  // exposure 7.5 on the slider = +0.15 EV (the slider spans ±2 EV over ±100)
  grade: true,
  // scale the brightening values of the table (exposure, brightness, shadows, whites) by how dark the face really is
  // and the detail values (sharpness, clarity) by how soft it is, so a photo that is already well lit and crisp is not edited twice
  gradeAdaptive: true,
  gExposure: 7.5, gBrightness: 8, gContrast: 8, gSaturation: 3, gTemperature: 2, gTint: 0,
  // contrast 8 and blacks -8 (suggested table: 5 / -3) were tuned on the studio's before/after pair: they give the
  // reference's deep hair, jacket and eye-socket shading instead of a flat look
  gHighlights: -16, gShadows: 22, gWhites: 0, gBlacks: -8, gSharpness: 22, gClarity: 55, gDenoise: 30,
  // face & skin engine (never reshapes the face): excess redness, colour evenness
  skinOn: true, skinRedness: 40, skinBalance: 40,
  // realistic spot healing (pimples, marks, stains): texture kept, beard and freckle clusters skipped; 0 = off
  skinSpots: 90,
  skinSmooth: 55,
  // natural lip colour (lips keep light, texture and shape; only the colour moves towards a lip colour that fits the skin)
  skinLips: 60,
  // lighting engine: fill light for shadows (eyes, nose, chin, forehead), L/R balance, burnt-highlight protection
  lightOn: true, lightFill: 45, lightEven: true, lightProtect: true,
  // crop engine: widen the frame (within the head-size rule) when the shoulders are cut off
  cropShoulders: true,
  // background edge clean-up (same meaning as the Background section; feather in mask pixels)
  edgeAware: true, edgeShift: 0, edgeSoftness: 40, edgeFeather: 1, decontaminate: true,
  shadow: false, shadowOpacity: 25, shadowBlur: 1.5, shadowX: 0, shadowY: 0.8,
  printBoost: 'medium', dpi: 300, cropMarks: true, cutLines: true, borderless: false, hardMargin: 3,
  // frame drawn inside each photo (photo size unchanged): on by default in every template, width in mm
  border: true, borderWidth: 0.1, borderColor: '#000000',
  // cut lines / crop marks sit this far outside each photo, in the white (on all four sides and between photos alike: at most half the gap)
  cutOffset: 2,
  // cut lines only around the printed photos: the unused paper stays completely white
  cutUsedOnly: true,
});

export const QUICK_FIELDS = Object.freeze(Object.keys(QUICK_DEFAULTS));

/** Grading fields with their slider limits and the adjustment each one drives. */
export const GRADE_RANGES = Object.freeze([
  ['gExposure', -100, 100], ['gBrightness', -100, 100], ['gContrast', -100, 100], ['gSaturation', -100, 100],
  ['gTemperature', -100, 100], ['gTint', -100, 100], ['gHighlights', -100, 100], ['gShadows', -100, 100],
  ['gWhites', -100, 100], ['gBlacks', -100, 100], ['gSharpness', 0, 100], ['gClarity', 0, 100], ['gDenoise', 0, 100],
]);
const GRADE_KEYS = Object.freeze({
  gExposure: 'exposure', gBrightness: 'brightness', gContrast: 'contrast', gSaturation: 'saturation', gTemperature: 'temperature',
  gTint: 'tint', gHighlights: 'highlights', gShadows: 'shadows', gWhites: 'whites', gBlacks: 'blacks', gSharpness: 'sharpness', gClarity: 'clarity', gDenoise: 'denoise',
});

/** Photo adjustments a preset applies (all neutral defaults + the grading values), or null when grading is off. */
export function presetAdjust(p) {
  if (!p.grade) return null;
  const a = { ...ADJUSTMENT_DEFAULTS };
  for (const [k, adj] of Object.entries(GRADE_KEYS)) a[adj] = p[k];
  return a;
}

/**
 * One-time upgrade of a saved template (an adjustment of a built-in or the user's own): the engine values
 * the previous version stored as its defaults move to the new ones (quality-reference tuning); anything the
 * user set to another value is kept, and fields the old version did not have (clarity, adaptive strength)
 * get their defaults when the template is normalised.
 */
export function upgradeSavedQuickFields(p) {
  if (!p || typeof p !== 'object') return p;
  const o = { ...p };
  if (o.gSharpness === 14) o.gSharpness = 22;
  if (o.lightFill === 35) o.lightFill = 45;
  if (o.skinBalance === 30) o.skinBalance = 40;
  return o;
}

/**
 * Studio request: every template follows the quality reference only. Saved adjustments of built-in templates
 * and the user's own templates are removed; what was removed is returned as a backup so it can be downloaded.
 * @returns {{quickPresets:[], quickOverrides:{}, backup:null|{at:number, quickPresets:object[], quickOverrides:object}}}
 */
export function resetSavedQuick(settings, now = Date.now()) {
  const presets = Array.isArray(settings?.quickPresets) ? settings.quickPresets : [];
  const overrides = settings?.quickOverrides && typeof settings.quickOverrides === 'object' ? settings.quickOverrides : {};
  const had = presets.length > 0 || Object.keys(overrides).length > 0;
  return { quickPresets: [], quickOverrides: {}, backup: had ? { at: now, quickPresets: presets, quickOverrides: overrides } : null };
}

/** Face brightness (mean luma 0..1) of the studio's quality reference portrait: nothing to brighten at or above it. */
export const GRADE_REFERENCE_L = 0.66;
/** Face brightness at (and below) which the table's brightening values apply in full. */
export const GRADE_FULL_BELOW_L = 0.45;
const BRIGHTENING_KEYS = Object.freeze(['exposure', 'brightness', 'shadows', 'whites']);

/** 0..1: how much of the brightening values a face of this mean luma needs (1 when unknown). */
export function gradeStrength(meanL) {
  if (!Number.isFinite(meanL)) return 1;
  return Math.min(1, Math.max(0, (GRADE_REFERENCE_L - meanL) / (GRADE_REFERENCE_L - GRADE_FULL_BELOW_L)));
}

/** Face sharpness (the app's own measure, laplacian variance of the face at 160 px) of the quality reference portrait. */
export const DETAIL_REFERENCE_SHARPNESS = 1900;
/** At or below this the detail values (sharpness, clarity) apply in full: a soft phone photo. */
export const DETAIL_FULL_BELOW_SHARPNESS = 800;
const DETAIL_KEYS = Object.freeze(['sharpness', 'clarity']);

/** 0..1: how much extra detail a face of this measured sharpness needs (1 when unknown). */
export function detailStrength(sharpness) {
  if (!Number.isFinite(sharpness)) return 1;
  return Math.min(1, Math.max(0, (DETAIL_REFERENCE_SHARPNESS - sharpness) / (DETAIL_REFERENCE_SHARPNESS - DETAIL_FULL_BELOW_SHARPNESS)));
}

/**
 * presetAdjust with the brightening values scaled by the face brightness and the detail values scaled by
 * the face sharpness (when the template is adaptive): a photo that is already bright / crisp is not edited twice.
 */
export function presetAdjustFor(p, meanL, sharpness = null) {
  const a = presetAdjust(p);
  if (!a || !p.gradeAdaptive) return a;
  const s = gradeStrength(meanL);
  for (const k of BRIGHTENING_KEYS) a[k] = Math.round(a[k] * s * 10) / 10;
  const d = detailStrength(sharpness);
  for (const k of DETAIL_KEYS) a[k] = Math.round(a[k] * d * 10) / 10;
  return a;
}

/** Face & skin + lighting parameters a preset writes to the photo edit (ellipse added by the analysis). */
export function presetFaceParams(p) {
  return {
    skin: { enabled: p.skinOn, redness: p.skinRedness, balance: p.skinBalance, spots: p.skinSpots, smooth: p.skinSmooth, lips: p.skinLips },
    light: { enabled: p.lightOn, fill: p.lightFill, even: p.lightEven, protect: p.lightProtect },
  };
}

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
  p.allowRotation = bool(raw.allowRotation, D.allowRotation);
  p.nine = bool(raw.nine, D.nine);
  p.nineMargin = num(raw.nineMargin, 0, 20, D.nineMargin);
  p.nineGap = num(raw.nineGap, 0, 20, D.nineGap);
  p.margin = num(raw.margin, 0, 100, D.margin);
  p.gap = num(raw.gap, 0, 50, D.gap);
  p.fillOrder = pick(raw.fillOrder, FILL_ORDERS, D.fillOrder);
  p.align = pick(raw.align, ['top-left', 'center', 'top-right'], D.align);
  p.perPerson = pick(raw.perPerson, PER_PERSON, D.perPerson);
  p.copies = Math.round(num(raw.copies, 1, 500, D.copies));
  p.whiteBg = bool(raw.whiteBg, D.whiteBg);
  p.bgColor = typeof raw.bgColor === 'string' && /^#[0-9a-f]{6}$/i.test(raw.bgColor) ? raw.bgColor.toLowerCase() : D.bgColor;
  p.autoCrop = bool(raw.autoCrop, D.autoCrop);
  p.autoLight = bool(raw.autoLight, D.autoLight);
  p.grade = bool(raw.grade, D.grade);
  p.gradeAdaptive = bool(raw.gradeAdaptive, D.gradeAdaptive);
  for (const [k, lo, hi] of GRADE_RANGES) p[k] = Math.round(num(raw[k], lo, hi, D[k]) * 10) / 10;
  p.skinOn = bool(raw.skinOn, D.skinOn);
  p.skinRedness = Math.round(num(raw.skinRedness, 0, 100, D.skinRedness));
  p.skinBalance = Math.round(num(raw.skinBalance, 0, 100, D.skinBalance));
  p.skinSpots = Math.round(num(raw.skinSpots, 0, 100, D.skinSpots));
  p.skinSmooth = Math.round(num(raw.skinSmooth, 0, 100, D.skinSmooth));
  p.skinLips = Math.round(num(raw.skinLips, 0, 100, D.skinLips));
  p.lightOn = bool(raw.lightOn, D.lightOn);
  p.lightFill = Math.round(num(raw.lightFill, 0, 100, D.lightFill));
  p.lightEven = bool(raw.lightEven, D.lightEven);
  p.lightProtect = bool(raw.lightProtect, D.lightProtect);
  p.cropShoulders = bool(raw.cropShoulders, D.cropShoulders);
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
  p.cutUsedOnly = bool(raw.cutUsedOnly, D.cutUsedOnly);
  p.cutOffset = Math.round(num(raw.cutOffset, 0, 5, D.cutOffset) * 100) / 100;
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
    allowRotation: preset.allowRotation,
    rotateAll: preset.allowRotation,
    grid: { cols: null, rows: null, rotated: false },
    align: { mode: preset.align, offsetX: 0, offsetY: 0 },
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
    allowRotation: preset.allowRotation,
    rotateAll: preset.allowRotation,
    nine: preset.nine ? { margin: preset.nineMargin, gap: preset.nineGap } : null,
    grid: { cols: null, rows: null, rotated: false },
    align: { mode: preset.align, offsetX: 0, offsetY: 0 },
    fillOrder: preset.fillOrder,
    compact: true,
    marks: { cutLines: preset.cutLines, cropMarks: preset.cropMarks, borders: preset.border, borderWidth: preset.borderWidth, borderColor: preset.borderColor, cutOffset: preset.cutOffset, cutUsedOnly: preset.cutUsedOnly },
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
