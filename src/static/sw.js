/* Service worker (Phase 2): installable + offline app shell.
   - static assets: cache-first (stale-while-revalidate)
   - navigation pages: network-first, fall back to cache when offline
   - data/API (and all POST): network only (never cached — must be fresh) */
const CACHE = "ch-shell-v143"; // v143: deck pass — community paper, card-sized stage, Bricolage

const SHELL = [
  "/",
  "/clear",
  "/library",
  "/static/core/nav.css",
  // Today + Clear shell ("/" and "/clear")
  "/static/home/home.css",
  "/static/home/today.css",
  "/static/home/clear.css",
  "/static/core/ring.js",
  "/static/home/main.js",
  "/static/home/round.js",
  "/static/vendor/htmx.min.js",
  // Library browse shell ("/library")
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
  "/static/core/markdown.js", // reader dependency (browse/reader.js:20)
  "/static/browse/browse.css",
  "/static/browse/main.js",
  "/static/browse/shared.js",
  "/static/browse/data.js",
  "/static/browse/feed.js",
  "/static/browse/actions.js",
  "/static/browse/lightbox.js",
  "/static/browse/relay.js",
  "/static/browse/nav.js",
  "/static/browse/drawer.js",
  "/static/browse/chrome.js",
  "/static/browse/ambient.js",
  "/static/browse/panels.js",
  "/static/browse/instances.js",
  "/static/browse/render.js",
  "/static/browse/reader.js",
  "/static/browse/tagedit.js",
  "/static/browse/prefetch.js",
  "/static/browse/palette.js",
  "/static/browse/operators.js",
  "/static/browse/fastscroll.js",
  "/static/vendor/hls.min.js",
  "/static/apple-touch-icon.png",
  "/static/apple-touch-startup-image-1290x2796.png",
  "/static/apple-touch-startup-image-1179x2556.png",
  "/static/apple-touch-startup-image-1170x2532.png",
  "/static/apple-touch-startup-image-1080x2340.png",
  "/static/apple-touch-startup-image-750x1334.png",
  "/static/apple-touch-startup-image-640x1136.png",
  "/static/apple-touch-startup-image-2048x2732.png",
  "/static/apple-touch-startup-image-1668x2388.png",
  "/static/apple-touch-startup-image-1668x2224.png",
  "/static/apple-touch-startup-image-1536x2048.png",
  "/static/apple-touch-startup-image-1488x2266.png",
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
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;

  if (req.method !== "GET") return; // POST etc. -> network
  const url = new URL(req.url);

  if (url.origin !== self.location.origin) return; // cross-origin -> network

  const isStatic = url.pathname.startsWith("/static/") || url.pathname === "/manifest.webmanifest";

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
        // Cache miss + offline: fall back to this page's own cached shell (ignoring the
        // query, e.g. /library?open=…), then "/", so the user sees the PWA instead of the
        // browser's raw network-error page.
        .catch(() =>
          caches
            .match(req, { ignoreSearch: true })
            .then(
              (m) =>
                m ||
                caches.match(
                  url.pathname === "/clear" || url.pathname === "/library" ? url.pathname : "/",
                ),
            )
            .then((m) => m || caches.match("/")),
        ),
    );

    return;
  }
  // data/API: default to network (no respondWith)
});
