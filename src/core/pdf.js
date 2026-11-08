// Minimal, dependency-free PDF 1.4 writer with exact physical page sizes.
// Images are embedded once and placed many times with transformation matrices,
// so photos are never recompressed per copy. Coordinates are PDF points.

import { mmToPt } from './units.js';

const enc = new TextEncoder();

function utf16beHex(str) {
  let hex = 'FEFF';
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    const units = cp > 0xffff ? [0xd800 + ((cp - 0x10000) >> 10), 0xdc00 + ((cp - 0x10000) & 0x3ff)] : [cp];
    for (const u of units) hex += u.toString(16).padStart(4, '0').toUpperCase();
  }
  return `<${hex}>`;
}

/** Fixed-precision number for content streams (no exponent notation). */
export function n(v) {
  const r = Math.round(v * 10000) / 10000;
  return Object.is(r, -0) ? '0' : String(r);
}

function pdfDate(d = new Date()) {
  const p = (x) => String(x).padStart(2, '0');
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

/**
 * @param {object} doc
 * @param {string} [doc.title]
 * @param {Array<{widthPt:number,heightPt:number,content:string,images:string[]}>} doc.pages
 * @param {Record<string,{width:number,height:number,colorSpace:string,filter:string,data:Uint8Array,smask?:{width:number,height:number,filter:string,data:Uint8Array}}>} doc.images
 * @returns {Uint8Array}
 */
export function buildPdf(doc) {
  const chunks = [];
  let length = 0;
  const offsets = [];
  const push = (data) => {
    const bytes = typeof data === 'string' ? enc.encode(data) : data;
    chunks.push(bytes);
    length += bytes.length;
  };
  let nextId = 1;
  const alloc = () => nextId++;
  const writeObj = (id, body) => {
    offsets[id] = length;
    push(`${id} 0 obj\n`);
    if (typeof body === 'string') push(`${body}\nendobj\n`);
    else { body(); push('\nendobj\n'); }
  };
  const writeStream = (id, dict, data) => {
    writeObj(id, () => {
      push(`<< ${dict} /Length ${data.length} >>\nstream\n`);
      push(data);
      push('\nendstream');
    });
  };

  push('%PDF-1.4\n');
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // binary marker comment

  const catalogId = alloc();
  const pagesId = alloc();
  const infoId = alloc();

  const imageIds = {};
  for (const [name, img] of Object.entries(doc.images || {})) {
    const id = alloc();
    let smaskRef = '';
    if (img.smask) {
      const sid = alloc();
      writeStream(sid, `/Type /XObject /Subtype /Image /Width ${img.smask.width} /Height ${img.smask.height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /${img.smask.filter}`, img.smask.data);
      smaskRef = ` /SMask ${sid} 0 R`;
    }
    writeStream(id, `/Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} /ColorSpace /${img.colorSpace} /BitsPerComponent 8 /Filter /${img.filter}${smaskRef}`, img.data);
    imageIds[name] = id;
  }

  const pageIds = [];
  for (const page of doc.pages) {
    const contentId = alloc();
    const pageId = alloc();
    writeStream(contentId, '', enc.encode(page.content));
    const xo = (page.images || []).map((nm) => `/${nm} ${imageIds[nm]} 0 R`).join(' ');
    const box = `[0 0 ${n(page.widthPt)} ${n(page.heightPt)}]`;
    writeObj(pageId, `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox ${box} /CropBox ${box} /TrimBox ${box} /Resources << /ProcSet [/PDF /ImageB /ImageC] /XObject << ${xo} >> >> /Contents ${contentId} 0 R >>`);
    pageIds.push(pageId);
  }

  writeObj(pagesId, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`);
  // PrintScaling /None asks viewers to default to "Actual size" in the print dialog.
  writeObj(catalogId, `<< /Type /Catalog /Pages ${pagesId} 0 R /ViewerPreferences << /PrintScaling /None /PickTrayByPDFSize true >> >>`);
  const title = doc.title ? ` /Title ${utf16beHex(doc.title)}` : '';
  writeObj(infoId, `<< /Producer (Hoshmand Photo Studio) /Creator (Hoshmand Photo Studio)${title} /CreationDate (${pdfDate(doc.date)}) >>`);

  const xrefOffset = length;
  let xref = `xref\n0 ${nextId}\n0000000000 65535 f \n`;
  for (let id = 1; id < nextId; id += 1) xref += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  push(xref);
  push(`trailer\n<< /Size ${nextId} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  const out = new Uint8Array(length);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

/**
 * PDF image placement matrix for a photo occupying rect (mm, top-left origin)
 * on a sheet of height Hmm. rotation 90 = photo top points to the right.
 */
export function imageMatrix(rect, sheetHeightMm, rotation = 0) {
  const X0 = mmToPt(rect.x);
  const Wp = mmToPt(rect.w);
  const Hp = mmToPt(rect.h);
  const Y0 = mmToPt(sheetHeightMm - rect.y - rect.h);
  if (rotation === 90) return [0, -Hp, Wp, 0, X0, Y0 + Hp];
  return [Wp, 0, 0, Hp, X0, Y0];
}

/** Matrix that applies printer calibration (scale about centre + offset in mm). */
export function calibrationMatrix(sheetWmm, sheetHmm, cal) {
  if (!cal) return null;
  const sx = cal.scaleX ?? 1; const sy = cal.scaleY ?? 1;
  const ox = cal.offsetXmm ?? 0; const oy = cal.offsetYmm ?? 0;
  if (sx === 1 && sy === 1 && ox === 0 && oy === 0) return null;
  const cx = mmToPt(sheetWmm / 2); const cy = mmToPt(sheetHmm / 2);
  return [sx, 0, 0, sy, cx - sx * cx + mmToPt(ox), cy - sy * cy - mmToPt(oy)];
}

/**
 * Convert a computed layout into PDF pages.
 * @param {object} layout result of computeLayout
 * @param {{imageName:(itemId:string)=>string, marks?:(page)=>{under:Array,over:Array}, labelImage?:(placement)=>string|null, calibration?:object}} ctx
 */
export function layoutToPdfPages(layout, ctx) {
  const W = layout.sheet.widthMm; const H = layout.sheet.heightMm;
  const yPt = (mm) => mmToPt(H - mm);
  const cal = calibrationMatrix(W, H, ctx.calibration);
  return layout.pages.map((page) => {
    const ops = [];
    const used = new Set();
    if (cal) ops.push(`${cal.map(n).join(' ')} cm`);
    const marks = ctx.marks ? ctx.marks(page) : { under: [], over: [] };
    const line = (seg, width, gray) => {
      ops.push(`q ${n(gray)} G ${n(mmToPt(width))} w ${n(mmToPt(seg.x1))} ${n(yPt(seg.y1))} m ${n(mmToPt(seg.x2))} ${n(yPt(seg.y2))} l S Q`);
    };
    for (const seg of marks.under) line(seg, seg.kind === 'cut' ? 0.1 : 0.15, seg.kind === 'cut' ? 0.6 : 0);
    for (const pl of page.placements) {
      const name = ctx.imageName(pl.itemId);
      used.add(name);
      ops.push(`q ${imageMatrix(pl.photo, H, pl.rotation).map(n).join(' ')} cm /${name} Do Q`);
      if (pl.label && ctx.labelImage) {
        const ln = ctx.labelImage(pl);
        if (ln) {
          used.add(ln);
          ops.push(`q ${imageMatrix(pl.label, H, 0).map(n).join(' ')} cm /${ln} Do Q`);
        }
      }
    }
    for (const o of marks.over) {
      const bw = 0.1;
      const r = o.rect;
      ops.push(`q 0.25 G ${n(mmToPt(bw))} w ${n(mmToPt(r.x + bw / 2))} ${n(yPt(r.y + r.h - bw / 2))} ${n(mmToPt(r.w - bw))} ${n(mmToPt(r.h - bw))} re S Q`);
    }
    return { widthPt: mmToPt(W), heightPt: mmToPt(H), content: ops.join('\n'), images: [...used] };
  });
}
