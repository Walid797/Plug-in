/* Hoshmand Photo Studio service worker (generated from src/sw.template.js).
 * Only same-origin requests are handled; nothing is ever sent to the network
 * by this worker except fetching the app's own files from the local server.
 */
const VERSION = "1.0.0-bec6114b1a";
const SHELL = ["index.html","manifest.webmanifest","app/app.js","app/app.css","app/build-info.json","icons/icon-192.png","icons/icon-512.png","icons/icon-maskable-512.png","icons/icon.svg"];
const SHELL_CACHE = `hoshmand-shell-${VERSION}`;
const RUNTIME_CACHE = 'hoshmand-runtime-v1';

/**
 * Static hosts (Render, GitHub Pages, …) often cannot send COOP/COEP headers.
 * Adding them to the page response here makes the app cross-origin isolated
 * (multi-threaded WebAssembly) from the second visit on. Everything the app
 * loads is same-origin, so `require-corp` blocks nothing it needs.
 */
function withIsolation(res) {
  if (!res || res.status === 0 || res.type === 'opaqueredirect' || res.headers.get('Cross-Origin-Embedder-Policy')) return res;
  const headers = new Headers(res.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await cache.addAll(SHELL.map((p) => new Request(p, { cache: 'reload' })));
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('hoshmand-shell-') && key !== SHELL_CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // never touch other origins
  const rel = url.pathname.replace(/^\/+/, '');
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        if (fresh.ok && fresh.type === 'basic') {
          const cache = await caches.open(SHELL_CACHE);
          cache.put('index.html', fresh.clone());
        }
        return withIsolation(fresh);
      } catch {
        const cached = await caches.match('index.html');
        return cached ? withIsolation(cached) : Response.error();
      }
    })());
    return;
  }
  const isShell = SHELL.includes(rel);
  const isRuntime = /^(vendor|models)\//.test(rel);
  if (!isShell && !isRuntime) return;
  event.respondWith((async () => {
    const cached = await caches.match(req, { ignoreSearch: true });
    if (cached) {
      if (isShell) {
        // refresh the shell in the background when the local server is running
        fetch(req).then(async (r) => { if (r.ok) (await caches.open(SHELL_CACHE)).put(req, r); }).catch(() => {});
      }
      return cached;
    }
    const res = await fetch(req);
    if (res.ok && res.status === 200) {
      const cache = await caches.open(isShell ? SHELL_CACHE : RUNTIME_CACHE);
      cache.put(req, res.clone());
    }
    return res;
  })());
});
