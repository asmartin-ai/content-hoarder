/* Service worker (Phase 2): installable + offline app shell.
   - static assets: cache-first (stale-while-revalidate)
   - navigation pages: network-first, fall back to cache when offline
   - data/API (and all POST): network only (never cached — must be fresh) */
const CACHE = "ch-shell-v114"; // v114: reddit unsave in v3 row menu + bulk tray
const SHELL = [
  "/",
  "/triage",
  "/reddit",
  // v3 browse shell (what "/" actually loads) — was stale, still listed the v2 app.js
  "/static/tokens.css",
  "/static/theme.js",
  "/static/haptics.js",
  "/static/core/tokens.css",
  "/static/core/util.js",
  "/static/core/api.js",
  "/static/core/toast.js",
  "/static/core/media.js",
  "/static/core/swipe.js",
  "/static/core/render.js",
  "/static/core/icons.js",
  "/static/core/tags.js",
  "/static/core/overlaynav.js",
  "/static/core/markdown.js", // reader dependency (browse/reader.js:20) — was missing, broke offline reader
  "/static/browse/browse.css",
  "/static/browse/main.js",
  "/static/browse/render.js",
  "/static/browse/reader.js",
  "/static/browse/tagedit.js",
  "/static/browse/prefetch.js",
  "/static/browse/palette.js",
  "/static/browse/operators.js",
  // /triage now loads triage.js as an ES module (imports core/util, core/api, core/icons)
  "/static/app.css",
  "/static/triage.js",
  "/static/reddit.css",
  "/static/reddit.js",
  "/static/vendor/hls.min.js",
  "/static/icon.svg",
  "/static/icon-192.png",
  "/static/icon-512.png",
  "/manifest.webmanifest",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return; // POST etc. -> network
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // cross-origin -> network

  const isStatic =
    url.pathname.startsWith("/static/") ||
    url.pathname === "/manifest.webmanifest";
  const isPage = req.mode === "navigate";

  if (isStatic) {
    e.respondWith(
      caches.match(req).then(
        (cached) =>
          cached ||
          fetch(req)
            .then((res) => {
              if (res && res.ok) {
                const copy = res.clone();
                caches.open(CACHE).then((c) => c.put(req, copy));
              }
              return res;
            })
            // Uncached + offline: reject → raw browser error. Return 504 so the
            // caller sees a controlled failure instead of an unhandled rejection.
            .catch(() => new Response("", { status: 504, statusText: "Gateway Offline" })),
      ),
    );
    return;
  }

  if (isPage) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
          return res;
        })
        // Cache miss + offline: fall back to the cached app shell so the user
        // sees the PWA instead of the browser's raw network-error page.
        .catch(() => caches.match(req).then((m) => m || caches.match("/"))),
    );
    return;
  }
  // data/API: default to network (no respondWith)
});
