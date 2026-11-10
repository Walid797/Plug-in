// Non-destructive crop geometry.
//
// A crop is stored resolution-independently:
//   cx, cy   – frame centre as a fraction of source width / height
//   cw       – frame width as a fraction of source width
//   rotation – frame rotation in degrees (positive = clockwise on screen)
// The frame aspect ratio always equals the target photo aspect (w/h), so the
// output is a uniform scale of the source — it can never be stretched.

const DEG = Math.PI / 180;

export function defaultCrop(srcW, srcH, aspect) {
  // Largest centred frame fully inside the image.
  const cwPx = Math.min(srcW, srcH * aspect);
  return { cx: 0.5, cy: 0.5, cw: cwPx / srcW, rotation: 0 };
}

export function cropToPixels(crop, srcW, srcH, aspect) {
  const cw = crop.cw * srcW;
  return { cx: crop.cx * srcW, cy: crop.cy * srcH, cw, ch: cw / aspect, angle: (crop.rotation || 0) * DEG };
}

export function pixelsToCrop(px, srcW, srcH) {
  return { cx: px.cx / srcW, cy: px.cy / srcH, cw: px.cw / srcW, rotation: px.angle / DEG };
}

/**
 * Affine matrix [a,b,c,d,e,f] mapping SOURCE pixels → OUTPUT pixels
 * (canvas setTransform order). M = T(out/2) · S(outW/cw) · R(-θ) · T(-c).
 */
export function cropMatrix(crop, srcW, srcH, outW, outH) {
  const aspect = outW / outH;
  const p = cropToPixels(crop, srcW, srcH, aspect);
  const s = outW / p.cw;
  const cos = Math.cos(-p.angle) * s;
  const sin = Math.sin(-p.angle) * s;
  // x' = cos*x - sin*y + e ; y' = sin*x + cos*y + f
  const e = outW / 2 - (cos * p.cx - sin * p.cy);
  const f = outH / 2 - (sin * p.cx + cos * p.cy);
  return [cos, sin, -sin, cos, e, f];
}

export function applyMatrix(m, x, y) {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

export function invertMatrix(m) {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-12) return null;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

export function multiplyMatrix(m1, m2) {
  // m1 · m2 (apply m2 first, then m1)
  return [
    m1[0] * m2[0] + m1[2] * m2[1], m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3], m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4], m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

/** Frame corners in source pixel space (TL, TR, BR, BL of the output). */
export function frameCorners(crop, srcW, srcH, aspect) {
  const p = cropToPixels(crop, srcW, srcH, aspect);
  const hw = p.cw / 2; const hh = p.ch / 2;
  const cos = Math.cos(p.angle); const sin = Math.sin(p.angle);
  return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => ({
    x: p.cx + x * cos - y * sin,
    y: p.cy + x * sin + y * cos,
  }));
}

/** Axis-aligned half extents of the rotated frame. */
function extents(p) {
  const c = Math.abs(Math.cos(p.angle)); const s = Math.abs(Math.sin(p.angle));
  return { ex: (p.cw / 2) * c + (p.ch / 2) * s, ey: (p.cw / 2) * s + (p.ch / 2) * c };
}

export function isFrameInside(crop, srcW, srcH, aspect, tol = 0.5) {
  const p = cropToPixels(crop, srcW, srcH, aspect);
  const { ex, ey } = extents(p);
  return p.cx - ex >= -tol && p.cx + ex <= srcW + tol && p.cy - ey >= -tol && p.cy + ey <= srcH + tol;
}

/** Largest frame width (px) that fits inside the image at the given rotation. */
export function maxFrameWidth(srcW, srcH, aspect, rotationDeg) {
  const a = rotationDeg * DEG;
  const c = Math.abs(Math.cos(a)); const s = Math.abs(Math.sin(a));
  return Math.min(srcW / (c + s / aspect), srcH / (s + c / aspect));
}

/** Shrink/move the frame so that it lies completely inside the image. */
export function constrainCrop(crop, srcW, srcH, aspect) {
  const p = cropToPixels(crop, srcW, srcH, aspect);
  const maxW = maxFrameWidth(srcW, srcH, aspect, crop.rotation || 0);
  p.cw = Math.min(p.cw, maxW);
  p.ch = p.cw / aspect;
  const { ex, ey } = extents(p);
  p.cx = Math.min(Math.max(p.cx, ex), srcW - ex);
  p.cy = Math.min(Math.max(p.cy, ey), srcH - ey);
  return pixelsToCrop(p, srcW, srcH);
}

/**
 * For a photo whose background is replaced by a plain colour: the frame keeps its size (so the head keeps the size the
 * rule asks for) and may reach beyond the picture at the top and the sides — there is only background there, and it is
 * painted in the background colour. Only the lower edge has to stay inside (a body cannot be invented): the frame is
 * moved up until it does.
 */
export function constrainCropBottom(crop, srcW, srcH, aspect) {
  const p = cropToPixels(crop, srcW, srcH, aspect);
  const { ey } = extents(p);
  if (p.cy + ey > srcH) p.cy = srcH - ey;
  return pixelsToCrop(p, srcW, srcH);
}

/** Pan by a delta measured in OUTPUT pixels (screen drag) for an output width. */
export function panCrop(crop, dxOut, dyOut, srcW, srcH, outW) {
  const p = cropToPixels(crop, srcW, srcH, 1);
  const k = p.cw / outW;
  const cos = Math.cos(p.angle); const sin = Math.sin(p.angle);
  // dragging the image right moves the frame left in source space
  const dx = -(dxOut * cos - dyOut * sin) * k;
  const dy = -(dxOut * sin + dyOut * cos) * k;
  return { ...crop, cx: crop.cx + dx / srcW, cy: crop.cy + dy / srcH };
}

/** Zoom by factor (>1 = zoom in = smaller frame), keeping a source point fixed. */
export function zoomCrop(crop, factor, srcW, srcH, anchor = null) {
  const cw = crop.cw / factor;
  if (!anchor) return { ...crop, cw };
  const cx = anchor.x / srcW + (crop.cx - anchor.x / srcW) / factor;
  const cy = anchor.y / srcH + (crop.cy - anchor.y / srcH) / factor;
  return { ...crop, cx, cy, cw };
}

/** Source-pixel → output-pixel ratio. Below 1 means the photo is upscaled. */
export function sourcePixelsPerOutputPixel(crop, srcW, outW) {
  return (crop.cw * srcW) / outW;
}
