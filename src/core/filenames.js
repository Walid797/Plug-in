// Safe, Persian-friendly file names. Keeps Persian letters, ZWNJ and digits;
// removes path separators, reserved characters, control and bidi-override
// characters (which can be used to disguise extensions).

const RESERVED_WIN = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const BIDI = /[‎‏‪-‮⁦-⁩؜﻿]/g;
const ILLEGAL = /[<>:"/\\|?*]/g;

export function sanitizeBaseName(name, fallback = 'عکس') {
  let s = String(name ?? '').normalize('NFC');
  s = s.replace(CONTROL, '').replace(BIDI, '').replace(ILLEGAL, '-');
  s = s.replace(/\s+/g, '-').replace(/-{2,}/g, '-');
  s = s.replace(/^[-.\s‌]+|[-.\s‌]+$/g, '');
  if (RESERVED_WIN.test(s)) s = `_${s}`;
  const chars = Array.from(s);
  if (chars.length > 80) s = chars.slice(0, 80).join('').replace(/[-.‌]+$/, '');
  return s || fallback;
}

/** Strip any extension the user typed and append a controlled one. */
export function safeFileName(base, ext) {
  const cleanExt = String(ext).toLowerCase().replace(/[^a-z0-9]/g, '');
  let b = String(base ?? '');
  b = b.replace(/\.(jpe?g|png|webp|pdf|zip|json|heic|gif|bmp|tiff?)$/i, '');
  return `${sanitizeBaseName(b)}.${cleanExt}`;
}

/** Base name of an imported file without extension, sanitised. */
export function importedBaseName(fileName) {
  return sanitizeBaseName(String(fileName ?? '').replace(/\.[^.]{1,6}$/, ''));
}
