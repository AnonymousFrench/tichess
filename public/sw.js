/* tichess lightweight PWA service worker:
 * - Never touches /api/*, non-GET, or cross-origin requests.
 * - Cache-first for immutable Vite /assets/* and app icons.
 * - Network-first (cache fallback offline) for HTML pages and manifest.
 */
const CACHE = 'tichess-shell-v1';
const SHELL = ['/', '/insights.html', '/repertoire.html', '/site.webmanifest', '/favicon.svg', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/sw.js') return;

  const isImmutable =
    url.pathname.startsWith('/assets/') ||
    url.pathname.startsWith('/stockfish/') ||
    /^\/(favicon|icon-|apple-touch-icon)/.test(url.pathname);

  if (isImmutable) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res && res.ok && res.type === 'basic') {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
            }
            return res;
          })
      )
    );
    return;
  }

  if (req.mode === 'navigate' || url.pathname === '/site.webmanifest' || url.pathname.endsWith('.html')) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match(req))
    );
  }
});
