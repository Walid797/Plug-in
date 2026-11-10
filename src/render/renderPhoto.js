// Single rendering pipeline used for the editor preview, print preview and the
// final export — so what you see is what is printed.
//
// Order: source → (AI clothing patch) → clothing recolour → relight (one-sided
// shadow of the face) → tone/colour adjustments (+sharpen) → background replacement (mask, edge clean-up, shadow)
// → clothing template overlay.

import { cropMatrix, invertMatrix, applyMatrix, multiplyMatrix, defaultCrop } from '../core/crop.js';
import { applyAdjustments, isNeutral, snapNearWhite, reconstructEdgeDetails } from '../core/adjust.js';
import { decontaminate, recolorRegion, boxFilter } from '../core/mask.js';
import { applyFaceEngine, ellipseToOutput, healDiscs, skinProbability } from '../core/faceengine.js';
import { applyRelight } from '../core/relight.js';
import { makeCanvas } from '../platform/image.js';

export const FULL_FRAME = Object.freeze({ cx: 0.5, cy: 0.5, cw: 1, rotation: 0 });

export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return [255, 255, 255];
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function ctx2d(c) {
  return c.getContext('2d', { willReadFrequently: true });
}

/**
 * Intermediate sizes for stepwise 2× downscaling of a rw×rh region so that the
 * final draw scales by ≥ 0.5 (good quality, no aliasing). Always terminates.
 * @returns {Array<[number, number]>}
 */
export function halvingPlan(scale, rw, rh) {
  const steps = [];
  let cw = rw; let ch = rh;
  while (scale * (rw / cw) < 0.5 && cw > 2 && ch > 2 && steps.length < 24) {
    cw = Math.max(1, Math.round(cw / 2)); ch = Math.max(1, Math.round(ch / 2));
    steps.push([cw, ch]);
  }
  return steps;
}

/** Draw `image` (srcW×srcH) through matrix M with stepwise downscaling for quality. */
export function drawThrough(ctx, image, srcW, srcH, M, outW, outH) {
  const scale = Math.hypot(M[0], M[1]);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  if (scale >= 0.5) {
    ctx.setTransform(M[0], M[1], M[2], M[3], M[4], M[5]);
    ctx.drawImage(image, 0, 0, srcW, srcH);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return;
  }
  const inv = invertMatrix(M);
  const pts = [[0, 0], [outW, 0], [outW, outH], [0, outH]].map(([x, y]) => applyMatrix(inv, x, y));
  const rx0 = Math.max(0, Math.floor(Math.min(...pts.map((p) => p.x)) - 2));
  const ry0 = Math.max(0, Math.floor(Math.min(...pts.map((p) => p.y)) - 2));
  const rx1 = Math.min(srcW, Math.ceil(Math.max(...pts.map((p) => p.x)) + 2));
  const ry1 = Math.min(srcH, Math.ceil(Math.max(...pts.map((p) => p.y)) + 2));
  const rw = rx1 - rx0; const rh = ry1 - ry0;
  if (rw <= 0 || rh <= 0) return;
  const plan = halvingPlan(scale, rw, rh);
  if (!plan.length) {
    ctx.setTransform(M[0], M[1], M[2], M[3], M[4], M[5]);
    ctx.drawImage(image, 0, 0, srcW, srcH);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return;
  }
  let cur = image; let first = true;
  let kx = 1; let ky = 1;
  for (const [nw, nh] of plan) {
    const c = makeCanvas(nw, nh);
    const cx = c.getContext('2d');
    cx.imageSmoothingEnabled = true; cx.imageSmoothingQuality = 'high';
    if (first) cx.drawImage(cur, rx0, ry0, rw, rh, 0, 0, nw, nh);
    else cx.drawImage(cur, 0, 0, cur.width, cur.height, 0, 0, nw, nh);
    first = false;
    cur = c; kx = nw / rw; ky = nh / rh;
  }
  const T = multiplyMatrix(M, [1 / kx, 0, 0, 1 / ky, rx0, ry0]);
  ctx.setTransform(T[0], T[1], T[2], T[3], T[4], T[5]);
  ctx.drawImage(cur, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

/** Alpha (0..1) of a source-space mask canvas, resampled into output space. */
export function maskInOutput(maskCanvas, srcW, srcH, M, outW, outH) {
  const c = makeCanvas(outW, outH);
  const cx = ctx2d(c);
  const S = [srcW / maskCanvas.width, 0, 0, srcH / maskCanvas.height, 0, 0];
  const T = multiplyMatrix(M, S);
  cx.imageSmoothingEnabled = true; cx.imageSmoothingQuality = 'high';
  cx.setTransform(T[0], T[1], T[2], T[3], T[4], T[5]);
  cx.drawImage(maskCanvas, 0, 0);
  const d = cx.getImageData(0, 0, outW, outH).data;
  const a = new Float32Array(outW * outH);
  for (let i = 0; i < a.length; i += 1) a[i] = d[i * 4 + 3] / 255;
  return a;
}

function drawCover(ctx, img, w, h) {
  const s = Math.max(w / img.width, h / img.height);
  const dw = img.width * s; const dh = img.height * s;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

/**
 * @param {object} edit photo.edit
 * @param {{src:{image,width,height}, mask?, clothesMask?, bgImage?, template?, templateMeta?, patch?}} assets
 * @param {number} outW @param {number} outH output pixel size
 * @param {{crop?, before?:boolean, transparent?:boolean, pxPerMm?:number, frameWidthPx?:number, skipOverlay?:boolean}} [opts]
 */
export function renderPhoto(edit, assets, outW, outH, opts = {}) {
  const { src } = assets;
  const before = !!opts.before;
  const crop = opts.crop || edit.crop || defaultCrop(src.width, src.height, outW / outH);
  const M = cropMatrix(crop, src.width, src.height, outW, outH);
  const out = makeCanvas(outW, outH);
  const octx = ctx2d(out);
  const fg = makeCanvas(outW, outH);
  const fctx = ctx2d(fg);
  drawThrough(fctx, src.image, src.width, src.height, M, outW, outH);

  const clothes = edit.clothes || {};
  if (!before && clothes.patch && assets.patch) {
    const p = clothes.patch;
    const PM = multiplyMatrix(M, [p.w * src.width / assets.patch.width, 0, 0, p.h * src.height / assets.patch.height, p.x * src.width, p.y * src.height]);
    fctx.setTransform(PM[0], PM[1], PM[2], PM[3], PM[4], PM[5]);
    fctx.drawImage(assets.patch, 0, 0);
    fctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  const recolorOn = !before && clothes.recolor?.enabled && assets.clothesMask;
  const bgOn = !before && edit.bg?.enabled && assets.mask;
  const adjustOn = !before && !isNeutral(edit.adjust);
  const face = edit.face;
  const snapWhite = !before && !!edit.bg?.whiteSnap && !edit.bg?.enabled;
  const faceOn = !before && !!(face?.ellipse && (face.skin?.enabled || face.light?.enabled));
  const fixesOn = !before && !!face?.fixes?.length;
  const overlayOn = !before && !!clothes.overlay?.enabled;
  const relightOn = !before && !!(face?.relight?.enabled && assets.relight);
  const frameWidthPx = opts.frameWidthPx || outW;
  const pxPerMm = opts.pxPerMm || outW / (edit.widthMm || 30);

  if (recolorOn || bgOn || adjustOn || faceOn || fixesOn || snapWhite || overlayOn || relightOn) {
    const img = fctx.getImageData(0, 0, outW, outH);
    const data = img.data;
    if (recolorOn) {
      const a = maskInOutput(assets.clothesMask, src.width, src.height, M, outW, outH);
      recolorRegion(data, a, outW, outH, hexToRgb(clothes.recolor.color), (clothes.recolor.strength ?? 100) / 100);
    }
    // relight: the shadow of one-sided light is removed first, on the photo's own values, so every later step
    // (grading, skin, lips) sees an evenly lit face
    let relit = null;
    if (relightOn) {
      relit = applyRelight(data, outW, outH, assets.relight.packed, relightMatrix(assets.relight, src, M), { strength: (face.relight.strength ?? 100) / 100 });
      if (opts.faceReport) opts.faceReport.relight = relit;
    }
    // skin probability from this face's own skin colour, measured before any tone change
    let skinP = null;
    const wantDetail = adjustOn && (edit.adjust.clarity > 0 || edit.adjust.sharpness > 0);
    if (face?.ellipse && wantDetail) skinP = skinProbability(data, outW, outH, ellipseToOutput(face.ellipse, src.width, src.height, M));
    let detailWeight = null;
    if (wantDetail && skinP) {
      // crisp hair/brows/stubble/clothes, calmer skin
      detailWeight = new Float32Array(skinP.length);
      for (let j = 0; j < skinP.length; j += 1) detailWeight[j] = 1 - 0.9 * skinP[j];
    }
    if (adjustOn) applyAdjustments(data, outW, outH, edit.adjust, { scale: Math.max(1, frameWidthPx / 350), detailWeight });
    // Super-resolution detail reconstruction for low-resolution sources (e.g. 500px images upscaled for print/export)
    if (!before && src.width > 0 && outW / src.width > 1.15) {
      reconstructEdgeDetails(data, outW, outH, outW / src.width, detailWeight);
    }
    if (faceOn) {
      const protect = (face.protect || []).map((z) => ({ ...ellipseToOutput(z, src.width, src.height, M), soft: !!z.soft }));
      const toOut = (poly) => (poly || []).map(([px, py]) => applyMatrix(M, px * src.width, py * src.height)).map((p) => [p.x, p.y]);
      const lips = face.lips ? { outer: toOut(face.lips.outer), inner: toOut(face.lips.inner) } : null;
      const toIris = (iris) => {
        if (!iris) return null;
        const pt = applyMatrix(M, iris.cx * src.width, iris.cy * src.height);
        const rPt = applyMatrix(M, (iris.cx + iris.r) * src.width, iris.cy * src.height);
        return { cx: pt.x, cy: pt.y, r: Math.hypot(rPt.x - pt.x, rPt.y - pt.y) };
      };
      const eyes = face.eyes ? {
        right: toOut(face.eyes.right),
        left: toOut(face.eyes.left),
        irisR: toIris(face.eyes.irisR),
        irisL: toIris(face.eyes.irisL),
      } : null;
      // with the relight applied the older left/right flattening has nothing left to do (and must not act twice)
      const light = relit?.applied || assets.relightBaked ? { ...face.light, even: false } : face.light;
      const rep = applyFaceEngine(data, outW, outH, ellipseToOutput(face.ellipse, src.width, src.height, M), { ...face, light, protect, lips, eyes });
      if (opts.faceReport) Object.assign(opts.faceReport, rep);
    }
    // manual repair brush: real skin texture cloned over the marks the user painted (after all tone work)
    if (fixesOn) healDiscs(data, outW, outH, fixesToDiscs(face.fixes, src.width, src.height, M));
    if (snapWhite) snapNearWhite(data);
    let alpha = null;
    if (bgOn) {
      alpha = maskInOutput(assets.mask, src.width, src.height, M, outW, outH);
      if (edit.bg.decontaminate !== false) decontaminate(data, alpha, outW, outH, Math.max(2, Math.round(frameWidthPx / 120)));
      for (let i = 0; i < alpha.length; i += 1) data[i * 4 + 3] = Math.round((data[i * 4 + 3] / 255) * alpha[i] * 255);
    }
    // Clothing template: the person's own clothes must not show around or inside it. Below the chin everything is
    // cleared except the neck; inside the collar opening the neck is continued downwards with its own skin, so there
    // is skin (not the old shirt, not a hole) wherever the template is open.
    if (overlayOn) {
      let chinY = null; let cx = outW / 2; let rx = outW * 0.22; let ry = outW * 0.28;
      if (face?.ellipse) {
        const ell = ellipseToOutput(face.ellipse, src.width, src.height, M);
        chinY = ell.cy + ell.ry * 1.01; cx = ell.cx; rx = ell.rx; ry = ell.ry;
      } else if (clothes.overlay) {
        const pt = applyMatrix(M, clothes.overlay.x * src.width, clothes.overlay.y * src.height);
        chinY = pt.y; cx = pt.x; rx = clothes.overlay.width * src.width * Math.hypot(M[0], M[1]) * 0.15; ry = rx * 1.3;
      }
      const bgRgb = hexToRgb(edit.bg?.color || '#ffffff');
      const clear = (idx, keep = 0) => {
        if (bgOn) data[idx + 3] = Math.round(data[idx + 3] * keep);
        else for (let c = 0; c < 3; c += 1) data[idx + c] = Math.round(data[idx + c] * keep + bgRgb[c] * (1 - keep));
      };
      let cTight = null; // the mask as measured: inside the neck column the person's own neck skin must not be eaten by the grown edge
      let cAlpha = assets.clothesMask ? maskInOutput(assets.clothesMask, src.width, src.height, M, outW, outH) : null; // 0..1
      if (cAlpha) {
        // grown a little: the soft outer edge of the old clothing would otherwise stay as a thin outline
        const grown = boxFilter(cAlpha, outW, outH, Math.max(2, Math.round(outW / 110)));
        cTight = cAlpha; cAlpha = Float32Array.from(cAlpha, (v, j) => Math.max(v, Math.min(1, grown[j] * 4)));
      }
      // where the template itself is opaque (it will be drawn over the photo at the end)
      let tAlpha = null;
      if (assets.template && assets.templateMeta && !opts.skipOverlay) {
        const tc = makeCanvas(outW, outH); const tx = ctx2d(tc);
        drawTemplate(tx, assets.template, assets.templateMeta, clothes.overlay, src, M);
        const td = tx.getImageData(0, 0, outW, outH).data;
        tAlpha = new Float32Array(outW * outH);
        for (let i = 0; i < tAlpha.length; i += 1) tAlpha[i] = td[i * 4 + 3] / 255;
      }
      // old clothing beside and above the chin line (collar wings, shoulders that rise beside the jaw): cleared everywhere
      // outside the face itself
      if (cAlpha && chinY != null) {
        const ecy = chinY - ry * 1.01;
        for (let y = Math.max(0, Math.floor(ecy)); y < Math.min(outH, Math.ceil(chinY)); y += 1) {
          for (let x = 0; x < outW; x += 1) {
            const j = y * outW + x;
            if (cAlpha[j] <= 0.04) continue;
            const dx = (x - cx) / (rx * 1.02); const dy = (y - ecy) / (ry * 1.02);
            if (dx * dx + dy * dy > 1) clear(j * 4, Math.max(0, 1 - cAlpha[j] * 1.6));
          }
        }
      }
      if (chinY != null) {
        const y0 = Math.max(0, Math.floor(chinY));
        const filled = new Uint8Array(outW * outH);
        // skin tone for a neck that is covered right from the chin (high collar): the lower face, a little darker
        let fb = null;
        { let r = 0; let g = 0; let b = 0; let k = 0;
          for (let y = Math.max(0, Math.round(chinY - ry * 0.45)); y < Math.min(outH, Math.round(chinY - ry * 0.2)); y += 1) for (let x = Math.max(0, Math.round(cx - rx * 0.35)); x < Math.min(outW, Math.round(cx + rx * 0.35)); x += 1) { const i = (y * outW + x) * 4; r += data[i]; g += data[i + 1]; b += data[i + 2]; k += 1; }
          if (k) fb = [(r / k) * 0.88, (g / k) * 0.86, (b / k) * 0.85]; }
        // a pixel counts as the person's own neck only when it is not clothing and has the colour of this person's skin
        const fbCb = fb ? -0.168736 * fb[0] - 0.331264 * fb[1] + 0.5 * fb[2] : 0; const fbCr = fb ? 0.5 * fb[0] - 0.418688 * fb[1] - 0.081312 * fb[2] : 0;
        const skinLike = (idx) => {
          if (!fb) return true;
          const R = data[idx]; const G = data[idx + 1]; const B = data[idx + 2];
          // generous: the neck is in the chin's shadow and often redder or greyer than the face
          return 0.299 * R + 0.587 * G + 0.114 * B > 30 && Math.abs(-0.168736 * R - 0.331264 * G + 0.5 * B - fbCb) < 26 && Math.abs(0.5 * R - 0.418688 * G - 0.081312 * B - fbCr) < 26;
        };
        for (let x = 0; x < outW; x += 1) {
          let last = null; // last skin pixel seen in this column, going down (starting with the skin just above the chin line)
          if (y0 > 0) { const up = ((y0 - 1) * outW + x) * 4; if (data[up + 3] > 128 && skinLike(up) && Math.abs(x - cx) <= rx * 0.9) last = [data[up], data[up + 1], data[up + 2]]; }
          for (let y = y0; y < outH; y += 1) {
            const j = y * outW + x; const idx = j * 4;
            const prog = Math.min(1, Math.max(0, (y - chinY) / Math.max(1, ry * 0.8)));
            const half = rx * (0.92 + 0.15 * prog); const off = Math.abs(x - cx);
            const inNeck = off <= half;
            const cl = !cAlpha ? 0 : inNeck ? cTight[j] : cAlpha[j];
            // beside the neck column: the person's own skin stays (a neck is as wide as it is; the template covers the shoulders),
            // everything else there (old shoulders, collar wings) is cleared
            if (!inNeck) { if (!(cl < 0.2 && data[idx + 3] > 128 && skinLike(idx) && off <= rx * 1.6)) clear(idx); continue; }
            if (cl < 0.2 && data[idx + 3] > 128 && skinLike(idx)) { last = [data[idx], data[idx + 1], data[idx + 2]]; continue; } // the person's own neck
            if (cl >= 0.2 || (data[idx + 3] > 128 && !skinLike(idx))) {
              // old clothing inside the neck column: under the template it does not matter; where the template is open it becomes neck
              const open = !tAlpha || tAlpha[j] < 0.98;
              const src3 = last || fb;
              if (open && src3 && y < chinY + ry * 1.6) {
                const side = (x - cx) / (rx * 0.95);
                const shade = (1 - 0.14 * Math.min(1, (y - chinY) / Math.max(1, ry))) * (1 - 0.16 * side * side); // a little darker towards the collar and towards the sides (round neck)
                data[idx] = src3[0] * shade; data[idx + 1] = src3[1] * shade; data[idx + 2] = src3[2] * shade; data[idx + 3] = 255; filled[j] = 1;
              } else clear(idx, cl >= 0.2 ? Math.max(0, 1 - cl * 1.6) : 0);
            }
          }
        }
        // the continued neck is blended with the real neck around it (normalised blur over skin and continued skin only),
        // so it reads as one piece of skin: no streaks, no line where it starts
        let any = false; for (let j = y0 * outW; j < filled.length && !any; j += 1) any = filled[j] === 1;
        if (any) {
          const n = outW * outH; const wgt = new Float32Array(n); const near = new Float32Array(n);
          for (let y = y0; y < outH; y += 1) for (let x = 0; x < outW; x += 1) { const j = y * outW + x; if (filled[j]) { wgt[j] = 1; near[j] = 1; } else if (data[j * 4 + 3] > 128 && Math.abs(x - cx) <= rx * 1.1 && skinLike(j * 4)) wgt[j] = 1; }
          const rad = Math.max(3, Math.round(rx * 0.16));
          const wB = boxFilter(boxFilter(wgt, outW, outH, rad), outW, outH, rad);
          const reach = boxFilter(near, outW, outH, Math.max(2, Math.round(rx * 0.1))); // real skin right next to the continued part joins the blend
          for (let c = 0; c < 3; c += 1) {
            const ch = new Float32Array(n); for (let j = 0; j < n; j += 1) ch[j] = wgt[j] ? data[j * 4 + c] : 0;
            const b = boxFilter(boxFilter(ch, outW, outH, rad), outW, outH, rad);
            for (let j = y0 * outW; j < n; j += 1) {
              if (!wgt[j] || wB[j] < 1e-3) continue;
              const k = filled[j] ? 1 : Math.min(1, reach[j] * 2.5);
              if (k > 0) data[j * 4 + c] = data[j * 4 + c] * (1 - k) + (b[j] / wB[j]) * k;
            }
          }
        }
      } else if (cAlpha) {
        for (let j = 0; j < cAlpha.length; j += 1) if (cAlpha[j] > 0.04) clear(j * 4, Math.max(0, 1 - cAlpha[j]));
      }
    }
    fctx.putImageData(img, 0, 0);
    if (bgOn) {
      const transparent = opts.transparent || edit.bg.mode === 'transparent';
      if (!transparent) {
        if (edit.bg.mode === 'image' && assets.bgImage) drawCover(octx, assets.bgImage, outW, outH);
        else { octx.fillStyle = edit.bg.color || '#ffffff'; octx.fillRect(0, 0, outW, outH); }
        const sh = edit.bg.shadow;
        if (sh?.enabled && sh.opacity > 0) drawShadow(octx, alpha, outW, outH, sh, pxPerMm);
      }
    } else {
      octx.fillStyle = (edit.bg && edit.bg.color) || '#ffffff';
      octx.fillRect(0, 0, outW, outH);
    }
  } else {
    octx.fillStyle = (!before && edit.bg && edit.bg.color) || '#ffffff';
    octx.fillRect(0, 0, outW, outH);
  }
  octx.drawImage(fg, 0, 0);

  const ov = clothes.overlay;
  if (!before && !opts.skipOverlay && ov?.enabled && assets.template && assets.templateMeta) {
    drawTemplate(octx, assets.template, assets.templateMeta, ov, src, M);
  }
  return out;
}

/** Draw a clothing template at its overlay position (anchor at ov.x/ov.y of the source, ov.width of the source wide, turned by ov.rotation). */
function drawTemplate(ctx, template, meta, ov, src, M) {
  const wPx = ov.width * src.width;
  const hPx = wPx / meta.aspect;
  const r = ((ov.rotation || 0) * Math.PI) / 180;
  const cos = Math.cos(r); const sin = Math.sin(r);
  const T = multiplyMatrix(M, [cos, sin, -sin, cos, ov.x * src.width, ov.y * src.height]);
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.setTransform(T[0], T[1], T[2], T[3], T[4], T[5]);
  ctx.drawImage(template, -meta.anchorX * wPx, -meta.anchorY * hPx, wPx, hPx);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

/** Matrix from output pixels to the relight work frame: output → source (inverse crop) → the field's reference size → work. */
export function relightMatrix(relight, src, M) {
  const S = [relight.refW / src.width, 0, 0, relight.refH / src.height, 0, 0];
  return multiplyMatrix(relight.W, multiplyMatrix(S, invertMatrix(M)));
}

function drawShadow(ctx, alpha, w, h, sh, pxPerMm) {
  const r = Math.max(1, Math.round((sh.blurMm ?? 2) * pxPerMm));
  const blurred = boxFilter(boxFilter(alpha, w, h, Math.ceil(r / 2)), w, h, Math.ceil(r / 2));
  const c = makeCanvas(w, h);
  const cx = ctx2d(c);
  const img = cx.createImageData(w, h);
  const op = Math.min(1, (sh.opacity ?? 30) / 100);
  for (let i = 0; i < blurred.length; i += 1) img.data[i * 4 + 3] = Math.round(blurred[i] * op * 255);
  cx.putImageData(img, 0, 0);
  ctx.drawImage(c, (sh.offsetXmm ?? 0) * pxPerMm, (sh.offsetYmm ?? 1) * pxPerMm);
}

/** Build a canvas whose alpha channel holds a Uint8 mask. */
export function alphaCanvasFromBytes(bytes, w, h) {
  const c = makeCanvas(w, h);
  const cx = ctx2d(c);
  const img = cx.createImageData(w, h);
  for (let i = 0; i < w * h; i += 1) {
    img.data[i * 4] = 255; img.data[i * 4 + 1] = 255; img.data[i * 4 + 2] = 255; img.data[i * 4 + 3] = bytes[i];
  }
  cx.putImageData(img, 0, 0);
  return c;
}

/** Repair-brush strokes (source-normalised) → discs in output pixels, sampled along each stroke. */
export function fixesToDiscs(fixes, srcW, srcH, M, cap = 600) {
  const scale = Math.hypot(M[0], M[1]);
  const out = [];
  for (const s of fixes || []) {
    const r = Math.max(1.5, (s.size || 0.004) * srcW * scale);
    const pts = (s.points || []).map(([px, py]) => [M[0] * px * srcW + M[2] * py * srcH + M[4], M[1] * px * srcW + M[3] * py * srcH + M[5]]);
    if (!pts.length) continue;
    out.push({ x: pts[0][0], y: pts[0][1], r });
    const step = Math.max(1, r * 0.6);
    for (let i = 1; i < pts.length; i += 1) {
      const [ax, ay] = pts[i - 1]; const [bx, by] = pts[i];
      const d = Math.hypot(bx - ax, by - ay);
      for (let t = step; t <= d; t += step) out.push({ x: ax + ((bx - ax) * t) / d, y: ay + ((by - ay) * t) / d, r });
    }
    if (out.length >= cap) break;
  }
  return out.slice(0, cap);
}

/** Brush strokes on a mask canvas (alpha = foreground). Coordinates are normalised to the source. */
export function applyStrokes(maskCanvas, strokes) {
  if (!strokes?.length) return maskCanvas;
  const w = maskCanvas.width; const h = maskCanvas.height;
  const cx = maskCanvas.getContext('2d');
  for (const s of strokes) {
    const radius = Math.max(0.5, s.size * w);
    const hard = 1 - Math.min(1, Math.max(0, s.softness ?? 0.5));
    cx.globalCompositeOperation = s.mode === 'erase' ? 'destination-out' : 'source-over';
    const stamp = (x, y) => {
      const g = cx.createRadialGradient(x, y, radius * hard * 0.999, x, y, radius);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      cx.fillStyle = g;
      cx.beginPath();
      cx.arc(x, y, radius, 0, Math.PI * 2);
      cx.fill();
    };
    const pts = s.points;
    if (!pts.length) continue;
    let [px, py] = [pts[0][0] * w, pts[0][1] * h];
    stamp(px, py);
    const step = Math.max(0.5, radius * 0.25);
    for (let i = 1; i < pts.length; i += 1) {
      const x = pts[i][0] * w; const y = pts[i][1] * h;
      const d = Math.hypot(x - px, y - py);
      for (let t = step; t <= d; t += step) stamp(px + ((x - px) * t) / d, py + ((y - py) * t) / d);
      px = x; py = y;
    }
  }
  cx.globalCompositeOperation = 'source-over';
  return maskCanvas;
}

export function cloneCanvas(c) {
  const n = makeCanvas(c.width, c.height);
  n.getContext('2d').drawImage(c, 0, 0);
  return n;
}
