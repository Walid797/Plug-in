// Persian (Dari) user-facing text and message formatters for machine codes.
import { formatNumber as fn } from '../core/digits.js';

const mm = (v) => `${fn(v, { maxFraction: 1 })} ملی‌متر`;
const n = (v) => fn(v, { maxFraction: 2 });

export const APP_NAME = 'هوشمند فوتو استودیو';
export const OFFLINE_BADGE = 'آفلاین — عکس‌های شما روی همین دستگاه باقی می‌ماند';

export const SECTIONS = [
  { id: 'home', title: 'صفحه اصلی / شروع کار', short: 'شروع', icon: 'house' },
  { id: 'editor', title: 'ویرایش عکس', short: 'ویرایش', icon: 'crop' },
  { id: 'smart', title: 'اصلاح هوشمند عکس پرسنلی', short: 'پرسنلی', icon: 'scan-face' },
  { id: 'background', title: 'حذف و تغییر پس‌زمینه', short: 'پس‌زمینه', icon: 'layers' },
  { id: 'clothing', title: 'تغییر لباس با هوش مصنوعی', short: 'لباس', icon: 'shirt' },
  { id: 'print', title: 'استودیوی چاپ', short: 'چاپ', icon: 'printer' },
  { id: 'templates', title: 'قالب‌های ذخیره‌شده', short: 'قالب‌ها', icon: 'layout-template' },
  { id: 'projects', title: 'پروژه‌ها و تاریخچه', short: 'پروژه‌ها', icon: 'folder-open' },
  { id: 'settings', title: 'تنظیمات و مدل‌های آفلاین', short: 'تنظیمات', icon: 'settings' },
];

export const WORKFLOW = ['وارد کردن', 'ویرایش', 'استانداردسازی', 'بازبینی', 'چیدمان چاپ', 'خروجی'];

const SIDE = { top: 'بالا', right: 'راست', bottom: 'پایین', left: 'چپ' };
const ORIENT = { portrait: 'عمودی', landscape: 'افقی' };
export const orientationName = (o) => ORIENT[o] || o;

/** Layout engine error → Persian. */
export function layoutErrorText(e) {
  switch (e.code) {
    case 'PAPER_INVALID': return 'اندازهٔ کاغذ نامعتبر است (باید بین ۱۰ تا ۲۰۰۰ ملی‌متر باشد).';
    case 'MARGIN_INVALID': return `حاشیهٔ ${SIDE[e.side] || ''} نامعتبر است (عدد صفر یا مثبت وارد کنید).`;
    case 'GAP_INVALID': return 'فاصلهٔ بین عکس‌ها نامعتبر است.';
    case 'LABEL_INVALID': return 'اندازهٔ برچسب نامعتبر است.';
    case 'NO_ITEMS': return 'هنوز هیچ عکسی به برگه اضافه نشده است.';
    case 'ITEM_SIZE_INVALID': return 'اندازهٔ یکی از عکس‌ها نامعتبر است.';
    case 'COPIES_INVALID': return 'تعداد نسخه باید عدد صحیح بین ۰ تا ۵۰۰۰ باشد.';
    case 'COPIES_TOO_MANY': return `مجموع نسخه‌ها (${n(e.total)}) بیش از حد مجاز است.`;
    case 'COPIES_ZERO': return 'تعداد نسخهٔ همهٔ عکس‌ها صفر است.';
    case 'GRID_INVALID': return 'تعداد ستون/ردیف باید عدد صحیح مثبت باشد.';
    case 'GRID_TOO_WIDE': return `${n(e.cols)} ستون به ${mm(e.need)} عرض نیاز دارد، اما فقط ${mm(e.avail)} عرض قابل استفاده است. اندازهٔ عکس هرگز کوچک نمی‌شود؛ ستون‌ها، حاشیه یا فاصله را کم کنید.`;
    case 'GRID_TOO_TALL': return `${n(e.rows)} ردیف به ${mm(e.need)} ارتفاع نیاز دارد، اما فقط ${mm(e.avail)} ارتفاع قابل استفاده است.`;
    case 'CUSTOM_OFFSET_INVALID': return 'جابجایی سفارشی باید عدد صفر یا مثبت باشد.';
    case 'CUSTOM_OFFSET_OUT_OF_RANGE': return `جابجایی سفارشی عکس‌ها را از ناحیهٔ قابل چاپ بیرون می‌برد (حداکثر افقی ${mm(e.maxX)}، عمودی ${mm(e.maxY)}).`;
    case 'AREA_TOO_SMALL': return `با این حاشیه‌ها در حالت ${orientationName(e.orientation)} جایی برای چاپ باقی نمی‌ماند.`;
    case 'PHOTO_DOES_NOT_FIT': return `عکس ${mm(e.needW)} × ${mm(e.needH)} در ناحیهٔ قابل استفادهٔ ${mm(e.availW)} × ${mm(e.availH)} (حالت ${orientationName(e.orientation)}) جا نمی‌شود.`;
    case 'ITEM_TOO_LARGE': return `یکی از عکس‌ها از ناحیهٔ قابل استفادهٔ ${mm(e.availW)} × ${mm(e.availH)} بزرگ‌تر است.`;
    case 'TOO_MANY_PAGES': return `این چیدمان به ${n(e.pages)} برگه نیاز دارد که بیش از حد مجاز (${n(e.max)}) است.`;
    default: return 'خطای ناشناخته در محاسبهٔ چیدمان.';
  }
}

export function layoutWarningText(w) {
  switch (w.code) {
    case 'OTHER_ORIENTATION_BETTER': return `در حالت ${orientationName(w.orientation)} تا ${n(w.capacity)} عکس در هر برگه جا می‌شود (اکنون ${n(w.current)}). «خودکار» را انتخاب کنید یا جهت را عوض کنید.`;
    case 'UNUSED_SLOTS': return `ظرفیت هر برگه ${n(w.capacity)} عکس است؛ ${n(w.count)} جای خالی باقی می‌ماند.`;
    case 'ROTATED_FOR_FIT': return `برای جا شدن بیشتر، ${n(w.count)} عکس ۹۰ درجه روی کاغذ چرخانده شده‌اند. اندازهٔ عکس تغییر نکرده است؛ پس از بریدن، عکس عادی است.`;
    case 'MARGINS_BELOW_PRINTER': return 'حاشیه‌ها از حاشیهٔ غیرقابل چاپ چاپگر کمتر است. اگر چاپ بدون حاشیه (Borderless) ندارید، لبه‌ها ممکن است چاپ نشوند.';
    case 'PRINTER_MARGIN_CLIP': return `${n(w.count)} عکس در ناحیهٔ غیرقابل چاپ چاپگر قرار می‌گیرد و ممکن است بریده شود.`;
    default: return '';
  }
}

export function qualityText(q) {
  const d = (v) => fn(v, { maxFraction: 1 });
  switch (q.code) {
    case 'FACE_NOT_FOUND': return { title: 'چهره پیدا نشد', body: 'در این عکس چهره‌ای تشخیص داده نشد. عکس روبه‌رو با نور کافی انتخاب کنید یا کادر را دستی تنظیم کنید.' };
    case 'MULTIPLE_FACES': return { title: 'بیش از یک چهره', body: `${d(q.value)} چهره دیده شد. عکس پرسنلی باید فقط یک نفر داشته باشد.` };
    case 'ROLL': return { title: 'صافی سر', body: q.level === 'ok' ? `سر صاف است (انحراف ${d(q.value)} درجه).` : `سر ${d(q.value)} درجه کج است. «پیشنهاد کادر» آن را صاف می‌کند.` };
    case 'YAW': return { title: 'روبه‌رو بودن چهره', body: q.level === 'ok' ? 'چهره تقریباً روبه‌روی دوربین است.' : 'چهره کاملاً روبه‌رو نیست؛ این را با ویرایش نمی‌توان اصلاح کرد.' };
    case 'HEAD_SIZE': return { title: 'اندازهٔ سر', body: `ارتفاع سر ${d(q.value)} ملی‌متر (مجاز: ${d(q.min)} تا ${d(q.max)})${q.estimated ? ' — بالای سر تخمینی است' : ''}.` };
    case 'EYE_LINE': return { title: 'ارتفاع خط چشم', body: `خط چشم ${d(q.value)} ملی‌متر از پایین (مجاز: ${d(q.min)} تا ${d(q.max)}).` };
    case 'CENTRED': return { title: 'وسط بودن', body: q.level === 'ok' ? 'چهره در وسط کادر است.' : `چهره ${d(Math.abs(q.value))} ملی‌متر به ${q.value > 0 ? 'راست' : 'چپ'} جابجا است.` };
    case 'FACE_CROPPED': return { title: 'بریده‌شدن سر یا چانه', body: q.level === 'ok' ? 'سر و چانه کامل داخل کادر است.' : 'بخشی از سر، چانه یا صورت بیرون از کادر است.' };
    case 'FRAME_OUTSIDE': return { title: 'کادر بیرون از عکس', body: 'بخشی از کادر بیرون از عکس اصلی است و با رنگ پس‌زمینه پر می‌شود.' };
    case 'LIGHTING': return { title: 'نور', body: q.level === 'ok' ? 'نور چهره مناسب است.' : q.dark ? 'چهره تاریک است؛ نوردهی یا روشنایی را بیشتر کنید.' : 'چهره بیش از حد روشن است.' };
    case 'LIGHT_BALANCE': return { title: 'یکنواختی نور', body: q.level === 'ok' ? 'نور دو طرف صورت یکسان است.' : 'یک طرف صورت تاریک‌تر است (سایهٔ تند).' };
    case 'SHARPNESS': return { title: 'وضوح', body: q.level === 'ok' ? 'عکس واضح به نظر می‌رسد.' : 'عکس ممکن است تار باشد (تخمین خودکار).' };
    case 'RESOLUTION': return { title: 'کیفیت برای چاپ', body: `وضوح مؤثر ${d(q.value)} DPI${q.level === 'ok' ? '' : ' — برای چاپ ۳۰۰ DPI کافی نیست و عکس بزرگ‌نمایی می‌شود'}.` };
    default: return { title: q.code, body: '' };
  }
}

export const LEVEL_FA = { ok: 'مناسب', warn: 'هشدار', error: 'مشکل', info: 'آگاهی' };

export function importErrorText(code, extra = {}) {
  switch (code) {
    case 'UNSUPPORTED': return `قالب «${extra.name || ''}» پشتیبانی نمی‌شود. فقط JPG، PNG و WebP.`;
    case 'HEIC': return `«${extra.name || ''}» با قالب HEIC/HEIF است. در تنظیمات دوربین آیفون «Most Compatible» را انتخاب کنید یا عکس را به JPG تبدیل کنید.`;
    case 'TOO_LARGE_FILE': return `«${extra.name || ''}» بیش از ${fn(extra.limitMb)} مگابایت است.`;
    case 'TOO_MANY_PIXELS': return `ابعاد «${extra.name || ''}» بیش از حد بزرگ است (${fn(extra.mp, { maxFraction: 0 })} مگاپیکسل).`;
    case 'TOO_SMALL': return `«${extra.name || ''}» بسیار کوچک است (${fn(extra.w)}×${fn(extra.h)} پیکسل).`;
    case 'DECODE': return `«${extra.name || ''}» باز نشد؛ فایل خراب است یا مرورگر آن را پشتیبانی نمی‌کند.`;
    case 'MEMORY': return `حافظهٔ دستگاه برای باز کردن «${extra.name || ''}» کافی نیست.`;
    case 'WEBP_UNSUPPORTED': return 'این مرورگر WebP را باز نمی‌کند.';
    default: return 'خطا در وارد کردن عکس.';
  }
}

export function storageErrorText(err) {
  const name = err?.name || '';
  if (name === 'QuotaExceededError') return 'فضای ذخیره‌سازی مرورگر پر است. پروژه‌های قدیمی را حذف کنید یا عکس‌های اصلی را نگه ندارید.';
  if (name === 'InvalidStateError' || name === 'SecurityError') return 'ذخیره‌سازی محلی در این حالت مرورگر (مثلاً پنجرهٔ خصوصی) در دسترس نیست.';
  return 'ذخیره در حافظهٔ محلی انجام نشد.';
}
