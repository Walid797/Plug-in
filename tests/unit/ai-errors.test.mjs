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
  const long = aiFailureText(new Error('x'.repeat(500)));
  assert.ok(long.length < 600, 'detail is cut');
  assert.match(aiFailureText(new Error('weird')), /جزئیات فنی: weird/);
});
