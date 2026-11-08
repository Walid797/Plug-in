import test from 'node:test';
import assert from 'node:assert/strict';
import { formatNumber, parseNumber, parseInteger, toFaDigits, toLatinDigits, formatBytes } from '../../src/core/digits.js';
import { toSolarHijri, formatDateFa, dateStampFa } from '../../src/core/dates.js';
import { sanitizeBaseName, safeFileName, importedBaseName } from '../../src/core/filenames.js';
import { History } from '../../src/core/history.js';
import { mmToPx, effectiveDpi, mmToPt, pxToMm } from '../../src/core/units.js';
import { PAPER_PRESETS, PHOTO_PRESETS, RULE_PROFILES } from '../../src/core/presets.js';

test('Persian digits and tolerant parsing', () => {
  assert.equal(toFaDigits('3x4 cm 2026'), '۳x۴ cm ۲۰۲۶');
  assert.equal(toLatinDigits('۱۲۳٤٥'), '12345');
  assert.equal(formatNumber(2.5), '۲٫۵');
  assert.equal(formatNumber(1234567, { grouping: true }), '۱٬۲۳۴٬۵۶۷');
  assert.equal(formatNumber(-0.001), '۰');
  assert.equal(formatNumber(-3.5), '−۳٫۵');
  assert.equal(formatNumber(NaN), '—');
  assert.equal(parseNumber('۳٫۵'), 3.5);
  assert.equal(parseNumber('3,5'), 3.5);
  assert.equal(parseNumber('٤/٥'), 4.5);
  assert.equal(parseNumber(' ۱۰ '), 10);
  assert.ok(Number.isNaN(parseNumber('1e3')));
  assert.ok(Number.isNaN(parseNumber('10mm')));
  assert.ok(Number.isNaN(parseNumber('')));
  assert.ok(Number.isNaN(parseNumber('2+2')));
  assert.equal(parseInteger('۱۲'), 12);
  assert.ok(Number.isNaN(parseInteger('1.5')));
  assert.equal(formatBytes(1536), '۱٫۵ کیلوبایت');
});

test('Solar Hijri with Afghan month names agrees with ICU for 70 years', () => {
  const f = new Intl.DateTimeFormat('en-u-ca-persian', { year: 'numeric', month: 'numeric', day: 'numeric' });
  for (let t = Date.UTC(1990, 0, 1); t < Date.UTC(2060, 0, 1); t += 86400000 * 5) {
    const d = new Date(t + 12 * 3600e3);
    const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
    const r = toSolarHijri(d);
    assert.deepEqual([r.year, r.month, r.day], [+p.year, +p.month, +p.day], d.toISOString());
  }
  assert.equal(formatDateFa(new Date(2026, 2, 21)), '۱ حمل ۱۴۰۵');
  assert.equal(formatDateFa(new Date(2026, 10, 7)), '۱۶ عقرب ۱۴۰۵');
  assert.equal(dateStampFa(new Date(2026, 10, 7)), '۱۴۰۵-۰۸-۱۶');
});

test('file names: Persian kept, unsafe characters and bidi overrides removed', () => {
  assert.equal(sanitizeBaseName('عکس پرسنلی  احمد'), 'عکس-پرسنلی-احمد');
  assert.equal(sanitizeBaseName('می‌خواهم'), 'می‌خواهم'); // ZWNJ preserved
  assert.equal(sanitizeBaseName('../../etc/passwd'), 'etc-passwd');
  assert.equal(sanitizeBaseName('a:b*c?d"e<f>g|h'), 'a-b-c-d-e-f-g-h');
  assert.equal(sanitizeBaseName('photo‮gpj.exe'), 'photogpj.exe');
  assert.equal(sanitizeBaseName('CON'), '_CON');
  assert.equal(sanitizeBaseName('   ...  '), 'عکس');
  assert.equal(sanitizeBaseName('x'.repeat(200)).length, 80);
  assert.equal(safeFileName('برگه.pdf', 'pdf'), 'برگه.pdf');
  assert.equal(safeFileName('test.exe', 'jpg'), 'test.exe.jpg');
  assert.equal(importedBaseName('IMG_2041.JPG'), 'IMG_2041');
});

test('History: undo/redo and limits', () => {
  const h = new History({ limit: 3 });
  let state = { v: 0 };
  for (let i = 1; i <= 5; i += 1) { h.push(state); state = { v: i }; }
  assert.equal(h.past.length, 3);
  state = h.undo(state); assert.equal(state.v, 4);
  state = h.undo(state); assert.equal(state.v, 3);
  state = h.redo(state); assert.equal(state.v, 4);
  h.push(state); state = { v: 9 };
  assert.equal(h.canRedo(), false);
  const big = new History({ limit: 100, maxBytes: 2000 });
  for (let i = 0; i < 50; i += 1) big.push({ blob: 'x'.repeat(200) });
  assert.ok(big.bytes <= 2000);
});

test('units: pixels = cm / 2.54 × DPI', () => {
  assert.equal(mmToPx(30, 300), 354); // 3 cm at 300 DPI = 354.33
  assert.equal(mmToPx(40, 300), 472);
  assert.equal(mmToPx(50.8, 300), 600);
  assert.equal(mmToPx(30, 600), 709);
  assert.ok(Math.abs(effectiveDpi(354, 30) - 299.72) < 0.01);
  assert.ok(Math.abs(mmToPt(25.4) - 72) < 1e-12);
  assert.ok(Math.abs(pxToMm(354, 300) - 29.972) < 0.001);
});

test('presets are physically sane and every rule profile is marked unverified', () => {
  for (const p of [...PAPER_PRESETS, ...PHOTO_PRESETS]) assert.ok(p.widthMm > 0 && p.heightMm > 0);
  const ids = PAPER_PRESETS.map((p) => p.id);
  for (const id of ['a4', 'a5', '10x15', '13x18', '15x20', '20x25']) assert.ok(ids.includes(id));
  for (const id of ['3x4', '4x6', '2x2in', '5x5']) assert.ok(PHOTO_PRESETS.some((p) => p.id === id));
  for (const r of RULE_PROFILES) {
    assert.equal(r.verified, false);
    assert.ok(r.headHeight.min < r.headHeight.target && r.headHeight.target < r.headHeight.max);
    assert.ok(r.headHeight.max < r.heightMm);
  }
});
