import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function request(port, method, p) {
  return new Promise((resolve, reject) => {
    // raw path (no normalisation by the client) to test traversal handling
    const req = http.request({ host: '127.0.0.1', port, method, path: p }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function start(cmd, args, port) {
  const proc = spawn(cmd, [...args, '--no-open', '--port', String(port)], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  const actual = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), 8000);
    proc.stdout.on('data', (d) => { const m = /127\.0\.0\.1:(\d+)/.exec(String(d)); if (m) { clearTimeout(t); resolve(Number(m[1])); } });
    proc.on('exit', (c) => { clearTimeout(t); reject(new Error(`exited ${c}`)); });
  });
  return { proc, port: actual };
}

const hasPython = spawnSync('python3', ['--version']).status === 0;
const servers = [['node', [path.join('server', 'serve.mjs')], 8911]];
if (hasPython) servers.push(['python3', [path.join('server', 'serve.py')], 8912]);

for (const [cmd, args, firstPort] of servers) {
  let port = firstPort;
  test(`${cmd} local server: allow-list, traversal protection, isolation headers`, async () => {
    const started = await start(cmd, args, port);
    const proc = started.proc;
    port = started.port; // the server moves to the next free port if needed
    try {
      const index = await request(port, 'GET', '/');
      assert.equal(index.status, 200);
      assert.match(index.headers['content-type'], /text\/html/);
      assert.equal(index.headers['cross-origin-opener-policy'], 'same-origin');
      assert.equal(index.headers['cross-origin-embedder-policy'], 'require-corp');
      assert.equal(index.headers['x-content-type-options'], 'nosniff');
      const wasm = await request(port, 'HEAD', '/vendor/mediapipe/wasm/vision_wasm_internal.wasm');
      assert.equal(wasm.status, 200);
      assert.equal(wasm.headers['content-type'], 'application/wasm');
      for (const p of ['/package.json', '/src/main.jsx', '/node_modules/preact/package.json', '/tests/unit/server.test.mjs',
        '/../../etc/passwd', '/app/../package.json', '/%2e%2e/%2e%2e/etc/passwd', '/vendor/..%2f..%2fpackage.json', '/.git/config', '/server/serve.mjs', '/app']) {
        const r = await request(port, 'GET', p);
        assert.equal(r.status, 404, `${p} must not be served (got ${r.status})`);
      }
      const post = await request(port, 'POST', '/index.html');
      assert.equal(post.status, 405);
    } finally {
      proc.kill();
    }
  });
}
