import { useState } from 'preact/hooks';
import { useStore, closeDialog, getState, openRepairBrush } from '../state/store.js';
import { Button, Icon, Badge, Modal } from './kit.jsx';
import { QuickPresetEditorDialog, bgColorName } from './QuickPresetEditor.jsx';
import { formatNumber } from '../core/digits.js';
import { orientationName, WORKFLOW, OFFLINE_BADGE, qualityText } from '../i18n/fa.js';
import { EpsonGuide, EpsonQuickLine } from './EpsonGuide.jsx';
import { computeSheetLayout, resolvePaper, PRINT_BOOST_FA } from '../print/sheet.js';
import { findQuickPreset, quickSizeLabel } from '../core/quickpresets.js';
import { segErrorText } from './views/Background.jsx';

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
        <li><Icon name="check" /><span><b>نوع کاغذ</b> را «Photo paper / Glossy» و کیفیت را «Best / High» انتخاب کنید (نه Plain paper؛ وگرنه عکس تیره می‌آید).</span></li>
        <li><Icon name="check" /><span><b>بدون حاشیه (Borderless)</b>: فقط اگر چاپگر پشتیبانی می‌کند و حاشیه‌های برنامه را کمتر از حاشیهٔ چاپگر گذاشته‌اید روشن کنید. بعضی درایورها در حالت بدون حاشیه کمی بزرگ‌نمایی (Expansion) می‌کنند؛ آن را کمترین مقدار بگذارید.</span></li>
      </ul>
      <EpsonGuide />
      <div class="notice warn"><Icon name="triangle-alert" /><p>تنظیمات مرورگر یا درایور چاپگر می‌تواند اندازهٔ چاپ را تغییر دهد. برای اطمینان، یک بار «برگهٔ کالیبراسیون» را چاپ و با خط‌کش اندازه بگیرید. دقت اندازه تا زمانی که با خط‌کش بررسی نشود تضمین‌شده نیست.</p></div>
    </Modal>
  );
}

function bgStatus(r, color) {
  const name = bgColorName(color);
  if (r.bg === 'ok') return { kind: 'ok', text: `پس‌زمینه ${name} شد` };
  if (r.bg === 'white') return { kind: 'ok', text: 'پس‌زمینه از قبل سفید بود؛ دست نخورد (جزئیات مو حفظ شد)' };
  if (r.bg === 'reused') return { kind: 'ok', text: `پس‌زمینه ${name} شد (ماسک قبلی)` };
  if (r.bg === 'failed') return { kind: 'err', text: `پس‌زمینه ${name} نشد`, detail: segErrorText({ code: r.bgError, ...(r.bgErrorInfo || {}) }) };
  if (r.bg === 'off') return { kind: '', text: 'پس‌زمینه طبق قالب دست نخورد' };
  return { kind: 'warn', text: 'پس‌زمینه دست نخورد (مدل محلی در دسترس نیست)' };
}

function cropStatus(r) {
  if (r.crop === 'ok') return { kind: 'ok', text: r.faces > 1 ? `کادر بر اساس بزرگ‌ترین چهره (${formatNumber(r.faces)} چهره)` : 'کادر و اندازهٔ سر تنظیم شد' };
  if (r.crop === 'noface') return { kind: 'err', text: 'چهره پیدا نشد؛ کادر پیش‌فرض ماند' };
  if (r.crop === 'failed') return { kind: 'err', text: 'تحلیل چهره ناموفق بود؛ کادر پیش‌فرض ماند' };
  if (r.cancelled) return { kind: 'warn', text: 'کادر خودکار انجام نشد (لغو شد)' };
  if (r.crop === 'off') return { kind: '', text: 'کادر طبق قالب دستی می‌ماند' };
  return { kind: 'warn', text: 'کادر خودکار انجام نشد (مدل چهره در دسترس نیست)' };
}

function engineStatus(r, preset) {
  const out = [];
  const e = r.engine;
  if (preset?.skinOn || preset?.lightOn) {
    if (!r.faces) out.push({ kind: 'warn', icon: 'triangle-alert', text: 'موتور پوست و نور اجرا نشد (چهره پیدا نشد)' });
    else if (!e) out.push({ kind: 'warn', icon: 'triangle-alert', text: 'موتور پوست و نور اجرا نشد (خطا)' });
    else if (!e.applied) out.push({ kind: 'warn', icon: 'triangle-alert', text: e.reason === 'NO_SKIN' ? 'پوست در عکس به‌اندازهٔ کافی تشخیص داده نشد؛ موتور پوست و نور اعمال نشد' : 'موتور پوست و نور اعمال نشد' });
    else {
      if (preset.skinOn && preset.skinSmooth > 0) out.push({ kind: 'ok', icon: 'check', text: `پوست صاف و تمیز شد (${formatNumber(preset.skinSmooth)}٪؛ مو، ابرو، چشم و لب دست‌نخورده)` });
      if (preset.skinOn && preset.skinSpots > 0) out.push(e.spotsFrac > 0.0005 || e.blemishes > 0 ? { kind: 'ok', icon: 'check', text: `جوش، خال و لکه‌ها خودکار پاک شد${e.blemishes ? ` (${formatNumber(e.blemishes)} نقطه با بافت واقعی پوست ترمیم شد)` : ''}؛ ریش، ابرو، چشم، لب و بافت پوست حفظ شد` } : { kind: 'ok', icon: 'check', text: 'لکهٔ واضحی برای پاک‌کردن پیدا نشد' });
      if (preset.skinOn) out.push(e.redShift > 0.3 ? { kind: 'ok', icon: 'check', text: 'قرمزی بیش‌ازحد پوست کم شد' } : { kind: 'ok', icon: 'check', text: 'رنگ پوست طبیعی بود؛ تغییر نکرد' });
      if (preset.lightOn) out.push(e.lift > 0.5 || e.protectedFrac > 0.02 ? { kind: 'ok', icon: 'check', text: `نور صورت یکنواخت‌تر شد${e.protectedFrac > 0.02 ? ' (نور سوخته مهار شد)' : ''}` } : { kind: 'ok', icon: 'check', text: 'نور صورت از قبل یکنواخت بود' });
    }
  }
  if (preset?.grade) {
    const gs = r.gradeStrength ?? 1;
    const ds = r.detailStrength ?? 1;
    if (preset.gradeAdaptive && ds <= 0.05) out.push({ kind: 'ok', icon: 'check', text: 'عکس از قبل واضح بود؛ وضوح موضعی اضافه نشد' });
    else if (preset.gradeAdaptive && ds < 0.95) out.push({ kind: 'ok', icon: 'check', text: `وضوح موضعی ${formatNumber(Math.round(ds * 100))}٪ اعمال شد (عکس تا حدی واضح بود)` });
    out.push({ kind: 'ok', icon: 'check', text: !preset.gradeAdaptive || gs >= 0.95 ? 'تنظیم رنگ قالب اعمال شد' : gs <= 0.05 ? 'چهره از قبل روشن بود؛ روشن‌سازی انجام نشد (فقط تنظیم‌های ظریف رنگ و وضوح)' : `تنظیم رنگ قالب اعمال شد (روشن‌سازی ${formatNumber(Math.round(gs * 100))}٪ چون چهره نسبتاً روشن بود)` });
  }
  if (r.shoulders === 'ok') out.push({ kind: 'ok', icon: 'check', text: 'هر دو شانه دیده می‌شود' });
  else if (r.shoulders === 'widened') out.push({ kind: 'ok', icon: 'check', text: 'کادر برای دیدن شانه‌ها بازتر شد' });
  else if (r.shoulders === 'limited') out.push({ kind: 'warn', icon: 'triangle-alert', text: 'شانه‌ها کامل دیده نمی‌شوند و کادر بازتر نمی‌شود (قاعدهٔ اندازهٔ سر یا لبهٔ عکس)' });
  return out;
}

/** Result of a one-click preset: what really happened, then one Print button. */
function QuickReadyDialog({ presetId, results, cancelled, aiState }) {
  const st = getState();
  const preset = findQuickPreset(presetId, st.settings);
  const layout = computeSheetLayout(st);
  const paper = resolvePaper(st.project.sheet, st.settings);
  const sizeName = preset ? quickSizeLabel(preset) : '';
  const boost = st.project.sheet.printBoost || 'off';
  const ok = results.filter((r) => !r.error);
  const missing = results.filter((r) => r.error);
  const canPrint = !!layout?.ok;
  return (
    <Modal wide title="آماده برای چاپ" onCancel={() => closeDialog('review')} footer={<>
      <Button variant="primary" size="lg" icon="printer" data-autofocus disabled={!canPrint} onClick={() => closeDialog('print')}>چاپ</Button>
      <Button icon="file-down" disabled={!canPrint} onClick={() => closeDialog('pdf')}>PDF با اندازهٔ دقیق</Button>
      <Button variant="ghost" onClick={() => closeDialog('review')}>اول پیش‌نمایش را ببینم</Button>
    </>}>
      {canPrint ? (
        <div class="notice ok"><Icon name="circle-check" /><div>
          <strong>{formatNumber(layout.totals.placed)} عکس {sizeName} روی {formatNumber(layout.totals.sheets)} برگهٔ {paper.nameFa}</strong>
          <p>هر برگه {formatNumber(layout.sheet.widthMm)} × {formatNumber(layout.sheet.heightMm)} ملی‌متر، جهت {orientationName(layout.orientation)}{preset?.perPerson === 'sheet' ? `، برای هر نفر یک برگهٔ کامل (${formatNumber(layout.capacity)} عکس)` : preset?.perPerson === 'copies' ? `، برای هر نفر ${formatNumber(preset.copies)} عکس` : ''}. روشن‌سازی چاپ: <b>{PRINT_BOOST_FA[boost]}</b> (سفید خالص، سفید می‌ماند).</p>
        </div></div>
      ) : <div class="notice err"><Icon name="circle-x" /><p>چیدمان معتبر نیست؛ استودیوی چاپ را بررسی کنید.</p></div>}
      {cancelled ? <div class="notice warn"><Icon name="triangle-alert" /><p>کار نیمه‌کاره لغو شد؛ فقط عکس‌های پردازش‌شده روی برگه هستند.</p></div> : null}
      {!aiState.segOk || !aiState.faceOk ? <div class="notice warn"><Icon name="triangle-alert" /><p>{aiState.reason || 'مدل محلی هوش مصنوعی در دسترس نیست'}؛ مراحل خودکار مربوط انجام نشد. اندازه و چیدمان چاپ درست است.</p></div> : null}
      <ul class="quick-results">
        {ok.map((r) => {
          const b = bgStatus(r, preset?.bgColor); const c = cropStatus(r);
          return (
            <li key={r.id}>
              <b class="qr-name" title={r.name}>{r.name}</b>
              <span class="qr-chips">
                <Badge kind="ok" icon="check">اندازهٔ {sizeName}</Badge>
                <Badge kind={b.kind} icon={b.kind === 'ok' ? 'check' : b.kind ? 'triangle-alert' : 'info'}>{b.text}</Badge>
                <Badge kind={c.kind} icon={c.kind === 'ok' ? 'check' : c.kind ? 'triangle-alert' : 'info'}>{c.text}</Badge>
                {engineStatus(r, preset).map((b) => <Badge key={b.text} kind={b.kind} icon={b.icon}>{b.text}</Badge>)}
                {r.light ? <Badge kind="gold" icon="sun">نور چهره اصلاح شد ({r.light > 0 ? 'روشن‌تر' : 'تیره‌تر'})</Badge> : r.crop === 'ok' ? <Badge kind="ok" icon="check">نور چهره مناسب</Badge> : null}
              </span>
              {b.detail ? <p class="tiny muted">{b.detail}</p> : null}
              <p class="tiny muted qr-fix">
                لکه یا داغی باقی مانده؟{' '}
                <Button size="sm" variant="ghost" icon="brush" onClick={() => { closeDialog('review'); openRepairBrush(r.id); }}>پاک‌کردن با قلم</Button>
                {' '}(ترمیم واقعی با پوست خود همین عکس؛ بعد از آن برگه خودکار به‌روز می‌شود.)
              </p>
              {r.issues.length ? <p class="tiny qr-issues"><Icon name="info" size={14} />برای بررسی: {r.issues.map((q) => qualityText(q).title).join('، ')}</p> : null}
            </li>
          );
        })}
        {missing.map((r) => <li key={r.id}><b class="qr-name">{r.name}</b> <Badge kind="err" icon="circle-x">عکس اصلی در دسترس نیست؛ روی برگه گذاشته نشد</Badge></li>)}
      </ul>
      <p class="tiny muted">هر تغییر با «واگرد» قابل برگشت است. انطباق رسمی با شرایط اداره تضمین نمی‌شود؛ مورد «برای بررسی» را در «اصلاح هوشمند» ببینید.</p>
      <EpsonQuickLine />
      <EpsonGuide />
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

const KINDS = { confirm: ConfirmDialog, retain: RetainDialog, preprint: PrePrintDialog, onboarding: OnboardingDialog, prompt: PromptDialog, quickready: QuickReadyDialog, quickedit: QuickPresetEditorDialog };

export function Dialogs() {
  const dialog = useStore((s) => s.dialog);
  if (!dialog) return null;
  const C = KINDS[dialog.kind];
  return C ? <C key={dialog.kind} {...dialog.props} /> : null;
}
