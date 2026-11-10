import test from 'node:test';
import assert from 'node:assert/strict';
import { skinProfile, findBlemishes, healBlemishes, skinPlan, rgbToLab, toneClass } from '../../src/core/skinprofile.js';
import { mergeFaceDetail } from '../../src/core/enhance.js';

const S = 512;
/** A synthetic aligned face: skin-coloured oval with mild grain on grey, white of the eye beside a dark iris. */
function face(skin, { sclera = [225, 225, 225], spots = [] } = {}) {
  const d = new Uint8ClampedArray(S * S * 4);
  let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
  for (let y = 0; y < S; y += 1) for (let x = 0; x < S; x += 1) {
    const i = (y * S + x) * 4; const inFace = ((x - 256) / 150) ** 2 + ((y - 292) / 190) ** 2 < 1;
    let c = inFace ? skin : [128, 128, 128];
    for (const ex of [193, 319]) if (Math.abs(y - 240) < 10 && Math.abs(x - ex) < 32) c = Math.abs(x - ex) < 11 ? [40, 30, 25] : sclera;
    const g = inFace ? rnd() * 4 : 0;
    let [r, gg, b] = c;
    for (const s of spots) { const w = Math.exp(-((x - s.x) ** 2 + (y - s.y) ** 2) / (2 * s.r * s.r)); r *= 1 - w * (1 - s.c[0]); gg *= 1 - w * (1 - s.c[1]); b *= 1 - w * (1 - s.c[2]); }
    d[i] = r + g; d[i + 1] = gg + g; d[i + 2] = b + g; d[i + 3] = 255;
  }
  return d;
}
const LIGHT = [224, 180, 155]; const DARK = [92, 60, 44];

test('rgbToLab: white, black and a skin colour', () => {
  const w = rgbToLab(255, 255, 255); assert.ok(Math.abs(w[0] - 100) < 0.1 && Math.abs(w[1]) < 0.1 && Math.abs(w[2]) < 0.1);
  assert.ok(rgbToLab(0, 0, 0)[0] < 0.1);
  const s = rgbToLab(...LIGHT); assert.ok(s[1] > 5 && s[2] > 10);
});

test('toneClass covers the whole range', () => {
  assert.equal(toneClass(60).id, 'very-light'); assert.equal(toneClass(35).id, 'intermediate'); assert.equal(toneClass(-40).id, 'dark');
});

test('profile: light and dark skin are told apart, also by the white of the eye', () => {
  const pl = skinProfile(face(LIGHT), S); const pd = skinProfile(face(DARK), S);
  assert.ok(pl && pd);
  assert.ok(pl.ita > 41, `light ita ${pl.ita}`); assert.ok(pd.ita < 10, `dark ita ${pd.ita}`);
  assert.ok(pl.skinToSclera > 0.5 && pd.skinToSclera < 0.2);
  assert.ok(pl.skinFraction > 0.8, `skin fraction ${pl.skinFraction}`);
});

test('plan: darker skin gets a lower brightness target; an under-exposed light skin does not', () => {
  const light = skinPlan(skinProfile(face(LIGHT), S)); const dark = skinPlan(skinProfile(face(DARK), S));
  assert.ok(light.targetLuma >= 180); assert.ok(dark.targetLuma <= 150, `dark target ${dark.targetLuma}`);
  assert.ok(dark.referenceL < light.referenceL);
  // the same light skin photographed 1.6 stops too dark: the white of the eye is just as dark, so the skin still reads as light
  const k = 0.5; const under = skinPlan(skinProfile(face(LIGHT.map((v) => v * k), { sclera: [225 * k, 225 * k, 225 * k] }), S));
  assert.ok(under.targetLuma >= 165 && under.targetLuma > dark.targetLuma + 20, `under-exposed target ${under.targetLuma}`);
});

test('plan: more blemishes and fewer pixels mean more of the skin is rebuilt', () => {
  const p = skinProfile(face(LIGHT), S);
  const clean = skinPlan(p, { faceWidthPx: 900, blemishArea: 0 }); const bad = skinPlan(p, { faceWidthPx: 900, blemishArea: 0.03 }); const small = skinPlan(p, { faceWidthPx: 200 });
  assert.ok(bad.regen > clean.regen && bad.sigmaSkin > clean.sigmaSkin && bad.smoothScale > clean.smoothScale);
  assert.ok(small.regen > clean.regen);
  assert.equal(skinPlan(p, { strength: 0 }).regen, 0);
});

test('plan: colour correction only outside the natural range', () => {
  const p = skinProfile(face(LIGHT), S);
  assert.equal(skinPlan({ ...p, chroma: 24, hue: 50 }).saturation, 0);
  assert.ok(skinPlan({ ...p, chroma: 12 }).saturation > 0); assert.ok(skinPlan({ ...p, chroma: 42 }).saturation < 0); assert.equal(skinPlan({ ...p, chroma: 34 }).saturation, 0);
  assert.ok(skinPlan({ ...p, hue: 30 }).temperature > 0); assert.ok(skinPlan({ ...p, hue: 75 }).temperature < 0);
});

const SPOTS = [{ x: 170, y: 310, r: 4, c: [1, 0.62, 0.6] }, { x: 345, y: 320, r: 5, c: [0.8, 0.68, 0.62] }, { x: 256, y: 150, r: 3.5, c: [1, 0.6, 0.58] }, { x: 300, y: 430, r: 4, c: [0.78, 0.7, 0.66] }];
for (const [name, skin] of [['light', LIGHT], ['dark', DARK]]) {
  test(`blemishes on ${name} skin: found, clean skin untouched, healed`, () => {
    const cleanImg = face(skin); const pc = skinProfile(cleanImg, S);
    assert.equal(findBlemishes(cleanImg, pc).count, 0);
    const img = face(skin, { spots: SPOTS }); const p = skinProfile(img, S); const f = findBlemishes(img, p);
    assert.equal(f.count, SPOTS.length);
    const out = healBlemishes(img, p, f);
    for (const s of SPOTS) {
      const i = (s.y * S + s.x) * 4;
      assert.ok(Math.abs(out[i + 1] - skin[1]) < 0.06 * skin[1] + 3, `spot at ${s.x},${s.y}: ${out[i + 1]} vs ${skin[1]}`);
    }
    const far = (200 * S + 256) * 4; assert.equal(out[far], img[far]);
  });
}

test('a single very dark, sharp spot is kept as a mole unless asked', () => {
  const img = face(LIGHT, { spots: [{ x: 340, y: 330, r: 4.5, c: [0.3, 0.25, 0.22] }] }); const p = skinProfile(img, S);
  const f = findBlemishes(img, p); assert.equal(f.count, 0); assert.equal(f.kept, 1);
  assert.equal(findBlemishes(img, p, { moles: true }).count, 1);
});

test('mergeFaceDetail with regeneration: the skin band comes from the model, tone stays the photo\'s', () => {
  const n = 64; const base = new Uint8ClampedArray(n * n * 4); const model = new Uint8ClampedArray(n * n * 4); const skin = new Float32Array(n * n).fill(1);
  for (let y = 0; y < n; y += 1) for (let x = 0; x < n; x += 1) {
    const i = (y * n + x) * 4; const patch = Math.abs(x - 32) < 5 && Math.abs(y - 32) < 5 ? -30 : 0; // a blotch the photo has and the model does not
    base[i] = 150 + patch; base[i + 1] = 120 + patch; base[i + 2] = 100 + patch; base[i + 3] = 255;
    model[i] = 200; model[i + 1] = 170; model[i + 2] = 150; model[i + 3] = 255; // brighter overall: must not carry over
  }
  const c = (32 * n + 32) * 4; const e = (8 * n + 8) * 4;
  const plain = mergeFaceDetail(base, model, n, { sigma: 2 });
  const regen = mergeFaceDetail(base, model, n, { sigma: 2, skin, regen: 1, sigmaSkin: 12 });
  assert.ok(regen[c + 1] - plain[c + 1] > 10, 'the blotch is lifted towards the model\'s clean skin');
  assert.ok(Math.abs(regen[e + 1] - 120) < 6, 'tone away from the blotch stays the photo\'s');
});

test('even light: an evenly lit face is left alone; a shaded half is brought up towards the lit half', async () => {
  const { evenLightField, applyGainField } = await import('../../src/core/skinprofile.js');
  const flat = face(LIGHT); assert.equal(evenLightField(flat, skinProfile(flat, S)).gain, null);
  const img = face(LIGHT);
  for (let y = 0; y < S; y += 1) for (let x = 0; x < S; x += 1) { const i = (y * S + x) * 4; const k = 1 - 0.3 / (1 + Math.exp(-(x - 256) / 30)); img[i] *= k; img[i + 1] *= k; img[i + 2] *= k; }
  const p = skinProfile(img, S); const ev = evenLightField(img, p);
  assert.ok(ev.gain && ev.amount > 0.3, `amount ${ev.amount}`);
  const lit = (300 * S + 150) * 4; const shade = (300 * S + 370) * 4; const before = img[lit + 1] - img[shade + 1];
  applyGainField(img, S, S, ev.gain, S, [1, 0, 0, 1, 0, 0]);
  const after = img[lit + 1] - img[shade + 1];
  assert.ok(after < before * 0.6, `difference ${before} → ${after}`);
  assert.ok(evenLightField(img, skinProfile(img, S)).uneven < ev.uneven);
});

test('constrainCropBottom: size kept, only the lower edge is brought inside', async () => {
  const { constrainCropBottom, cropToPixels } = await import('../../src/core/crop.js');
  const c = constrainCropBottom({ cx: 0.5, cy: 0.6, cw: 1.2, rotation: 0 }, 400, 300, 0.75);
  const p = cropToPixels(c, 400, 300, 0.75);
  assert.equal(c.cw, 1.2); assert.ok(Math.abs(p.cy + p.ch / 2 - 300) < 1e-6); assert.ok(p.cy - p.ch / 2 < 0);
  const inside = { cx: 0.5, cy: 0.4, cw: 0.3, rotation: 0 }; assert.deepEqual(constrainCropBottom(inside, 400, 300, 0.75), inside);
});

test('skin colour: natural skin untouched; red, yellow and grey skin brought into the natural range', async () => {
  const { skinColorCorrection, applySkinColor, NATURAL_SKIN: N } = await import('../../src/core/skinprofile.js');
  const fix = (rgb) => {
    const img = face(rgb); const p = skinProfile(img, S); const cc = skinColorCorrection(p);
    if (cc.needed) applySkinColor(img, S, S, new Uint8Array(4).fill(255), 2, 2, cc.gains);
    return { before: p, cc, after: skinProfile(img, S) };
  };
  const natural = fix([214, 160, 126]); assert.equal(natural.cc.needed, false, `hue ${natural.before.hue} chroma ${natural.before.chroma}`);
  for (const [name, rgb] of [['red', [235, 150, 135]], ['yellow', [215, 160, 85]], ['grey', [170, 158, 150]]]) {
    const r = fix(rgb); assert.ok(r.cc.needed, name);
    assert.ok(r.after.hue > N.hueMin - 3 && r.after.hue < N.hueMax + 3, `${name}: hue ${r.before.hue.toFixed(1)} → ${r.after.hue.toFixed(1)}`);
    assert.ok(r.after.chroma > N.chromaMin - 3 && r.after.chroma < N.chromaMax + 3, `${name}: chroma ${r.before.chroma.toFixed(1)} → ${r.after.chroma.toFixed(1)}`);
    assert.ok(Math.abs(r.after.L - r.before.L) < 3, `${name}: brightness kept`);
  }
});
