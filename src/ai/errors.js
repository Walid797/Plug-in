// Turns the raw error of a local AI run into a cause the user can act on. Pure (no DOM), unit-tested.
// The browser reports memory, WebAssembly and GPU problems only as free text, so the text is matched.

const SHORT = 140;

// MediaPipe draws every photo through WebGL, even on its CPU path. With no WebGL at all (graphics driver blocked or
// broken) its GL calls hit an undefined context, e.g. "Cannot read properties of undefined (reading 'activeTexture')".
const NO_WEBGL = /reading '(activeTexture|bindTexture|createTexture|texImage2D|texParameteri|viewport|getExtension|createFramebuffer)'|GLctx|(create|get)[^.]{0,40}WebGL[^.]{0,20}(context|canvas)[^.]{0,20}(fail|null|unavailable)|WebGL2? (is )?not (supported|available)|NO_WEBGL/i;

/** @returns {{kind:'memory'|'wasm'|'webgl'|'gpu'|'load'|'timeout'|'other', detail:string}} */
export function classifyAiError(err) {
  const raw = String(err?.message || err?.code || err || '').replace(/\s+/g, ' ').trim();
  const name = String(err?.name || '');
  const text = `${name} ${raw}`;
  const detail = raw.length > SHORT ? `${raw.slice(0, SHORT)}…` : raw;
  let kind = 'other';
  if (err?.code === 'RUNTIME_LOAD' || /failed to fetch|NetworkError|Failed to load|ERR_FILE_NOT_FOUND|404/i.test(text)) kind = 'load';
  else if (err?.code === 'TIMEOUT') kind = 'timeout';
  else if (/out of memory|OOM|Aborted\(OOM|could not allocate|cannot allocate|allocation failed|Array buffer allocation|WebAssembly\.Memory|memory access out of bounds|RangeError/i.test(text)) kind = 'memory';
  else if (/simd|CompileError|LinkError|WebAssembly\.(instantiate|compile)|wasm.*(unsupported|not supported)|SharedArrayBuffer/i.test(text)) kind = 'wasm';
  else if (err?.code === 'NO_WEBGL' || NO_WEBGL.test(text)) kind = 'webgl';
  else if (/webgl|webgpu|gpu|fp16|context lost|shader/i.test(text)) kind = 'gpu';
  return { kind, detail };
}

/** Persian message for a failed background/face/clothing run; `what` names the step. */
export function aiFailureText(err, what = 'اجرای مدل') {
  const { kind, detail } = classifyAiError(err);
  const tech = detail ? ` (جزئیات فنی: ${detail})` : '';
  switch (kind) {
    case 'memory': return `${what} ناموفق بود چون حافظهٔ آزاد این کمپیوتر کم است. برنامه‌ها و تب‌های دیگر را ببندید، برنامه را دوباره باز کنید و فقط یک عکس را امتحان کنید. اگر ادامه داشت، عکس را کوچک‌تر (مثلاً کمتر از ۱۲ مگاپیکسل) کنید.${tech}`;
    case 'wasm': return `${what} ناموفق بود چون مرورگر یا پردازندهٔ این کمپیوتر قابلیت لازم (WebAssembly SIMD) را ندارد. مرورگر را به‌روز کنید (Chrome یا Edge نسخهٔ ۱۱۱ به بالا) یا از نسخهٔ ویندوزی برنامه استفاده کنید.${tech}`;
    case 'webgl': return `${what} ناموفق بود چون گرافیک (WebGL) این کمپیوتر در دسترس نیست؛ موتور هوش مصنوعی برای خواندن عکس به آن نیاز دارد. نسخهٔ ویندوزی تازه (۱.۰.۳ به بعد) این را خودش با گرافیک نرم‌افزاری حل می‌کند: برنامه را به‌روز کنید. در مرورگر، «تنظیمات ← سیستم ← استفاده از شتاب سخت‌افزاری» را روشن کنید و مرورگر را دوباره باز کنید؛ درایور کارت گرافیک را هم به‌روز کنید.${tech}`;
    case 'gpu': return `${what} روی کارت گرافیک ناموفق بود. در «تنظیمات ← سخت‌افزار اجرای مدل» گزینهٔ «پردازنده (CPU)» را انتخاب و دوباره امتحان کنید.${tech}`;
    case 'load': return `فایل‌های موتور هوش مصنوعی بارگذاری نشد (فایل ناقص یا مسدود). صفحه را با Ctrl+F5 دوباره بارگذاری کنید؛ در نسخهٔ ویندوزی برنامه را دوباره نصب کنید.${tech}`;
    case 'timeout': return `${what} بیش از حد طول کشید و متوقف شد. کمپیوتر کند است یا حافظه کم دارد؛ برنامه‌های دیگر را ببندید و دوباره امتحان کنید.${tech}`;
    default: return `${what} ناموفق بود. صفحه را دوباره بارگذاری کنید و دوباره امتحان کنید. اگر تکرار شد، متن داخل پرانتز را برای پشتیبانی بفرستید.${tech}`;
  }
}
