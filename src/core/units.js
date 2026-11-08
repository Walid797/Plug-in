// Physical unit helpers. Millimetres are the canonical unit everywhere in the
// app; points (1/72 inch) are only used when writing PDF content streams.

export const MM_PER_INCH = 25.4;
export const PT_PER_INCH = 72;
/** Geometric tolerance in millimetres used by every fit comparison. */
export const EPS = 1e-6;

export const mmToPt = (mm) => (mm * PT_PER_INCH) / MM_PER_INCH;
export const ptToMm = (pt) => (pt * MM_PER_INCH) / PT_PER_INCH;
export const cmToMm = (cm) => cm * 10;
export const inchToMm = (inch) => inch * MM_PER_INCH;

/**
 * Pixels needed for a physical length at a target DPI.
 * pixels = (cm / 2.54) × DPI  ==  (mm / 25.4) × DPI, rounded to whole pixels.
 */
export function mmToPx(mm, dpi) {
  if (!(mm > 0) || !(dpi > 0)) return 0;
  return Math.max(1, Math.round((mm / MM_PER_INCH) * dpi));
}

/** Physical length (mm) of a pixel count printed at a given DPI. */
export const pxToMm = (px, dpi) => (px / dpi) * MM_PER_INCH;

/** DPI a pixel count achieves when printed at a physical length. */
export const effectiveDpi = (px, mm) => (mm > 0 ? px / (mm / MM_PER_INCH) : 0);

/** CSS reference pixels per millimetre (CSS: 1in = 96px = 25.4mm). */
export const CSS_PX_PER_MM = 96 / MM_PER_INCH;

/** Round to a fixed number of decimals without floating-point noise. */
export function roundTo(value, decimals = 2) {
  const f = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * f) / f;
}

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
