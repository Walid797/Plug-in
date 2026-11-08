// ID-photo standardisation geometry: face metrics from landmarks, crop
// suggestions for a rule profile and quality checks. Pure math — the model that
// produces landmarks lives in src/ai. No biometric template is ever computed.

import { cropMatrix, applyMatrix, invertMatrix, isFrameInside } from './crop.js';

// MediaPipe Face Mesh landmark indices.
export const LM = Object.freeze({
  rightEyeOuter: 33, rightEyeInner: 133, leftEyeInner: 362, leftEyeOuter: 263,
  rightIris: 468, leftIris: 473, noseTip: 1, chin: 152, forehead: 10,
  rightCheek: 234, leftCheek: 454,
});

/**
 * Head top above the eye line, as a multiple of the eye→chin distance, used only
 * when no segmentation mask is available (classic proportion: eyes near the
 * vertical middle of the head). Marked as an estimate in the UI.
 */
export const CROWN_RATIO = 1.05;

const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * @param {Array<{x:number,y:number}>} lm normalised landmarks (0..1)
 * @param {number} srcW @param {number} srcH
 * @param {{crownV?: number|null}} [opts]
 */
export function faceMetrics(lm, srcW, srcH, opts = {}) {
  const P = (i) => ({ x: lm[i].x * srcW, y: lm[i].y * srcH });
  const hasIris = lm.length > 473;
  const e1 = hasIris ? P(LM.rightIris) : mid(P(LM.rightEyeOuter), P(LM.rightEyeInner));
  const e2 = hasIris ? P(LM.leftIris) : mid(P(LM.leftEyeOuter), P(LM.leftEyeInner));
  const [a, b] = e1.x <= e2.x ? [e1, e2] : [e2, e1];
  const roll = Math.atan2(b.y - a.y, b.x - a.x);
  const eyeMid = mid(a, b);
  const cos = Math.cos(-roll); const sin = Math.sin(-roll);
  const toFace = (p) => {
    const dx = p.x - eyeMid.x; const dy = p.y - eyeMid.y;
    return { u: dx * cos - dy * sin, v: dx * sin + dy * cos };
  };
  const chin = toFace(P(LM.chin));
  const forehead = toFace(P(LM.forehead));
  const cheekA = toFace(P(LM.rightCheek)); const cheekB = toFace(P(LM.leftCheek));
  const nose = toFace(P(LM.noseTip));
  const faceWidth = Math.abs(cheekB.u - cheekA.u);
  const faceCenterU = (cheekA.u + cheekB.u) / 2;
  const crownEstimated = opts.crownV == null;
  const crownV = crownEstimated ? -chin.v * CROWN_RATIO : opts.crownV;
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const p of lm) {
    minX = Math.min(minX, p.x * srcW); maxX = Math.max(maxX, p.x * srcW);
    minY = Math.min(minY, p.y * srcH); maxY = Math.max(maxY, p.y * srcH);
  }
  return {
    eyeA: a, eyeB: b, eyeMid, eyeDist: dist(a, b),
    rollDeg: (roll * 180) / Math.PI,
    chinV: chin.v, foreheadV: forehead.v, crownV, crownEstimated,
    headHeight: chin.v - crownV,
    faceWidth, faceCenterU,
    yaw: faceWidth > 0 ? (nose.u - faceCenterU) / faceWidth : 0,
    bbox: { x: minX, y: minY, w: maxX - minX, h: maxY - minY },
  };
}

/**
 * Zones that retouching must never touch: both eyes (inner corner, lashes, lids), the mouth (lips and
 * corners) and the underside of the nose (nostrils). Ellipses in source-normalised units like faceEllipse
 * (centre over the source size, radii over the source width). Derived from the landmarks only; nothing is
 * stored about the person beyond these shapes.
 */
export function faceProtectZones(lm, srcW, srcH) {
  if (!lm || lm.length < 400) return [];
  const P = (i) => ({ x: lm[i].x * srcW, y: lm[i].y * srcH });
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const rot = (a, b) => (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
  const zone = (c, rx, ry, deg) => ({ cx: c.x / srcW, cy: c.y / srcH, rx: rx / srcW, ry: ry / srcW, rot: deg });
  const out = [];
  for (const [o, i] of [[33, 133], [263, 362]]) { // eyes
    const a = P(o); const b = P(i); const w = d(a, b);
    out.push(zone(mid(a, b), w * 0.78, w * 0.5, rot(a, b)));
  }
  const m1 = P(61); const m2 = P(291); const mw = d(m1, m2); // mouth
  const mc = mid(mid(m1, m2), mid(P(0), P(17)));
  out.push(zone(mc, mw * 0.68, Math.max(d(P(0), P(17)) * 0.95, mw * 0.3), rot(m1, m2)));
  const n1 = P(98); const n2 = P(327); const nw = d(n1, n2); // nostrils / underside of the nose
  out.push(zone({ x: (n1.x + n2.x) / 2, y: (n1.y + n2.y) / 2 - nw * 0.08 }, nw * 0.72, nw * 0.4, rot(n1, n2)));
  return out;
}

/** Map face-frame (u,v) back to source pixels. */
export function faceToSource(m, u, v) {
  const r = (m.rollDeg * Math.PI) / 180;
  return { x: m.eyeMid.x + u * Math.cos(r) - v * Math.sin(r), y: m.eyeMid.y + u * Math.sin(r) + v * Math.cos(r) };
}

/**
 * Find the top of the head (hair included) from a foreground mask by scanning
 * upward from the forehead along several columns around the face axis.
 * @param {(x:number,y:number)=>number} sample alpha 0..1 at source pixel
 * @returns {number|null} crown v in the face frame
 */
export function crownFromMask(m, sample, srcW, srcH) {
  const step = Math.max(1, m.eyeDist / 40);
  const maxUp = m.chinV * 3;
  let best = null;
  for (const f of [-0.25, -0.12, 0, 0.12, 0.25]) {
    const u = m.faceCenterU + f * m.faceWidth;
    let lastIn = null;
    let gap = 0;
    for (let v = m.foreheadV; v > -maxUp; v -= step) {
      const p = faceToSource(m, u, v);
      if (p.x < 0 || p.y < 0 || p.x >= srcW || p.y >= srcH) break;
      if (sample(p.x, p.y) >= 0.5) { lastIn = v; gap = 0; } else { gap += step; if (gap > m.eyeDist * 0.15) break; }
    }
    if (lastIn != null && (best == null || lastIn < best)) best = lastIn;
  }
  return best;
}

/** A generic unverified profile for any photo size (head ≈ 70%, eyes ≈ 57% from bottom). */
export function genericProfile(widthMm, heightMm) {
  return {
    id: 'generic', nameFa: 'نسبت عمومی', widthMm, heightMm, verified: false,
    headHeight: { min: heightMm * 0.62, max: heightMm * 0.78, target: heightMm * 0.7 },
    eyeFromBottom: { min: heightMm * 0.52, max: heightMm * 0.66, target: heightMm * 0.57 },
  };
}

/** Suggested crop (normalised crop object) for a profile. */
export function suggestCrop(m, profile, srcW, srcH) {
  const W = profile.widthMm; const H = profile.heightMm;
  const k = m.headHeight / profile.headHeight.target; // source px per mm
  const eye = profile.eyeFromBottom?.target ?? H * 0.57;
  let vc = (eye - H / 2) * k;
  // Keep at least a small gap above the head if the eye rule would cut it.
  const crownTopMm = H / 2 + (m.crownV - vc) / k;
  if (crownTopMm < 1) vc += (crownTopMm - 1) * k;
  // the face centre (cheek to cheek) is placed exactly on the vertical centre line of the frame
  const uc = m.faceCenterU;
  const c = faceToSource(m, uc, vc);
  return { cx: c.x / srcW, cy: c.y / srcH, cw: (W * k) / srcW, rotation: m.rollDeg };
}

/** Measurements of the face inside a given crop, in output millimetres. */
export function evaluateCrop(m, crop, widthMm, heightMm, srcW, srcH) {
  const M = cropMatrix(crop, srcW, srcH, widthMm, heightMm);
  const map = (u, v) => { const s = faceToSource(m, u, v); return applyMatrix(M, s.x, s.y); };
  const eye = applyMatrix(M, m.eyeMid.x, m.eyeMid.y);
  const chin = map(0, m.chinV);
  const crown = map(0, m.crownV);
  const centre = map(m.faceCenterU, 0);
  const left = map(m.faceCenterU - m.faceWidth / 2, 0);
  const right = map(m.faceCenterU + m.faceWidth / 2, 0);
  return {
    headHeightMm: Math.hypot(chin.x - crown.x, chin.y - crown.y),
    eyeFromBottomMm: heightMm - eye.y,
    crownTopMm: crown.y,
    chinBottomMm: heightMm - chin.y,
    centreOffsetMm: centre.x - widthMm / 2,
    faceLeftMm: Math.min(left.x, right.x), faceRightMm: Math.max(left.x, right.x),
    residualRollDeg: m.rollDeg - (crop.rotation || 0),
    insideImage: isFrameInside(crop, srcW, srcH, widthMm / heightMm),
  };
}

/**
 * Fraction of the frame's lower edge (at 94% height) covered by the person mask —
 * a proxy for "both shoulders visible". Needs a foreground mask.
 * @param {(x:number,y:number)=>number} sample alpha at source px
 */
export function shoulderCoverage(crop, widthMm, heightMm, srcW, srcH, sample) {
  const M = cropMatrix(crop, srcW, srcH, widthMm, heightMm);
  const inv = invertMatrix(M);
  let hit = 0; const n = 41;
  for (let i = 0; i < n; i += 1) {
    const p = applyMatrix(inv, (widthMm * (i + 0.5)) / n, heightMm * 0.94);
    if (p.x >= 0 && p.y >= 0 && p.x < srcW && p.y < srcH && sample(p.x, p.y) >= 0.5) hit += 1;
  }
  return hit / n;
}

/**
 * Like shoulderCoverage, but also reports the left and right halves separately
 * (each as the share of its own samples inside the person), for a symmetry check.
 */
export function shoulderSides(crop, widthMm, heightMm, srcW, srcH, sample) {
  const M = cropMatrix(crop, srcW, srcH, widthMm, heightMm);
  const inv = invertMatrix(M);
  const n = 40; let l = 0; let r = 0;
  for (let i = 0; i < n; i += 1) {
    const p = applyMatrix(inv, (widthMm * (i + 0.5)) / n, heightMm * 0.94);
    const hit = p.x >= 0 && p.y >= 0 && p.x < srcW && p.y < srcH && sample(p.x, p.y) >= 0.5 ? 1 : 0;
    if (i < n / 2) l += hit; else r += hit;
  }
  return { left: l / (n / 2), right: r / (n / 2), frac: (l + r) / n };
}

/**
 * Is the background already clean white? Looks at the top strip and the upper side strips of the
 * frame (where there is no person in a personnel photo). Replacing an already white background only
 * costs fine hair detail, so the pipeline leaves it alone.
 * @returns {{white:boolean, mean:number, spread:number}}
 */
export function backgroundWhiteness(rgba, w, h) {
  const vals = [];
  const top = Math.max(1, Math.round(h * 0.05)); const side = Math.max(1, Math.round(w * 0.06)); const sideH = Math.round(h * 0.3);
  const take = (x0, x1, y0, y1) => { for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) { const i = (y * w + x) * 4; vals.push(Math.min(rgba[i], rgba[i + 1], rgba[i + 2])); } };
  take(0, w, 0, top); take(0, side, 0, sideH); take(w - side, w, 0, sideH);
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const spread = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
  return { white: mean >= 244 && spread <= 6, mean, spread };
}

/** Luma statistics of a face crop: brightness, left/right balance, sharpness. */
export function faceRegionStats(rgba, w, h) {
  const L = new Float32Array(w * h);
  let sum = 0; let left = 0; let right = 0;
  for (let i = 0, j = 0; j < w * h; i += 4, j += 1) {
    const l = (0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2]) / 255;
    L[j] = l; sum += l;
    if (j % w < w / 2) left += l; else right += l;
  }
  let lapSum = 0; let lapSq = 0; let cnt = 0;
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      const i = y * w + x;
      const lap = (4 * L[i] - L[i - 1] - L[i + 1] - L[i - w] - L[i + w]) * 255;
      lapSum += lap; lapSq += lap * lap; cnt += 1;
    }
  }
  const mean = lapSum / Math.max(1, cnt);
  return {
    meanL: sum / (w * h),
    balance: (left - right) / ((w * h) / 2),
    sharpness: lapSq / Math.max(1, cnt) - mean * mean,
  };
}

export const QUALITY_THRESHOLDS = Object.freeze({
  rollWarnDeg: 2, rollErrorDeg: 8, yawWarn: 0.08, centreWarnFrac: 0.05,
  darkL: 0.28, brightL: 0.86, balanceWarn: 0.16, sharpnessWarn: 40,
  dpiWarn: 250, dpiError: 150,
  topMarginMinMm: 1.5, topMarginMaxFrac: 0.18, shoulderMinFrac: 0.55, shoulderSymmetryWarn: 0.25,
});

/** Assemble the human-facing checklist (levels: ok | warn | error | info). */
export function assessQuality({ metrics, evaluation, profile, stats, faceCount, effectiveDpi, shoulderFrac = null, shoulderSides: sides = null }) {
  const T = QUALITY_THRESHOLDS;
  const out = [];
  if (!faceCount) return [{ code: 'FACE_NOT_FOUND', level: 'error' }];
  if (faceCount > 1) out.push({ code: 'MULTIPLE_FACES', level: 'error', value: faceCount });
  const roll = Math.abs(evaluation ? evaluation.residualRollDeg : metrics.rollDeg);
  out.push({ code: 'ROLL', level: roll > T.rollErrorDeg ? 'error' : roll > T.rollWarnDeg ? 'warn' : 'ok', value: roll });
  out.push({ code: 'YAW', level: Math.abs(metrics.yaw) > T.yawWarn ? 'warn' : 'ok', value: metrics.yaw });
  if (evaluation && profile) {
    const hh = evaluation.headHeightMm;
    const r = profile.headHeight;
    out.push({ code: 'HEAD_SIZE', level: hh < r.min ? 'warn' : hh > r.max ? 'warn' : 'ok', value: hh, min: r.min, max: r.max, estimated: metrics.crownEstimated });
    if (profile.eyeFromBottom) {
      const e = evaluation.eyeFromBottomMm; const er = profile.eyeFromBottom;
      out.push({ code: 'EYE_LINE', level: e < er.min || e > er.max ? 'warn' : 'ok', value: e, min: er.min, max: er.max });
    }
    const off = Math.abs(evaluation.centreOffsetMm);
    out.push({ code: 'CENTRED', level: off > profile.widthMm * T.centreWarnFrac ? 'warn' : 'ok', value: evaluation.centreOffsetMm });
    const cut = evaluation.crownTopMm < 0 || evaluation.chinBottomMm < 0 || evaluation.faceLeftMm < 0 || evaluation.faceRightMm > profile.widthMm;
    out.push({ code: 'FACE_CROPPED', level: cut ? 'error' : 'ok' });
    if (!evaluation.insideImage) out.push({ code: 'FRAME_OUTSIDE', level: 'warn' });
    const top = evaluation.crownTopMm;
    const maxTop = profile.heightMm * T.topMarginMaxFrac;
    out.push({ code: 'TOP_MARGIN', level: top < T.topMarginMinMm || top > maxTop ? 'warn' : 'ok', value: top, min: T.topMarginMinMm, max: maxTop, estimated: metrics.crownEstimated });
  }
  if (stats) {
    out.push({ code: 'LIGHTING', level: stats.meanL < T.darkL || stats.meanL > T.brightL ? 'warn' : 'ok', value: stats.meanL, dark: stats.meanL < T.darkL });
    out.push({ code: 'LIGHT_BALANCE', level: Math.abs(stats.balance) > T.balanceWarn ? 'warn' : 'ok', value: stats.balance });
    out.push({ code: 'SHARPNESS', level: stats.sharpness < T.sharpnessWarn ? 'warn' : 'ok', value: stats.sharpness });
  }
  if (shoulderFrac != null) {
    out.push({ code: 'SHOULDERS', level: shoulderFrac < T.shoulderMinFrac ? 'warn' : 'ok', value: shoulderFrac });
  }
  if (sides && shoulderFrac != null) {
    out.push({ code: 'SHOULDER_SYMMETRY', level: Math.abs(sides.left - sides.right) > QUALITY_THRESHOLDS.shoulderSymmetryWarn ? 'warn' : 'ok', value: sides.left - sides.right });
  }
  if (effectiveDpi != null) {
    out.push({ code: 'RESOLUTION', level: effectiveDpi < T.dpiError ? 'error' : effectiveDpi < T.dpiWarn ? 'warn' : 'ok', value: effectiveDpi });
  }
  return out;
}

/**
 * Conservative automatic exposure for one-click presets. Corrects only faces
 * that the quality check itself flags as clearly too dark or too bright (the
 * same thresholds), so naturally darker or lighter skin is not "normalised".
 * Works in linear light; the result is an exposure-slider delta (100 = 2 EV).
 * @param {number|null|undefined} meanL face-region mean sRGB luma (0..1)
 * @returns {number} integer slider delta (0 = leave as is)
 */
export const AUTO_LIGHT = Object.freeze({ darkBelow: QUALITY_THRESHOLDS.darkL, darkTarget: 0.33, maxEv: 0.7, brightAbove: QUALITY_THRESHOLDS.brightL, brightTarget: 0.82, minEv: -0.5 });

const toLinear = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

/**
 * Gentle exposure toward the brightness of a well-lit personnel photo (studio quality reference:
 * face mean luma ≈ 0.66). Never more than +0.5 EV (so dark skin tones are not "whitened") and never
 * above the target; faces that are brighter than the target are left to autoExposureDelta.
 * @returns {number} integer slider delta (0 = leave as is)
 */
export const EXPOSURE_TARGET = Object.freeze({ meanL: 0.66, maxEv: 0.5, dead: 0.02 });
export function exposureTowardTarget(meanL) {
  if (!Number.isFinite(meanL) || meanL <= 0.005) return 0;
  const T = EXPOSURE_TARGET;
  if (meanL >= T.meanL - T.dead) return 0;
  const ev = Math.min(T.maxEv, Math.log2(toLinear(T.meanL) / toLinear(meanL)));
  return Math.round((ev / 2) * 100);
}

export function autoExposureDelta(meanL) {
  if (!Number.isFinite(meanL) || meanL <= 0.005 || meanL >= 0.995) return 0;
  const A = AUTO_LIGHT;
  let ev = 0;
  if (meanL < A.darkBelow) ev = Math.min(A.maxEv, Math.log2(toLinear(A.darkTarget) / toLinear(meanL)));
  else if (meanL > A.brightAbove) ev = Math.max(A.minEv, Math.log2(toLinear(A.brightTarget) / toLinear(meanL)));
  return Math.round((ev / 2) * 100);
}
