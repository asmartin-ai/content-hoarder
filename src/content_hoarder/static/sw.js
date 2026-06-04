/* Service worker (Phase 2): installable + offline app shell.
   - static assets: cache-first (stale-while-revalidate)
   - navigation pages: network-first, fall back to cache when offline
   - data/API (and all POST): network only (never cached — must be fresh) */
const CACHE = "ch-shell-v7";
const SHELL = [
  "/", "/triage",
  "/static/app.css", "/static/app.js", "/static/triage.js",
  "/static/icon.svg", "/static/icon-192.png", "/static/icon-512.png",
  "/manifest.webmanifest",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;                 // POST etc. -> network
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;  // cross-origin -> network

  const isStatic = url.pathname.startsWith("/static/") || url.pathname === "/manifest.webmanifest";
  const isPage = url.pathname === "/" || url.pathname === "/triage";

  if (isStatic) {
    e.respondWith(
      caches.match(req).then((cached) =>
        cached || fetch(req).then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
      )
    );
    return;
  }

  if (isPage) {
    e.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }
  // data/API: default to network (no respondWith)
});
