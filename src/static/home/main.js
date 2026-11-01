/* home/main.js — boot for the server-rendered Today and Clear pages (clear-v2.md §3, §6):
   mounts the round island on Clear, htmx glue (ch:toast → undo snackbar), theme toggle,
   Enter-to-start on Today, service worker, PWA-open autosync. */

import { postJSON } from "../core/api.js";
import { isTypingTarget } from "../core/util.js";
import { snackbar } from "../core/toast.js";

const page = document.body.dataset.page;

/* Old deep link: /?deck=1 opened the deck; rounds replace it. */
if (location.pathname === "/" && new URLSearchParams(location.search).has("deck"))
  location.replace("/clear");

if (page === "clear") {
  import("./round.js").then(({ mountRound }) => mountRound(document.querySelector(".round")));
}

/* Server responses announce results with `HX-Trigger: {"ch:toast": {msg, undo?}}`; htmx 2
   dispatches the payload object itself as `event.detail` (plus `elt`). */
document.body.addEventListener("ch:toast", (e) => {
  const detail = e.detail || {};
  const undo = detail.undo;

  if (!detail.msg) return;

  if (!undo || !undo.post) {
    snackbar(detail.msg, null);

    return;
  }

  window.chHaptic?.("archived");
  snackbar(detail.msg, () => {
    window.chHaptic?.("undo");
    window.htmx?.ajax("POST", undo.post, {
      values: undo.vals || {},
      target: undo.target,
      swap: "outerHTML",
    });
  });
});

/* Theme buttons rendered (or re-rendered by htmx) without theme.js's [data-theme-toggle] hook. */
document.addEventListener("click", (e) => {
  const t = e.target instanceof Element ? e.target.closest("#theme-toggle, .today-theme") : null;

  if (!t || t.hasAttribute("data-theme-toggle")) return;
  window.toggleTheme?.();
});

/* Today: Enter anywhere starts the round — unless typing or another control has focus. */
document.addEventListener("keydown", (e) => {
  if (page !== "today" || e.key !== "Enter" || e.defaultPrevented || e.repeat) return;

  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
  const t = e.target;

  if (isTypingTarget(t)) return;

  if (t instanceof Element && t.closest("button, a, [role=radio], [contenteditable]")) return;
  const go = document.getElementById("hero-go");

  if (!go) return;
  e.preventDefault();
  go.click();
});

/* Today: broken thumbnails (hotlink blocks, 404s) never show the broken-image icon: try
   data-fallback once, then a strip card becomes a text tile and a mosaic tile a glyph tile. */
const THUMBS = ".strip-card img, .pile-mosaic img";

function dropBrokenThumb(img) {
  const fallback = img.dataset.fallback;

  if (fallback) {
    img.removeAttribute("data-fallback");
    img.src = fallback;

    return;
  }

  const card = img.closest(".strip-card");

  if (card) {
    img.remove();
    card.classList.add("is-text");

    return;
  }

  const glyph = document.createElement("span");
  const mosaic = img.closest(".pile-mosaic");

  glyph.className = "pile-glyph";
  glyph.textContent =
    mosaic?.dataset.glyph ?? mosaic?.querySelector(".pile-glyph")?.textContent ?? "";
  img.replaceWith(glyph);
}

// Imgur serves a real 161×81 "image no longer available" PNG for deleted images.
const isImgurGone = (img) => img.naturalWidth === 161 && img.naturalHeight === 81;

if (page === "today") {
  // `error` does not bubble: one capture listener covers htmx-swapped rows too.
  document.addEventListener(
    "error",
    (e) => {
      const img = e.target;

      if (img instanceof HTMLImageElement && img.matches(THUMBS)) dropBrokenThumb(img);
    },
    true,
  );

  // `load` does not bubble either: catch Imgur's removed-image placeholder.
  document.addEventListener(
    "load",
    (e) => {
      const img = e.target;

      if (img instanceof HTMLImageElement && img.matches(THUMBS) && isImgurGone(img))
        dropBrokenThumb(img);
    },
    true,
  );

  // Thumbnails that already failed before this module ran.
  for (const img of document.querySelectorAll(THUMBS)) {
    if (!img.complete || !img.getAttribute("src")) continue;

    if (img.naturalWidth === 0 || isImgurGone(img)) dropBrokenThumb(img);
  }
}

if ("serviceWorker" in navigator)
  navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((err) => {
    // Service workers (and therefore PWA install) only work in a secure context:
    // HTTPS, or localhost/127.0.0.1. Plain HTTP over a LAN or Tailscale IP fails
    // here silently — surface it so the cause is visible. See docs/MOBILE_TAILSCALE.md.
    console.warn("Service worker registration failed (needs HTTPS or localhost):", err);
  });

/* ---- automatic Reddit saved-sync: the PWA-open half of the auto path (Epic 25). Fire-and-forget on
   boot + when the tab regains focus; the server DEBOUNCES (90s) and NO-OPs unless autosync is opted
   in, so this is safe to call freely. Silent: no toast, no view refresh (Today shows no inbox size). */
(function autoSyncOnOpen() {
  let lastPing = 0;

  function ping() {
    const now = Date.now();

    if (now - lastPing < 60000) return; // client guard; server debounce is the real gate
    lastPing = now;
    postJSON("/reddit/sync/auto", {}).catch(() => {
      /* offline / network — silent; retried on next focus */
    });
  }

  ping();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") ping();
  });
})();
