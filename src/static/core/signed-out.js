if ("caches" in window) {
  caches.keys().then((keys) => Promise.all(keys.map((key) => caches.delete(key))));
}

navigator.serviceWorker
  ?.getRegistrations()
  .then((registrations) =>
    Promise.all(registrations.map((registration) => registration.unregister())),
  );

try {
  localStorage.clear();
  sessionStorage.clear();
} catch {}
