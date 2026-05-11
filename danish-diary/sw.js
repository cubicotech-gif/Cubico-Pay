// Danish Diary — Service Worker
// Strategy: cache-first for app shell, stale-while-revalidate for fonts.
// Apps Script API calls bypass the cache.

const CACHE_VERSION = 'danish-diary-v1';
const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png',
  '/favicon-32.png'
];

// On install — pre-cache the app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) =>
      // Files that don't exist yet (icons) shouldn't break the install,
      // so add each individually and ignore failures.
      Promise.all(APP_SHELL.map((url) =>
        cache.add(url).catch(() => null)
      ))
    )
  );
  self.skipWaiting();
});

// On activate — clean up old cache versions
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== CACHE_VERSION)
          .map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// On fetch
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== 'GET') return;

  // Apps Script API calls must bypass the SW — its cross-domain redirect
  // (script.google.com → script.googleusercontent.com) can stall when
  // proxied through cacheFirst on iOS PWA mode.
  if (url.hostname === 'script.google.com' ||
      url.hostname === 'script.googleusercontent.com') return;

  // Stale-while-revalidate for Google Fonts
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  // Cache-first for everything else (the app shell)
  event.respondWith(cacheFirst(request));
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok && response.type === 'basic') {
      const cache = await caches.open(CACHE_VERSION);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    const fallback = await caches.match('/index.html');
    if (fallback) return fallback;
    return new Response('Offline', { status: 503, statusText: 'Offline' });
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match(request);
  const networkPromise = fetch(request)
    .then((response) => {
      if (response && response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => cached);
  return cached || networkPromise;
}

// ============================================================
// PUSH NOTIFICATIONS — handler stub (Phase 2)
// ============================================================
// When push is wired up later, the backend will send a payload like
// { title: 'Aging reminder', body: '3 people overdue', url: '/' }
// and this handler shows it as a system notification. Frontend
// subscription flow + Apps Script trigger to actually fire them
// still need to be added.
self.addEventListener('push', (event) => {
  if (!event.data) return;
  let data = {};
  try { data = event.data.json(); } catch (e) { data = { title: 'Diary', body: event.data.text() }; }
  event.waitUntil(self.registration.showNotification(data.title || 'Danish Diary', {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: data.url || '/' }
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
