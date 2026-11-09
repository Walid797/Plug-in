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
<radialGradient id="neckShadow" cx="50%" cy="10%" r="65%">
  <stop offset="0%" stop-color="#000000" stop-opacity="0.45"/>
  <stop offset="55%" stop-color="#000000" stop-opacity="0.18"/>
  <stop offset="100%" stop-color="#000000" stop-opacity="0"/>
</radialGradient>
<linearGradient id="j" x1="0" y1="0" x2="0" y2="1">
  <stop offset="0" stop-color="${shade(color, 0.16)}"/>
  <stop offset="0.4" stop-color="${color}"/>
  <stop offset="1" stop-color="${shade(color, -0.32)}"/>
</linearGradient>
<linearGradient id="lLeft" x1="0" y1="0" x2="1" y2="1">
  <stop offset="0" stop-color="${shade(color, 0.35)}"/>
  <stop offset="0.7" stop-color="${shade(color, 0.08)}"/>
  <stop offset="1" stop-color="${shade(color, -0.15)}"/>
</linearGradient>
<linearGradient id="lRight" x1="1" y1="0" x2="0" y2="1">
  <stop offset="0" stop-color="${shade(color, 0.22)}"/>
  <stop offset="0.7" stop-color="${shade(color, 0.02)}"/>
  <stop offset="1" stop-color="${shade(color, -0.20)}"/>
</linearGradient>
<linearGradient id="s" x1="0" y1="0" x2="0" y2="1">
  <stop offset="0" stop-color="#ffffff"/>
  <stop offset="0.6" stop-color="${shirt}"/>
  <stop offset="1" stop-color="${shade(shirt, -0.16)}"/>
</linearGradient>
<linearGradient id="sCollar" x1="0" y1="0" x2="0" y2="1">
  <stop offset="0" stop-color="#ffffff"/>
  <stop offset="1" stop-color="${shade(shirt, -0.08)}"/>
</linearGradient>
<linearGradient id="t" x1="0" y1="0" x2="1" y2="0">
  <stop offset="0" stop-color="${shade(tie, -0.22)}"/>
  <stop offset="0.35" stop-color="${shade(tie, 0.22)}"/>
  <stop offset="0.7" stop-color="${shade(tie, 0.05)}"/>
  <stop offset="1" stop-color="${shade(tie, -0.28)}"/>
</linearGradient>
<filter id="lapelShadow" x="-10%" y="-10%" width="120%" height="120%">
  <feDropShadow dx="2" dy="5" stdDeviation="4" flood-color="#000000" flood-opacity="0.35"/>
</filter>
</defs>
<!-- Collar ambient drop-shadow onto neck/throat -->
<ellipse cx="500" cy="74" rx="145" ry="36" fill="url(#neckShadow)"/>

<!-- Shirt chest -->
<path d="M386 50 Q500 120 614 50 L660 110 L500 640 L340 110 Z" fill="url(#s)"/>

<!-- Silk Tie Under Collar -->
<path d="M472 108 Q500 114 528 108 L524 168 Q500 174 476 168 Z" fill="url(#t)"/>
<path d="M476 168 L524 168 L544 490 L500 556 L456 490 Z" fill="url(#t)"/>
<!-- Tie knot shadow dimple -->
<ellipse cx="500" cy="154" rx="8" ry="12" fill="#000000" opacity="0.28"/>

<!-- Shirt Collar Left & Right (Crisp tailored spread collar) -->
<path d="M388 50 Q440 92 498 106 L448 214 L378 96 Z" fill="url(#sCollar)" stroke="${shade(shirt, -0.25)}" stroke-width="2.5"/>
<path d="M612 50 Q560 92 502 106 L552 214 L622 96 Z" fill="url(#sCollar)" stroke="${shade(shirt, -0.25)}" stroke-width="2.5"/>
<!-- Inner collar shadow -->
<path d="M492 104 L500 108 L508 104" stroke="${shade(shirt, -0.4)}" stroke-width="2" fill="none"/>

<!-- Main Suit Jacket Canvas & Shoulders -->
<path d="M0 760 L0 318 C0 228 62 184 176 160 L398 84 L500 600 L602 84 L824 160 C938 184 1000 228 1000 318 L1000 760 Z" fill="url(#j)"/>

<!-- Shoulder Seams & Armhole Depth -->
<path d="M176 160 C120 220 100 280 90 380" stroke="${shade(color, -0.35)}" stroke-width="2.5" fill="none" opacity="0.4"/>
<path d="M824 160 C880 220 900 280 910 380" stroke="${shade(color, -0.35)}" stroke-width="2.5" fill="none" opacity="0.4"/>

<!-- Left Suit Lapel (Notched) with soft 3D shadow -->
<g filter="url(#lapelShadow)">
  <path d="M398 84 L500 600 L436 352 L338 262 L392 184 L364 150 Z" fill="url(#lLeft)"/>
  <!-- Lapel edge pick-stitch -->
  <path d="M394 86 L494 594 L434 352 L342 264 L390 188 L368 152 Z" stroke="${shade(color, 0.45)}" stroke-width="1.2" stroke-dasharray="3,3" fill="none" opacity="0.6"/>
</g>

<!-- Right Suit Lapel (Notched) with soft 3D shadow -->
<g filter="url(#lapelShadow)">
  <path d="M602 84 L500 600 L564 352 L662 262 L608 184 L636 150 Z" fill="url(#lRight)"/>
  <!-- Lapel edge pick-stitch -->
  <path d="M606 86 L506 594 L566 352 L658 264 L610 188 L632 152 Z" stroke="${shade(color, 0.45)}" stroke-width="1.2" stroke-dasharray="3,3" fill="none" opacity="0.6"/>
</g>

<!-- Breast Pocket Welt & Folded Silk Pocket Square -->
<path d="M250 360 L330 342 L332 358 L252 376 Z" fill="${shade(color, -0.15)}" stroke="${shade(color, -0.4)}" stroke-width="1.5"/>
<path d="M268 356 L284 330 L302 348 L314 334 L322 344 Z" fill="#ffffff" stroke="#dde2ea" stroke-width="1.2"/>

<!-- Center Seam & Tailored Horn Buttons -->
<path d="M500 600 L500 760" stroke="${shade(color, -0.5)}" stroke-width="4"/>
<circle cx="518" cy="650" r="10" fill="${shade(color, -0.55)}" stroke="${shade(color, -0.2)}" stroke-width="1.5"/>
<circle cx="518" cy="650" r="5" fill="${shade(color, -0.3)}"/>
<circle cx="518" cy="726" r="10" fill="${shade(color, -0.55)}" stroke="${shade(color, -0.2)}" stroke-width="1.5"/>
<circle cx="518" cy="726" r="5" fill="${shade(color, -0.3)}"/>

<!-- Side waist seam pockets hint -->
<path d="M120 530 L250 530" stroke="${shade(color, -0.35)}" stroke-width="3" opacity=".5"/>
<path d="M750 530 L880 530" stroke="${shade(color, -0.35)}" stroke-width="3" opacity=".5"/>
</svg>`;
}

function shirtTieSvg({ color = '#eef2f7', tie = '#1f3a6b' }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">
<defs>
<radialGradient id="shirtNeckShadow" cx="50%" cy="10%" r="65%">
  <stop offset="0%" stop-color="#000000" stop-opacity="0.40"/>
  <stop offset="60%" stop-color="#000000" stop-opacity="0.15"/>
  <stop offset="100%" stop-color="#000000" stop-opacity="0"/>
</radialGradient>
<linearGradient id="b" x1="0" y1="0" x2="0" y2="1">
  <stop offset="0" stop-color="${shade(color, 0.06)}"/>
  <stop offset="0.5" stop-color="${color}"/>
  <stop offset="1" stop-color="${shade(color, -0.16)}"/>
</linearGradient>
<linearGradient id="t" x1="0" y1="0" x2="1" y2="0">
  <stop offset="0" stop-color="${shade(tie, -0.22)}"/>
  <stop offset="0.35" stop-color="${shade(tie, 0.22)}"/>
  <stop offset="0.7" stop-color="${shade(tie, 0.05)}"/>
  <stop offset="1" stop-color="${shade(tie, -0.25)}"/>
</linearGradient>
<filter id="collarShadow" x="-10%" y="-10%" width="120%" height="120%">
  <feDropShadow dx="1" dy="4" stdDeviation="3.5" flood-color="#000000" flood-opacity="0.25"/>
</filter>
</defs>
<!-- Collar ambient drop shadow onto neck -->
<ellipse cx="500" cy="74" rx="140" ry="34" fill="url(#shirtNeckShadow)"/>

<!-- Main Shirt Body -->
<path d="M0 760 L0 320 C0 232 70 186 190 160 L392 64 Q500 122 608 64 L810 160 C930 186 1000 232 1000 320 L1000 760 Z" fill="url(#b)"/>

<!-- Shoulder seams -->
<path d="M190 160 L392 64" stroke="${shade(color, -0.25)}" stroke-width="2" stroke-dasharray="3,3" opacity="0.6"/>
<path d="M810 160 L608 64" stroke="${shade(color, -0.25)}" stroke-width="2" stroke-dasharray="3,3" opacity="0.6"/>

<!-- Silk Tie Under Collar -->
<path d="M472 112 Q500 118 528 112 L524 172 Q500 178 476 172 Z" fill="url(#t)"/>
<path d="M476 170 L524 170 L542 500 L500 566 L458 500 Z" fill="url(#t)"/>
<ellipse cx="500" cy="158" rx="7" ry="10" fill="#000000" opacity="0.25"/>

<!-- Stiff Shirt Collar Left & Right -->
<g filter="url(#collarShadow)">
  <path d="M392 52 Q440 96 500 108 L446 224 L372 100 Z" fill="${shade(color, 0.08)}" stroke="${shade(color, -0.3)}" stroke-width="2.5"/>
  <path d="M608 52 Q560 96 500 108 L554 224 L628 100 Z" fill="${shade(color, 0.08)}" stroke="${shade(color, -0.3)}" stroke-width="2.5"/>
</g>

<!-- Front Placket & Mother-of-Pearl Buttons -->
<rect x="488" y="220" width="24" height="540" fill="${shade(color, -0.04)}" stroke="${shade(color, -0.18)}" stroke-width="1.5"/>
<circle cx="500" cy="270" r="6" fill="#f8fafc" stroke="#cbd5e1" stroke-width="1.5"/>
<circle cx="500" cy="370" r="6" fill="#f8fafc" stroke="#cbd5e1" stroke-width="1.5"/>
<circle cx="500" cy="470" r="6" fill="#f8fafc" stroke="#cbd5e1" stroke-width="1.5"/>
<circle cx="500" cy="570" r="6" fill="#f8fafc" stroke="#cbd5e1" stroke-width="1.5"/>
<circle cx="500" cy="670" r="6" fill="#f8fafc" stroke="#cbd5e1" stroke-width="1.5"/>

<!-- Subtle Fabric Folds -->
<path d="M210 600 Q260 640 300 760" stroke="${shade(color, -0.14)}" stroke-width="3" fill="none" opacity=".6"/>
<path d="M790 600 Q740 640 700 760" stroke="${shade(color, -0.14)}" stroke-width="3" fill="none" opacity=".6"/>
</svg>`;
}

function uniformSvg({ color = '#25324a', collar = '#f2f4f7' }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">
<defs>
<radialGradient id="uniNeckShadow" cx="50%" cy="10%" r="65%">
  <stop offset="0%" stop-color="#000000" stop-opacity="0.45"/>
  <stop offset="60%" stop-color="#000000" stop-opacity="0.18"/>
  <stop offset="100%" stop-color="#000000" stop-opacity="0"/>
</radialGradient>
<linearGradient id="b" x1="0" y1="0" x2="0" y2="1">
  <stop offset="0" stop-color="${shade(color, 0.16)}"/>
  <stop offset="0.4" stop-color="${color}"/>
  <stop offset="1" stop-color="${shade(color, -0.28)}"/>
</linearGradient>
</defs>
<!-- Collar ambient drop shadow onto neck -->
<ellipse cx="500" cy="74" rx="142" ry="34" fill="url(#uniNeckShadow)"/>

<!-- Uniform Jacket Body -->
<path d="M0 760 L0 320 C0 232 70 186 190 160 L392 64 Q500 130 608 64 L810 160 C930 186 1000 232 1000 320 L1000 760 Z" fill="url(#b)"/>

<!-- Mandarin / Diplomat Collar -->
<path d="M386 56 Q500 146 614 56 L652 96 Q500 220 348 96 Z" fill="${collar}" stroke="${shade(collar, -0.3)}" stroke-width="3"/>
<!-- Inner collar lining -->
<path d="M394 62 Q500 140 606 62" stroke="${shade(collar, -0.45)}" stroke-width="2" fill="none"/>

<!-- Center closure & polished brass/metallic buttons -->
<path d="M500 180 L500 760" stroke="${shade(color, -0.45)}" stroke-width="3"/>
<circle cx="516" cy="270" r="8" fill="#d4af37" stroke="#996515" stroke-width="1.5"/>
<circle cx="516" cy="380" r="8" fill="#d4af37" stroke="#996515" stroke-width="1.5"/>
<circle cx="516" cy="490" r="8" fill="#d4af37" stroke="#996515" stroke-width="1.5"/>
<circle cx="516" cy="600" r="8" fill="#d4af37" stroke="#996515" stroke-width="1.5"/>
<circle cx="516" cy="710" r="8" fill="#d4af37" stroke="#996515" stroke-width="1.5"/>

<!-- Breast pockets with flaps -->
<path d="M220 400 L340 400 L340 500 L220 500 Z" fill="${shade(color, -0.06)}" stroke="${shade(color, -0.35)}" stroke-width="2.5" opacity=".85"/>
<path d="M214 394 L280 424 L346 394 Z" fill="${shade(color, 0.08)}" stroke="${shade(color, -0.4)}" stroke-width="2"/>
<circle cx="280" cy="416" r="4.5" fill="#d4af37"/>

<path d="M660 400 L780 400 L780 500 L660 500 Z" fill="${shade(color, -0.06)}" stroke="${shade(color, -0.35)}" stroke-width="2.5" opacity=".85"/>
<path d="M654 394 L720 424 L786 394 Z" fill="${shade(color, 0.08)}" stroke="${shade(color, -0.4)}" stroke-width="2"/>
<circle cx="720" cy="416" r="4.5" fill="#d4af37"/>
</svg>`;
}

export const BUILTIN_TEMPLATES = [
  {
    id: 'suit-diplomat',
    nameFa: 'کت‌وشلوار دیپلمات آتلیه‌ای (عکاسی واقعی)',
    png: 'models/templates/suit_diplomat.png',
    thumb: 'models/templates/suit_diplomat_thumb.png',
    meta: { aspect: 768 / 1024, anchorX: 0.5, anchorY: 535 / 1024 },
  },
  { id: 'suit', nameFa: 'کت‌وشلوار رسمی با پیراهن و نکتایی (طرح برداری)', defaultColor: '#1d2638', colors: ['#1d2638', '#111214', '#3a3f47', '#2c3e2f'], svg: suitSvg },
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

/** id format: "builtin:<id>" or "builtin:<id>:<color>" or "user:<key>" */
export async function getTemplate(id) {
  if (id.startsWith('builtin:')) {
    const parts = id.split(':');
    const tid = parts[1];
    const color = parts[2];
    const t = BUILTIN_TEMPLATES.find((x) => x.id === tid);
    if (!t) return null;
    if (t.png) {
      try {
        const res = await fetch(t.png);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        const dec = await decodeImage(blob, {});
        return { image: dec.image, meta: t.meta || { aspect: dec.width / dec.height, anchorX: 0.5, anchorY: 0.56 } };
      } catch (err) {
        console.error('Failed to load photographic suit template:', t.png, err);
        return null;
      }
    }
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
  if (!t) return '';
  return t.svg ? t.svg({ color: color || t.defaultColor }) : '';
}
