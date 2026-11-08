// Built-in clothing templates (original vector artwork, not AI). They are
// composited over the photo and positioned relative to the chin/neck.
// Geometry: 1000 × 760 units; anchor = neck centre at (500, 70).
import { getBlob } from '../storage/db.js';
import { decodeImage, makeCanvas } from '../platform/image.js';

const W = 1000; const H = 760;
export const TEMPLATE_META = { aspect: W / H, anchorX: 0.5, anchorY: 70 / H };

function shade(hex, amt) {
  const v = parseInt(hex.slice(1), 16);
  const c = (s) => Math.max(0, Math.min(255, Math.round(((v >> s) & 255) * (1 + amt))));
  return `#${[16, 8, 0].map((s) => c(s).toString(16).padStart(2, '0')).join('')}`;
}

function suitSvg({ color = '#1d2638', tie = '#7a1f2b', shirt = '#f4f6f9' }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">
<defs>
<linearGradient id="j" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${shade(color, 0.12)}"/><stop offset="1" stop-color="${shade(color, -0.25)}"/></linearGradient>
<linearGradient id="l" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${shade(color, 0.28)}"/><stop offset="1" stop-color="${shade(color, 0.02)}"/></linearGradient>
<linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${shirt}"/><stop offset="1" stop-color="${shade(shirt, -0.1)}"/></linearGradient>
<linearGradient id="t" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${shade(tie, -0.15)}"/><stop offset=".5" stop-color="${shade(tie, 0.15)}"/><stop offset="1" stop-color="${shade(tie, -0.15)}"/></linearGradient>
</defs>
<path d="M392 52 Q500 120 608 52 L660 110 L500 640 L340 110 Z" fill="url(#s)"/>
<path d="M392 52 Q440 92 500 104 L452 214 L380 96 Z" fill="${shade(shirt, -0.04)}" stroke="${shade(shirt, -0.2)}" stroke-width="3"/>
<path d="M608 52 Q560 92 500 104 L548 214 L620 96 Z" fill="${shade(shirt, -0.04)}" stroke="${shade(shirt, -0.2)}" stroke-width="3"/>
<path d="M470 108 L530 108 L522 168 L478 168 Z" fill="url(#t)"/>
<path d="M478 166 L522 166 L540 486 L500 552 L460 486 Z" fill="url(#t)"/>
<path d="M0 760 L0 318 C0 228 62 184 176 160 L398 84 L500 600 L602 84 L824 160 C938 184 1000 228 1000 318 L1000 760 Z" fill="url(#j)"/>
<path d="M398 84 L500 600 L436 352 L338 262 L392 184 L364 150 Z" fill="url(#l)"/>
<path d="M602 84 L500 600 L564 352 L662 262 L608 184 L636 150 Z" fill="url(#l)"/>
<path d="M500 600 L500 760" stroke="${shade(color, -0.4)}" stroke-width="4"/>
<circle cx="520" cy="650" r="11" fill="${shade(color, -0.45)}"/><circle cx="520" cy="726" r="11" fill="${shade(color, -0.45)}"/>
<path d="M120 520 L260 520" stroke="${shade(color, -0.35)}" stroke-width="4" opacity=".6"/><path d="M740 520 L880 520" stroke="${shade(color, -0.35)}" stroke-width="4" opacity=".6"/>
</svg>`;
}

function shirtTieSvg({ color = '#eef2f7', tie = '#1f3a6b' }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">
<defs>
<linearGradient id="b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${shade(color, 0.03)}"/><stop offset="1" stop-color="${shade(color, -0.14)}"/></linearGradient>
<linearGradient id="t" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${shade(tie, -0.15)}"/><stop offset=".5" stop-color="${shade(tie, 0.18)}"/><stop offset="1" stop-color="${shade(tie, -0.15)}"/></linearGradient>
</defs>
<path d="M0 760 L0 320 C0 232 70 186 190 160 L392 64 Q500 122 608 64 L810 160 C930 186 1000 232 1000 320 L1000 760 Z" fill="url(#b)"/>
<path d="M392 52 Q440 96 500 108 L446 224 L372 100 Z" fill="${shade(color, 0.05)}" stroke="${shade(color, -0.25)}" stroke-width="3"/>
<path d="M608 52 Q560 96 500 108 L554 224 L628 100 Z" fill="${shade(color, 0.05)}" stroke="${shade(color, -0.25)}" stroke-width="3"/>
<path d="M470 112 L530 112 L522 172 L478 172 Z" fill="url(#t)"/>
<path d="M478 170 L522 170 L542 500 L500 566 L458 500 Z" fill="url(#t)"/>
<path d="M500 230 L500 760" stroke="${shade(color, -0.2)}" stroke-width="3"/>
<circle cx="500" cy="600" r="7" fill="${shade(color, -0.25)}"/><circle cx="500" cy="690" r="7" fill="${shade(color, -0.25)}"/>
<path d="M210 600 Q260 640 300 760" stroke="${shade(color, -0.12)}" stroke-width="4" fill="none" opacity=".7"/>
<path d="M790 600 Q740 640 700 760" stroke="${shade(color, -0.12)}" stroke-width="4" fill="none" opacity=".7"/>
</svg>`;
}

function uniformSvg({ color = '#25324a', collar = '#f2f4f7' }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">
<defs><linearGradient id="b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${shade(color, 0.12)}"/><stop offset="1" stop-color="${shade(color, -0.22)}"/></linearGradient></defs>
<path d="M0 760 L0 320 C0 232 70 186 190 160 L392 64 Q500 130 608 64 L810 160 C930 186 1000 232 1000 320 L1000 760 Z" fill="url(#b)"/>
<path d="M386 56 Q500 150 614 56 L652 96 Q500 230 348 96 Z" fill="${collar}" stroke="${shade(collar, -0.25)}" stroke-width="3"/>
<path d="M500 180 L500 760" stroke="${shade(color, -0.35)}" stroke-width="4"/>
<circle cx="520" cy="300" r="9" fill="${shade(color, -0.4)}"/><circle cx="520" cy="420" r="9" fill="${shade(color, -0.4)}"/><circle cx="520" cy="540" r="9" fill="${shade(color, -0.4)}"/>
<path d="M230 430 L330 430 L330 520 L230 520 Z" fill="none" stroke="${shade(color, -0.3)}" stroke-width="4" opacity=".7"/>
</svg>`;
}

export const BUILTIN_TEMPLATES = [
  { id: 'suit', nameFa: 'کت‌وشلوار رسمی با پیراهن و نکتایی', defaultColor: '#1d2638', colors: ['#1d2638', '#111214', '#3a3f47', '#2c3e2f'], svg: suitSvg },
  { id: 'office', nameFa: 'لباس اداری (پیراهن روشن و نکتایی)', defaultColor: '#eef2f7', colors: ['#eef2f7', '#dbe8f6', '#f3efe6', '#ffffff'], svg: shirtTieSvg },
  { id: 'uniform', nameFa: 'یونیفورم ساده (پیراهن تیره با یخن)', defaultColor: '#25324a', colors: ['#25324a', '#1b1b1f', '#2f4a3a', '#4a2f2f'], svg: uniformSvg },
];

async function rasteriseSvg(svgText, widthPx = 1500) {
  const blob = new Blob([svgText], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const c = makeCanvas(widthPx, Math.round(widthPx / TEMPLATE_META.aspect));
    const cx = c.getContext('2d');
    cx.imageSmoothingQuality = 'high';
    cx.drawImage(img, 0, 0, c.width, c.height);
    return c;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** id format: "builtin:<id>:<color>" or "user:<key>" */
export async function getTemplate(id) {
  if (id.startsWith('builtin:')) {
    const [, tid, color] = id.split(':');
    const t = BUILTIN_TEMPLATES.find((x) => x.id === tid);
    if (!t) return null;
    const image = await rasteriseSvg(t.svg({ color: color || t.defaultColor }));
    return { image, meta: TEMPLATE_META };
  }
  if (id.startsWith('user:')) {
    const blob = await getBlob(id).catch(() => null);
    if (!blob) return null;
    const dec = await decodeImage(blob, { maxPixels: 6_000_000 });
    return { image: dec.image, meta: { aspect: dec.width / dec.height, anchorX: 0.5, anchorY: 0.09 } };
  }
  return null;
}

export function templatePreviewSvg(tid, color) {
  const t = BUILTIN_TEMPLATES.find((x) => x.id === tid);
  return t ? t.svg({ color: color || t.defaultColor }) : '';
}
