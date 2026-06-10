self.addEventListener('push', event => {
  const data = event.data?.json() ?? {};
  event.waitUntil(
    self.registration.showNotification(data.title || 'Addie', {
      body: data.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      requireInteraction: !!data.requireInteraction,
      vibrate: [300, 100, 300, 100, 500],
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      if (list.length) return list[0].focus();
      return clients.openWindow('/');
    })
  );
});
