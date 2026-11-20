// Offline cache for the app shell. Bump VERSION when files change.
const VERSION = 'lumen-v18';
const SHELL = ['./', 'index.html', 'manifest.webmanifest', 'js/main.js?v=18', 'js/ui.js?v=18', 'js/apps.js?v=18', 'js/env.js?v=18', 'js/hands.js?v=18', 'js/hands-worker.js?v=18', 'js/jellyfin.js?v=18', 'js/livevideo.js?v=18', 'js/phone.js?v=18',
  'vendor/three.module.min.js', 'vendor/three.core.min.js', 'icons/icon-192.png', 'icons/icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // Jellyfin (proxied under jf/) is live data and video: never cache it.
  if (url.pathname.includes('/jf/') || e.request.headers.has('range')) return;
  // network first so updates show up, cache as fallback for offline use
  e.respondWith(fetch(e.request).then(r => {
    const copy = r.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); return r;
  }).catch(() => caches.match(e.request)));
});
