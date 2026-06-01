// Minimal service worker (Phase 1).
// Its presence + a fetch handler makes the app installable on Firefox for Android.
// Offline shell caching is a Phase 2 enhancement.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {
  // Network pass-through (no caching yet).
});
