// Printer guidance for 4-colour Epson inkjets (EcoTank / L-series) on photo
// paper. A web page cannot change printer-driver settings, so these are shown
// to the user; option names differ slightly between models and driver versions.
import { Icon } from './kit.jsx';

export function EpsonQuickLine() {
  return (
    <p class="small epson-line">
      <Icon name="printer" size={16} />
      <span>در پنجرهٔ چاپ: کاغذ <b dir="ltr">10 x 15 cm (4 x 6 in)</b>، مقیاس <b>پیش‌فرض / ۱۰۰٪</b>، حاشیه <b>پیش‌فرض یا هیچ</b>. در تنظیمات اپسون: نوع کاغذ <b>Glossy</b> (نه Plain) و کیفیت <b>High</b>.</span>
    </p>
  );
}

export function EpsonGuide({ open = false }) {
  return (
    <details class="epson-guide" open={open}>
      <summary><Icon name="printer" size={16} />تنظیمات چاپگر اپسون ۴ رنگ (سری L / EcoTank) برای کاغذ عکس</summary>
      <div class="epson-body">
        <h4>۱. در پنجرهٔ چاپ مرورگر (Chrome / Edge)</h4>
        <ol>
          <li><b>اندازهٔ کاغذ (Paper size):</b> «10 x 15 cm (4 x 6 in)». برنامه اندازهٔ دقیق صفحه را می‌فرستد، اما مرورگر کاغذِ چاپگر را خودش عوض نمی‌کند؛ اگر پیش‌فرض چاپگر A4 باشد، اینجا باید ۴×۶ را انتخاب کنید (یا پایین‌تر، پیش‌فرض چاپگر را یک بار ۴×۶ کنید).</li>
          <li><b>مقیاس (Scale):</b> «پیش‌فرض / Default» یعنی ۱۰۰٪. گزینهٔ «Fit to page / متناسب با صفحه» خاموش باشد.</li>
          <li><b>حاشیه (Margins):</b> «پیش‌فرض» یا «هیچ / None».</li>
          <li><b>Background graphics</b> روشن (برای نشانه‌های برش) و <b>Headers and footers</b> خاموش.</li>
          <li>برای تنظیمات اختصاصی اپسون در ویندوز: «Print using system dialog» (Ctrl+Shift+P) ← «Preferences».</li>
        </ol>
        <h4>۲. تنظیمات درایور اپسون (یک بار؛ ذخیره می‌شود)</h4>
        <p class="small muted">ویندوز: Settings ← Printers ← چاپگر اپسون ← Printing preferences. آنچه اینجا بگذارید پیش‌فرض همهٔ چاپ‌ها می‌شود.</p>
        <ol>
          <li><b>نوع کاغذ (Paper Type):</b> دقیقاً مطابق کاغذ: «Epson Premium Glossy» یا «Photo Paper Glossy». <b>هرگز «Plain paper» برای کاغذ عکس</b> — جوهر زیادی می‌ریزد و عکس <b>تیره، کدر و خیس</b> می‌شود؛ این شایع‌ترین علت تاریک آمدن عکس است.</li>
          <li><b>کیفیت (Quality):</b> «High» یا «Best Photo».</li>
          <li><b>اندازهٔ سند (Document Size):</b> «10 x 15 cm (4 x 6 in)» و جهت مطابق برنامه.</li>
          <li><b>High Speed</b> (چاپ دوطرفهٔ سریع) را خاموش کنید تا خطوط ریز و تاری کمتر شود.</li>
          <li><b>بدون حاشیه (Borderless):</b> خاموش؛ قالب‌ها با حاشیهٔ ۵ ملی‌متر چیده شده‌اند. اگر روشن کردید، «Amount of Enlargement / Expansion» را روی کمترین (Min) بگذارید تا عکس بزرگ‌تر از اندازه چاپ نشود.</li>
          <li><b>رنگ (More Options):</b> Color Correction «Automatic» و Color Mode «EPSON Standard (sRGB)»؛ PhotoEnhance خاموش. <b>Brightness درایور را صفر بگذارید</b>، چون برنامه خودش «روشن‌سازی چاپ» را اعمال می‌کند — دو بار روشن نکنید.</li>
          <li><b>جهت کاغذ:</b> طرف براق (قابل چاپ) را طبق دفترچهٔ چاپگر بگذارید؛ در سینی عقب سری L معمولاً رو به بالا.</li>
        </ol>
        <h4>۳. از گوشی اندروید</h4>
        <ol>
          <li>Chrome ← ⋮ ← اشتراک‌گذاری ← چاپ ← چاپگر اپسون (سرویس چاپ Mopria یا Epson Print Enabler). اندازهٔ کاغذ «4x6» و اگر نشان داد، نوع کاغذ «Photo / Glossy».</li>
          <li>یا «PDF با اندازهٔ دقیق» را بسازید و با برنامهٔ Epson Smart Panel با «اندازهٔ واقعی / Actual size» چاپ کنید.</li>
        </ol>
        <h4>۴. روشنایی و کیفیت</h4>
        <ul>
          <li>یک بار «برگهٔ آزمایش روشنایی» را چاپ کنید (استودیوی چاپ ← چاپگر و کیفیت). چهار نسخه با سطح‌های خاموش/کم/متوسط/زیاد چاپ می‌شود؛ بهترین را انتخاب کنید.</li>
          <li>رنگ جوهر پس از خشک شدن کمی تغییر می‌کند؛ ۱۰ تا ۳۰ دقیقه بعد مقایسه کنید و نور صفحهٔ گوشی را برای مقایسه زیاد نگذارید.</li>
          <li>اگر رگه یا رنگ اشتباه دیدید: Maintenance ← Nozzle Check و در صورت نیاز Head Cleaning.</li>
          <li>نام دقیق گزینه‌ها در مدل‌ها و نسخه‌های مختلف درایور کمی فرق دارد.</li>
        </ul>
      </div>
    </details>
  );
}
