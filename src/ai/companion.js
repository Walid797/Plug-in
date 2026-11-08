// Optional LOCAL companion runtime for generative clothing edits.
// Talks only to a loopback address (127.0.0.1 / localhost / [::1]) running an
// AUTOMATIC1111-compatible Stable Diffusion WebUI API (also Forge / SD.Next).
// No cloud service is ever contacted.

const LOOPBACK = /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|localhost|\[::1\])$/i;

export function validateCompanionUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { return { ok: false, reason: 'نشانی معتبر نیست.' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, reason: 'فقط http یا https مجاز است.' };
  if (!LOOPBACK.test(u.hostname)) return { ok: false, reason: 'برای حفظ حریم خصوصی فقط نشانی‌های همین کمپیوتر (127.0.0.1 یا localhost) مجاز است.' };
  if (u.username || u.password) return { ok: false, reason: 'نام کاربری در نشانی مجاز نیست.' };
  return { ok: true, base: `${u.protocol}//${u.host}` };
}

async function withTimeout(promise, ms, controller) {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => { controller?.abort(); rej(Object.assign(new Error('TIMEOUT'), { code: 'TIMEOUT' })); }, ms); });
  try { return await Promise.race([promise, timeout]); } finally { clearTimeout(t); }
}

/** Check that a compatible local server answers. */
export async function checkCompanion(url) {
  const v = validateCompanionUrl(url);
  if (!v.ok) return { ok: false, reason: v.reason };
  const controller = new AbortController();
  try {
    const r = await withTimeout(fetch(`${v.base}/sdapi/v1/sd-models`, { signal: controller.signal, mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer' }), 4000, controller);
    if (!r.ok) return { ok: false, reason: `پاسخ نامعتبر از سرور محلی (${r.status}).` };
    const models = await r.json();
    if (!Array.isArray(models)) return { ok: false, reason: 'این سرور با API مورد نیاز سازگار نیست.' };
    return { ok: true, models: models.map((m) => m.model_name || m.title).filter(Boolean) };
  } catch (e) {
    if (e.code === 'TIMEOUT') return { ok: false, reason: 'سرور محلی پاسخ نداد (۴ ثانیه).' };
    return { ok: false, reason: 'اتصال برقرار نشد. موتور محلی روشن نیست یا اجازهٔ CORS برای این برنامه داده نشده است.' };
  }
}

// Internal prompts for the model (not user-facing text).
export const STYLE_PROMPTS = {
  suit: 'wearing a formal dark navy business suit jacket, white dress shirt and a dark tie',
  office: 'wearing a crisp light blue office dress shirt with a dark tie',
  shirt: 'wearing a plain white formal dress shirt with collar',
  school: 'wearing a simple dark school uniform shirt with a white collar',
};

export function buildPrompt(style, colorName) {
  const base = STYLE_PROMPTS[style] || STYLE_PROMPTS.suit;
  const color = colorName ? `, clothing color ${colorName}` : '';
  return `professional passport ID photo of the same person ${base}${color}, natural studio lighting, photorealistic, sharp focus`;
}

export const NEGATIVE_PROMPT = 'different person, changed face, distorted face, deformed, extra limbs, extra fingers, text, watermark, logo, cartoon, painting, low quality, blurry';

/**
 * Inpaint the masked clothing region. image/mask are PNG data URLs of equal size.
 * @returns {Promise<Blob>} PNG
 */
export async function inpaint(url, { image, mask, width, height, prompt, steps = 28, denoise = 0.8, seed = -1 }, signal) {
  const v = validateCompanionUrl(url);
  if (!v.ok) throw Object.assign(new Error(v.reason), { code: 'BAD_URL' });
  const body = {
    init_images: [image], mask, prompt, negative_prompt: NEGATIVE_PROMPT,
    denoising_strength: denoise, inpainting_fill: 1, inpaint_full_res: false, inpaint_full_res_padding: 32,
    mask_blur: 4, inpainting_mask_invert: 0, steps, cfg_scale: 6.5, width, height,
    sampler_name: 'Euler a', seed, batch_size: 1, n_iter: 1, restore_faces: false, send_images: true, save_images: false,
  };
  const r = await fetch(`${v.base}/sdapi/v1/img2img`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
    mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer',
  });
  if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { code: 'HTTP' });
  const json = await r.json();
  const b64 = json?.images?.[0];
  if (!b64 || typeof b64 !== 'string') throw Object.assign(new Error('NO_IMAGE'), { code: 'NO_IMAGE' });
  const clean = b64.replace(/^data:image\/\w+;base64,/, '');
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  // must decode as an image of the requested size
  return new Blob([bytes], { type: 'image/png' });
}
