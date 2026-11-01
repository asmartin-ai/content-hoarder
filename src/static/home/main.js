/* home/main.js — boot for the Today + Clear page (home.html): client-side routing between
   "/" (Today) and "/clear" (a round), shared nav wiring, service worker, PWA-open autosync.
   Contract: docs/design/clear-overhaul.md §4. */

import { postJSON } from "../core/api.js";
import { mountRound } from "./round.js";
import { mountToday } from "./today.js";

const ROUTES = { "/": mountToday, "/clear": mountRound };

const TITLES = { "/": "Today · content-hoarder", "/clear": "Clear · content-hoarder" };

const view = document.getElementById("view");

let current = null;

const ctx = { go };

function mount() {
  const path = location.pathname;
  const fn = ROUTES[path] || mountToday;

  if (current) {
    try {
      current.unmount();
    } catch (err) {
      console.error(err);
    }

    current = null;
  }

  document.body.classList.toggle("is-round", path === "/clear");
  document.querySelectorAll(".ch-tab").forEach((tab) => {
    const active =
      (tab.dataset.tab === "today" && path === "/") ||
      (tab.dataset.tab === "clear" && path === "/clear");

    if (active) tab.setAttribute("aria-current", "page");
    else tab.removeAttribute("aria-current");
  });

  if (TITLES[path]) document.title = TITLES[path];
  view.innerHTML = "";

  try {
    current = fn(view, ctx);
  } catch (err) {
    console.error(err);
    view.innerHTML =
      '<p class="sec-sub today-err">Something went sideways. Reload to try again.</p>';
  }
}

/* Client-side navigation between "/" and "/clear?…"; anything else is a real page load. */
function go(path, opts) {
  const url = new URL(path, location.href);

  if (url.origin !== location.origin || !ROUTES[url.pathname]) {
    location.href = url.href;

    return;
  }

  const same = url.href === location.href;

  if ((opts && opts.replace) || same) history.replaceState(null, "", url.href);
  else history.pushState(null, "", url.href);
  mount();
  window.scrollTo(0, 0);
}

/* Old deep link: /?deck=1 opened the deck; rounds replace it. */
if (location.pathname === "/" && new URLSearchParams(location.search).has("deck"))
  history.replaceState(null, "", "/clear");

document.body.classList.add("has-tabbar");

document.addEventListener("click", (e) => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
    return;
  const t = e.target;

  if (!(t instanceof Element)) return;
  const link = t.closest('.ch-tab[data-tab="today"], .ch-tab[data-tab="clear"], .ch-brand');

  if (!link) return;
  e.preventDefault();
  go(link.getAttribute("href") || "/");
});

document.getElementById("theme-toggle")?.addEventListener("click", () => window.toggleTheme?.());

window.addEventListener("popstate", mount);

mount();

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
