#!/usr/bin/env node
// Zero-dependency local server for Hoshmand Photo Studio.
// - Listens on 127.0.0.1 only (never exposed to the network).
// - Serves an allow-list of folders; source, tests and node_modules are not served.
// - Sends cross-origin isolation headers so WASM threads can be used.
// Usage: node server/serve.mjs [--port 8787] [--no-open]
import http from 'node:http';
import { promises as fs, createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argPort = Number(args[args.indexOf('--port') + 1]);
let port = Number.isInteger(argPort) && argPort > 0 ? argPort : 8787;
const shouldOpen = !args.includes('--no-open');

const ALLOWED_FILES = new Set(['index.html', 'sw.js', 'manifest.webmanifest', 'favicon.ico']);
const ALLOWED_DIRS = new Set(['app', 'vendor', 'models', 'icons', 'docs']);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.task': 'application/octet-stream', '.tflite': 'application/octet-stream', '.onnx': 'application/octet-stream',
};

function securityHeaders(res) {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=(), interest-cohort=()');
}

async function resolveSafe(urlPath) {
  let rel;
  try { rel = decodeURIComponent(urlPath.split('?')[0].split('#')[0]); } catch { return null; }
  if (rel.includes('\0')) return null;
  rel = rel.replace(/^\/+/, '') || 'index.html';
  const norm = path.posix.normalize(rel);
  if (norm.startsWith('..') || path.isAbsolute(norm)) return null;
  const first = norm.split('/')[0];
  if (!(ALLOWED_FILES.has(norm) || (ALLOWED_DIRS.has(first) && norm.includes('/')))) return null;
  const abs = path.join(root, norm);
  try {
    const real = await fs.realpath(abs);
    if (!real.startsWith(root + path.sep)) return null;
    const st = await fs.stat(real);
    return st.isFile() ? { file: real, size: st.size } : null;
  } catch { return null; }
}

const server = http.createServer(async (req, res) => {
  securityHeaders(res);
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return; }
  const hit = await resolveSafe(req.url || '/');
  if (!hit) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not found'); return; }
  const ext = path.extname(hit.file).toLowerCase();
  const noCache = ext === '.html' || hit.file.endsWith(`${path.sep}sw.js`) || ext === '.webmanifest' || ext === '.json';
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': hit.size,
    'Cache-Control': noCache ? 'no-cache' : 'public, max-age=3600',
  });
  if (req.method === 'HEAD') { res.end(); return; }
  createReadStream(hit.file).pipe(res);
});

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

function listen(attempt = 0) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attempt < 20) { port += 1; listen(attempt + 1); return; }
    console.error('خطا در راه‌اندازی سرور محلی:', err.message);
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}/`;
    console.log('هوشمند فوتو استودیو آماده است (فقط روی همین کمپیوتر):');
    console.log(`  ${url}`);
    console.log('برای بستن، این پنجره را ببندید یا Ctrl+C بزنید.');
    if (shouldOpen) openBrowser(url);
  });
}
listen();
