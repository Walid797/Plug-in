import { useState } from 'preact/hooks';
import { useStore, updateSettings, confirmDialog, toast, openDialog, uid, setState, getState } from '../../state/store.js';
import { MODELS } from '../../ai/registry.js';
import { installModelFromFile, uninstallModel, refreshModelStatus } from '../../ai/models.js';
import { getFaceLandmarker, getSegmenter, getModnet, disposeAll } from '../../ai/runtime.js';
import { aiAvailability, detectCapabilities } from '../../platform/capabilities.js';
import { clearAllData } from '../../storage/db.js';
import { createProject, refreshProjectsIndex } from '../../state/persist.js';
import { releaseAllMedia } from '../../state/media.js';
import { PAPER_PRESETS } from '../../core/presets.js';
import { calibrationGeometry, printCalibration, calibrationPdf, allPaperPresets } from '../../print/sheet.js';
import { saveBlob } from '../../platform/download.js';
import { safeFileName } from '../../core/filenames.js';
import { formatNumber, formatBytes } from '../../core/digits.js';
import { formatDateFa } from '../../core/dates.js';
import { workerStatus } from '../../platform/worker.js';
import { Button, Group, Notice, Badge, Select, Switch, NumberInput, FilePick, Segmented, Icon } from '../kit.jsx';
import { EpsonGuide } from '../EpsonGuide.jsx';

export function modelStatusText(m) {
  switch (m?.status) {
    case 'available': return m.source === 'browser' ? 'نصب‌شده در مرورگر' : 'آماده (پوشهٔ models)';
    case 'ready': return `بارگذاری‌شده — ${m.backend || ''}`;
    case 'loading': return 'در حال بارگذاری…';
    case 'missing': return 'نصب نشده';
    case 'file-protocol': return 'در حالت file:// در دسترس نیست';
    case 'error': return `خطا (${m.error || 'نامشخص'})`;
    default: return 'در حال بررسی…';
  }
}

const statusKind = (s) => ({ available: 'ok', ready: 'ok', loading: 'accent', missing: 'warn', 'file-protocol': 'warn', error: 'err' }[s] || '');

function Models() {
  const models = useStore((s) => s.models);
  const caps = useStore((s) => s.caps);
  const delegate = useStore((s) => s.settings.aiDelegate);
  const ai = caps ? aiAvailability(caps) : { ok: false, reason: '' };
  const test = async (id) => {
    try {
      if (id === 'face-landmarker') await getFaceLandmarker();
      else if (id === 'selfie-multiclass') await getSegmenter();
      else if (id === 'modnet') await getModnet();
      else await getOnnxModel(id);
      toast('مدل با موفقیت بارگذاری شد.', 'success');
    } catch (e) {
      console.error(e);
      toast(`بارگذاری مدل ناموفق بود: ${e.code || e.message}`, 'error', 8000);
    }
  };
  return (
    <section class="card" id="models">
      <div class="group-title"><h3>مدل‌های هوش مصنوعی آفلاین</h3><span class="actions"><Button size="sm" variant="ghost" icon="refresh-cw" onClick={refreshModelStatus}>بررسی دوباره</Button></span></div>
      {!ai.ok ? <Notice kind="warn">{ai.reason}</Notice> : null}
      <p class="hint">مدل‌ها فقط از پوشهٔ همین برنامه یا از حافظهٔ همین مرورگر خوانده می‌شوند. هیچ مدلی از انترنت دریافت نمی‌شود و هیچ عکسی برای آموزش مدل استفاده نمی‌شود.</p>
      <div class="model-list">
        {MODELS.map((m) => {
          const st = models[m.id];
          return (
            <article class="model" key={m.id}>
              <div class="model-head">
                <div><b>{m.nameFa}</b><p class="small muted">{m.purposeFa}</p></div>
                <Badge kind={statusKind(st?.status)}>{modelStatusText(st)}</Badge>
              </div>
              <dl class="kv">
                <dt>فایل</dt><dd class="ltr">{m.path}</dd>
                <dt>اندازه</dt><dd>{m.bytes ? formatBytes(m.bytes) : 'متغیر'}</dd>
                <dt>نسخه</dt><dd>{m.version}</dd>
                <dt>مجوز</dt><dd>{m.license} — <span class="faint">{m.licenseNoteFa}</span></dd>
                <dt>چکسام SHA-256</dt><dd class="ltr tiny">{(Array.isArray(m.sha256) ? m.sha256.join(' یا ') : m.sha256) || 'ثبت نشده (فایل را خودتان تهیه می‌کنید)'}</dd>
                <dt>نیازمندی</dt><dd>{m.requirementsFa}</dd>
                <dt>منبع رسمی</dt><dd class="ltr tiny">{m.source}</dd>
                {st?.backend ? <><dt>اجرا با</dt><dd>{st.backend}</dd></> : null}
              </dl>
              <div class="btn-row">
                <Button size="sm" icon="play" disabled={!ai.ok || !['available', 'ready'].includes(st?.status)} onClick={() => test(m.id)}>آزمایش بارگذاری</Button>
                <FilePick size="sm" icon="upload" accept={m.runtime === 'onnx' ? '.onnx' : `.${m.path.split('.').pop()}`} disabled={!ai.ok} onFiles={(f) => installModelFromFile(m.id, f[0])}>نصب از فایل</FilePick>
                {st?.source === 'browser' ? <Button size="sm" variant="ghost" icon="trash-2" onClick={() => uninstallModel(m.id)}>حذف از مرورگر</Button> : null}
              </div>
            </article>
          );
        })}
      </div>
      <Segmented label="سخت‌افزار اجرای مدل" value={delegate} onChange={(v) => { updateSettings({ aiDelegate: v }); disposeAll(); }} options={[
        { value: 'auto', label: 'خودکار (پایدار)' }, { value: 'gpu', label: 'کارت گرافیک (GPU)' }, { value: 'cpu', label: 'پردازنده (CPU)' }, { value: 'nogl', label: 'بدون گرافیک (ONNX)' },
      ]} />
      <p class="hint">«بدون گرافیک» همان مدل‌ها را با موتور ONNX فقط روی پردازنده اجرا می‌کند و به WebGL نیاز ندارد. اگر این کمپیوتر WebGL نداشته باشد (مثلاً کارت گرافیک ندارد)، برنامه خودش همین را به کار می‌برد.</p>
      <p class="hint">«خودکار» از پردازنده (WASM) استفاده می‌کند که روی همهٔ دستگاه‌ها نتیجهٔ یکسان می‌دهد. کارت گرافیک در بعضی موبایل‌ها نتیجهٔ خالی یا خطا می‌دهد؛ اگر آن را انتخاب کنید و خطا رخ دهد، برنامه خودکار با پردازنده دوباره امتحان می‌کند.</p>
      <p class="hint">راهنمای کامل نصب مدل‌ها: پوشهٔ docs، فایل «ai-models.md».</p>
    </section>
  );
}

function Calibration() {
  const settings = useStore((s) => s.settings);
  const [paperId, setPaperId] = useState('a4');
  const [orient, setOrient] = useState('portrait');
  const papers = allPaperPresets(settings);
  const paper = papers.find((p) => p.id === paperId) || PAPER_PRESETS[0];
  const g = calibrationGeometry(paper, orient);
  const [mw, setMw] = useState(g.square);
  const [mh, setMh] = useState(g.square);
  const [ml, setMl] = useState(10);
  const [mt, setMt] = useState(10);
  const sx = g.square / mw; const sy = g.square / mh;
  const suspicious = sx < 0.8 || sx > 1.25 || sy < 0.8 || sy > 1.25;
  const save = async () => {
    const name = await openDialog('prompt', { title: 'ذخیرهٔ کالیبراسیون', label: 'نام چاپگر / کاغذ', value: `چاپگر — ${paper.nameFa}` });
    if (!name) return;
    const id = uid('cal');
    updateSettings((s) => ({ calibrationProfiles: [...s.calibrationProfiles, { id, name, scaleX: sx, scaleY: sy, offsetXmm: 10 - ml, offsetYmm: 10 - mt, paperId, at: Date.now() }], activeCalibrationId: id }));
    toast('کالیبراسیون ذخیره و فعال شد.', 'success');
  };
  return (
    <section class="card" id="calibration">
      <h3>کالیبراسیون چاپ</h3>
      <ol class="steps">
        <li>برگهٔ کالیبراسیون را با <b>مقیاس ۱۰۰٪ / Actual size</b> چاپ کنید (همان روشی که عکس‌ها را چاپ می‌کنید: مرورگر یا PDF).</li>
        <li>ضلع مربع و خط‌کش ۵۰ ملی‌متری را با یک خط‌کش فلزی دقیق اندازه بگیرید.</li>
        <li>اندازه‌های واقعی را اینجا وارد و ذخیره کنید. ضریب فقط برای جبران تغییر مقیاس درایور است؛ بهترین راه، تنظیم درست مقیاس در پنجرهٔ چاپ است.</li>
      </ol>
      <div class="grid-2">
        <Select label="کاغذ برگهٔ کالیبراسیون" value={paperId} onChange={(v) => { setPaperId(v); }} options={papers.map((p) => ({ value: p.id, label: p.nameFa }))} />
        <Segmented label="جهت" value={orient} onChange={setOrient} options={[{ value: 'portrait', label: 'عمودی' }, { value: 'landscape', label: 'افقی' }]} />
      </div>
      <p class="hint">مربع روی این کاغذ: {formatNumber(g.square)} × {formatNumber(g.square)} ملی‌متر{g.square < 100 ? ' (مربع ۱۰۰ ملی‌متری روی این کاغذ جا نمی‌شود؛ کاغذ بزرگ‌تر مثل A4 دقیق‌تر است)' : ''}.</p>
      <div class="btn-row">
        <Button icon="printer" onClick={() => printCalibration(paper, orient)}>چاپ برگهٔ کالیبراسیون</Button>
        <Button icon="file-down" onClick={async () => { const pdf = await calibrationPdf(paper, orient); await saveBlob(new Blob([pdf], { type: 'application/pdf' }), safeFileName(`کالیبراسیون-${paper.nameFa}`, 'pdf')); toast('PDF کالیبراسیون ساخته شد.', 'success'); }}>PDF کالیبراسیون</Button>
      </div>
      <div class="grid-2">
        <NumberInput label="عرض اندازه‌گیری‌شدهٔ مربع" unit="ملی‌متر" value={mw} min={10} max={400} step={0.1} onChange={setMw} />
        <NumberInput label="ارتفاع اندازه‌گیری‌شدهٔ مربع" unit="ملی‌متر" value={mh} min={10} max={400} step={0.1} onChange={setMh} />
        <NumberInput label="فاصلهٔ خط «۱۰ ملی‌متر» از لبهٔ چپ کاغذ" unit="ملی‌متر" value={ml} min={0} max={40} step={0.1} onChange={setMl} />
        <NumberInput label="فاصلهٔ خط «۱۰ ملی‌متر» از لبهٔ بالای کاغذ" unit="ملی‌متر" value={mt} min={0} max={40} step={0.1} onChange={setMt} />
      </div>
      <p>ضریب افقی: <b>{formatNumber(sx, { maxFraction: 4 })}</b> — ضریب عمودی: <b>{formatNumber(sy, { maxFraction: 4 })}</b> — جابجایی: {formatNumber(10 - ml, { maxFraction: 1 })} / {formatNumber(10 - mt, { maxFraction: 1 })} ملی‌متر</p>
      {suspicious ? <Notice kind="warn">ضریب بیش از ۲۰٪ با ۱ تفاوت دارد؛ احتمالاً «Fit to page» روشن است یا اندازه‌گیری اشتباه است.</Notice> : null}
      <Button variant="primary" icon="save" onClick={save}>ذخیرهٔ کالیبراسیون</Button>
      {settings.calibrationProfiles.length ? (
        <table class="table">
          <thead><tr><th>نام</th><th>افقی</th><th>عمودی</th><th>جابجایی</th><th>تاریخ</th><th /></tr></thead>
          <tbody>
            {settings.calibrationProfiles.map((c) => (
              <tr key={c.id}>
                <td>{c.name} {settings.activeCalibrationId === c.id ? <Badge kind="ok">فعال</Badge> : null}</td>
                <td>{formatNumber(c.scaleX, { maxFraction: 4 })}</td><td>{formatNumber(c.scaleY, { maxFraction: 4 })}</td>
                <td>{formatNumber(c.offsetXmm, { maxFraction: 1 })}، {formatNumber(c.offsetYmm, { maxFraction: 1 })}</td>
                <td class="faint">{formatDateFa(c.at)}</td>
                <td class="nowrap">
                  {settings.activeCalibrationId !== c.id ? <Button size="sm" onClick={() => updateSettings({ activeCalibrationId: c.id })}>فعال کن</Button> : <Button size="sm" variant="ghost" onClick={() => updateSettings({ activeCalibrationId: null })}>غیرفعال</Button>}
                  <Button size="sm" variant="ghost" icon="trash-2" onClick={() => updateSettings((s) => ({ calibrationProfiles: s.calibrationProfiles.filter((x) => x.id !== c.id), activeCalibrationId: s.activeCalibrationId === c.id ? null : s.activeCalibrationId }))}>حذف</Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <EpsonGuide />
    </section>
  );
}

function Capabilities() {
  const caps = useStore((s) => s.caps);
  const storage = useStore((s) => s.storage);
  if (!caps) return null;
  const yes = (v) => (v ? <Badge kind="ok">دارد</Badge> : <Badge>ندارد</Badge>);
  return (
    <section class="card">
      <h3>توانایی‌های این دستگاه و مرورگر</h3>
      <dl class="kv caps">
        <dt>نحوهٔ باز شدن</dt><dd>{caps.fileMode ? <Badge kind="warn">مستقیم از فایل (file://)</Badge> : <Badge kind="ok">راه‌انداز محلی ({location.host})</Badge>}</dd>
        <dt>ذخیره‌سازی</dt><dd>{storage.mode === 'memory' ? <Badge kind="err">فقط حافظهٔ موقت</Badge> : <Badge kind="ok">{storage.backend === 'opfs' ? 'OPFS + IndexedDB' : 'IndexedDB'}</Badge>}</dd>
        <dt>فضای مصرف‌شده</dt><dd>{caps.storage.usage != null ? `${formatBytes(caps.storage.usage)} از ${formatBytes(caps.storage.quota)}` : 'نامشخص'}{caps.storage.persisted ? ' · ماندگار' : ''}</dd>
        <dt>WebGPU</dt><dd>{yes(caps.webgpu)} {caps.webgpuAdapter ? <span class="faint tiny ltr">{caps.webgpuAdapter}</span> : null}</dd>
        <dt>WebGL2</dt><dd>{yes(caps.webgl2)} {caps.webglRenderer ? <span class="faint tiny ltr">{caps.webglRenderer}</span> : null}</dd>
        <dt>WebAssembly SIMD</dt><dd>{yes(caps.wasmSimd)}</dd>
        <dt>WASM چندرشته‌ای</dt><dd>{yes(caps.wasmThreads)} {!caps.wasmThreads && !caps.fileMode ? <span class="faint tiny">(نیازمند سرور با سرآیندهای ایزوله‌سازی)</span> : null}</dd>
        <dt>OffscreenCanvas</dt><dd>{yes(caps.offscreen2d)}</dd>
        <dt>پردازش پس‌زمینه (Worker)</dt><dd>{caps.worker ? <Badge kind="ok">{workerStatus() === 'main-thread' ? 'رشتهٔ اصلی (جایگزین)' : 'دارد'}</Badge> : <Badge>ندارد</Badge>}</dd>
        <dt>Service Worker / PWA</dt><dd>{caps.serviceWorker ? <Badge kind="ok">دارد</Badge> : <Badge kind="warn">ندارد</Badge>} {!caps.serviceWorker ? <span class="faint tiny">(فقط روی localhost یا HTTPS؛ در file:// کار نمی‌کند)</span> : null}</dd>
        <dt>حافظهٔ دستگاه</dt><dd>{caps.deviceMemoryGb ? `حدود ${formatNumber(caps.deviceMemoryGb)} گیگابایت` : 'نامشخص'} · {caps.cores ? `${formatNumber(caps.cores)} هسته` : ''}</dd>
        <dt>حداکثر بوم</dt><dd>{formatNumber(caps.maxCanvasPixels / 1e6, { maxFraction: 1 })} مگاپیکسل{caps.ios ? ' (محدودیت iOS)' : ''}</dd>
      </dl>
      {caps.ios ? <Notice kind="info">در iOS حافظهٔ مرورگر محدود است: عکس‌های بسیار بزرگ کوچک‌تر پردازش می‌شوند، WebGPU ممکن است نباشد و پاک شدن داده‌ها توسط سیستم ممکن است. پروژه‌های مهم را با PDF پشتیبان بگیرید.</Notice> : null}
      <Button size="sm" variant="ghost" icon="refresh-cw" onClick={async () => setState({ caps: await detectCapabilities() })}>بررسی دوباره</Button>
    </section>
  );
}

function Privacy() {
  const caps = useStore((s) => s.caps);
  const clearProjects = async () => {
    const ok = await confirmDialog({ title: 'پاک کردن همهٔ پروژه‌ها', body: 'همهٔ پروژه‌ها، عکس‌های ذخیره‌شده، ماسک‌ها و مدل‌های نصب‌شده در مرورگر برای همیشه پاک شوند؟ تنظیمات برنامه می‌ماند.', confirmLabel: 'پاک کردن', danger: true });
    if (!ok) return;
    releaseAllMedia();
    setState((s) => ({ ...s, project: null, photos: {} }));
    await clearAllData({ keepSettings: true });
    await createProject();
    await refreshProjectsIndex();
    toast('همهٔ داده‌های پروژه پاک شد.', 'success');
  };
  const clearAll = async () => {
    const ok = await confirmDialog({ title: 'پاک کردن کامل داده‌های محلی', body: 'همه‌چیز (پروژه‌ها، عکس‌ها، تنظیمات، کالیبراسیون و حافظهٔ آفلاین برنامه) از این مرورگر پاک می‌شود. برای استفادهٔ آفلاین بعدی باید برنامه را دوباره با راه‌انداز محلی باز کنید.', confirmLabel: 'پاک کردن همه', danger: true });
    if (!ok) return;
    releaseAllMedia();
    setState((s) => ({ ...s, project: null, photos: {} }));
    await clearAllData();
    try { for (const k of await caches.keys()) await caches.delete(k); } catch { /* none */ }
    try { for (const r of (await navigator.serviceWorker?.getRegistrations?.()) || []) await r.unregister(); } catch { /* none */ }
    toast('همهٔ داده‌های محلی پاک شد. صفحه دوباره بارگذاری می‌شود.', 'success');
    setTimeout(() => location.reload(), 1200);
  };
  return (
    <section class="card">
      <h3>حریم خصوصی و داده‌ها</h3>
      <ul class="checklist">
        <li><Icon name="shield-check" />هیچ داده‌ای (عکس، چهره، تنظیمات) به انترنت فرستاده نمی‌شود. برنامه هیچ آمارگیر، ردیاب یا درخواست پنهانی ندارد.</li>
        <li><Icon name="scan-face" />نقاط چهره فقط در حافظهٔ موقت برای کادربندی استفاده می‌شوند؛ هیچ اثر انگشت چهره (Embedding) ساخته یا ذخیره نمی‌شود.</li>
        <li><Icon name="lock" />تنها ارتباط ممکن، اتصال اختیاری خودتان به موتور محلی روی 127.0.0.1 است.</li>
      </ul>
      <div class="btn-row">
        {navigator.storage?.persist && !caps?.storage?.persisted ? <Button size="sm" icon="hard-drive" onClick={async () => { const ok = await navigator.storage.persist(); toast(ok ? 'مرورگر ذخیره‌سازی ماندگار را پذیرفت.' : 'مرورگر درخواست را نپذیرفت؛ داده‌ها ممکن است هنگام کمبود فضا پاک شوند.', ok ? 'success' : 'warn'); setState({ caps: await detectCapabilities() }); }}>درخواست ذخیره‌سازی ماندگار</Button> : null}
        <Button size="sm" variant="danger" icon="trash-2" onClick={clearProjects}>پاک کردن همهٔ پروژه‌ها</Button>
        <Button size="sm" variant="danger" icon="trash-2" onClick={clearAll}>پاک کردن کامل داده‌های محلی</Button>
      </div>
    </section>
  );
}

export function SettingsView() {
  const s = useStore((st) => st.settings);
  return (
    <div class="view">
      <div class="page settings">
        <div class="page-head"><div><h2>تنظیمات و مدل‌های آفلاین</h2><p class="muted">نسخهٔ برنامه: {getState().version}</p></div></div>
        <section class="card">
          <h3>عمومی</h3>
          <div class="grid-2">
            <Segmented label="پوسته" value={s.theme} onChange={(v) => updateSettings({ theme: v })} options={[{ value: 'system', label: 'مطابق سیستم' }, { value: 'dark', label: 'تیره' }, { value: 'light', label: 'روشن' }]} />
            <Select label="نگهداری عکس‌های اصلی" value={s.retainOriginals} onChange={(v) => updateSettings({ retainOriginals: v })} options={[
              { value: 'ask', label: 'هر بار بپرس' }, { value: 'always', label: 'همیشه روی این دستگاه ذخیره شود' }, { value: 'never', label: 'هرگز (فقط در همین جلسه)' },
            ]} />
            <Select label="DPI پیش‌فرض خروجی" value={String(s.defaultDpi)} onChange={(v) => updateSettings({ defaultDpi: Number(v) })} options={[300, 350, 400, 600].map((d) => ({ value: String(d), label: `${formatNumber(d)} DPI` }))} />
            <Select label="کیفیت JPEG" value={String(s.jpegQuality)} onChange={(v) => updateSettings({ jpegQuality: Number(v) })} options={[{ value: '0.9', label: 'بالا (۹۰)' }, { value: '0.95', label: 'خیلی بالا (۹۵)' }, { value: '0.98', label: 'تقریباً بدون افت (۹۸)' }, { value: '1', label: 'حداکثر (۱۰۰)' }]} />
          </div>
          <Switch label="نمایش دوبارهٔ راهنمای شروع" checked={!s.onboardingDone} onChange={(v) => { updateSettings({ onboardingDone: !v }); if (v) openDialog('onboarding').then(() => updateSettings({ onboardingDone: true })); }} />
        </section>
        <Models />
        <Calibration />
        <Capabilities />
        <Privacy />
        <section class="card">
          <h3>راهنما و مجوزها</h3>
          <p class="small">راهنمای کامل فارسی در پوشهٔ <span class="ltr">docs</span> همراه برنامه است: نصب و استفادهٔ آفلاین (README.md)، کالیبراسیون و رفع اشکال چاپ (print-calibration.md)، نصب مدل‌ها (ai-models.md)، گزارش آزمون و محدودیت‌ها (test-report.md) و جدول قابلیت‌ها (feature-matrix.md).</p>
          <p class="small">اجزای متن‌باز: قلم وزیرمتن (OFL-1.1)، Preact (MIT)، MediaPipe Tasks و مدل‌های آن (Apache-2.0)، ONNX Runtime Web (MIT)، نمادهای Lucide (ISC). متن مجوزها در پوشهٔ vendor و فایل THIRD_PARTY_NOTICES.md.</p>
        </section>
      </div>
    </div>
  );
}
