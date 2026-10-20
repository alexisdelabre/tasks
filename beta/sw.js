// Network first, cache as a fallback, so the app opens offline with the last known tasks.
// « no-cache » makes the browser ask GitHub Pages each time (a cheap 304 when nothing changed): without it,
// the HTTP cache (max-age 600) can serve the old style.css or app.js for 10 minutes after a deploy.
const CACHE = 'tasks-beta-1792502634';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' }).then(r => {
      const copy = r.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return r;
    }).catch(() => caches.match(e.request))
  );
});
