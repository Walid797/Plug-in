import { useEffect, useRef, useState } from 'preact/hooks';
import { useStore, closeDialog } from '../state/store.js';
import { Button, Icon, IconButton } from './kit.jsx';
import { formatNumber } from '../core/digits.js';
import { orientationName, WORKFLOW, OFFLINE_BADGE } from '../i18n/fa.js';

function Modal({ title, children, footer, wide, onCancel }) {
  const ref = useRef(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) {
      try { d.showModal(); } catch { d.setAttribute('open', ''); }
    }
    const first = d?.querySelector('[data-autofocus]') || d?.querySelector('button, input, select');
    first?.focus();
  }, []);
  return (
    <dialog ref={ref} class={`modal ${wide ? 'wide' : ''}`} aria-labelledby="dlg-title" onCancel={(e) => { e.preventDefault(); onCancel(); }}>
      <div class="modal-head">
        <h2 id="dlg-title">{title}</h2>
        <IconButton icon="x" label="بستن" onClick={onCancel} />
      </div>
      <div class="modal-body">{children}</div>
      {footer ? <div class="modal-foot">{footer}</div> : null}
    </dialog>
  );
}

function ConfirmDialog({ title, body, confirmLabel = 'تأیید', danger, cancelLabel = 'انصراف' }) {
  return (
    <Modal title={title} onCancel={() => closeDialog(false)} footer={<>
      <Button variant={danger ? 'danger' : 'primary'} data-autofocus onClick={() => closeDialog(true)}>{confirmLabel}</Button>
      <Button variant="ghost" onClick={() => closeDialog(false)}>{cancelLabel}</Button>
    </>}>
      {typeof body === 'string' ? <p>{body}</p> : body}
    </Modal>
  );
}

function RetainDialog() {
  const [remember, setRemember] = useState(false);
  return (
    <Modal title="عکس‌های اصلی ذخیره شوند؟" onCancel={() => closeDialog({ keep: false, remember: false })} footer={<>
      <Button variant="primary" data-autofocus onClick={() => closeDialog({ keep: true, remember })}>بله، روی همین دستگاه ذخیره شود</Button>
      <Button onClick={() => closeDialog({ keep: false, remember })}>نه، فقط در همین جلسه</Button>
    </>}>
      <p>برای اینکه بعداً بتوانید این پروژه را دوباره باز و چاپ کنید، عکس‌های اصلی باید در حافظهٔ محلی همین مرورگر نگه داشته شوند.</p>
      <ul class="checklist">
        <li><Icon name="shield-check" />عکس‌ها هرگز به انترنت فرستاده نمی‌شوند و فقط روی همین دستگاه می‌مانند.</li>
        <li><Icon name="trash-2" />هر زمان بخواهید از «پروژه‌ها» یا «تنظیمات» می‌توانید آن‌ها را کامل پاک کنید.</li>
        <li><Icon name="info" />اگر «فقط در همین جلسه» را انتخاب کنید، تنظیمات ویرایش ذخیره می‌شود اما پس از بستن صفحه باید عکس‌ها را دوباره انتخاب کنید.</li>
      </ul>
      <label class="switch"><span>این انتخاب را به خاطر بسپار</span><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.currentTarget.checked)} /><span class="track" aria-hidden="true" /></label>
    </Modal>
  );
}

function PrePrintDialog({ layout, paper, mode }) {
  const W = layout.sheet.widthMm; const H = layout.sheet.heightMm;
  const isPdf = mode === 'pdf';
  return (
    <Modal wide title={isPdf ? 'پیش از چاپ فایل PDF' : 'پیش از چاپ — تنظیمات پنجرهٔ چاپ'} onCancel={() => closeDialog(false)} footer={<>
      <Button variant="primary" icon={isPdf ? 'file-down' : 'printer'} data-autofocus onClick={() => closeDialog(true)}>{isPdf ? 'ساخت PDF' : 'ادامه و باز کردن پنجرهٔ چاپ'}</Button>
      <Button variant="ghost" onClick={() => closeDialog(false)}>انصراف</Button>
    </>}>
      <div class="notice info"><Icon name="info" /><div>
        <strong>کاغذ: {paper.nameFa} — {formatNumber(W)} × {formatNumber(H)} ملی‌متر، جهت {orientationName(layout.orientation)}</strong>
        <p>{formatNumber(layout.totals.placed)} عکس روی {formatNumber(layout.totals.sheets)} برگه. هر برگه دقیقاً یک صفحهٔ چاپی است.</p>
      </div></div>
      <ul class="checklist">
        <li><Icon name="check" /><span><b>اندازهٔ کاغذ</b> را در پنجرهٔ چاپ دقیقاً «{paper.nameFa}» ({formatNumber(W)}×{formatNumber(H)} ملی‌متر) انتخاب کنید. اگر در فهرست نیست، اندازهٔ سفارشی بسازید.</span></li>
        <li><Icon name="check" /><span><b>جهت</b> را «{orientationName(layout.orientation)}» بگذارید.</span></li>
        <li><Icon name="check" /><span><b>مقیاس (Scale)</b> را ۱۰۰٪ یا «اندازهٔ واقعی / Actual size» بگذارید و <b>«متناسب با صفحه / Fit to page / Shrink»</b> را خاموش کنید.</span></li>
        <li><Icon name="check" /><span><b>حاشیه‌ها (Margins)</b> را «هیچ / None» بگذارید. {isPdf ? '' : 'سربرگ و پانویس (Headers and footers) را خاموش کنید.'}</span></li>
        <li><Icon name="check" /><span><b>سینی کاغذ</b> را درست انتخاب کنید (برای کاغذ عکس معمولاً سینی عکس یا «Photo tray»).</span></li>
        <li><Icon name="check" /><span><b>نوع کاغذ</b> را «Photo paper / Glossy» و کیفیت را «Best / High» انتخاب کنید.</span></li>
        <li><Icon name="check" /><span><b>بدون حاشیه (Borderless)</b>: فقط اگر چاپگر پشتیبانی می‌کند و حاشیه‌های برنامه را کمتر از حاشیهٔ چاپگر گذاشته‌اید روشن کنید. بعضی درایورها در حالت بدون حاشیه کمی بزرگ‌نمایی (Expansion) می‌کنند؛ آن را کمترین مقدار بگذارید.</span></li>
      </ul>
      <div class="notice warn"><Icon name="triangle-alert" /><p>تنظیمات مرورگر یا درایور چاپگر می‌تواند اندازهٔ چاپ را تغییر دهد. برای اطمینان، یک بار «برگهٔ کالیبراسیون» را چاپ و با خط‌کش اندازه بگیرید. دقت اندازه تا زمانی که با خط‌کش بررسی نشود تضمین‌شده نیست.</p></div>
    </Modal>
  );
}

function OnboardingDialog() {
  const [step, setStep] = useState(0);
  const steps = [
    { icon: 'shield-check', title: 'به هوشمند فوتو استودیو خوش آمدید', body: <><p>این برنامه برای عکس‌های تذکره، پاسپورت، مکتب، کارمندی و شخصی ساخته شده و <b>کاملاً آفلاین</b> کار می‌کند.</p><p class="muted">{OFFLINE_BADGE}. هیچ عکسی به انترنت فرستاده نمی‌شود.</p></> },
    { icon: 'images', title: 'مراحل کار', body: <ol class="steps">{WORKFLOW.map((w, i) => <li key={w}><b>{formatNumber(i + 1)}.</b> {w}</li>)}</ol> },
    { icon: 'printer', title: 'چاپ دقیق', body: <><p>در «استودیوی چاپ» اندازهٔ کاغذ و عکس را انتخاب کنید؛ برنامه بیشترین تعداد قابل جا شدن را حساب می‌کند و هرگز عکس را کوچک یا کشیده نمی‌کند.</p><p class="muted">هنگام چاپ، مقیاس را ۱۰۰٪ بگذارید و یک بار برگهٔ کالیبراسیون را با خط‌کش بررسی کنید.</p></> },
    { icon: 'cpu', title: 'هوش مصنوعی محلی', body: <><p>تشخیص چهره و حذف پس‌زمینه با مدل‌های محلی روی همین دستگاه انجام می‌شود. اگر مدلی نصب نباشد، دکمهٔ آن غیرفعال است و دلیلش نوشته شده است.</p><p class="muted">ویرایش دستی و چاپ همیشه بدون هوش مصنوعی هم کار می‌کند.</p></> },
  ];
  const s = steps[step];
  const last = step === steps.length - 1;
  return (
    <Modal title={s.title} onCancel={() => closeDialog(true)} footer={<>
      <Button variant="primary" data-autofocus onClick={() => (last ? closeDialog(true) : setStep(step + 1))}>{last ? 'شروع کار' : 'بعدی'}</Button>
      {step > 0 ? <Button variant="ghost" onClick={() => setStep(step - 1)}>قبلی</Button> : null}
      <span class="faint small" style={{ marginInlineStart: 'auto' }}>{formatNumber(step + 1)} از {formatNumber(steps.length)}</span>
    </>}>
      <div class="onboard-icon"><Icon name={s.icon} size={34} /></div>
      {s.body}
    </Modal>
  );
}

function PromptDialog({ title, label, value = '', confirmLabel = 'ذخیره' }) {
  const [v, setV] = useState(value);
  return (
    <Modal title={title} onCancel={() => closeDialog(null)} footer={<>
      <Button variant="primary" onClick={() => closeDialog(v.trim() || null)}>{confirmLabel}</Button>
      <Button variant="ghost" onClick={() => closeDialog(null)}>انصراف</Button>
    </>}>
      <label class="field"><span class="field-label">{label}</span>
        <input class="input" data-autofocus value={v} maxLength={120} onInput={(e) => setV(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === 'Enter') closeDialog(v.trim() || null); }} />
      </label>
    </Modal>
  );
}

const KINDS = { confirm: ConfirmDialog, retain: RetainDialog, preprint: PrePrintDialog, onboarding: OnboardingDialog, prompt: PromptDialog };

export function Dialogs() {
  const dialog = useStore((s) => s.dialog);
  if (!dialog) return null;
  const C = KINDS[dialog.kind];
  return C ? <C key={dialog.kind} {...dialog.props} /> : null;
}
