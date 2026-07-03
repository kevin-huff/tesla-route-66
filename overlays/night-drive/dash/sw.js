// Night Drive PWA service worker — cache the shell so the dashboard opens
// instantly in the car even on garbage cellular. API calls always go to the
// network (the retry queue in app.js owns offline mutations).
const VERSION = 'nd-v1';
const SHELL = [
  './',
  'index.html',
  'app.css',
  'app.js',
  'icon.svg',
  'manifest.webmanifest',
  '../fonts/barlow-400.woff2',
  '../fonts/barlow-600.woff2',
  '../fonts/barlow-700.woff2',
  '../fonts/jetbrains-mono-500.woff2',
  '../fonts/jetbrains-mono-600.woff2',
  '../fonts/jetbrains-mono-700.woff2',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.includes('/api/')) return; // network only
  e.respondWith(
    caches.match(e.request).then(
      (hit) =>
        hit ||
        fetch(e.request).then((res) => {
          if (res.ok && url.origin === location.origin) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(e.request, copy));
          }
          return res;
        }),
    ),
  );
});
