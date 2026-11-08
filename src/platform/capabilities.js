// Feature detection. Nothing here touches the network.

const WASM_SIMD = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);

export function isFileProtocol() {
  return typeof location !== 'undefined' && location.protocol === 'file:';
}

export function isIOS() {
  const ua = navigator.userAgent || '';
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export async function detectCapabilities() {
  const caps = {
    protocol: location.protocol,
    fileMode: isFileProtocol(),
    secureContext: !!window.isSecureContext,
    crossOriginIsolated: !!window.crossOriginIsolated,
    serviceWorker: 'serviceWorker' in navigator && window.isSecureContext && !isFileProtocol(),
    indexedDB: (() => { try { return typeof indexedDB !== 'undefined' && !!indexedDB; } catch { return false; } })(),
    opfs: false,
    wasm: typeof WebAssembly === 'object',
    wasmSimd: false,
    wasmThreads: typeof SharedArrayBuffer !== 'undefined' && !!window.crossOriginIsolated,
    webgl2: false,
    webgpu: false,
    webgpuAdapter: null,
    offscreenCanvas: typeof OffscreenCanvas !== 'undefined',
    offscreen2d: false,
    createImageBitmap: typeof createImageBitmap === 'function',
    worker: typeof Worker !== 'undefined',
    compressionStream: typeof CompressionStream !== 'undefined',
    share: typeof navigator.share === 'function',
    deviceMemoryGb: navigator.deviceMemory || null,
    cores: navigator.hardwareConcurrency || null,
    ios: isIOS(),
    touch: navigator.maxTouchPoints > 0,
    webp: false,
    storage: { usage: null, quota: null, persisted: null },
    maxCanvasPixels: isIOS() ? 16_777_216 : 120_000_000,
  };
  try { caps.wasmSimd = caps.wasm && WebAssembly.validate(WASM_SIMD); } catch { /* no simd */ }
  try { caps.webgl2 = !!document.createElement('canvas').getContext('webgl2'); } catch { /* none */ }
  try {
    if (caps.offscreenCanvas) caps.offscreen2d = !!new OffscreenCanvas(1, 1).getContext('2d');
  } catch { /* none */ }
  try {
    if (navigator.gpu && caps.secureContext) {
      const adapter = await Promise.race([navigator.gpu.requestAdapter(), new Promise((r) => setTimeout(() => r(null), 1500))]);
      caps.webgpu = !!adapter;
      if (adapter?.info) caps.webgpuAdapter = [adapter.info.vendor, adapter.info.architecture].filter(Boolean).join(' ');
    }
  } catch { /* none */ }
  try {
    if (navigator.storage?.getDirectory && !caps.fileMode) {
      await navigator.storage.getDirectory();
      caps.opfs = true;
    }
  } catch { /* none */ }
  try {
    if (navigator.storage?.estimate) {
      const e = await navigator.storage.estimate();
      caps.storage.usage = e.usage ?? null;
      caps.storage.quota = e.quota ?? null;
    }
    if (navigator.storage?.persisted) caps.storage.persisted = await navigator.storage.persisted();
  } catch { /* none */ }
  caps.webp = await new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img.width === 1);
    img.onerror = () => resolve(false);
    img.src = 'data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==';
  });
  return caps;
}

/** Whether local AI can run on this page at all, with a Persian reason when not. */
export function aiAvailability(caps) {
  if (caps.fileMode) return { ok: false, reason: 'برنامه مستقیم از فایل (file://) باز شده است. مرورگر در این حالت بارگذاری مدل‌ها را مسدود می‌کند. برنامه را با راه‌انداز محلی (start-windows.bat یا start-linux.sh یا start-mac.command) باز کنید.' };
  if (!caps.wasm) return { ok: false, reason: 'این مرورگر WebAssembly را پشتیبانی نمی‌کند؛ هوش مصنوعی محلی ممکن نیست.' };
  return { ok: true, reason: '' };
}
