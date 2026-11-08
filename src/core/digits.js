// Persian (Dari) digit formatting and tolerant numeric parsing.

const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const FA_DECIMAL = '٫';
const FA_THOUSANDS = '٬';

/** Replace ASCII digits with Persian digits (other characters untouched). */
export function toFaDigits(input) {
  return String(input).replace(/[0-9]/g, (d) => FA_DIGITS[d.charCodeAt(0) - 48]);
}

/** Normalise Persian/Arabic-Indic digits to ASCII. */
export function toLatinDigits(input) {
  return String(input)
    .replace(/[۰-۹]/g, (d) => String(FA_DIGITS.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String(AR_DIGITS.indexOf(d)));
}

/**
 * Format a number for display with Persian digits.
 * @param {number} n
 * @param {{maxFraction?: number, minFraction?: number, grouping?: boolean}} [opts]
 */
export function formatNumber(n, opts = {}) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  const { maxFraction = 2, minFraction = 0, grouping = false } = opts;
  const factor = 10 ** maxFraction;
  const rounded = Math.round((Math.abs(n) + Number.EPSILON) * factor) / factor;
  let [intPart, frac = ''] = rounded.toFixed(maxFraction).split('.');
  frac = frac.replace(/0+$/, '');
  while (frac.length < minFraction) frac += '0';
  if (grouping) intPart = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, FA_THOUSANDS);
  const sign = n < 0 && rounded !== 0 ? '−' : '';
  return toFaDigits(sign + intPart + (frac ? FA_DECIMAL + frac : ''));
}

/**
 * Parse user-entered numbers. Accepts Persian, Arabic-Indic and ASCII digits and
 * '٫', '.', ',' or '/' as the decimal separator. Returns NaN when the text is
 * not a plain decimal number (no expressions, no exponents, no units).
 */
export function parseNumber(text) {
  if (typeof text === 'number') return Number.isFinite(text) ? text : NaN;
  if (text == null) return NaN;
  let s = toLatinDigits(String(text)).trim();
  s = s.replace(/[‌‎‏\s]/g, '');
  s = s.replace(/[٫,/]/g, '.').replace(/^[−–]/, '-');
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(s)) return NaN;
  return Number(s);
}

/** Parse a strictly positive integer (copies, rows, columns). */
export function parseInteger(text) {
  const n = parseNumber(text);
  return Number.isInteger(n) ? n : NaN;
}

/** Human-readable byte size in Persian. */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${formatNumber(bytes)} بایت`;
  if (bytes < 1024 * 1024) return `${formatNumber(bytes / 1024, { maxFraction: 1 })} کیلوبایت`;
  if (bytes < 1024 ** 3) return `${formatNumber(bytes / 1024 ** 2, { maxFraction: 1 })} مگابایت`;
  return `${formatNumber(bytes / 1024 ** 3, { maxFraction: 2 })} گیگابایت`;
}
