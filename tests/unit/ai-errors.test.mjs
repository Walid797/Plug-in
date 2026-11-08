import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyAiError, aiFailureText } from '../../src/ai/errors.js';

test('AI errors are sorted into causes the user can act on', () => {
  assert.equal(classifyAiError(new RangeError('WebAssembly.Memory(): could not allocate memory')).kind, 'memory');
  assert.equal(classifyAiError(new Error('Aborted(OOM). Build with -sASSERTIONS')).kind, 'memory');
  assert.equal(classifyAiError(new Error('Array buffer allocation failed')).kind, 'memory');
  assert.equal(classifyAiError(Object.assign(new Error('x'), { name: 'CompileError', message: 'WebAssembly.instantiate(): Wasm SIMD unsupported' })).kind, 'wasm');
  assert.equal(classifyAiError(new Error('No full support of FP16 on this GPU')).kind, 'gpu');
  assert.equal(classifyAiError(new Error('WebGL context lost')).kind, 'gpu');
  // the exact error MediaPipe throws when the PC has no WebGL (seen on a Windows desktop install)
  assert.equal(classifyAiError(new TypeError("Cannot read properties of undefined (reading 'activeTexture')")).kind, 'webgl');
  assert.equal(classifyAiError(Object.assign(new Error('x'), { code: 'NO_WEBGL' })).kind, 'webgl');
  assert.equal(classifyAiError(Object.assign(new Error('RUNTIME_LOAD'), { code: 'RUNTIME_LOAD' })).kind, 'load');
  assert.equal(classifyAiError(Object.assign(new Error('TIMEOUT'), { code: 'TIMEOUT' })).kind, 'timeout');
  assert.equal(classifyAiError(new Error('something odd')).kind, 'other');
  assert.equal(classifyAiError(null).kind, 'other');
});

test('failure texts name the cause, give the fix and keep the technical detail (short)', () => {
  const mem = aiFailureText(new RangeError('could not allocate memory'), 'جداسازی پس‌زمینه');
  assert.match(mem, /حافظهٔ آزاد/); assert.match(mem, /جزئیات فنی/); assert.match(mem, /could not allocate/);
  assert.match(aiFailureText(new Error('Wasm SIMD unsupported')), /SIMD/);
  assert.match(aiFailureText(new Error('FP16 gpu')), /CPU/);
  const gl = aiFailureText(new TypeError("Cannot read properties of undefined (reading 'activeTexture')"), 'تحلیل چهره');
  assert.match(gl, /WebGL/); assert.match(gl, /شتاب سخت‌افزاری/); assert.match(gl, /activeTexture/);
  const long = aiFailureText(new Error('x'.repeat(500)));
  assert.ok(long.length < 600, 'detail is cut');
  assert.match(aiFailureText(new Error('weird')), /جزئیات فنی: weird/);
});

test('a stuck stage becomes a TIMEOUT that names the stage', async () => {
  const { withTimeout } = await import('../../src/ai/runtime.js').catch(() => ({}));
  if (!withTimeout) return; // runtime.js needs the browser store; covered by the e2e suite
  await assert.rejects(withTimeout(new Promise(() => {}), 'create', 20), (e) => e.code === 'TIMEOUT' && /create/.test(e.message));
  assert.equal(await withTimeout(Promise.resolve(7), 'run', 1000), 7);
  assert.match(aiFailureText(Object.assign(new Error('TIMEOUT: create > 180s'), { code: 'TIMEOUT' }), 'جداسازی پس‌زمینه'), /موتور گرافیک/);
});
