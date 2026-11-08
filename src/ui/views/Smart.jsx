import { useEffect, useState } from 'preact/hooks';
import { useStore, updateEdit, toast, setSection, startTask, orderedPhotos, getState, recordHistory } from '../../state/store.js';
import { PhotoCanvas } from '../PhotoCanvas.jsx';
import { Queue, NeedPhotos } from '../Queue.jsx';
import { Icon, Button, Group, Notice, Badge, Select, Switch } from '../kit.jsx';
import { useCropHandlers, ViewSwitch } from './Editor.jsx';
import { analyzeFace, currentQuality, suggestionFor, profileFor, shoulderFracFor, refineCrownWithMask } from '../../ai/face.js';
import { getFace } from '../../state/media.js';
import { RULE_PROFILES, findPhoto } from '../../core/presets.js';
import { qualityText, LEVEL_FA } from '../../i18n/fa.js';
import { formatNumber } from '../../core/digits.js';
import { aiAvailability } from '../../platform/capabilities.js';
import { modelStatusText } from './Settings.jsx';

const LEVEL_ICON = { ok: 'circle-check', warn: 'triangle-alert', error: 'circle-x', info: 'info' };

function aiErrorText(e) {
  if (e?.code === 'FILE_PROTOCOL') return 'در حالت file:// مدل بارگذاری نمی‌شود. برنامه را با راه‌انداز محلی باز کنید.';
  if (e?.code === 'MODEL_MISSING') return 'فایل مدل پیدا نشد. از «تنظیمات و مدل‌های آفلاین» آن را نصب کنید.';
  if (e?.code === 'HASH_MISMATCH') return 'فایل مدل خراب یا تغییر یافته است (چکسام نادرست).';
  if (e?.code === 'RUNTIME_LOAD') return 'موتور هوش مصنوعی محلی بارگذاری نشد (پوشهٔ vendor ناقص است؟).';
  if (e?.code === 'NO_ORIGINAL') return 'عکس اصلی در دسترس نیست.';
  return 'اجرای مدل محلی ناموفق بود. حافظهٔ دستگاه ممکن است کافی نباشد.';
}

export function SmartView() {
  const photo = useStore((s) => (s.selectedPhotoId ? s.photos[s.selectedPhotoId] : null));
  const caps = useStore((s) => s.caps);
  const model = useStore((s) => s.models['face-landmarker']);
  const customProfiles = useStore((s) => s.settings.customProfiles);
  const rev = useStore((s) => (photo ? s.rev[photo.id] || 0 : 0));
  const [view, setView] = useState('result');
  const [showFace, setShowFace] = useState(true);
  const [busy, setBusy] = useState(false);
  const [suggestion, setSuggestion] = useState(null);
  const [batch, setBatch] = useState(null); // {photoId: crop}
  const handlers = useCropHandlers(photo || { id: null });

  const [shoulderFrac, setShoulderFrac] = useState(null);
  useEffect(() => { setSuggestion(batch?.[photo?.id] || null); }, [photo?.id]);
  useEffect(() => {
    let alive = true;
    if (!photo) return undefined;
    const t = setTimeout(() => {
      refineCrownWithMask(photo).then((changed) => {
        if (changed && alive) {
          setSuggestion(suggestionFor(getState().photos[photo.id]));
          toast('بالای سر با ماسک پس‌زمینه دقیق‌تر شد؛ پیشنهاد کادر تازه نمایش داده شد.', 'info');
        }
      }).catch(() => {});
      shoulderFracFor(photo).then((v) => { if (alive) setShoulderFrac(v); });
    }, 150);
    return () => { alive = false; clearTimeout(t); };
  }, [photo?.id, photo?.maskKey, photo?.edit.crop, photo?.edit.widthMm, photo?.edit.heightMm, rev]);

  if (!photo) return <div class="view"><NeedPhotos /></div>;
  const ai = caps ? aiAvailability(caps) : { ok: false, reason: '' };
  const modelOk = model && ['available', 'ready'].includes(model.status);
  const canRun = ai.ok && modelOk;
  const disabledReason = !ai.ok ? ai.reason : !modelOk ? `مدل تشخیص چهره: ${modelStatusText(model)}` : '';
  const face = getFace(photo.id);
  void rev;
  const quality = face ? currentQuality(photo, { shoulderFrac }) : null;
  const profile = profileFor(photo);
  const e = photo.edit;
  const profiles = [...RULE_PROFILES, ...customProfiles];

  const analyze = async () => {
    setBusy(true);
    try {
      const r = await analyzeFace(photo);
      if (!r.faceCount) toast('در این عکس چهره‌ای پیدا نشد.', 'warn');
      else {
        setSuggestion(suggestionFor(getState().photos[photo.id]));
        if (r.faceCount > 1) toast(`${formatNumber(r.faceCount)} چهره پیدا شد؛ بزرگ‌ترین چهره استفاده شد.`, 'warn');
      }
    } catch (err) {
      console.error(err);
      toast(aiErrorText(err), 'error', 9000);
    } finally { setBusy(false); }
  };

  const accept = (pid = photo.id, crop = suggestion) => {
    if (!crop) return;
    updateEdit(pid, { crop });
    if (pid === photo.id) setSuggestion(null);
    if (batch) setBatch((b) => { const n = { ...b }; delete n[pid]; return Object.keys(n).length ? n : null; });
  };
  const reject = (pid = photo.id) => {
    if (pid === photo.id) setSuggestion(null);
    if (batch) setBatch((b) => { const n = { ...b }; delete n[pid]; return Object.keys(n).length ? n : null; });
  };

  const runBatch = async () => {
    const list = orderedPhotos(getState());
    const task = startTask('تحلیل گروهی چهره‌ها…', { cancellable: true });
    const out = {};
    let noFace = 0;
    try {
      for (let i = 0; i < list.length; i += 1) {
        if (task.signal.aborted) break;
        task.update(i / list.length, `تحلیل ${formatNumber(i + 1)} از ${formatNumber(list.length)}`);
        try {
          const r = await analyzeFace(list[i]);
          if (r.faceCount) out[list[i].id] = suggestionFor(getState().photos[list[i].id]);
          else noFace += 1;
        } catch (err) { if (err.code !== 'NO_ORIGINAL') throw err; }
      }
      setBatch(Object.keys(out).length ? out : null);
      setSuggestion(out[photo.id] || null);
      toast(`پیشنهاد کادر برای ${formatNumber(Object.keys(out).length)} عکس آماده شد${noFace ? `؛ در ${formatNumber(noFace)} عکس چهره پیدا نشد` : ''}. هر پیشنهاد را بررسی و تأیید کنید.`, 'info', 8000);
    } catch (err) {
      toast(aiErrorText(err), 'error');
    } finally { task.done(); }
  };

  const setProfile = (id) => {
    if (id === 'generic') { updateEdit(photo.id, { profileId: null }); return; }
    const p = profiles.find((x) => x.id === id);
    const ph = findPhoto(p.photoId);
    updateEdit(photo.id, { profileId: id, widthMm: p.widthMm, heightMm: p.heightMm, sizeId: ph ? ph.id : 'custom' });
    setSuggestion(null);
  };

  return (
    <div class="view">
      <div class="workspace">
        <Queue />
        <section class="stage" aria-label="بوم اصلاح هوشمند">
          <div class="stage-toolbar" role="toolbar">
            <Button variant="primary" icon="scan-face" disabled={!canRun || busy} busy={busy} onClick={analyze} title={disabledReason || 'تحلیل چهره با مدل محلی'}>تحلیل چهره</Button>
            <Button icon="check" variant={suggestion ? 'gold' : ''} disabled={!suggestion} onClick={() => accept()}>پذیرش پیشنهاد</Button>
            <Button icon="x" variant="ghost" disabled={!suggestion} onClick={() => reject()}>رد</Button>
            <span class="toolbar-spacer" />
            <ViewSwitch view={view} setView={setView} />
          </div>
          <PhotoCanvas photo={photo} mode="crop" view={view} guides={profile} face={showFace ? face : null} suggestion={suggestion} {...handlers} />
          {suggestion ? <div class="stage-note ok"><Icon name="square-dashed" size={16} />کادر سبز خط‌چین پیشنهاد برنامه است. «پذیرش» را بزنید یا کادر را دستی تنظیم کنید.</div> : null}
        </section>
        <aside class="panel" aria-label="اصلاح هوشمند">
          <div class="panel-inner">
            {!canRun ? <Notice kind="warn" title="هوش مصنوعی در دسترس نیست">
              <p>{disabledReason}</p>
              <p>کادربندی دستی با خطوط راهنما همچنان کار می‌کند.</p>
              <Button size="sm" variant="ghost" icon="settings" onClick={() => setSection('settings')}>تنظیمات مدل‌ها</Button>
            </Notice> : null}
            <Group title="قالب اندازه و قواعد">
              <Select label="قاعدهٔ عکس" value={e.profileId || 'generic'} onChange={setProfile} options={[
                { value: 'generic', label: `نسبت عمومی برای ${formatNumber(e.widthMm)}×${formatNumber(e.heightMm)} ملی‌متر` },
                ...profiles.map((p) => ({ value: p.id, label: `${p.nameFa}${p.verified ? '' : ' (تأییدنشده)'}` })),
              ]} />
              <div class="btn-row"><Badge kind="warn" icon="triangle-alert">تأییدنشده</Badge><span class="hint">{profile.noteFa || 'این برنامه انطباق رسمی با هیچ اداره را تضمین نمی‌کند.'}</span></div>
              <dl class="kv">
                <dt>ارتفاع سر</dt><dd>{formatNumber(profile.headHeight.min, { maxFraction: 1 })} تا {formatNumber(profile.headHeight.max, { maxFraction: 1 })} ملی‌متر</dd>
                {profile.eyeFromBottom ? <><dt>خط چشم از پایین</dt><dd>{formatNumber(profile.eyeFromBottom.min, { maxFraction: 1 })} تا {formatNumber(profile.eyeFromBottom.max, { maxFraction: 1 })} ملی‌متر</dd></> : null}
              </dl>
            </Group>
            <Group title="بررسی کیفیت" actions={face ? <Switch label="نمایش نقاط" checked={showFace} onChange={setShowFace} /> : null}>
              {!face ? <p class="hint">برای بررسی خودکار، «تحلیل چهره» را بزنید. داده‌های چهره فقط در حافظهٔ موقت می‌ماند و ذخیره یا ارسال نمی‌شود.</p> : (
                <ul class="quality">
                  {quality.map((q) => {
                    const t = qualityText(q);
                    return (
                      <li key={q.code} class={`q-${q.level}`}>
                        <Icon name={LEVEL_ICON[q.level] || 'info'} />
                        <div><b>{t.title}</b> <span class="faint tiny">({LEVEL_FA[q.level]})</span><p>{t.body}</p></div>
                      </li>
                    );
                  })}
                </ul>
              )}
              {face?.metrics && !photo.maskKey ? <p class="hint">بررسی شانه‌ها به ماسک پس‌زمینه نیاز دارد (بخش پس‌زمینه).</p> : null}
              {face?.metrics ? <p class="hint">بالای سر: {face.crownSource === 'mask' ? 'از ماسک پس‌زمینه (دقیق‌تر)' : 'تخمینی از نسبت چهره — برای دقت بیشتر ابتدا پس‌زمینه را جدا کنید'}.</p> : null}
            </Group>
            <Group title="پردازش گروهی">
              <p class="hint">برای همهٔ عکس‌های پروژه پیشنهاد کادر ساخته می‌شود؛ هیچ تغییری بدون تأیید شما اعمال نمی‌شود.</p>
              <Button icon="users" disabled={!canRun} onClick={runBatch} title={disabledReason}>پیشنهاد برای همهٔ عکس‌ها</Button>
              {batch ? (
                <>
                  <p class="small">{formatNumber(Object.keys(batch).length)} پیشنهاد در انتظار بررسی.</p>
                  <div class="btn-row">
                    <Button size="sm" variant="primary" icon="check" onClick={() => { for (const [pid, c] of Object.entries(batch)) { recordHistory({ type: 'edit', photoId: pid }); updateEdit(pid, { crop: c }, { history: false }); } setBatch(null); setSuggestion(null); toast('همهٔ پیشنهادها اعمال شد. هر عکس با واگرد قابل برگشت است.', 'success'); }}>پذیرش همه</Button>
                    <Button size="sm" variant="ghost" icon="x" onClick={() => { setBatch(null); setSuggestion(null); }}>رد همه</Button>
                  </div>
                </>
              ) : null}
            </Group>
          </div>
        </aside>
      </div>
    </div>
  );
}
