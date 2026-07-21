// Take over as soon as a new version lands. Safe here because this worker has no
// fetch handler, so there's no risk of serving mismatched assets to a page that's
// already loaded. Without this, an installed PWA that never fully closes could sit
// on the old notification behaviour for days.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  const data = event.data?.json() ?? {};
  event.waitUntil(
    self.registration.showNotification(data.title || 'Ankora', {
      body: data.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      requireInteraction: !!data.requireInteraction,
      vibrate: [300, 100, 300, 100, 500],
      // A tag lets a newer nudge quietly replace an older, un-tapped one.
      tag: data.tag || undefined,
      // Carried to the click handler so it knows where to send the user.
      data: { url: data.url || '/' },
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if ('focus' in client) {
          // App is already open: focus it and tell it to surface the check-in,
          // rather than reloading the tab (which would lose in-progress state).
          client.postMessage({ type: 'nudge-open', url: target });
          return client.focus();
        }
      }
      // Cold start: open the app at the nudge URL; it reads the pending nudge
      // from the cloud and opens the conversation itself.
      return clients.openWindow(target);
    })
  );
});
