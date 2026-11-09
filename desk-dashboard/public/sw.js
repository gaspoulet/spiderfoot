// Service worker : l'app reste utilisable hors ligne.
// - Fichiers de l'app : cache d'abord, mis à jour en arrière-plan.
// - /api/devoirs : réseau d'abord, dernière réponse en secours.
const VERSION = 'bureau-v4';
const SHELL = [
  '/', '/index.html', '/styles.css', '/app.js', '/manifest.webmanifest',
  '/icons/icon.svg', '/icons/apple-touch-icon.png', '/icons/icon-192.png', '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(url.pathname, copy)); }
        return res;
      }).catch(() => caches.match(url.pathname).then((r) => r || new Response(
        JSON.stringify({ error: 'offline', message: 'Hors ligne' }),
        { status: 503, headers: { 'content-type': 'application/json' } },
      ))),
    );
    return;
  }

  // Navigation : toujours renvoyer l'app (même hors ligne)
  const key = req.mode === 'navigate' ? '/index.html' : req;
  event.respondWith(
    caches.match(key).then((cached) => {
      const network = fetch(req).then((res) => {
        if (res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(key, copy)); }
        return res;
      }).catch(() => cached);
      return cached || network;
    }),
  );
});
