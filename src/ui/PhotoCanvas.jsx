// Interactive photo stage: crop (pan / zoom / pinch / keyboard), before-after
// split, mask view, face + rule guides, and restore/erase brush painting.
import { useEffect, useRef, useState } from 'preact/hooks';
import { cropMatrix, invertMatrix, applyMatrix, panCrop, zoomCrop, frameCorners, defaultCrop } from '../core/crop.js';
import { getPreview, gatherAssets, getPersonMask, getClothesMask } from '../state/media.js';
import { renderPhoto, FULL_FRAME } from '../render/renderPhoto.js';
import { useStore } from '../state/store.js';
import { Icon } from './kit.jsx';

const PAD = 34;

function fitFrame(cw, ch, aspect) {
  const aw = Math.max(40, cw - PAD * 2); const ah = Math.max(40, ch - PAD * 2);
  let w = aw; let h = w / aspect;
  if (h > ah) { h = ah; w = h * aspect; }
  return { x: (cw - w) / 2, y: (ch - h) / 2, w, h };
}

function editRenderKey(edit, rev) {
  const { crop, ...rest } = edit;
  const bg = { ...rest.bg, strokes: rest.bg.strokes.length, lastLen: rest.bg.strokes.at(-1)?.points.length || 0 };
  const rc = { ...rest.clothes.recolor, strokes: rest.clothes.recolor.strokes.length, lastLen: rest.clothes.recolor.strokes.at(-1)?.points.length || 0 };
  return JSON.stringify([rest.adjust, rest.face, bg, rc, rest.clothes.overlay, rest.clothes.patch, rev, rest.widthMm, rest.heightMm]);
}

/**
 * @param {{photo, mode:'crop'|'view'|'brush', view?:'result'|'before'|'split'|'mask', maskTarget?:'person'|'clothes',
 *   brush?:{mode:'restore'|'erase', size:number, softness:number}, guides?:object|null, face?:object|null,
 *   suggestion?:object|null, onCropStart?, onCrop?, onCropEnd?, onStrokeStart?, onStroke?, onStrokeEnd?, label?:string}} props
 */
export function PhotoCanvas(props) {
  const { photo, mode = 'crop', view = 'result', guides = null, face = null, suggestion = null } = props;
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const [size, setSize] = useState({ w: 600, h: 500, dpr: 1 });
  const [pv, setPv] = useState(null);
  const [processed, setProcessed] = useState(null);
  const [maskCanvas, setMaskCanvas] = useState(null);
  const [split, setSplit] = useState(0.5);
  const [busy, setBusy] = useState(false);
  const [missing, setMissing] = useState(false);
  const [renderError, setRenderError] = useState(false);
  const rev = useStore((s) => s.rev[photo?.id] || 0);
  const pointers = useRef(new Map());
  const gesture = useRef(null);
  const cursor = useRef(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  const aspect = photo ? photo.edit.widthMm / photo.edit.heightMm : 0.75;
  const crop = photo ? (photo.edit.crop || (pv ? defaultCrop(pv.width, pv.height, aspect) : null)) : null;

  // container size
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setSize({ w: Math.max(100, r.width), h: Math.max(100, r.height), dpr: Math.min(2, window.devicePixelRatio || 1) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // preview
  useEffect(() => {
    let alive = true;
    setPv(null); setProcessed(null); setMissing(false);
    if (!photo) return undefined;
    getPreview(photo).then((p) => { if (alive) { if (p) setPv(p); else setMissing(true); } }).catch(() => alive && setMissing(true));
    return () => { alive = false; };
  }, [photo?.id, photo?.origKey]);

  // processed preview (debounced, latest wins)
  const renderKey = photo ? editRenderKey(photo.edit, rev) : '';
  useEffect(() => {
    if (!pv || !photo) return undefined;
    let alive = true;
    const t = setTimeout(async () => {
      setBusy(true);
      try {
        const assets = await gatherAssets(photo, pv);
        if (!alive) return;
        const c = crop || FULL_FRAME;
        const canvas = renderPhoto(photo.edit, assets, pv.width, pv.height, {
          crop: FULL_FRAME, pxPerMm: (c.cw * pv.width) / photo.edit.widthMm, frameWidthPx: c.cw * pv.width,
        });
        if (alive) { setProcessed(canvas); setRenderError(false); }
      } catch (e) {
        console.error(e);
        if (alive) setRenderError(true);
      } finally {
        if (alive) setBusy(false);
      }
    }, 70);
    return () => { alive = false; clearTimeout(t); };
  }, [pv, renderKey]);

  // mask canvas for mask view / brush feedback
  const target = props.maskTarget || 'person';
  useEffect(() => {
    if (!pv || !photo || (view !== 'mask' && mode !== 'brush')) { setMaskCanvas(null); return undefined; }
    let alive = true;
    const t = setTimeout(async () => {
      const m = target === 'clothes' ? await getClothesMask(photo) : await getPersonMask(photo);
      if (alive) setMaskCanvas(m);
    }, 16);
    return () => { alive = false; clearTimeout(t); };
  }, [pv, view, mode, target, renderKey]);

  // draw
  const frame = fitFrame(size.w, size.h, aspect);
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    c.width = Math.round(size.w * size.dpr); c.height = Math.round(size.h * size.dpr);
    const ctx = c.getContext('2d');
    ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);
    if (!pv || !crop) return;
    const V = matrixFor(frame, crop, pv);
    const drawSrc = (img) => {
      ctx.save();
      ctx.setTransform(size.dpr * V[0], size.dpr * V[1], size.dpr * V[2], size.dpr * V[3], size.dpr * V[4], size.dpr * V[5]);
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, pv.width, pv.height);
      ctx.restore();
    };
    // checkerboard inside frame (shows transparency / outside-image areas)
    ctx.save();
    ctx.beginPath(); ctx.rect(frame.x, frame.y, frame.w, frame.h); ctx.clip();
    ctx.fillStyle = '#ffffff'; ctx.fillRect(frame.x, frame.y, frame.w, frame.h);
    ctx.restore();
    const after = processed || pv.image;
    if (view === 'before') drawSrc(pv.image);
    else if (view === 'mask' && maskCanvas) {
      drawSrc(pv.image);
      const ov = document.createElement('canvas');
      ov.width = maskCanvas.width; ov.height = maskCanvas.height;
      const ox = ov.getContext('2d');
      ox.fillStyle = target === 'clothes' ? 'rgba(75,111,242,1)' : 'rgba(229,60,60,1)';
      ox.fillRect(0, 0, ov.width, ov.height);
      ox.globalCompositeOperation = target === 'clothes' ? 'destination-in' : 'destination-out';
      ox.drawImage(maskCanvas, 0, 0);
      ctx.save();
      ctx.globalAlpha = 0.55;
      ctx.setTransform(size.dpr * V[0], size.dpr * V[1], size.dpr * V[2], size.dpr * V[3], size.dpr * V[4], size.dpr * V[5]);
      ctx.drawImage(ov, 0, 0, pv.width, pv.height);
      ctx.restore();
    } else {
      drawSrc(after);
      if (view === 'split') {
        const sx = frame.x + frame.w * split;
        ctx.save();
        ctx.beginPath(); ctx.rect(sx, 0, size.w - sx, size.h); ctx.clip();
        drawSrc(pv.image);
        ctx.restore();
        ctx.fillStyle = '#fff'; ctx.fillRect(sx - 1, frame.y, 2, frame.h);
        ctx.beginPath(); ctx.arc(sx, frame.y + frame.h / 2, 11, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#1b1d22'; ctx.font = '600 11px Vazirmatn, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('⇆', sx, frame.y + frame.h / 2 + 1);
      }
    }
    // dim outside frame
    ctx.save();
    ctx.fillStyle = 'rgba(10,11,13,0.62)';
    ctx.beginPath();
    ctx.rect(0, 0, size.w, size.h);
    ctx.rect(frame.x, frame.y, frame.w, frame.h);
    ctx.fill('evenodd');
    ctx.restore();
    // frame
    ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.lineWidth = 1;
    ctx.strokeRect(frame.x + 0.5, frame.y + 0.5, frame.w - 1, frame.h - 1);
    ctx.strokeStyle = '#e6ad3e'; ctx.lineWidth = 3;
    const L = Math.min(22, frame.w / 6);
    for (const [x, y, dx, dy] of [[frame.x, frame.y, 1, 1], [frame.x + frame.w, frame.y, -1, 1], [frame.x, frame.y + frame.h, 1, -1], [frame.x + frame.w, frame.y + frame.h, -1, -1]]) {
      ctx.beginPath(); ctx.moveTo(x, y + dy * L); ctx.lineTo(x, y); ctx.lineTo(x + dx * L, y); ctx.stroke();
    }
    if (mode === 'crop' && gesture.current) {
      ctx.strokeStyle = 'rgba(255,255,255,.28)'; ctx.lineWidth = 1;
      for (let i = 1; i < 3; i += 1) {
        ctx.beginPath(); ctx.moveTo(frame.x + (frame.w * i) / 3, frame.y); ctx.lineTo(frame.x + (frame.w * i) / 3, frame.y + frame.h); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(frame.x, frame.y + (frame.h * i) / 3); ctx.lineTo(frame.x + frame.w, frame.y + (frame.h * i) / 3); ctx.stroke();
      }
    }
    if (guides) drawGuides(ctx, frame, guides, photo.edit);
    if (suggestion) drawPolygon(ctx, frameCorners(suggestion, pv.width, pv.height, aspect).map((p) => applyMatrix(V, p.x, p.y)), '#43b883', [6, 5]);
    if (face?.landmarks) drawFace(ctx, face, V, pv, photo);
    if (mode === 'brush' && cursor.current && props.brush) {
      const r = (props.brush.size * frame.w) / 2;
      ctx.strokeStyle = props.brush.mode === 'erase' ? '#ff7a6e' : '#7cf0b4'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(cursor.current.x, cursor.current.y, Math.max(2, r), 0, Math.PI * 2); ctx.stroke();
    }
  });

  // ---- interaction ----
  const toLocal = (e) => {
    const r = canvasRef.current.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const curCrop = () => {
    const p = propsRef.current.photo;
    return p.edit.crop || defaultCrop(pv.width, pv.height, p.edit.widthMm / p.edit.heightMm);
  };

  const strokePoint = (pt) => {
    const V = matrixFor(frame, curCrop(), pv);
    const inv = invertMatrix(V);
    const s = applyMatrix(inv, pt.x, pt.y);
    return [s.x / pv.width, s.y / pv.height];
  };

  const onPointerDown = (e) => {
    if (!pv || !crop) return;
    canvasRef.current.setPointerCapture(e.pointerId);
    const pt = toLocal(e);
    pointers.current.set(e.pointerId, pt);
    if (view === 'split' && Math.abs(pt.x - (frame.x + frame.w * split)) < 18) {
      gesture.current = { type: 'split' };
      return;
    }
    if (pointers.current.size === 2) {
      if (gesture.current?.type === 'stroke') propsRef.current.onStrokeEnd?.(gesture.current.stroke);
      const [a, b] = [...pointers.current.values()];
      gesture.current = { type: 'pinch', dist: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
      if (mode !== 'crop') propsRef.current.onCropStart?.();
      return;
    }
    if (mode === 'brush' && props.brush) {
      const k = curCrop().cw;
      const stroke = { mode: props.brush.mode, size: (props.brush.size * k) / 2, softness: props.brush.softness, points: [strokePoint(pt)] };
      gesture.current = { type: 'stroke', stroke, last: pt };
      propsRef.current.onStrokeStart?.(stroke);
      return;
    }
    if (mode === 'crop') {
      gesture.current = { type: 'pan', last: pt };
      propsRef.current.onCropStart?.();
    }
  };

  const onPointerMove = (e) => {
    const pt = toLocal(e);
    if (mode === 'brush') { cursor.current = pt; if (!gesture.current) canvasRef.current && setSize((s) => ({ ...s })); }
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, pt);
    const g = gesture.current;
    if (!g) return;
    if (g.type === 'split') { setSplit(Math.min(1, Math.max(0, (pt.x - frame.x) / frame.w))); return; }
    if (g.type === 'pan') {
      const dx = pt.x - g.last.x; const dy = pt.y - g.last.y;
      g.last = pt;
      propsRef.current.onCrop?.(panCrop(curCrop(), dx, dy, pv.width, pv.height, frame.w));
    } else if (g.type === 'pinch' && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      let c = curCrop();
      c = panCrop(c, mid.x - g.mid.x, mid.y - g.mid.y, pv.width, pv.height, frame.w);
      const V = matrixFor(frame, c, pv);
      const anchor = applyMatrix(invertMatrix(V), mid.x, mid.y);
      c = zoomCrop(c, dist / g.dist, pv.width, pv.height, anchor);
      g.dist = dist; g.mid = mid;
      propsRef.current.onCrop?.(c);
    } else if (g.type === 'stroke') {
      if (Math.hypot(pt.x - g.last.x, pt.y - g.last.y) < 2) return;
      g.last = pt;
      g.stroke = { ...g.stroke, points: [...g.stroke.points, strokePoint(pt)] };
      propsRef.current.onStroke?.(g.stroke);
    }
  };

  const onPointerUp = (e) => {
    pointers.current.delete(e.pointerId);
    const g = gesture.current;
    if (!g) return;
    if (g.type === 'stroke') propsRef.current.onStrokeEnd?.(g.stroke);
    if (g.type === 'pan' || g.type === 'pinch') propsRef.current.onCropEnd?.();
    gesture.current = pointers.current.size ? gesture.current : null;
    if (g.type === 'pinch' && pointers.current.size === 1) gesture.current = null;
    setSize((s) => ({ ...s }));
  };

  const onWheel = (e) => {
    if (!pv || !crop) return;
    e.preventDefault();
    const pt = toLocal(e);
    const c = curCrop();
    const V = matrixFor(frame, c, pv);
    const anchor = applyMatrix(invertMatrix(V), pt.x, pt.y);
    const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0016));
    propsRef.current.onCropStart?.({ coalesce: true });
    propsRef.current.onCrop?.(zoomCrop(c, factor, pv.width, pv.height, anchor));
    clearTimeout(onWheel.t);
    onWheel.t = setTimeout(() => propsRef.current.onCropEnd?.(), 300);
  };

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return undefined;
    const h = (e) => onWheel(e);
    c.addEventListener('wheel', h, { passive: false });
    return () => c.removeEventListener('wheel', h);
  });

  const onKeyDown = (e) => {
    if (!pv || !crop || mode !== 'crop') return;
    const step = e.shiftKey ? 10 : 1;
    let c = curCrop();
    let handled = true;
    if (e.key === 'ArrowLeft') c = panCrop(c, -step, 0, pv.width, pv.height, frame.w);
    else if (e.key === 'ArrowRight') c = panCrop(c, step, 0, pv.width, pv.height, frame.w);
    else if (e.key === 'ArrowUp') c = panCrop(c, 0, -step, pv.width, pv.height, frame.w);
    else if (e.key === 'ArrowDown') c = panCrop(c, 0, step, pv.width, pv.height, frame.w);
    else if (e.key === '+' || e.key === '=') c = zoomCrop(c, 1.04, pv.width, pv.height, null);
    else if (e.key === '-' || e.key === '_') c = zoomCrop(c, 1 / 1.04, pv.width, pv.height, null);
    else if (e.key === ']') c = { ...c, rotation: (c.rotation || 0) + 0.5 };
    else if (e.key === '[') c = { ...c, rotation: (c.rotation || 0) - 0.5 };
    else handled = false;
    if (handled) {
      e.preventDefault();
      propsRef.current.onCropStart?.({ coalesce: true });
      propsRef.current.onCrop?.(c);
      clearTimeout(onKeyDown.t);
      onKeyDown.t = setTimeout(() => propsRef.current.onCropEnd?.(), 400);
    }
  };

  const label = props.label || (mode === 'crop'
    ? 'بوم کادربندی: برای جابجایی بکشید، با چرخ ماوس یا دو انگشت بزرگ‌نمایی کنید. صفحه‌کلید: جهت‌ها جابجایی، + و − بزرگ‌نمایی، [ و ] چرخش.'
    : mode === 'brush' ? 'بوم قلم‌مو: برای بازگرداندن یا پاک کردن بخش‌ها بکشید.' : 'پیش‌نمایش عکس');

  return (
    <div class="photo-stage" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        class={`photo-canvas mode-${mode}`}
        style={{ width: `${size.w}px`, height: `${size.h}px` }}
        tabIndex={0}
        role="img"
        aria-label={label}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={() => { if (mode === 'brush') { cursor.current = null; setSize((s) => ({ ...s })); } }}
        onKeyDown={onKeyDown}
      />
      {busy ? <div class="stage-busy" role="status"><Icon name="loader-circle" class="spin" /> <span>در حال پردازش…</span></div> : null}
      {renderError ? (
        <div class="stage-error" role="alert">
          <Icon name="triangle-alert" size={16} />
          <span>پیش‌نمایش با تنظیمات تازه ساخته نشد (حافظه یا خطای پردازش). آنچه می‌بینید نتیجهٔ نهایی نیست؛ دوباره امتحان کنید یا صفحه را بارگذاری مجدد کنید.</span>
        </div>
      ) : null}
      {missing ? (
        <div class="stage-missing" role="alert">
          <Icon name="image" />
          <p>عکس اصلی این مورد در این دستگاه موجود نیست. از نوار عکس‌ها «جایگزینی» را بزنید و همان عکس را دوباره انتخاب کنید.</p>
        </div>
      ) : null}
    </div>
  );
}

export function matrixFor(frame, crop, pv) {
  const M = cropMatrix(crop, pv.width, pv.height, frame.w, frame.h);
  return [M[0], M[1], M[2], M[3], M[4] + frame.x, M[5] + frame.y];
}

function drawPolygon(ctx, pts, color, dash) {
  ctx.save();
  ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.setLineDash(dash || []);
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath(); ctx.stroke();
  ctx.restore();
}

function drawGuides(ctx, frame, profile, edit) {
  const k = frame.w / edit.widthMm;
  const H = edit.heightMm;
  ctx.save();
  ctx.setLineDash([4, 4]);
  ctx.lineWidth = 1;
  if (profile.eyeFromBottom) {
    const y1 = frame.y + (H - profile.eyeFromBottom.max) * k;
    const y2 = frame.y + (H - profile.eyeFromBottom.min) * k;
    ctx.fillStyle = 'rgba(75,111,242,.14)';
    ctx.fillRect(frame.x, y1, frame.w, y2 - y1);
    ctx.strokeStyle = 'rgba(120,150,255,.9)';
    ctx.beginPath(); ctx.moveTo(frame.x, y1); ctx.lineTo(frame.x + frame.w, y1); ctx.moveTo(frame.x, y2); ctx.lineTo(frame.x + frame.w, y2); ctx.stroke();
  }
  if (profile.headHeight && profile.eyeFromBottom) {
    const eyeY = frame.y + (H - profile.eyeFromBottom.target) * k;
    const hh = profile.headHeight.target * k;
    ctx.strokeStyle = 'rgba(230,173,62,.9)';
    ctx.beginPath();
    ctx.ellipse(frame.x + frame.w / 2, eyeY + hh * 0.02, hh * 0.36, hh * 0.52, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(255,255,255,.35)';
  ctx.beginPath(); ctx.moveTo(frame.x + frame.w / 2, frame.y); ctx.lineTo(frame.x + frame.w / 2, frame.y + frame.h); ctx.stroke();
  ctx.restore();
}

function drawFace(ctx, face, V, pv, photo) {
  const m = face.metrics;
  if (!m) return;
  const k = pv.width / photo.width;
  const P = (p) => applyMatrix(V, p.x * k, p.y * k);
  ctx.save();
  ctx.fillStyle = '#43b883';
  for (const e of [m.eyeA, m.eyeB]) { const s = P(e); ctx.beginPath(); ctx.arc(s.x, s.y, 3.5, 0, Math.PI * 2); ctx.fill(); }
  const r = (m.rollDeg * Math.PI) / 180;
  const toSrc = (u, v) => ({ x: m.eyeMid.x + u * Math.cos(r) - v * Math.sin(r), y: m.eyeMid.y + u * Math.sin(r) + v * Math.cos(r) });
  const line = (v, color, dashed) => {
    const a = P(toSrc(m.faceCenterU - m.faceWidth * 0.7, v)); const b = P(toSrc(m.faceCenterU + m.faceWidth * 0.7, v));
    ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.setLineDash(dashed ? [5, 4] : []);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  };
  line(0, '#43b883');
  line(m.chinV, '#43b883');
  line(m.crownV, '#e6ad3e', m.crownEstimated);
  ctx.restore();
}
