import { useStore, updateSettings, updateSheet, confirmDialog, toast, setSection, uid } from '../../state/store.js';
import { PAPER_PRESETS, RULE_PROFILES, PHOTO_PRESETS } from '../../core/presets.js';
import { formatNumber } from '../../core/digits.js';
import { formatDateFa } from '../../core/dates.js';
import { Button, Group, Badge, Icon, IconButton, NumberInput, FilePick, Notice } from '../kit.jsx';
import { saveBlob, readFileText } from '../../platform/download.js';
import { safeFileName } from '../../core/filenames.js';
import { useState } from 'preact/hooks';

const isNum = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

/** Validate imported JSON strictly; unknown fields are dropped. */
export function sanitizeTemplates(json) {
  const out = { paperPresets: [], layoutPresets: [], customProfiles: [] };
  if (!json || json.format !== 'hoshmand-templates') throw new Error('FORMAT');
  for (const p of (json.paperPresets || []).slice(0, 100)) {
    if (isNum(p.widthMm, 10, 2000) && isNum(p.heightMm, 10, 2000)) out.paperPresets.push({ id: uid('paper'), nameFa: String(p.nameFa || 'کاغذ').slice(0, 60), widthMm: p.widthMm, heightMm: p.heightMm });
  }
  for (const l of (json.layoutPresets || []).slice(0, 100)) {
    const sh = l.sheet || {};
    if (!sh.margins || !sh.gap) continue;
    const m = sh.margins;
    if (![m.top, m.right, m.bottom, m.left].every((v) => isNum(v, 0, 200)) || !isNum(sh.gap.x, 0, 100) || !isNum(sh.gap.y, 0, 100)) continue;
    out.layoutPresets.push({
      id: uid('lp'), name: String(l.name || 'چیدمان').slice(0, 80), at: Date.now(),
      sheet: {
        paperId: String(sh.paperId || '10x15').slice(0, 40), customPaper: isNum(sh.customPaper?.widthMm, 10, 2000) && isNum(sh.customPaper?.heightMm, 10, 2000) ? { widthMm: sh.customPaper.widthMm, heightMm: sh.customPaper.heightMm } : { widthMm: 100, heightMm: 150 },
        orientation: ['auto', 'portrait', 'landscape'].includes(sh.orientation) ? sh.orientation : 'auto',
        margins: { top: m.top, right: m.right, bottom: m.bottom, left: m.left }, gap: { x: sh.gap.x, y: sh.gap.y },
        mode: sh.mode === 'fill' ? 'fill' : 'exact', allowRotation: !!sh.allowRotation,
        fillOrder: ['col-ltr', 'col-rtl', 'rtl', 'ltr'].includes(sh.fillOrder) ? sh.fillOrder : 'col-ltr',
        marks: { cutLines: !!sh.marks?.cutLines, cropMarks: !!sh.marks?.cropMarks, borders: !!sh.marks?.borders },
        dpi: [300, 350, 400, 600].includes(sh.dpi) ? sh.dpi : 300,
      },
    });
  }
  for (const r of (json.customProfiles || []).slice(0, 100)) {
    if (!isNum(r.widthMm, 5, 300) || !isNum(r.heightMm, 5, 300) || !isNum(r.headHeight?.min, 1, 300) || !isNum(r.headHeight?.max, 1, 300)) continue;
    out.customProfiles.push({
      id: uid('rp'), nameFa: String(r.nameFa || 'قاعده').slice(0, 80), widthMm: r.widthMm, heightMm: r.heightMm, photoId: 'custom',
      headHeight: { min: r.headHeight.min, max: r.headHeight.max, target: (r.headHeight.min + r.headHeight.max) / 2 },
      eyeFromBottom: isNum(r.eyeFromBottom?.min, 1, 300) && isNum(r.eyeFromBottom?.max, 1, 300) ? { min: r.eyeFromBottom.min, max: r.eyeFromBottom.max, target: (r.eyeFromBottom.min + r.eyeFromBottom.max) / 2 } : null,
      verified: false, noteFa: String(r.noteFa || '').slice(0, 200),
    });
  }
  return out;
}

function ProfileEditor({ onDone }) {
  const [p, setP] = useState({ nameFa: '', widthMm: 30, heightMm: 40, hmin: 25, hmax: 31, emin: 21, emax: 26, noteFa: '' });
  const ok = p.nameFa.trim() && p.hmin < p.hmax && p.hmax < p.heightMm && p.emin < p.emax;
  return (
    <div class="card flat">
      <div class="grid-2">
        <label class="field"><span class="field-label">نام قاعده</span><input class="input" value={p.nameFa} maxLength={80} onInput={(e) => setP({ ...p, nameFa: e.currentTarget.value })} /></label>
        <label class="field"><span class="field-label">منبع / یادداشت</span><input class="input" value={p.noteFa} maxLength={200} onInput={(e) => setP({ ...p, noteFa: e.currentTarget.value })} /></label>
        <NumberInput label="عرض عکس" unit="ملی‌متر" value={p.widthMm} min={5} max={300} onChange={(v) => setP({ ...p, widthMm: v })} />
        <NumberInput label="ارتفاع عکس" unit="ملی‌متر" value={p.heightMm} min={5} max={300} onChange={(v) => setP({ ...p, heightMm: v })} />
        <NumberInput label="کمترین ارتفاع سر" unit="ملی‌متر" value={p.hmin} min={1} max={300} step={0.5} onChange={(v) => setP({ ...p, hmin: v })} />
        <NumberInput label="بیشترین ارتفاع سر" unit="ملی‌متر" value={p.hmax} min={1} max={300} step={0.5} onChange={(v) => setP({ ...p, hmax: v })} />
        <NumberInput label="کمترین خط چشم از پایین" unit="ملی‌متر" value={p.emin} min={1} max={300} step={0.5} onChange={(v) => setP({ ...p, emin: v })} />
        <NumberInput label="بیشترین خط چشم از پایین" unit="ملی‌متر" value={p.emax} min={1} max={300} step={0.5} onChange={(v) => setP({ ...p, emax: v })} />
      </div>
      <p class="hint">قاعده‌های شما «تأییدنشده» ذخیره می‌شوند. مسئولیت تطبیق با مرجع رسمی با شماست.</p>
      <div class="btn-row">
        <Button variant="primary" icon="save" disabled={!ok} onClick={() => {
          updateSettings((s) => ({ customProfiles: [...s.customProfiles, { id: uid('rp'), nameFa: p.nameFa.trim(), widthMm: p.widthMm, heightMm: p.heightMm, photoId: PHOTO_PRESETS.find((x) => x.widthMm === p.widthMm && x.heightMm === p.heightMm)?.id || 'custom', headHeight: { min: p.hmin, max: p.hmax, target: (p.hmin + p.hmax) / 2 }, eyeFromBottom: { min: p.emin, max: p.emax, target: (p.emin + p.emax) / 2 }, verified: false, noteFa: p.noteFa }] }));
          onDone();
        }}>ذخیرهٔ قاعده</Button>
        <Button variant="ghost" onClick={onDone}>انصراف</Button>
      </div>
    </div>
  );
}

export function TemplatesView() {
  const settings = useStore((s) => s.settings);
  const [editing, setEditing] = useState(false);
  const del = async (kind, id, name) => {
    if (!(await confirmDialog({ title: 'حذف قالب', body: `«${name}» حذف شود؟`, confirmLabel: 'حذف', danger: true }))) return;
    updateSettings((s) => ({ [kind]: s[kind].filter((x) => x.id !== id) }));
  };
  const exportJson = async () => {
    const data = JSON.stringify({ format: 'hoshmand-templates', version: 1, paperPresets: settings.paperPresets, layoutPresets: settings.layoutPresets, customProfiles: settings.customProfiles }, null, 2);
    await saveBlob(new Blob([data], { type: 'application/json' }), safeFileName('قالب‌های-هوشمند', 'json'));
    toast('فایل قالب‌ها ساخته شد.', 'success');
  };
  const importJson = async (files) => {
    try {
      const text = await readFileText(files[0]);
      const t = sanitizeTemplates(JSON.parse(text));
      updateSettings((s) => ({ paperPresets: [...s.paperPresets, ...t.paperPresets], layoutPresets: [...s.layoutPresets, ...t.layoutPresets], customProfiles: [...s.customProfiles, ...t.customProfiles] }));
      toast(`${formatNumber(t.paperPresets.length + t.layoutPresets.length + t.customProfiles.length)} قالب وارد شد.`, 'success');
    } catch {
      toast('فایل قالب معتبر نیست.', 'error');
    }
  };
  return (
    <div class="view">
      <div class="page">
        <div class="page-head">
          <div><h2>قالب‌های ذخیره‌شده</h2><p class="muted">کاغذهای سفارشی، چیدمان‌های چاپ و قواعد عکس پرسنلی را ذخیره و دوباره استفاده کنید.</p></div>
          <div class="btn-row">
            <Button icon="download" onClick={exportJson}>خروجی قالب‌ها (JSON)</Button>
            <FilePick accept="application/json,.json" icon="import" onFiles={importJson}>وارد کردن قالب‌ها</FilePick>
          </div>
        </div>

        <section class="card">
          <h3>چیدمان‌های چاپ</h3>
          {!settings.layoutPresets.length ? <p class="muted small">هنوز چیدمانی ذخیره نشده است. در «استودیوی چاپ» دکمهٔ «ذخیرهٔ این چیدمان» را بزنید.</p> : (
            <table class="table">
              <thead><tr><th>نام</th><th>کاغذ</th><th>حاشیه / فاصله</th><th>تاریخ</th><th /></tr></thead>
              <tbody>
                {settings.layoutPresets.map((l) => (
                  <tr key={l.id}>
                    <td>{l.name}</td>
                    <td>{[...PAPER_PRESETS, ...settings.paperPresets].find((p) => p.id === l.sheet.paperId)?.nameFa || 'سفارشی'}</td>
                    <td>{formatNumber(l.sheet.margins.top)} / {formatNumber(l.sheet.gap.x)} ملی‌متر</td>
                    <td class="faint">{formatDateFa(l.at)}</td>
                    <td class="nowrap">
                      <Button size="sm" icon="check" onClick={() => { updateSheet((sh) => ({ ...sh, ...structuredClone(l.sheet), items: sh.items })); setSection('print'); toast(`چیدمان «${l.name}» اعمال شد.`, 'success'); }}>اعمال</Button>
                      <IconButton small icon="trash-2" label="حذف" onClick={() => del('layoutPresets', l.id, l.name)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section class="card">
          <h3>اندازه‌های کاغذ</h3>
          <div class="paper-grid">
            {PAPER_PRESETS.map((p) => <div class="paper" key={p.id}><span class="paper-shape" style={{ aspectRatio: `${p.widthMm}/${p.heightMm}` }} /><b>{p.nameFa}</b><span class="faint tiny">{formatNumber(p.widthMm)}×{formatNumber(p.heightMm)} ملی‌متر</span><Badge>آماده</Badge></div>)}
            {settings.paperPresets.map((p) => (
              <div class="paper" key={p.id}><span class="paper-shape" style={{ aspectRatio: `${p.widthMm}/${p.heightMm}` }} /><b>{p.nameFa}</b><span class="faint tiny">{formatNumber(p.widthMm)}×{formatNumber(p.heightMm)} ملی‌متر</span>
                <IconButton small icon="trash-2" label="حذف" onClick={() => del('paperPresets', p.id, p.nameFa)} /></div>
            ))}
          </div>
        </section>

        <section class="card">
          <div class="group-title"><h3>قواعد عکس پرسنلی</h3><span class="actions"><Button size="sm" icon="plus" onClick={() => setEditing(true)}>قاعدهٔ تازه</Button></span></div>
          <Notice kind="warn">هیچ‌کدام از این قواعد توسط این برنامه با یک مرجع رسمی تأیید نشده‌اند. پیش از استفادهٔ رسمی (تذکره، پاسپورت، ویزا) شرایط را از ادارهٔ مربوط بپرسید.</Notice>
          {editing ? <ProfileEditor onDone={() => setEditing(false)} /> : null}
          <table class="table">
            <thead><tr><th>نام</th><th>اندازه</th><th>ارتفاع سر</th><th>خط چشم از پایین</th><th>وضعیت</th><th /></tr></thead>
            <tbody>
              {[...RULE_PROFILES, ...settings.customProfiles].map((r) => (
                <tr key={r.id}>
                  <td>{r.nameFa}{r.noteFa ? <div class="faint tiny">{r.noteFa}</div> : null}</td>
                  <td class="nowrap">{formatNumber(r.widthMm)}×{formatNumber(r.heightMm)}</td>
                  <td class="nowrap">{formatNumber(r.headHeight.min, { maxFraction: 1 })}–{formatNumber(r.headHeight.max, { maxFraction: 1 })}</td>
                  <td class="nowrap">{r.eyeFromBottom ? `${formatNumber(r.eyeFromBottom.min, { maxFraction: 1 })}–${formatNumber(r.eyeFromBottom.max, { maxFraction: 1 })}` : '—'}</td>
                  <td><Badge kind="warn" icon="triangle-alert">تأییدنشده</Badge></td>
                  <td>{settings.customProfiles.some((c) => c.id === r.id) ? <IconButton small icon="trash-2" label="حذف" onClick={() => del('customProfiles', r.id, r.nameFa)} /> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <p class="hint"><Icon name="info" size={14} /> فایل قالب‌ها فقط عدد و متن دارد؛ هنگام وارد کردن، همهٔ مقادیر بررسی و موارد نامعتبر کنار گذاشته می‌شوند.</p>
      </div>
    </div>
  );
}
