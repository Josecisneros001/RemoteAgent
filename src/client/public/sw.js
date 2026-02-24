// Service Worker for Push Notifications
self.addEventListener('push', (event) => {
  console.log('[SW] Push event received:', event.data ? 'has data' : 'no data');

  if (!event.data) return;

  let data;
  try {
    data = event.data.json();
    console.log('[SW] Push payload parsed:', data.title);
  } catch (e) {
    console.error('[SW] Failed to parse push payload:', e);
    return;
  }

  const options = {
    body: data.body,
    icon: '/icon-192.svg',
    badge: '/icon-192.svg',
    vibrate: [200, 100, 200],
    data: data.data,
    tag: data.data?.test ? 'test-notification' : undefined,
    renotify: true,
    requireInteraction: false,
    actions: [
      { action: 'view', title: 'View' },
      { action: 'dismiss', title: 'Dismiss' },
    ],
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
      .then(() => console.log('[SW] showNotification succeeded'))
      .catch((err) => console.error('[SW] showNotification failed:', err))
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  if (event.action === 'dismiss') return;

  const runId = event.notification.data?.runId;
  const url = runId ? `/?run=${runId}` : '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // If a window is already open, focus it
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      // Otherwise open a new window
      return clients.openWindow(url);
    })
  );
});

// No caching — skip waiting and claim clients immediately
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Clear any previously cached data
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});
