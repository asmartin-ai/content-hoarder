const CACHE = "ch-shell-v154";

const SHELL = [
  "/",
  "/home",
  "/clear",
  "/library",
  "/add",
  "/settings",
  "/static/core/nav.css",
  "/static/home/home.css",
  "/static/home/today.css",
  "/static/home/orient.css",
  "/static/home/clear.css",
  "/static/add/add.css",
  "/static/add/add.js",
  "/static/core/ring.js",
  "/static/home/main.js",
  "/static/home/ai-consent.js",
  "/static/home/settings.js",
  "/static/home/round.js",
  "/static/vendor/htmx.min.js",
  "/static/theme.js",
  "/static/haptics.js",
  "/static/core/tokens.css",
  "/static/core/util.js",
  "/static/core/api.js",
  "/static/core/toast.js",
  "/static/core/track.js",
  "/static/core/media.js",
  "/static/core/swipe.js",
  "/static/core/render.js",
  "/static/core/icons.js",
  "/static/core/tags.js",
  "/static/core/overlaynav.js",
  "/static/core/markdown.js",
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
  "/static/apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) =>
        Promise.all(SHELL.map((u) => c.add(new Request(u, { cache: "reload" })).catch(() => {}))),
      )
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

  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (url.origin !== self.location.origin) return;

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
            .catch(() => new Response("", { status: 504, statusText: "Gateway Offline" })),
      ),
    );

    return;
  }

  if (isPage) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok && !res.redirected) {
            const copy = res.clone();

            caches.open(CACHE).then((c) => c.put(url.origin + url.pathname, copy));
          }

          return res;
        })
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
});
