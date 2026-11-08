// Paper sizes, photo sizes and ID-photo rule profiles.
// Rule profiles are guidance only. None is marked verified: the user must
// confirm requirements with the issuing authority before official use.

export const PAPER_PRESETS = Object.freeze([
  { id: 'a4', nameFa: 'A4', widthMm: 210, heightMm: 297 },
  { id: 'a5', nameFa: 'A5', widthMm: 148, heightMm: 210 },
  { id: '10x15', nameFa: '۱۰×۱۵ سانتی‌متر (۴×۶ انچ)', widthMm: 100, heightMm: 150, noteFa: 'کاغذ عکس ۴R؛ اندازهٔ دقیق ۴×۶ انچ ۱۰۱٫۶×۱۵۲٫۴ ملی‌متر است' },
  { id: '4x6in', nameFa: '۴×۶ انچ (۱۰۱٫۶×۱۵۲٫۴ ملی‌متر)', widthMm: 101.6, heightMm: 152.4 },
  { id: '13x18', nameFa: '۱۳×۱۸ سانتی‌متر', widthMm: 130, heightMm: 180 },
  { id: '15x20', nameFa: '۱۵×۲۰ سانتی‌متر', widthMm: 150, heightMm: 200 },
  { id: '20x25', nameFa: '۲۰×۲۵ سانتی‌متر', widthMm: 200, heightMm: 250 },
]);

export const PHOTO_PRESETS = Object.freeze([
  { id: '3x4', nameFa: '۳×۴ سانتی‌متر', widthMm: 30, heightMm: 40 },
  { id: '3.5x4.5', nameFa: '۳٫۵×۴٫۵ سانتی‌متر', widthMm: 35, heightMm: 45 },
  { id: '4x6', nameFa: '۴×۶ سانتی‌متر', widthMm: 40, heightMm: 60 },
  { id: '2x2in', nameFa: '۲×۲ انچ (۵۰٫۸ ملی‌متر)', widthMm: 50.8, heightMm: 50.8 },
  { id: '5x5', nameFa: '۵×۵ سانتی‌متر', widthMm: 50, heightMm: 50 },
]);

export const COPY_PRESETS = Object.freeze([1, 2, 4, 6, 8, 10, 12, 16, 20]);
export const DPI_PRESETS = Object.freeze([300, 350, 400, 600]);

/**
 * ID photo rule profiles (all distances in mm on the finished photo).
 * headHeight: chin → top of head (crown, including hair).
 * eyeFromBottom: bottom edge → eye line.
 */
export const RULE_PROFILES = Object.freeze([
  {
    // framing taken from the studio's quality reference (measured with the app's own face analysis):
    // head ≈ 25.5 mm (62–64% of the height), eye line ≈ 26 mm from the bottom, ≈ 2 mm above the head,
    // both shoulders and part of the jacket visible
    id: 'generic-3x4', nameFa: 'عکس پرسنلی عمومی ۳×۴', photoId: '3x4', widthMm: 30, heightMm: 40,
    headHeight: { min: 24, max: 28, target: 25.5 }, eyeFromBottom: { min: 24.5, max: 27.5, target: 26 },
    background: '#ffffff', verified: false,
    noteFa: 'راهنمای عمومی؛ با شرایط ادارهٔ صادرکننده (تذکره، مکتب، اداره) مطابقت داده نشده است.',
  },
  {
    id: 'icao-35x45', nameFa: 'سبک پاسپورت بین‌المللی ۳٫۵×۴٫۵ (ICAO)', photoId: '3.5x4.5', widthMm: 35, heightMm: 45,
    headHeight: { min: 32, max: 36, target: 34 }, eyeFromBottom: { min: 25, max: 31, target: 28 },
    background: '#ffffff', verified: false,
    noteFa: 'بر پایهٔ توصیه‌های عمومی ICAO؛ برای هر کشور جداگانه بررسی کنید.',
  },
  {
    id: 'us-2x2', nameFa: 'سبک ۲×۲ انچ', photoId: '2x2in', widthMm: 50.8, heightMm: 50.8,
    headHeight: { min: 25.4, max: 34.9, target: 30 }, eyeFromBottom: { min: 28.6, max: 34.9, target: 31.5 },
    background: '#ffffff', verified: false,
    noteFa: 'مقادیر رایج برای عکس ۲×۲ انچ؛ پیش از استفادهٔ رسمی با مرجع مربوط مطابقت دهید.',
  },
  {
    id: 'generic-4x6', nameFa: 'عکس عمومی ۴×۶', photoId: '4x6', widthMm: 40, heightMm: 60,
    headHeight: { min: 34, max: 42, target: 38 }, eyeFromBottom: { min: 34, max: 40, target: 37 },
    background: '#ffffff', verified: false, noteFa: 'راهنمای عمومی؛ تأییدنشده.',
  },
  {
    id: 'generic-5x5', nameFa: 'عکس عمومی ۵×۵', photoId: '5x5', widthMm: 50, heightMm: 50,
    headHeight: { min: 25, max: 35, target: 30 }, eyeFromBottom: { min: 28, max: 34, target: 31 },
    background: '#ffffff', verified: false, noteFa: 'راهنمای عمومی؛ تأییدنشده.',
  },
]);

/** Quick-start purposes shown on the home screen. */
export const PURPOSES = Object.freeze([
  { id: 'tazkira', nameFa: 'تذکره / کارت هویت', photoId: '3x4', profileId: 'generic-3x4' },
  { id: 'passport', nameFa: 'پاسپورت و ویزا', photoId: '3.5x4.5', profileId: 'icao-35x45' },
  { id: 'school', nameFa: 'مکتب و پوهنتون', photoId: '3x4', profileId: 'generic-3x4' },
  { id: 'employee', nameFa: 'کارت کارمندی', photoId: '3x4', profileId: 'generic-3x4' },
  { id: 'personal', nameFa: 'عکس شخصی', photoId: '4x6', profileId: 'generic-4x6' },
]);

export const BACKGROUND_PRESETS = Object.freeze([
  { id: 'white', nameFa: 'سفید', color: '#ffffff' },
  { id: 'lightblue', nameFa: 'آبی روشن', color: '#cfe3f5' },
  { id: 'lightgray', nameFa: 'خاکستری روشن', color: '#e4e6e8' },
]);

/** Border (frame) colours offered for photos. */
export const BORDER_COLORS = Object.freeze([
  { id: 'black', nameFa: 'سیاه', color: '#000000' },
  { id: 'darkgray', nameFa: 'خاکستری تیره', color: '#404040' },
  { id: 'gray', nameFa: 'خاکستری', color: '#9ca3af' },
]);

export const findPaper = (id) => PAPER_PRESETS.find((p) => p.id === id) || null;
export const findPhoto = (id) => PHOTO_PRESETS.find((p) => p.id === id) || null;
export const findProfile = (id, custom = []) => [...RULE_PROFILES, ...custom].find((p) => p.id === id) || null;
