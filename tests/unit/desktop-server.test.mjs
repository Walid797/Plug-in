import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { startAppServer, resolveSafe } = require('../../desktop/appserver.cjs');

function fakeWww() {
  const dir = mkdtempSync(path.join(tmpdir(), 'hoshmand-www-'));
  mkdirSync(path.join(dir, 'app')); mkdirSync(path.join(dir, 'models')); mkdirSync(path.join(dir, 'secret'));
  writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>x</title>');
  writeFileSync(path.join(dir, 'sw.js'), '// sw');
  writeFileSync(path.join(dir, 'app', 'app.js'), 'console.log(1)');
  writeFileSync(path.join(dir, 'models', 'm.onnx'), 'abc');
  writeFileSync(path.join(dir, 'secret', 'x.txt'), 'no');
  writeFileSync(path.join(dir, 'main.cjs'), 'no');
  return dir;
}

test('desktop server: allow-listed files only, isolation headers, 127.0.0.1, GET/HEAD only', async () => {
  const dir = fakeWww();
  const s = await startAppServer(dir, 0);
  try {
    const base = `http://127.0.0.1:${s.port}`;
    const r = await fetch(`${base}/`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/html/);
    assert.equal(r.headers.get('cross-origin-opener-policy'), 'same-origin');
    assert.equal(r.headers.get('cross-origin-embedder-policy'), 'require-corp');
    assert.equal((await fetch(`${base}/app/app.js`)).status, 200);
    assert.equal((await fetch(`${base}/models/m.onnx`)).headers.get('content-type'), 'application/octet-stream');
    for (const bad of ['/secret/x.txt', '/main.cjs', '/../main.cjs', '/app/../../etc/passwd', '/%2e%2e/main.cjs', '/app', '/app/nothing.js', '/models/%00']) {
      assert.equal((await fetch(`${base}${bad}`)).status, 404, `blocked ${bad}`);
    }
    assert.equal((await fetch(`${base}/`, { method: 'POST' })).status, 405);
    assert.equal(s.server.address().address, '127.0.0.1');
  } finally { s.close(); }
});

test('desktop server: a busy port is reported (the app shows a message instead of using another origin)', async () => {
  const dir = fakeWww();
  const a = await startAppServer(dir, 0);
  try { await assert.rejects(() => startAppServer(dir, a.port), (e) => e.code === 'EADDRINUSE'); } finally { a.close(); }
});

test('desktop server: resolveSafe rejects traversal and unknown folders', () => {
  const dir = fakeWww();
  assert.equal(resolveSafe(dir, '/secret/x.txt'), null);
  assert.equal(resolveSafe(dir, '/../index.html'), null);
  assert.ok(resolveSafe(dir, '/index.html'));
});
