'use strict';
// Local server for the desktop app. Same rules as server/serve.mjs: 127.0.0.1 only, an allow-list of folders,
// cross-origin isolation headers (WASM threads), nothing else is served. The port is FIXED on purpose: the browser
// storage (projects, settings, models) belongs to the origin http://127.0.0.1:<port>, so it must not change between runs.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ALLOWED_FILES = new Set(['index.html', 'sw.js', 'manifest.webmanifest']);
const ALLOWED_DIRS = new Set(['app', 'vendor', 'models', 'icons']);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8', '.task': 'application/octet-stream', '.tflite': 'application/octet-stream', '.onnx': 'application/octet-stream',
};

function resolveSafe(root, urlPath) {
  let rel;
  try { rel = decodeURIComponent(String(urlPath).split('?')[0].split('#')[0]); } catch { return null; }
  if (rel.includes('\0')) return null;
  rel = rel.replace(/^\/+/, '') || 'index.html';
  const norm = path.posix.normalize(rel);
  if (norm.startsWith('..') || path.isAbsolute(norm)) return null;
  const first = norm.split('/')[0];
  if (!(ALLOWED_FILES.has(norm) || (ALLOWED_DIRS.has(first) && norm.includes('/')))) return null;
  try {
    const abs = path.join(root, norm);
    const real = fs.realpathSync(abs);
    if (!real.startsWith(root + path.sep)) return null;
    const st = fs.statSync(real);
    return st.isFile() ? { file: real, size: st.size } : null;
  } catch { return null; }
}

/** @returns {Promise<{server:import('node:http').Server, port:number, close:()=>void}>} */
function startAppServer(wwwDir, port) {
  const root = fs.realpathSync(wwwDir);
  const server = http.createServer((req, res) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return; }
    const hit = resolveSafe(root, req.url || '/');
    if (!hit) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not found'); return; }
    const ext = path.extname(hit.file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': hit.size,
      'Cache-Control': ext === '.html' || path.basename(hit.file) === 'sw.js' ? 'no-cache' : 'public, max-age=3600',
    });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(hit.file).pipe(res);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port, close: () => server.close() }));
  });
}

module.exports = { startAppServer, resolveSafe };
