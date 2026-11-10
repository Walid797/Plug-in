// Fitting a clothing template (suit with collar) to a person: the collar opening is sized to the person's own neck
// and placed at the base of the neck, centred on the neck (the body), not just under the face. Pure functions.

/**
 * Geometry of a collar template as fractions of its width (x) and height (y):
 * tipsY = top of the collar at the sides of the neck (the template's anchor), opening = width of the neck opening
 * there, knotY = where the collar closes (top of the tie knot / first button).
 */
export const DIPLOMAT_GEOMETRY = Object.freeze({ tipsY: 440 / 1024, opening: 269 / 768, knotY: 578 / 1024 });

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const median = (a) => { const s = a.slice().sort((p, q) => p - q); return s.length ? s[(s.length - 1) >> 1] : NaN; };

/**
 * Measure the neck below the chin on a skin map (bytes, mw×mh, covering the whole photo).
 * Works in the face's own axes: u across the face, v down from the eye line (photo pixels).
 * @param {{eyeMid:{x:number,y:number}, rollDeg:number, faceWidth:number, chinV:number, faceCenterU:number}} m face metrics
 * @returns {{width:number, centerU:number, bottomV:number, rows:number}|null} neck width, its centre and the lowest row with neck skin
 */
export function measureNeck(skin, mw, mh, photoW, photoH, m) {
  const r = (m.rollDeg * Math.PI) / 180; const cos = Math.cos(r); const sin = Math.sin(r);
  const fw = m.faceWidth;
  const at = (u, v) => {
    const x = ((m.eyeMid.x + u * cos - v * sin) / photoW) * mw; const y = ((m.eyeMid.y + u * sin + v * cos) / photoH) * mh;
    const ix = Math.round(x - 0.5); const iy = Math.round(y - 0.5);
    return ix >= 0 && iy >= 0 && ix < mw && iy < mh ? skin[iy * mw + ix] : 0;
  };
  const step = fw / 60; const rows = [];
  for (let v = m.chinV + 0.05 * fw; v <= m.chinV + 1.1 * fw; v += fw / 40) {
    // the skin run that crosses the midline under the face (or the nearest one within 0.2 face widths)
    let c = null;
    for (const d of [0, 0.07, -0.07, 0.14, -0.14, 0.2, -0.2]) if (at(m.faceCenterU + d * fw, v) >= 128) { c = m.faceCenterU + d * fw; break; }
    if (c == null) { rows.push({ v, width: 0, center: m.faceCenterU }); continue; }
    let a = c; let b = c;
    while (a > m.faceCenterU - 1.2 * fw && at(a - step, v) >= 128) a -= step;
    while (b < m.faceCenterU + 1.2 * fw && at(b + step, v) >= 128) b += step;
    rows.push({ v, width: b - a, center: (a + b) / 2 });
  }
  const neck = rows.filter((q) => q.v >= m.chinV + 0.08 * fw && q.v <= m.chinV + 0.34 * fw && q.width >= 0.35 * fw && q.width <= 1.25 * fw);
  if (neck.length < 3) return null;
  const width = median(neck.map((q) => q.width)); const centerU = median(neck.map((q) => q.center));
  let bottomV = neck[neck.length - 1].v;
  for (const q of rows) { if (q.v <= bottomV) continue; if (q.width >= 0.45 * width) bottomV = q.v; else break; }
  return { width, centerU, bottomV, rows: neck.length };
}

/**
 * Place a collar template on a face.
 * @param {object} m face metrics (photo pixels) @param {number} photoW @param {number} photoH
 * @param {{tipsY:number, opening:number, knotY:number}} geo template geometry @param {number} aspect template width / height
 * @param {{width:number, centerU:number, bottomV:number}|null} neck from measureNeck, or null (proportions of the face are used)
 * @returns {{x:number, y:number, width:number, rotation:number, source:string, neckWidth:number, tipsV:number, knotV:number}} overlay values (x, y, width normalised to the photo; the anchor is the collar tips line)
 */
export function fitCollar(m, photoW, photoH, geo, aspect, neck = null) {
  const fw = m.faceWidth;
  const neckW = neck ? clamp(neck.width, 0.55 * fw, 1.05 * fw) : 0.8 * fw;
  // the opening is a little wider than the neck, so the collar sits around it instead of cutting into it
  const widthPx = clamp((neckW * 1.1) / geo.opening, 2.05 * fw, 2.95 * fw);
  const knotDepth = (geo.knotY - geo.tipsY) * (widthPx / aspect);
  // collar tips a little below the chin line; raised when the visible neck is short, so the opening still shows skin
  let tipsV = m.chinV + 0.16 * fw;
  if (neck && neck.bottomV < tipsV + knotDepth - 0.06 * fw) tipsV = Math.max(m.chinV + 0.05 * fw, neck.bottomV - knotDepth + 0.06 * fw);
  // centred on the neck (the body) more than on the face: a head turned or leaning to one side keeps its collar under the neck
  const centerU = neck ? m.faceCenterU + clamp(neck.centerU - m.faceCenterU, -0.25 * fw, 0.25 * fw) * 0.75 : m.faceCenterU;
  const r = (m.rollDeg * Math.PI) / 180; const cos = Math.cos(r); const sin = Math.sin(r);
  const x = m.eyeMid.x + centerU * cos - tipsV * sin; const y = m.eyeMid.y + centerU * sin + tipsV * cos;
  return { x: x / photoW, y: y / photoH, width: widthPx / photoW, rotation: m.rollDeg, source: neck ? 'neck' : 'proportion', neckWidth: neckW, tipsV, knotV: tipsV + knotDepth };
}
