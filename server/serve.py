#!/usr/bin/env python3
"""Local server for Hoshmand Photo Studio (Python 3.8+, standard library only).

Listens on 127.0.0.1 only, serves an allow-list of folders and sends the
cross-origin isolation headers needed for multi-threaded WebAssembly.
Usage: python3 server/serve.py [--port 8787] [--no-open]
"""
import http.server
import os
import socketserver
import sys
import webbrowser
from urllib.parse import unquote, urlsplit

ROOT = os.path.realpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
ALLOWED_FILES = {'index.html', 'sw.js', 'manifest.webmanifest', 'favicon.ico'}
ALLOWED_DIRS = {'app', 'vendor', 'models', 'icons', 'docs'}
MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
    '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
    '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
    '.task': 'application/octet-stream', '.tflite': 'application/octet-stream', '.onnx': 'application/octet-stream',
}


def resolve_safe(url_path):
    try:
        rel = unquote(urlsplit(url_path).path)
    except Exception:
        return None
    if '\0' in rel:
        return None
    rel = rel.lstrip('/') or 'index.html'
    norm = os.path.normpath(rel).replace('\\', '/')
    if norm.startswith('..') or os.path.isabs(norm):
        return None
    first = norm.split('/')[0]
    if not (norm in ALLOWED_FILES or (first in ALLOWED_DIRS and '/' in norm)):
        return None
    real = os.path.realpath(os.path.join(ROOT, norm))
    if not real.startswith(ROOT + os.sep) or not os.path.isfile(real):
        return None
    return real


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = 'Hoshmand'
    sys_version = ''

    def _headers(self):
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        self.send_header('Cross-Origin-Resource-Policy', 'same-origin')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')

    def _serve(self, body):
        path = resolve_safe(self.path)
        if not path:
            self.send_response(404)
            self._headers()
            self.send_header('Content-Type', 'text/plain; charset=utf-8')
            self.end_headers()
            if body:
                self.wfile.write(b'Not found')
            return
        ext = os.path.splitext(path)[1].lower()
        size = os.path.getsize(path)
        self.send_response(200)
        self._headers()
        self.send_header('Content-Type', MIME.get(ext, 'application/octet-stream'))
        self.send_header('Content-Length', str(size))
        no_cache = ext in ('.html', '.json', '.webmanifest') or path.endswith(os.sep + 'sw.js')
        self.send_header('Cache-Control', 'no-cache' if no_cache else 'public, max-age=3600')
        self.end_headers()
        if body:
            with open(path, 'rb') as f:
                while True:
                    chunk = f.read(1 << 16)
                    if not chunk:
                        break
                    self.wfile.write(chunk)

    def do_GET(self):
        self._serve(True)

    def do_HEAD(self):
        self._serve(False)

    def _not_allowed(self):
        self.send_response(405)
        self._headers()
        self.send_header('Allow', 'GET, HEAD')
        self.send_header('Content-Length', '0')
        self.end_headers()

    do_POST = do_PUT = do_DELETE = do_PATCH = do_OPTIONS = _not_allowed

    def log_message(self, fmt, *args):  # keep the console quiet
        pass


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = False


def main():
    port = 8787
    if '--port' in sys.argv:
        port = int(sys.argv[sys.argv.index('--port') + 1])
    for attempt in range(20):
        try:
            httpd = Server(('127.0.0.1', port + attempt), Handler)
            break
        except OSError:
            continue
    else:
        print('خطا: درگاه آزاد پیدا نشد.')
        sys.exit(1)
    url = 'http://127.0.0.1:%d/' % httpd.server_address[1]
    print('هوشمند فوتو استودیو آماده است (فقط روی همین کمپیوتر):')
    print('  ' + url, flush=True)
    print('برای بستن، این پنجره را ببندید یا Ctrl+C بزنید.')
    if '--no-open' not in sys.argv:
        webbrowser.open(url)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
