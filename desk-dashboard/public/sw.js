// Service worker : l'app reste utilisable hors ligne.
// - Fichiers de l'app : cache d'abord, mis à jour en arrière-plan.
// - /api/devoirs : réseau d'abord, dernière réponse en secours.
const VERSION = 'bureau-v14';
const SHELL = [
  '/', '/styles.css', '/app.js', '/manifest.webmanifest',
  '/icons/icon.svg', '/icons/apple-touch-icon.png', '/icons/icon-192.png', '/icons/icon-512.png',
];

// Safari refuse une réponse « redirigée » servie par le service worker : on la recopie.
async function clean(res) {
  if (!res || !res.redirected) return res;
  const body = await res.blob();
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const c = await caches.open(VERSION);
    for (const url of SHELL) {
      try { const res = await fetch(url, { cache: 'reload' }); if (res.ok) await c.put(url, await clean(res)); } catch { /* hors ligne */ }
    }
    await self.skipWaiting();
  })());
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

  // Navigation : réseau d'abord (toujours la dernière version), copie en cache pour le hors-ligne
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const res = await clean(await fetch('/', { cache: 'no-store' }));
        if (res.ok) { const c = await caches.open(VERSION); await c.put('/', res.clone()); }
        return res;
      } catch {
        return (await caches.match('/')) || Response.error();
      }
    })());
    return;
  }

  // Fichiers : cache d'abord, mis à jour en arrière-plan
  event.respondWith((async () => {
    const cached = await caches.match(req);
    const network = fetch(req).then(async (res) => {
      res = await clean(res);
      if (res.ok && res.type === 'basic') { const c = await caches.open(VERSION); await c.put(req, res.clone()); }
      return res;
    }).catch(() => cached);
    return cached || network;
  })());
});
