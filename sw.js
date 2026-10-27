// Service worker : app installable + coquille dispo hors ligne.
// Réseau d'abord (pour toujours avoir la dernière version), cache en secours.
const CACHE = 'travail-v18';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'time.js', 'manifest.webmanifest', 'icons/icon-192.png', 'planning.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Ne jamais mettre en cache les données Supabase
  if (url.hostname.endsWith('supabase.co')) return;
  const sameOrigin = url.origin === self.location.origin;
  const isLib = url.hostname === 'cdn.jsdelivr.net';
  if (!sameOrigin && !isLib) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((r) => r || caches.match('index.html')))
  );
});

// Notification "fin de pause" envoyée par le serveur
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Fin de pause', {
    body: d.body || 'Ta pause est terminée',
    tag: d.tag || 'pause',
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    vibrate: [300, 150, 300, 150, 300],
    requireInteraction: true,
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (all.length) return all[0].focus();
    return self.clients.openWindow('./');
  })());
});
