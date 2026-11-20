/* Antigravity Bridge Service Worker */

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Network-first passthrough fetch handler (ensures full PWA installability criteria)
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(fetch(event.request));
});

self.addEventListener('push', (event) => {
  let data = {
    title: 'Antigravity IDE',
    body: 'Nueva solicitud pendiente de revisión',
    url: '/'
  };

  if (event.data) {
    try {
      data = { ...data, ...event.data.json() };
    } catch {
      data.body = event.data.text();
    }
  }

  const options = {
    body: data.body,
    icon: '/icon.svg',
    badge: '/icon.svg',
    tag: data.tag || `agy-${Date.now()}`,
    renotify: true,
    requireInteraction: Boolean(data.requireInteraction),
    vibrate: [180, 80, 180],
    actions: Array.isArray(data.actions) ? data.actions : [],
    data: {
      url: data.url || '/',
      requestId: data.requestId || null,
      apiToken: data.apiToken || null,
      serverUrl: data.serverUrl || ''
    }
  };

  event.waitUntil(self.registration.showNotification(data.title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const { action } = event;
  const { url, requestId, apiToken, serverUrl } = event.notification.data || {};
  const apiBase = (serverUrl || '').replace(/\/+$/, '');

  // Handle direct Approve / Reject action buttons from notification banner (Android/Desktop)
  if ((action === 'approve' || action === 'reject') && requestId && apiToken) {
    const decision = action === 'approve' ? 'approved' : 'rejected';
    event.waitUntil(
      fetch(`${apiBase}/api/requests/${encodeURIComponent(requestId)}/decide`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiToken}`
        },
        body: JSON.stringify({
          decision,
          reason:
            decision === 'approved'
              ? 'Aprobado desde notificación push'
              : 'Rechazado desde notificación push'
        })
      }).catch(() => {
        // If background fetch fails, open the app so user can confirm manually
        return self.clients.openWindow(url || '/');
      })
    );
    return;
  }

  // Default tap: focus existing PWA window or open it
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.navigate(url || '/');
          return client.focus();
        }
      }
      return self.clients.openWindow(url || '/');
    })
  );
});
