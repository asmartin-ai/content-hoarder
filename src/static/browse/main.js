/* browse/main.js — v3 browse page entry (Epic 20 Stage C).
   Spec: 05-log-book-2.html + 06-adhd-round.html (LOCKED 2026-06-11).
   Entry point only: the surface itself lives in the sibling browse modules (shared
   state, data, feed, actions, lightbox, relay, nav, drawer, chrome, ambient, panels,
   instances). Each of those installs its own DOM listeners when it is evaluated; this
   file imports them in dependency order, then runs the boot sequence. */

import * as api from "../core/api.js";
import { toast } from "../core/toast.js";
import { wireTagExpanders } from "../core/render.js";
import { $, itemsEl, restoreView } from "./shared.js";
import {
  clearItemFirstPageCache,
  loadCounts,
  loadItems,
  refreshPulse,
  refreshRail,
} from "./data.js";
import { loadAmbient } from "./ambient.js";
import { readerUI } from "./instances.js";
import { paintChips, paintTabs, qInput, sortSel, syncSortControl } from "./nav.js";
import { initPalette } from "./palette.js";

/* modules main.js does not otherwise reach into: they wire their own listeners */
import "./actions.js";
import "./lightbox.js";
import "./relay.js";
import "./drawer.js";
import "./panels.js";

wireTagExpanders(itemsEl);

restoreView();

syncSortControl();

async function openDeepLinkedReader() {
  const qs = new URLSearchParams(location.search);
  const fn = qs.get("open");

  if (!fn) return;

  try {
    const item = await api.fetchItem(fn);
    const fromClear = qs.get("from") === "clear";
    let triageEnter = false;

    if (fromClear) {
      try {
        triageEnter =
          qs.get("enter") === "up" || sessionStorage.getItem("ch_clear_reader_enter") === fn;
        sessionStorage.removeItem("ch_clear_reader_enter");
      } catch {
        triageEnter = qs.get("enter") === "up";
      }

      if (qs.get("enter")) {
        qs.delete("enter");
        history.replaceState(
          history.state,
          "",
          location.pathname + "?" + qs.toString() + location.hash,
        );
      }
    }

    readerUI.open(item, { from: fromClear ? "clear" : "", triageEnter });
  } catch {
    toast("Couldn't open that item.");
  }
}

/* ---- boot ---- */
paintTabs();

paintChips();

refreshRail();

loadCounts();

refreshPulse();

loadAmbient();

loadItems(true);

openDeepLinkedReader();

if ("serviceWorker" in navigator)
  navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((err) => {
    // Service workers (and therefore PWA install) only work in a secure context:
    // HTTPS, or localhost/127.0.0.1. Plain HTTP over a LAN or Tailscale IP fails
    // here silently — surface it so the cause is visible. See docs/MOBILE_TAILSCALE.md.
    console.warn("Service worker registration failed (needs HTTPS or localhost):", err);
  });

/* ---- automatic Reddit saved-sync: the PWA-open half of the auto path (Epic 25). Fire-and-forget on
   boot + when the tab regains focus; the server DEBOUNCES (90s) and NO-OPs unless autosync is opted
   in, so this is safe to call freely. Quietly refreshes the view when a sync actually imported or
   reconciled something — never interrupts the user with a toast. The background scheduler funnels into
   the same /reddit/sync/auto -> auto_sync path. */
(function autoSyncOnOpen() {
  let lastPing = 0;

  async function ping() {
    const now = Date.now();

    if (now - lastPing < 60000) return; // client guard; server debounce is the real gate
    lastPing = now;

    try {
      const data = await api.postJSON("/reddit/sync/auto", {});

      if (!data || data.skipped) return; // disabled / debounced -> nothing changed

      const r = data.result || {},
        rec = r.reconcile || {};

      if ((r.new || 0) > 0 || (rec.unsaved || 0) > 0 || (rec.promoted_done || 0) > 0) {
        clearItemFirstPageCache();
        loadItems(true);
        loadCounts();
        refreshRail();
        refreshPulse();
      }
    } catch {
      /* offline / network — silent; retried on next focus */
    }
  }

  ping();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") ping();
  });
})();

/* ---- command palette (locked Epic 20: ">" flips search to command mode) ---- */
initPalette(qInput, [
  {
    label: "Start a round",
    hint: "page",
    run: () => location.assign("/clear"),
  },
  {
    label: "Go to Reddit saved",
    hint: "page",
    run: () => location.assign("/reddit"),
  },
  {
    label: "Theme: dark",
    hint: "view",
    run: () => {
      const b = $('#set-theme [data-theme="dark"]');

      if (b) b.click();
    },
  },
  {
    label: "Theme: light",
    hint: "view",
    run: () => {
      const b = $('#set-theme [data-theme="light"]');

      if (b) b.click();
    },
  },
  {
    label: "Density: comfortable",
    hint: "view",
    run: () => {
      const b = $('#set-density [data-d="comfortable"]');

      if (b) b.click();
    },
  },
  {
    label: "Density: compact",
    hint: "view",
    run: () => {
      const b = $('#set-density [data-d="compact"]');

      if (b) b.click();
    },
  },
  {
    label: "Density: card",
    hint: "view",
    run: () => {
      const b = $('#set-density [data-d="card"]');

      if (b) b.click();
    },
  },
  {
    label: "Sort: newest saved",
    hint: "sort",
    run: () => {
      sortSel.value = "first_seen_utc:desc";
      sortSel.dispatchEvent(new Event("change"));
    },
  },
  {
    label: "Sort: oldest post",
    hint: "sort",
    run: () => {
      sortSel.value = "created_utc:asc";
      sortSel.dispatchEvent(new Event("change"));
    },
  },
  {
    label: "Sort: shortest",
    hint: "sort",
    run: () => {
      sortSel.value = "duration:asc";
      sortSel.dispatchEvent(new Event("change"));
    },
  },
]);
