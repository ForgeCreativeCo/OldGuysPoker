// Service worker for the installed app. Caches only the app shell so the
// window opens instantly. Gameplay always needs the live server.
// Cache names are prefixed "ogp-" so we only ever clean up our own caches,
// never those of another app that shares this origin.
const VERSION = 'ogp-shell-v3';
const SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/config.js',
  '/vendor/socket.io.min.js',
  '/css/style.css',
  '/js/app.js',
  '/js/table-view.js',
  '/js/voice.js',
  '/js/sound.js',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('ogp-') && k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Never touch other origins, the live socket, or non-GET requests.
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/socket.io/')) return;

  // Network first so updates show up right away; fall back to cache offline.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: e.request.mode === 'navigate' })
        .then((hit) => hit || caches.match('/'))),
  );
});
