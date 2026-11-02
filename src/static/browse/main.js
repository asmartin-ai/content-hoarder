import * as api from "../core/api.js";
import { toast } from "../core/toast.js";
import { wireTagExpanders } from "../core/render.js";
import { setArchivePref } from "../core/media.js";
import { itemsEl, restoreView, state } from "./shared.js";
import { render } from "./feed.js";
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

import "./actions.js";
import "./lightbox.js";
import "./relay.js";
import "./drawer.js";
import "./panels.js";

wireTagExpanders(itemsEl);

restoreView();

syncSortControl();

function reapplyStoredPrefs() {
  const density = localStorage.chDensity || "comfortable";
  const safe = localStorage.chSafe !== "0";
  const archiveMedia = localStorage.chArchiveMedia === "1";

  if (density === state.density && safe === state.safe && archiveMedia === state.archiveMedia)
    return;

  const safeChanged = safe !== state.safe;

  state.density = density;
  state.safe = safe;
  state.archiveMedia = archiveMedia;
  setArchivePref(archiveMedia);

  if (safeChanged) {
    refreshRail();
    loadItems(true);

    return;
  }

  render();
}

window.addEventListener("pageshow", (event) => {
  if (event.persisted) reapplyStoredPrefs();
});

window.addEventListener("storage", (event) => {
  if (event.key === "chDensity" || event.key === "chSafe" || event.key === "chArchiveMedia")
    reapplyStoredPrefs();
});

if (window.visualViewport) {
  const vv = window.visualViewport;

  const syncKeyboard = () => {
    const hidden = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);

    document.documentElement.style.setProperty("--kb", Math.round(hidden) + "px");
  };

  vv.addEventListener("resize", syncKeyboard);
  vv.addEventListener("scroll", syncKeyboard);
}

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
    console.warn("Service worker registration failed (needs HTTPS or localhost):", err);
  });

(function autoSyncOnOpen() {
  let lastPing = 0;

  async function ping() {
    const now = Date.now();

    if (now - lastPing < 60000) return;
    lastPing = now;

    try {
      const data = await api.postJSON("/reddit/sync/auto", {});

      if (!data || data.skipped) return;

      const r = data.result || {},
        rec = r.reconcile || {};

      if ((r.new || 0) > 0 || (rec.unsaved || 0) > 0 || (rec.promoted_done || 0) > 0) {
        clearItemFirstPageCache();
        loadItems(true);
        loadCounts();
        refreshRail();
        refreshPulse();
      }
    } catch {}
  }

  ping();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") ping();
  });
})();

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
      if ((document.documentElement.dataset.theme || "dark") !== "dark") window.toggleTheme?.();
    },
  },
  {
    label: "Theme: light",
    hint: "view",
    run: () => {
      if ((document.documentElement.dataset.theme || "dark") !== "light") window.toggleTheme?.();
    },
  },
  {
    label: "Density: comfortable",
    hint: "view",
    run: () => {
      state.density = "comfortable";
      localStorage.chDensity = state.density;
      render();
    },
  },
  {
    label: "Density: compact",
    hint: "view",
    run: () => {
      state.density = "compact";
      localStorage.chDensity = state.density;
      render();
    },
  },
  {
    label: "Density: card",
    hint: "view",
    run: () => {
      state.density = "card";
      localStorage.chDensity = state.density;
      render();
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
