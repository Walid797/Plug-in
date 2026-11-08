import { useState } from 'preact/hooks';
import { useStore, updateEdit, recordHistory, toast, setSection, updateSettings, startTask } from '../../state/store.js';
import { PhotoCanvas } from '../PhotoCanvas.jsx';
import { Queue, NeedPhotos } from '../Queue.jsx';
import { Button, Group, Notice, Slider, Switch, Segmented, Badge, Icon, FilePick, Select } from '../kit.jsx';
import { useCropHandlers, ViewSwitch } from './Editor.jsx';
import { strokeHandlers, segErrorText } from './Background.jsx';
import { segmentPhoto } from '../../ai/segment.js';
import { hasMask, getFace, getPreview, getClothesMask, setPatch, registerUserTemplate } from '../../state/media.js';
import { BUILTIN_TEMPLATES, templatePreviewSvg } from '../../assets/suits.js';
import { aiAvailability } from '../../platform/capabilities.js';
import { checkCompanion, inpaint, buildPrompt, validateCompanionUrl } from '../../ai/companion.js';
import { formatNumber } from '../../core/digits.js';
import { defaultCrop, frameCorners } from '../../core/crop.js';
import { makeDomCanvas, decodeImage } from '../../platform/image.js';
import { putBlob } from '../../storage/db.js';
import { uid } from '../../state/store.js';
import { modelStatusText } from './Settings.jsx';

const CLOTH_COLORS = [
  { color: '#1c2333', nameFa: 'سرمه‌ای تیره', en: 'dark navy' },
  { color: '#111214', nameFa: 'سیاه', en: 'black' },
  { color: '#3b3f46', nameFa: 'خاکستری ذغالی', en: 'charcoal gray' },
  { color: '#f4f5f7', nameFa: 'سفید', en: 'white' },
  { color: '#bcd3ea', nameFa: 'آبی روشن', en: 'light blue' },
  { color: '#2f4a3a', nameFa: 'سبز تیره', en: 'dark green' },
  { color: '#5a3b2a', nameFa: 'قهوه‌ای', en: 'brown' },
];

function TemplateThumb({ tid, color }) {
  const svg = templatePreviewSvg(tid, color);
  return <span class="tpl-thumb" aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg }} />;
}

export function ClothingView() {
  const photo = useStore((s) => (s.selectedPhotoId ? s.photos[s.selectedPhotoId] : null));
  const caps = useStore((s) => s.caps);
  const models = useStore((s) => s.models);
  const companion = useStore((s) => s.settings.companion);
  const rev = useStore((s) => (photo ? s.rev[photo.id] || 0 : 0));
  const [view, setView] = useState('result');
  const [tool, setTool] = useState('move');
  const [brush, setBrush] = useState({ mode: 'restore', size: 0.06, softness: 0.4 });
  const [busy, setBusy] = useState(false);
  const [comp, setComp] = useState({ checked: false, ok: false, reason: '' });
  const [style, setStyle] = useState('suit');
  const [genColor, setGenColor] = useState(CLOTH_COLORS[0]);
  const [pending, setPending] = useState(null); // previous patch when a generated one is under review
  const handlers = useCropHandlers(photo || { id: null });
  if (!photo) return <div class="view"><NeedPhotos /></div>;
  void rev;
  const e = photo.edit;
  const rc = e.clothes.recolor;
  const ov = e.clothes.overlay;
  const ai = caps ? aiAvailability(caps) : { ok: false };
  const segOk = ['available', 'ready'].includes(models['selfie-multiclass']?.status);
  const canSeg = ai.ok && segOk;
  const segReason = !ai.ok ? ai.reason : !segOk ? `مدل ناحیه‌بندی: ${modelStatusText(models['selfie-multiclass'])}` : '';
  const hasClothes = hasMask(photo, 'clothes');
  const setRc = (patch, history = true) => updateEdit(photo.id, (ed) => ({ ...ed, clothes: { ...ed.clothes, recolor: { ...ed.clothes.recolor, ...patch } } }), { history });
  const setOv = (patch, history = true) => updateEdit(photo.id, (ed) => ({ ...ed, clothes: { ...ed.clothes, overlay: { ...ed.clothes.overlay, ...patch } } }), { history });

  const detect = async () => {
    setBusy(true);
    try {
      await segmentPhoto(photo, { modelId: 'selfie-multiclass' });
      setRc({ enabled: true });
      toast('ناحیهٔ لباس با مدل محلی تشخیص داده شد. با قلم‌مو می‌توانید آن را اصلاح کنید.', 'success');
    } catch (err) {
      console.error(err);
      toast(segErrorText(err), 'error', 10000);
    } finally { setBusy(false); }
  };

  const autoPlace = () => {
    const f = getFace(photo.id);
    if (!f?.metrics) { toast('برای جای‌گذاری خودکار، ابتدا در بخش «اصلاح هوشمند» چهره را تحلیل کنید. می‌توانید دستی هم تنظیم کنید.', 'warn', 8000); return; }
    const m = f.metrics;
    const r = (m.rollDeg * Math.PI) / 180;
    const v = m.chinV * 1.08;
    const x = m.eyeMid.x + m.faceCenterU * Math.cos(r) - v * Math.sin(r);
    const y = m.eyeMid.y + m.faceCenterU * Math.sin(r) + v * Math.cos(r);
    setOv({ x: x / photo.width, y: y / photo.height, width: (m.faceWidth * 3.4) / photo.width, rotation: m.rollDeg });
  };

  const chooseTemplate = (tid, color) => {
    const t = BUILTIN_TEMPLATES.find((x) => x.id === tid);
    const c = color || t.defaultColor;
    setOv({ enabled: true, templateId: `builtin:${tid}:${c}` });
    if (!ov.templateId) setTimeout(autoPlace, 0);
  };

  const testCompanion = async () => {
    setComp({ checked: false, ok: false, reason: 'در حال بررسی…' });
    const r = await checkCompanion(companion.url);
    setComp({ checked: true, ok: r.ok, reason: r.ok ? `متصل است (${formatNumber(r.models.length)} مدل)` : r.reason });
  };

  const generate = async () => {
    if (!comp.ok) return;
    const task = startTask('ساخت لباس با موتور محلی… (ممکن است چند دقیقه طول بکشد)', { cancellable: true });
    setBusy(true);
    try {
      const pv = await getPreview(photo);
      const mask = await getClothesMask(photo);
      if (!pv || !mask) throw new Error('NO_MASK');
      const aspect = e.widthMm / e.heightMm;
      const crop = e.crop || defaultCrop(pv.width, pv.height, aspect);
      const pts = frameCorners(crop, pv.width, pv.height, aspect);
      const x0 = Math.max(0, Math.floor(Math.min(...pts.map((p) => p.x)))); const y0 = Math.max(0, Math.floor(Math.min(...pts.map((p) => p.y))));
      const x1 = Math.min(pv.width, Math.ceil(Math.max(...pts.map((p) => p.x)))); const y1 = Math.min(pv.height, Math.ceil(Math.max(...pts.map((p) => p.y))));
      const rw = x1 - x0; const rh = y1 - y0;
      const s = Math.min(1, 768 / Math.max(rw, rh));
      const W = Math.max(64, Math.round((rw * s) / 8) * 8); const H = Math.max(64, Math.round((rh * s) / 8) * 8);
      const ic = makeDomCanvas(W, H); ic.getContext('2d').drawImage(pv.image, x0, y0, rw, rh, 0, 0, W, H);
      const mc = makeDomCanvas(W, H); const mx = mc.getContext('2d');
      mx.fillStyle = '#000'; mx.fillRect(0, 0, W, H);
      const tmp = makeDomCanvas(W, H); const tx = tmp.getContext('2d');
      tx.drawImage(mask, x0 * (mask.width / pv.width), y0 * (mask.height / pv.height), rw * (mask.width / pv.width), rh * (mask.height / pv.height), 0, 0, W, H);
      tx.globalCompositeOperation = 'source-in'; tx.fillStyle = '#fff'; tx.fillRect(0, 0, W, H);
      mx.drawImage(tmp, 0, 0);
      const blob = await inpaint(companion.url, { image: ic.toDataURL('image/png'), mask: mc.toDataURL('image/png'), width: W, height: H, prompt: buildPrompt(style, genColor.en) }, task.signal);
      const dec = await decodeImage(blob, {});
      if (dec.width !== W || dec.height !== H) throw new Error('SIZE');
      // keep generated pixels only inside the clothing mask (face, hair and background untouched)
      const out = makeDomCanvas(W, H); const ox = out.getContext('2d');
      ox.drawImage(dec.image, 0, 0);
      ox.globalCompositeOperation = 'destination-in';
      ox.drawImage(tmp, 0, 0);
      const pBlob = await new Promise((res) => out.toBlob(res, 'image/png'));
      const patch = await setPatch(photo.id, pBlob, { x: x0 / pv.width, y: y0 / pv.height, w: rw / pv.width, h: rh / pv.height });
      setPending(pending ?? (e.clothes.patch || 'none'));
      recordHistory({ type: 'edit', photoId: photo.id });
      updateEdit(photo.id, (ed) => ({ ...ed, aiEdited: true, clothes: { ...ed.clothes, patch } }), { history: false });
      toast('نتیجه آماده است. آن را بررسی کنید و «پذیرش» یا «دور انداختن» را بزنید.', 'info', 8000);
    } catch (err) {
      console.error(err);
      if (err.code === 'CANCELLED' || err.name === 'AbortError') toast('ساخت لغو شد.', 'info');
      else toast(err.message === 'NO_MASK' ? 'ابتدا ناحیهٔ لباس را تشخیص دهید یا با قلم‌مو مشخص کنید.' : 'موتور محلی نتیجهٔ معتبری برنگرداند.', 'error', 8000);
    } finally { setBusy(false); task.done(); }
  };

  const discard = () => {
    const prev = pending === 'none' ? null : pending;
    updateEdit(photo.id, (ed) => ({ ...ed, aiEdited: !!prev, clothes: { ...ed.clothes, patch: prev } }));
    setPending(null);
  };

  const brushing = tool === 'brush' && rc.enabled;
  const compUrlOk = validateCompanionUrl(companion.url).ok;
  return (
    <div class="view">
      <div class="workspace">
        <Queue />
        <section class="stage" aria-label="بوم لباس">
          <div class="stage-toolbar" role="toolbar">
            <Segmented value={tool} onChange={setTool} options={[
              { value: 'move', label: 'جابجایی', icon: 'move' },
              { value: 'brush', label: 'قلم‌موی ناحیهٔ لباس', icon: 'brush', disabled: !rc.enabled },
            ]} />
            <span class="toolbar-spacer" />
            <ViewSwitch view={view} setView={setView} extra={[{ value: 'mask', label: 'ناحیه', icon: 'layers', disabled: !hasClothes && !rc.strokes.length }]} />
          </div>
          <PhotoCanvas photo={photo} mode={brushing ? 'brush' : 'crop'} view={view} brush={brushing ? brush : null} maskTarget="clothes" {...handlers} {...strokeHandlers(photo.id, ['clothes', 'recolor', 'strokes'])} />
          {e.aiEdited ? <div class="stage-note gold"><Icon name="sparkles" size={16} />این عکس با هوش مصنوعی ویرایش شده است و در نام فایل خروجی مشخص می‌شود.</div> : null}
        </section>
        <aside class="panel" aria-label="ابزارهای لباس">
          <div class="panel-inner">
            <Notice kind="info">چهره، مو و پوست هرگز تغییر داده نمی‌شوند. عکس اصلی همیشه دست‌نخورده می‌ماند و هر تغییر با واگرد برمی‌گردد.</Notice>

            <Group title="۱. تغییر رنگ لباس (ناحیه‌بندی با هوش مصنوعی)">
              <p class="hint">مدل محلی ناحیهٔ لباس را پیدا می‌کند؛ رنگ با حفظ چین و سایه‌ها عوض می‌شود. لباس تازه ساخته نمی‌شود.</p>
              {!canSeg ? <Notice kind="warn"><p>{segReason}</p></Notice> : null}
              <div class="btn-row">
                <Button icon="scan" busy={busy} disabled={!canSeg || busy} onClick={detect} title={segReason}>{hasClothes ? 'تشخیص دوبارهٔ لباس' : 'تشخیص ناحیهٔ لباس'}</Button>
                <Switch label="فعال" checked={rc.enabled} onChange={(v) => setRc({ enabled: v })} disabled={!hasClothes && !rc.strokes.length} />
              </div>
              <div class="swatches" role="group" aria-label="رنگ لباس">
                {CLOTH_COLORS.map((c) => <button type="button" key={c.color} class="swatch" style={{ background: c.color }} aria-pressed={String(rc.color === c.color)} aria-label={c.nameFa} data-tip={c.nameFa} onClick={() => setRc({ color: c.color, enabled: true })} disabled={!hasClothes && !rc.strokes.length} />)}
                <label class="swatch custom" data-tip="رنگ دلخواه"><input type="color" value={rc.color} aria-label="رنگ دلخواه لباس" onChange={(ev) => setRc({ color: ev.currentTarget.value, enabled: true })} /></label>
              </div>
              <Slider label="شدت" min={0} max={100} value={rc.strength} defaultValue={100} format={(v) => `${formatNumber(v)}٪`} onInput={(v) => setRc({ strength: v }, false)} onCommit={(v, s) => { setRc({ strength: s }, false); setRc({ strength: v }); }} disabled={!rc.enabled} />
              {rc.enabled ? (
                <>
                  <Segmented value={brush.mode} onChange={(m) => { setBrush({ ...brush, mode: m }); setTool('brush'); }} options={[{ value: 'restore', label: 'افزودن به ناحیه', icon: 'brush' }, { value: 'erase', label: 'حذف از ناحیه', icon: 'eraser' }]} />
                  <Slider label="اندازهٔ قلم" min={1} max={30} value={Math.round(brush.size * 100)} defaultValue={6} format={(v) => formatNumber(v)} onInput={(v) => setBrush({ ...brush, size: v / 100 })} />
                </>
              ) : null}
            </Group>

            <Group title="۲. قالب لباس (بدون هوش مصنوعی)">
              <p class="hint">قالب‌های برداری ساده که روی عکس قرار می‌گیرند — مانند روش رایج عکاسی‌ها. هوش مصنوعی نیست.</p>
              <div class="tpl-grid">
                {BUILTIN_TEMPLATES.map((t) => (
                  <button type="button" key={t.id} class="tpl" aria-pressed={String(ov.enabled && ov.templateId?.startsWith(`builtin:${t.id}:`))} onClick={() => chooseTemplate(t.id)}>
                    <TemplateThumb tid={t.id} />
                    <span>{t.nameFa}</span>
                  </button>
                ))}
              </div>
              {ov.enabled && ov.templateId?.startsWith('builtin:') ? (
                <div class="swatches" role="group" aria-label="رنگ قالب">
                  {BUILTIN_TEMPLATES.find((t) => ov.templateId.startsWith(`builtin:${t.id}:`))?.colors.map((c) => {
                    const tid = ov.templateId.split(':')[1];
                    return <button type="button" key={c} class="swatch" style={{ background: c }} aria-label={`رنگ ${c}`} aria-pressed={String(ov.templateId.endsWith(c))} onClick={() => chooseTemplate(tid, c)} />;
                  })}
                </div>
              ) : null}
              <div class="btn-row">
                <FilePick accept="image/png" size="sm" icon="image-plus" onFiles={async (f) => {
                  const file = f[0];
                  if (!/png$/i.test(file.type) && !/\.png$/i.test(file.name)) { toast('قالب باید PNG با پس‌زمینهٔ شفاف باشد.', 'error'); return; }
                  const key = `user:${uid('tpl')}`;
                  await putBlob(key, file);
                  const dec = await decodeImage(file, { maxPixels: 6_000_000 });
                  registerUserTemplate(key, { image: dec.image, meta: { aspect: dec.width / dec.height, anchorX: 0.5, anchorY: 0.09 } });
                  setOv({ enabled: true, templateId: key });
                }}>قالب PNG خودتان</FilePick>
                {ov.enabled ? <Button size="sm" variant="ghost" icon="crosshair" onClick={autoPlace}>جای‌گذاری خودکار</Button> : null}
                {ov.enabled ? <Button size="sm" variant="ghost" icon="x" onClick={() => setOv({ enabled: false })}>برداشتن قالب</Button> : null}
              </div>
              {ov.enabled ? (
                <>
                  <Slider label="جابجایی افقی" min={0} max={1000} value={Math.round(ov.x * 1000)} defaultValue={500} format={(v) => formatNumber(v / 10, { maxFraction: 1 })} onInput={(v) => setOv({ x: v / 1000 }, false)} onCommit={(v, s) => { setOv({ x: s / 1000 }, false); setOv({ x: v / 1000 }); }} />
                  <Slider label="جابجایی عمودی" min={0} max={1000} value={Math.round(ov.y * 1000)} defaultValue={800} format={(v) => formatNumber(v / 10, { maxFraction: 1 })} onInput={(v) => setOv({ y: v / 1000 }, false)} onCommit={(v, s) => { setOv({ y: s / 1000 }, false); setOv({ y: v / 1000 }); }} />
                  <Slider label="اندازه" min={50} max={1500} value={Math.round(ov.width * 1000)} defaultValue={600} format={(v) => formatNumber(v / 10, { maxFraction: 1 })} onInput={(v) => setOv({ width: v / 1000 }, false)} onCommit={(v, s) => { setOv({ width: s / 1000 }, false); setOv({ width: v / 1000 }); }} />
                  <Slider label="چرخش (درجه)" min={-30} max={30} step={0.5} value={ov.rotation} defaultValue={0} format={(v) => `${formatNumber(v, { maxFraction: 1 })}°`} onInput={(v) => setOv({ rotation: v }, false)} onCommit={(v, s) => { setOv({ rotation: s }, false); setOv({ rotation: v }); }} />
                </>
              ) : null}
            </Group>

            <Group title="۳. ساخت لباس با هوش مصنوعی مولد (موتور محلی اختیاری)">
              <Notice kind="warn">
                <p>هیچ مدل مولد لباس با مجوز آزاد که بتواند به‌طور واقعی داخل مرورگر اجرا شود همراه برنامه نیست؛ بنابراین این بخش فقط با یک <b>موتور محلی جداگانه روی همین کمپیوتر</b> کار می‌کند (Stable Diffusion WebUI سازگار با API، با کارت گرافیک). هیچ سرویس ابری استفاده نمی‌شود.</p>
              </Notice>
              <Switch label="استفاده از موتور محلی" checked={companion.enabled} onChange={(v) => updateSettings((s) => ({ companion: { ...s.companion, enabled: v } }))} />
              {companion.enabled ? (
                <>
                  <label class="field"><span class="field-label">نشانی موتور (فقط همین کمپیوتر)</span>
                    <input class="input ltr" value={companion.url} onChange={(ev) => updateSettings((s) => ({ companion: { ...s.companion, url: ev.currentTarget.value.trim() } }))} />
                  </label>
                  {!compUrlOk ? <p class="field-error">{validateCompanionUrl(companion.url).reason}</p> : null}
                  <div class="btn-row">
                    <Button size="sm" icon="plug" disabled={!compUrlOk} onClick={testCompanion}>آزمایش اتصال</Button>
                    {comp.reason ? <Badge kind={comp.ok ? 'ok' : comp.checked ? 'err' : ''}>{comp.reason}</Badge> : null}
                  </div>
                  <Select label="سبک" value={style} onChange={setStyle} options={[
                    { value: 'suit', label: 'کت‌وشلوار رسمی' }, { value: 'office', label: 'لباس اداری' },
                    { value: 'shirt', label: 'پیراهن یخن‌دار' }, { value: 'school', label: 'یونیفورم مکتب' },
                  ]} />
                  <Select label="رنگ" value={genColor.color} onChange={(v) => setGenColor(CLOTH_COLORS.find((c) => c.color === v))} options={CLOTH_COLORS.map((c) => ({ value: c.color, label: c.nameFa }))} />
                  <div class="btn-row">
                    <Button variant="primary" icon="sparkles" busy={busy} disabled={!comp.ok || busy || (!hasClothes && !rc.strokes.length)} onClick={generate}
                      title={!comp.ok ? 'ابتدا اتصال به موتور محلی را آزمایش کنید.' : (!hasClothes && !rc.strokes.length) ? 'ابتدا ناحیهٔ لباس را مشخص کنید.' : ''}>{pending ? 'ساخت دوباره' : 'ساخت'}</Button>
                    {pending ? <Button icon="check" onClick={() => { setPending(null); toast('نتیجه پذیرفته شد و عکس «ویرایش‌شده با هوش مصنوعی» علامت خورد.', 'success'); }}>پذیرش</Button> : null}
                    {pending ? <Button variant="ghost" icon="trash-2" onClick={discard}>دور انداختن</Button> : null}
                  </div>
                  {!comp.ok ? <p class="hint">تا وقتی اتصال تأیید نشود، دکمهٔ «ساخت» غیرفعال است. راهنمای راه‌اندازی در docs/ai-models.md.</p> : null}
                </>
              ) : <p class="hint">خاموش است. برای راه‌اندازی، راهنمای «مدل‌های آفلاین» را ببینید.</p>}
              {e.clothes.patch && !pending ? <Button size="sm" variant="ghost" icon="x" onClick={() => updateEdit(photo.id, (ed) => ({ ...ed, aiEdited: false, clothes: { ...ed.clothes, patch: null } }))}>حذف لباس ساخته‌شده</Button> : null}
            </Group>
            <Button variant="ghost" icon="settings" onClick={() => setSection('settings')}>مدل‌ها و نیازمندی‌ها</Button>
          </div>
        </aside>
      </div>
    </div>
  );
}
