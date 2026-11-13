// Offline cache for 戳戳樂. Bump CACHE whenever any file below changes,
// otherwise iPads that already installed the app keep the old copy.
const CACHE = 'pokepoke-1.0.2';
const FILES = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'manifest.webmanifest',
  'assets/logo-a.jpg',
  'assets/logo-b.jpg',
  'assets/waves.svg',
  'assets/icon-180.png',
  'assets/icon-192.png',
  'assets/icon-512.png',
  'assets/sounds/rice-1.mp3',
  'assets/sounds/rice-2.mp3',
  'assets/sounds/rice-3.mp3',
  'assets/sounds/squid-1.mp3',
  'assets/sounds/squid-2.mp3',
  'assets/sounds/squid-3.mp3',
  'assets/sounds/hug-1.mp3',
  'assets/sounds/hug-2.mp3',
  'assets/sounds/hug-3.mp3',
];

self.addEventListener('install', e => {
  // cache:'reload' skips the HTTP cache so a new version never stores stale files
  e.waitUntil(caches.open(CACHE)
    .then(c => c.addAll(FILES.map(f => new Request(f, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('pokepoke-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then(hit => {
      if (hit) return hit;
      return fetch(req).catch(() => (req.mode === 'navigate' ? caches.match('index.html') : Response.error()));
    })
  );
});
