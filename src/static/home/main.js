import { postJSON } from "../core/api.js";
import { isTypingTarget } from "../core/util.js";
import { snackbar } from "../core/toast.js";
import { track } from "../core/track.js";

const page = document.body.dataset.page;

if (location.pathname === "/" && new URLSearchParams(location.search).has("deck"))
  location.replace("/clear");

if (page === "clear") {
  import("./round.js").then(({ mountRound }) => mountRound(document.querySelector(".round")));
}

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

const pileKind = (detail) => {
  try {
    return (
      detail.requestConfig?.parameters?.kind ||
      JSON.parse(detail.elt?.getAttribute?.("hx-vals") || "{}").kind ||
      ""
    );
  } catch {
    return "";
  }
};

document.body.addEventListener("htmx:afterRequest", (e) => {
  const detail = e.detail || {};

  if (document.body.dataset.analytics !== "1" || !detail.successful) return;
  const path = (detail.pathInfo?.requestPath || "").split("?")[0];

  if (path === "/hx/sweeps/apply") track("pile_apply", { kind: pileKind(detail) });
  else if (path === "/hx/sweeps/undo") track("pile_undo", {});
});

document.addEventListener("click", (e) => {
  const t = e.target instanceof Element ? e.target.closest("#theme-toggle, .today-theme") : null;

  if (!t || t.hasAttribute("data-theme-toggle")) return;
  window.toggleTheme?.();
});

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

const THUMBS = ".deck-card img, .pile-mosaic img";

function dropBrokenThumb(img) {
  const fallback = img.dataset.fallback;

  if (fallback) {
    img.removeAttribute("data-fallback");
    img.src = fallback;

    return;
  }

  const card = img.closest(".deck-card");

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

const isImgurGone = (img) => img.naturalWidth === 161 && img.naturalHeight === 81;

if (page === "today") {
  document.addEventListener(
    "error",
    (e) => {
      const img = e.target;

      if (img instanceof HTMLImageElement && img.matches(THUMBS)) dropBrokenThumb(img);
    },
    true,
  );

  document.addEventListener(
    "load",
    (e) => {
      const img = e.target;

      if (img instanceof HTMLImageElement && img.matches(THUMBS) && isImgurGone(img))
        dropBrokenThumb(img);
    },
    true,
  );

  for (const img of document.querySelectorAll(THUMBS)) {
    if (!img.complete || !img.getAttribute("src")) continue;

    if (img.naturalWidth === 0 || isImgurGone(img)) dropBrokenThumb(img);
  }
}

if ("serviceWorker" in navigator)
  navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((err) => {
    console.warn("Service worker registration failed (needs HTTPS or localhost):", err);
  });

(function autoSyncOnOpen() {
  const KEY = "ch.syncPing";

  function ping() {
    const now = Date.now();

    try {
      if (now - (Number(sessionStorage.getItem(KEY)) || 0) < 60000) return;
      sessionStorage.setItem(KEY, String(now));
    } catch {}

    postJSON("/reddit/sync/auto", {}).catch(() => {});
  }

  ping();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") ping();
  });
})();
