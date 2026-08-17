/* FRACTAL RUN NAVI :: service worker
   Network-first for app files so a deploy is picked up immediately,
   cache-first for icons. Map tiles and every API call bypass the worker. */
const VERSION = 'runnavi-v5';
const SHELL = [
  './', './index.html', './css/app.css',
  './js/util.js', './js/store.js', './js/providers.js', './js/terrain.js',
  './js/weather.js', './js/planner.js', './js/mapview.js', './js/tracker.js',
  './js/health.js', './js/share.js', './js/app.js',
  './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // tiles / APIs / Leaflet CDN

  const isIcon = url.pathname.includes('/icons/');
  if (isIcon) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req)));
    return;
  }
  e.respondWith(
    fetch(req)
      .then(res => {
        const copy = res.clone();
        caches.open(VERSION).then(c => c.put(req, copy)).catch(() => { });
        return res;
      })
      .catch(() => caches.match(req).then(hit => hit || caches.match('./index.html')))
  );
});
