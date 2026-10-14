// Service worker — guarda la calculadora para que abra sin internet.
// Estrategia: primero red, y si no hay conexión, la copia guardada.
const CACHE = 'donceles-v1';
const PRECACHE = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];
const NO_CACHE = /^\/(baugh|healthz)/;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('donceles-v1'.split('-v')[0]) && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const mismoOrigen = url.origin === self.location.origin;
  if (mismoOrigen && (!url.pathname.startsWith('/') || NO_CACHE.test(url.pathname))) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        // No se guarda una redirección al inicio de sesión ni una respuesta con error.
        const valida = res && (res.ok || res.type === 'opaque') && !(res.redirected && /\/login/.test(res.url));
        if (valida) {
          const copia = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copia)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: mismoOrigen }).then((r) => r || (req.mode === 'navigate' ? caches.match('/') : undefined)))
  );
});
