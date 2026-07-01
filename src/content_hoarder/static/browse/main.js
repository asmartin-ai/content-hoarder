/* browse/main.js — v3 browse page entry (Epic 20 Stage C).
   Spec: 05-log-book-2.html + 06-adhd-round.html (LOCKED 2026-06-11).
   State, fetching, infinite scroll / Focus batches, keyboard, swipe, bulk,
   the ambient resurfacing slot, win pebbles, and the settings panel. */

import { esc, debounce, isTypingTarget } from "../core/util.js";
import * as api from "../core/api.js";
import { toast, snackbar } from "../core/toast.js";
import {
  createLightbox,
  imageUrl,
  imageUrls,
  redditUrl,
  playableVideoSrc,
  localUrl,
  canRecoverArchiveToday,
  archiveTodayConfirmText,
  setArchivePref,
  thumb,
  mediaType,
} from "../core/media.js";
import { attachSwipe } from "../core/swipe.js";
import {
  wireTagExpanders,
  shareItem,
  itemUrl,
  metaLine,
  CH_SOURCES,
  srcAccent,
} from "../core/render.js";
import { listHtml, emptyHtml, isNsfw } from "./render.js";
import { canOpenInReader, initReader } from "./reader.js";
import { initPalette } from "./palette.js";
import { initOperators } from "./operators.js";
import { initTagEditor } from "./tagedit.js";
import {
  PREFETCH_LIMITS,
  buildFirstPageWarmParams,
  createFirstPageCache,
  createFirstPagePrefetcher,
} from "./prefetch.js";

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

/* ---- state ---- */
const state = {
  status: "inbox",
  source: "",
  category: "",
  tags: [],
  q: "",
  exact: false,
  sort: localStorage.chSort || "first_seen_utc:desc",
  density: localStorage.chDensity || "comfortable",
  focus: localStorage.chFocus === "1",
  safe: localStorage.chSafe !== "0", // default ON: hide NSFW unless the user opted into "Show all"
  archiveMedia: localStorage.chArchiveMedia === "1", // default OFF: prefer local /media copies (Epic 4 P1)
  goal:
    localStorage.chGoal === undefined
      ? 8
      : parseInt(localStorage.chGoal, 10) || 0,
  offset: 0,
  hasMore: false,
  loading: false,
  items: [],
  batchTotal: 0, // Focus: size of the dealt batch
  batchCleared: 0, // Focus: cleared from THIS batch (session-local)
  stamped: false, // Focus: celebration shown for this batch
  curated: new Set(),
  pulse: { new_today: 0, cleared_today: 0, swept_recent: 0 },
};
const FOCUS_BATCH = 25;
/* Per-tab sort memory (Epic 10 / item 412): each status tab remembers its own sort, and the
   "All" view (status "") defaults to the learned easy-to-triage "smart" sort. Falls back to the
   legacy global chSort, then newest-saved. (smart degrades to recency until triage_score is
   learned, so it's safe on an untrained DB — see db._order_clause NULLS LAST.) */
const SORT_DEFAULT = "first_seen_utc:desc";
const SORT_BY_TAB = { "": "smart:desc" };
const sortKey = (status) => "chSort:" + (status || "all");
function sortForTab(status) {
  try {
    const v = localStorage.getItem(sortKey(status));
    if (v) return v;
  } catch (e) {}
  return SORT_BY_TAB[status] || localStorage.chSort || SORT_DEFAULT;
}
setArchivePref(state.archiveMedia); // tell core/media.js whether to prefer local /media copies
const nsfwRevealed = new Set();
const itemsEl = $("#items");
const doneRetention = {
  loaded: false,
  loading: false,
  days: 30,
  preview: null,
};

/* ---- mobile "Jump" drawer state (the phone expression of the .rail) ---- */
const drawer = $("#navdrawer");
let facets = { sources: [], categories: [], tags: [], groups: [] };
let navFilter = "";
let managing = false;
const loadJSON = (k, f) => {
  try {
    const v = JSON.parse(localStorage.getItem(k));
    return v ?? f;
  } catch (e) {
    return f;
  }
};
const saveSet = (k, s) => {
  try {
    localStorage.setItem(k, JSON.stringify([...s]));
  } catch (e) {}
};
const pins = new Set(loadJSON("chDrawerPins", []));
const hiddenGroups = new Set(loadJSON("chDrawerHidden", []));
const collapsed = new Set(loadJSON("chDrawerCollapsed", []));

const COPY = {
  keep: "Kept — filed, worth revisiting.",
  archived: "Archived — set aside, out of the way.",
  done: "Done — finished with it.",
  inbox: "Back in the inbox.",
};

/* ---- fetching + rendering ---- */
function params(extra) {
  const p = {
    sort: state.sort.split(":")[0],
    order: state.sort.split(":")[1],
    ...extra,
  };
  if (state.status) p.status = state.status;
  if (state.source) p.source = state.source;
  if (state.category) p.category = state.category;
  if (state.q) p.q = state.q;
  if (state.exact) p.exact = "1";
  if (state.safe) p.safe = "1";
  const sp = new URLSearchParams(p);
  state.tags.forEach((t) => sp.append("tag", t));
  return sp;
}

const itemFirstPageCache = createFirstPageCache();
const itemFirstPagePrefetch = createFirstPagePrefetcher({
  cache: itemFirstPageCache,
  fetchJSON: (url, opts) => api.getJSON(url, opts),
});
const TOP_PREFETCH_SORTS = [
  "smart:desc",
  "first_seen_utc:desc",
  "created_utc:desc",
];

function topSourceIds() {
  return facets.sources.map((s) => s && s.id).filter(Boolean);
}

function warmItemFirstPages() {
  const warmParams = buildFirstPageWarmParams(
    {
      status: state.status,
      source: state.source,
      category: state.category,
      tags: state.tags,
      q: state.q,
      exact: state.exact,
      safe: state.safe,
      focus: state.focus,
      sort: state.sort,
    },
    topSourceIds(),
    TOP_PREFETCH_SORTS,
    PREFETCH_LIMITS,
  );
  if (!warmParams.length) {
    itemFirstPagePrefetch.abort();
    return;
  }
  itemFirstPagePrefetch.warm(warmParams);
}

function clearItemFirstPageCache() {
  itemFirstPagePrefetch.clear();
}

let loadGen = 0;
async function loadItems(reset) {
  // an append during a load is a duplicate; a RESET supersedes whatever is in
  // flight (generation check below — otherwise clearing a slow search drops the
  // user's newest intent on the floor)
  if (!reset && state.loading) return;
  const gen = ++loadGen;
  state.loading = true;
  if (reset) itemFirstPagePrefetch.abort();
  if (reset) {
    state.offset = 0;
    state.items = [];
    state.batchCleared = 0;
    state.stamped = false;
    saveView(); // persist the active view so a reload/return keeps your place
    // keep the current rows on screen (dimmed) during a refetch — only blank to the skeleton on a
    // cold start, so changing filter/sort/status/source no longer flashes the whole list away
    if (itemsEl.querySelector("[data-fullname]"))
      itemsEl.classList.add("loading");
    else itemsEl.innerHTML = '<div class="skeleton">FETCHING…</div>';
  }
  try {
    const limit = state.focus ? FOCUS_BATCH : 50;
    const offset = state.offset;
    const query = params({ limit, offset });
    let r = itemFirstPageCache.get(query);
    const fromCache = !!r;
    if (!r) {
      r = await api.getJSON("/items?" + query);
    }
    if (gen !== loadGen) return; // a newer load superseded this one
    if (!fromCache) itemFirstPageCache.set(query, r);
    state.items = state.items.concat(r.items);
    state.hasMore = state.focus ? false : r.has_more;
    state.offset += r.items.length;
    if (reset && state.focus) state.batchTotal = r.items.length;
    render();
    if (reset) warmItemFirstPages();
  } catch (e) {
    if (gen === loadGen) {
      itemsEl.classList.remove("loading");
      itemsEl.innerHTML =
        '<div class="skeleton">COULDN’T LOAD — IS THE SERVER UP?</div>';
    }
  } finally {
    if (gen === loadGen) state.loading = false;
  }
}

function render() {
  itemsEl.className = "items density-" + state.density;
  syncSelectionToVisibleItems();
  paintBulk();
  if (!state.items.length) {
    itemsEl.innerHTML = emptyHtml(state.focus);
    paintBatch();
    return;
  }
  itemsEl.innerHTML = listHtml(state.items, state, {
    view: state.status,
    curated: state.curated,
    nsfwRevealed: false,
  });
  // re-apply transient row state + attach swipe per row (touch-only inside attachSwipe)
  $$(".row, .pin").forEach((row) => {
    const fn = row.dataset.fullname;
    if (selected.has(fn)) row.classList.add("selected");
    if (nsfwRevealed.has(fn)) {
      row
        .querySelectorAll(".monitor.nsfw, .screen.nsfw")
        .forEach((el) => el.classList.remove("nsfw"));
    }
    if (row.classList.contains("row")) {
      attachSwipe(row, {
        commit: 80,
        commit2: 170,
        onRight: () => act(fn, "archived"),
        onRightLong: () => act(fn, "keep"),
        onLeft: () => act(fn, "done"),
        onLeftLong: () => snooze(fn),
        onLongPress: () => openRowMenu(fn),
        onRelayClose: () => closeRelay(),
      });
    }
  });
  paintBatch();
}

/* ---- actions: live clear + undo/redo (locked #11) ---- */
function rowEl(fullname) {
  return itemsEl.querySelector(
    '[data-fullname="' + CSS.escape(fullname) + '"]',
  );
}

/* Re-blur an NSFW item's feed thumbnail — the reverse of the tap-reveal. Called when
   the reader/lightbox opened for it closes, so a reveal doesn't persist across close
   (Epic 13 P2). Idempotent and a no-op for non-NSFW items. */
function reblur(fn) {
  if (!fn) return;
  nsfwRevealed.delete(fn);
  const item = state.items.find((it) => it.fullname === fn);
  if (!item || !isNsfw(item)) return;
  const row = rowEl(fn);
  if (row)
    row
      .querySelectorAll(".monitor, .screen")
      .forEach((el) => el.classList.add("nsfw"));
}

/* Single-level redo buffer: the last single-item action that was undone, so it can
   be replayed. Mirrors the single-level snackbar undo (only the most recent action is
   undoable, so only one is redoable). Any new act() clears it. */
let lastUndone = null;

async function act(fullname, status, opts = {}) {
  lastUndone = null; // a fresh action invalidates the redo buffer
  if (window.chHaptic) window.chHaptic(status); // tactile confirm on the decision (covers swipe + buttons)

  /* SPEC A2: reader triage skips leave-anim, cache clear, item removal, and render().
     The item stays in state.items with its status updated lazily; undo just reverts
     the in-memory status. No redo tracking for the reader path. */
  if (opts.fromReader) {
    try {
      await api.setStatus(fullname, status);
    } catch (e) {
      toast("That didn't stick — try again.");
      return;
    }
    const item = state.items.find((it) => it.fullname === fullname);
    const prevStatus = item ? item.status : null;
    if (item) item.status = status;
    if (state.focus) state.batchCleared += 1;
    bumpPulse(status === "inbox" ? 0 : 1);
    snackbar(COPY[status] || "Logged.", async () => {
      if (window.chHaptic) window.chHaptic("undo");
      try {
        await api.undoItem(fullname);
        bumpPulse(status === "inbox" ? 0 : -1);
        if (state.focus)
          state.batchCleared = Math.max(0, state.batchCleared - 1);
        if (item) item.status = prevStatus;
      } catch (e) {
        toast("Undo failed.");
      }
    });
    return;
  }

  // Inline row path: leave-anim, cache clear, item removal, render (existing behavior)
  const row = rowEl(fullname);
  if (row && !row.classList.contains("leaving")) {
    row.classList.add("leaving", "lv-" + status);
    await new Promise((r) => setTimeout(r, 180));
  }
  try {
    await api.setStatus(fullname, status);
    clearItemFirstPageCache();
  } catch (e) {
    if (row) row.classList.remove("leaving", "lv-" + status);
    toast("That didn't stick — try again.");
    return;
  }
  const undoIdx = state.items.findIndex((it) => it.fullname === fullname);
  const undoItem = undoIdx >= 0 ? state.items[undoIdx] : null;
  state.items = state.items.filter((it) => it.fullname !== fullname);
  if (state.focus) state.batchCleared += 1;
  bumpPulse(status === "inbox" ? 0 : 1);
  render();
  snackbar(COPY[status] || "Logged.", async () => {
    if (window.chHaptic) window.chHaptic("undo");
    try {
      await api.undoItem(fullname);
      clearItemFirstPageCache();
      bumpPulse(status === "inbox" ? 0 : -1);
      if (state.focus) state.batchCleared = Math.max(0, state.batchCleared - 1);
      // restore the row in place — no full refetch/skeleton, keeps the scroll position
      if (undoItem && !state.items.some((it) => it.fullname === fullname)) {
        state.items.splice(Math.min(undoIdx, state.items.length), 0, undoItem);
      }
      render();
      lastUndone = { fullname, status }; // now redoable
    } catch (e) {
      toast("Undo failed.");
    }
  });
}

async function snooze(fullname, opts = {}) {
  lastUndone = null;
  if (window.chHaptic) window.chHaptic("skip");

  /* SPEC A2: reader snooze skips leave-anim, cache clear, item removal, and render().
     The item stays in state.items with its status updated lazily; undo reverts status. */
  if (opts.fromReader) {
    let res;
    try {
      res = await api.snoozeItem(fullname, { window_days: 7 });
    } catch (e) {
      toast("Snooze didn't stick - try again.");
      return;
    }
    const item = state.items.find((it) => it.fullname === fullname);
    const prevStatus = item ? item.status : null;
    const escalated = !!(res && res.decayed_at);
    if (item && escalated) item.status = "archived";
    if (state.focus) state.batchCleared += 1;
    if (escalated) bumpPulse(1);
    snackbar(
      escalated ? "Archived after repeat snoozes." : "Snoozed for 7 days.",
      async () => {
        try {
          const undoBody =
            res && res.snoozed_wave
              ? { snoozed_wave: res.snoozed_wave }
              : { decayed_at: res.decayed_at };
          await api.undoSnooze(undoBody);
          if (state.focus)
            state.batchCleared = Math.max(0, state.batchCleared - 1);
          if (escalated) bumpPulse(-1);
          if (item) item.status = prevStatus;
        } catch (e) {
          toast("Undo failed.");
        }
      },
    );
    return;
  }

  // Inline row path: existing behavior
  const row = rowEl(fullname);
  if (row && !row.classList.contains("leaving")) {
    row.classList.add("leaving", "lv-snooze");
    await new Promise((r) => setTimeout(r, 180));
  }
  let res;
  try {
    res = await api.snoozeItem(fullname, { window_days: 7 });
    clearItemFirstPageCache();
  } catch (e) {
    if (row) row.classList.remove("leaving", "lv-snooze");
    toast("Snooze didn't stick - try again.");
    return;
  }
  const undoIdx = state.items.findIndex((it) => it.fullname === fullname);
  const undoItem = undoIdx >= 0 ? state.items[undoIdx] : null;
  state.items = state.items.filter((it) => it.fullname !== fullname);
  const escalated = !!(res && res.decayed_at);
  if (state.focus) state.batchCleared += 1;
  if (escalated) bumpPulse(1);
  render();
  snackbar(
    escalated ? "Archived after repeat snoozes." : "Snoozed for 7 days.",
    async () => {
      try {
        const undoBody =
          res && res.snoozed_wave
            ? { snoozed_wave: res.snoozed_wave }
            : { decayed_at: res.decayed_at };
        await api.undoSnooze(undoBody);
        clearItemFirstPageCache();
        if (state.focus)
          state.batchCleared = Math.max(0, state.batchCleared - 1);
        if (escalated) bumpPulse(-1);
        if (undoItem && !state.items.some((it) => it.fullname === fullname)) {
          state.items.splice(
            Math.min(undoIdx, state.items.length),
            0,
            undoItem,
          );
        }
        render();
      } catch (e) {
        toast("Undo failed.");
      }
    },
  );
}

/* Redo: replay the last undone single-item action (re-applies the status + shows a
   fresh undo snackbar). act() resets lastUndone, so it's a clean one-step toggle. */
function redo() {
  if (!lastUndone) {
    toast("Nothing to redo.");
    return;
  }
  act(lastUndone.fullname, lastUndone.status);
}

/* the in-app thread reader — replaces external handoff for Reddit/HN discussion
   threads. act/openMediaFor/closeSheets are hoisted function declarations. */
const readerUI = initReader({
  onTriage: (fn, status) => act(fn, status, { fromReader: true }),
  onSnooze: (fn) => snooze(fn, { fromReader: true }),
  onMedia: openMediaFor,
  closeSheets,
  onClose: reblur,
  onImage: (url) => lightbox.openImage(url), // inline comment/selftext image → lightbox
  onBodySaved: (updated) => {
    if (!updated || !updated.fullname) return;
    const it = state.items.find((x) => x.fullname === updated.fullname);
    if (it) Object.assign(it, updated);
    render();
  },
});

/* per-item manual tag editor (browse surface, Epic 5/26 P2) — opens from the ＋ trigger on
   a row/card or the `t` key. Writes the server's returned tag list back to state, re-renders
   so the row's chips update, and re-syncs the rail (debounced) — note db.tag_counts restricts
   facets to the curated FILTER_TAGS, so a brand-new user tag shows on the row but NOT in the
   rail until a user-tag vocab registry exists (Epic 26 follow-up). */
const refreshRailSoon = debounce(() => refreshRail(), 350);
const tagEditor = initTagEditor({
  getItem: (fn) => state.items.find((it) => it.fullname === fn),
  getKnownTags: () => facets.tags.map((t) => t.id),
  onChange: (fn, tags) => {
    const it = state.items.find((x) => x.fullname === fn);
    if (it) {
      it.metadata = it.metadata || {};
      it.metadata.tags = tags;
    }
    render();
    refreshRailSoon();
  },
});

/* delegated row interactions */
itemsEl.addEventListener("click", (e) => {
  // Relay-style long-press strip buttons are handled by a dedicated listener;
  // bail here so the row's title/media logic doesn't double-process them.
  if (e.target.closest(".relay-strip")) return;
  const actBtn = e.target.closest(".act");
  const card = e.target.closest("[data-fullname]");
  if (!card) return;
  const fn = card.dataset.fullname;
  if (actBtn && actBtn.dataset.act) {
    act(fn, actBtn.dataset.act);
    return;
  } // status acts carry data-act
  if (e.target.closest("[data-select]")) {
    toggleSelect(card);
    return;
  }
  const tagBtn = e.target.closest("[data-tagedit]");
  if (tagBtn) {
    e.stopPropagation();
    tagEditor.open(fn, tagBtn);
    return;
  }
  const media = e.target.closest("[data-media]");
  if (media) {
    const item = state.items.find((it) => it.fullname === fn);
    if (!item) return;
    if (isNsfw(item) && !nsfwRevealed.has(fn)) {
      // first tap reveals, second opens
      nsfwRevealed.add(fn);
      media.classList.remove("nsfw"); // veil hidden by CSS; re-blurs on reader/lightbox close
      return;
    }
    // Thumbnail tap = a quick PLAIN-MEDIA peek — image lightbox / video player / gallery viewer.
    // The post + comment THREAD is reached by tapping the title or body text (handled below).
    // (Reverted the reddit-image/video → reader interception per user pref + Epic 5 P2, 2026-06-22.)
    // openMediaFor → lightbox registers with the overlay coordinator (core/media.js pushOverlay),
    // so the OS/back button closes the lightbox and returns to the feed (inbox), not exits the app.
    openMediaFor(item);
    return;
  }
  // Discussion-thread + note items: tapping the title link or body text opens the in-app reader.
  // A title link's parent is an <h3> (every density); meta/source links sit in .meta,
  // so they keep their external navigation.
  const rItem = state.items.find((it) => it.fullname === fn);
  if (canOpenInReader(rItem)) {
    const a = e.target.closest("a");
    const onTitle = a && a.parentElement && a.parentElement.tagName === "H3";
    const onText = !a && e.target.closest(".title, .snippet, .pin h3");
    if (onTitle || onText) {
      e.preventDefault();
      readerUI.open(rItem);
      if (rItem.source === "reddit" || rItem.source === "hackernews")
        preloadNext(rItem);
    }
  }
});

/* ---- hold-to-preview (Relay-style press-and-hold media peek) ----
   Long-press opens a temporary lightbox while the pointer stays down. Release closes
   it and swallows the trailing synthetic click so it does not reopen persistently. */
let mediaPressStart = null;
let mediaHoldTimer = null;
let mediaPeeking = false;
let suppressMediaClick = false;
let suppressMediaClickTimer = null;
const MEDIA_HOLD_DELAY = 250;
const MEDIA_PRESS_SLOP = 10;
function armMediaClickSuppress() {
  suppressMediaClick = true;
  clearTimeout(suppressMediaClickTimer);
  suppressMediaClickTimer = setTimeout(() => {
    suppressMediaClick = false;
    suppressMediaClickTimer = null;
  }, 700);
}
function clearMediaHold() {
  if (mediaHoldTimer !== null) {
    clearTimeout(mediaHoldTimer);
    mediaHoldTimer = null;
  }
}
itemsEl.addEventListener("pointerdown", (e) => {
  const media = e.target.closest("[data-media]");
  if (!media) return;
  if (e.pointerType === "mouse" && e.button !== 0) return;
  const fn = media.closest("[data-fullname]")?.dataset.fullname;
  if (!fn) return;
  mediaPressStart = {
    id: e.pointerId,
    x: e.clientX,
    y: e.clientY,
    t: performance.now(),
    fn,
  };
  clearMediaHold();
  mediaHoldTimer = setTimeout(() => {
    mediaHoldTimer = null;
    if (!mediaPressStart || mediaPressStart.id !== e.pointerId) return;
    const item = state.items.find((it) => it.fullname === fn);
    if (!item) return;
    mediaPeeking = true;
    armMediaClickSuppress();
    openMediaFor(item, { peek: true });
  }, MEDIA_HOLD_DELAY);
});
itemsEl.addEventListener("pointermove", (e) => {
  if (!mediaPressStart || e.pointerId !== mediaPressStart.id) return;
  if (
    Math.hypot(e.clientX - mediaPressStart.x, e.clientY - mediaPressStart.y) >
    MEDIA_PRESS_SLOP
  ) {
    clearMediaHold();
    mediaPressStart = null;
  }
});
itemsEl.addEventListener("pointerup", (e) => {
  if (!mediaPressStart || e.pointerId !== mediaPressStart.id) return;
  const wasPeeking = mediaPeeking;
  clearMediaHold();
  mediaPressStart = null;
  if (wasPeeking) {
    mediaPeeking = false;
    armMediaClickSuppress();
  }
});
itemsEl.addEventListener("pointercancel", (e) => {
  if (mediaPressStart && e.pointerId === mediaPressStart.id) {
    if (mediaPeeking) armMediaClickSuppress();
    mediaPeeking = false;
    mediaPressStart = null;
  }
  clearMediaHold();
});
itemsEl.addEventListener(
  "click",
  (e) => {
    if (!suppressMediaClick || !e.target.closest("[data-media]")) return;
    suppressMediaClick = false;
    clearTimeout(suppressMediaClickTimer);
    suppressMediaClickTimer = null;
    e.stopPropagation();
    e.preventDefault();
  },
  true,
);

/* ---- predictive preload: on reader-open, warm the NEXT discussion thread + its media (Epic 8 P2) ----
   Sequential reading is the common path, so when an item opens we pre-hydrate the next Reddit/HN
   comment thread (a GET lazily hydrates it server-side → the next open is instant) and prime its media
   image. Bounded + safe: ONE thread fetch per open (de-duped via _preloaded), only discussion items have
   threads, and an in-flight preload is aborted when a newer one starts. */
let _preloadCtl = null;
const _preloaded = new Set();
const threadPath = (item) =>
  item && item.source === "hackernews"
    ? "/hackernews/items/" + encodeURIComponent(item.fullname) + "/thread"
    : item && item.source === "reddit"
      ? "/reddit/items/" + encodeURIComponent(item.fullname) + "/thread"
      : "";
function preloadNext(opened) {
  if (!opened) return;
  const i = state.items.indexOf(opened);
  if (i < 0) return;
  let next = null; // nearest following discussion item (small look-ahead)
  for (let j = i + 1; j < state.items.length && j <= i + 4; j++) {
    if (
      state.items[j].source === "reddit" ||
      state.items[j].source === "hackernews"
    ) {
      next = state.items[j];
      break;
    }
  }
  if (!next) return;
  const mu = imageUrl(next); // prime media (CDN/local — no rate-limit concern)
  if (mu) {
    const im = new Image();
    im.src = mu;
  }
  if (_preloaded.has(next.fullname)) return; // warm each thread at most once
  _preloaded.add(next.fullname);
  if (_preloadCtl) {
    try {
      _preloadCtl.abort();
    } catch (_e) {}
  }
  _preloadCtl = new AbortController();
  // sort is irrelevant for warming (hydration caches the whole thread; sort is applied at read time)
  const path = threadPath(next);
  if (path) fetch(path, { signal: _preloadCtl.signal }).catch(() => {});
}

/* ---- media lightbox ---- */
let lastMediaFn = null; // item whose media is open in the lightbox → re-blurred on close
let mediaOpenSeq = 0; // invalidates async replacements when the lightbox closes/reopens
const lightbox = createLightbox({
  modal: "#media-modal",
  body: "#media-body",
  lockScrollEl: itemsEl,
  onClose: () => {
    mediaOpenSeq += 1;
    reblur(lastMediaFn);
  },
});
function archiveTodayPlaceholderHtml(item) {
  const m = item.metadata || {};
  const url = redditUrl(m.permalink || item.url);
  let html =
    '<p class="media-fallback">Deleted Reddit media is unavailable locally.</p>' +
    '<button class="media-fallback archive-today-btn" data-archive-today-recover="' +
    esc(item.fullname) +
    '" type="button">Recover deleted media via archive.today</button>' +
    '<p class="media-fallback media-note">Contacts archive.today with the original media URL. One item only.</p>';
  if (url)
    html +=
      '<a class="media-fallback" href="' +
      esc(url) +
      '" target="_blank" rel="noopener">Open on Reddit ↗</a>';
  return html;
}

function openMediaFor(item, opts) {
  lastMediaFn = item.fullname;
  const m = item.metadata || {};
  if (canRecoverArchiveToday(item))
    return lightbox.openHtml(archiveTodayPlaceholderHtml(item), opts);
  if (Array.isArray(m.gallery) && m.gallery.length)
    // sized variants load first (Epic 13 P2); prefer locally-archived copies when present (Epic 4 P1)
    return lightbox.openGallery(
      m.gallery.map((u) => localUrl(item, u)),
      (m.gallery_preview || []).map((u) => localUrl(item, u)),
      opts,
    );
  const imgs = imageUrls(item);
  if (imgs.length > 1) return lightbox.openGallery(imgs, imgs, opts);
  const vsrc = playableVideoSrc(item); // shared playability test (same as the reader's inline player)
  if (vsrc) return lightbox.openVideo(vsrc, m.thumbnail, opts);
  const img = imageUrl(item);
  if (img) return lightbox.openImage(img, opts);
  /* Gallery without captured image URLs — hydrate one item on demand via the existing
     OAuth/cached-thread backend, then fall back to the local thumbnail + Reddit link. */
  if (m.media_type === "gallery" || /\/gallery\//i.test(item.url || "")) {
    const fallbackHtml = (msg) => {
      const url = redditUrl(m.permalink || item.url);
      const preview = thumb(item, "card") || "";
      const previewHtml = preview
        ? '<div class="media-gallery"><img class="gallery-img gallery-preview-fallback" src="' +
          esc(preview) +
          '" alt=""></div>'
        : "";
      return (
        previewHtml +
        (url
          ? '<p class="media-fallback">' +
            esc(msg || "Full gallery images unavailable (not archived).") +
            '</p><a class="media-fallback" href="' +
            esc(url) +
            '" target="_blank" rel="noopener">Open on Reddit ↗</a>'
          : '<p class="media-fallback">' +
            esc(msg || "Full gallery images unavailable.") +
            "</p>")
      );
    };
    if (opts && opts.peek) return lightbox.openHtml(fallbackHtml(), opts);
    const openSeq = ++mediaOpenSeq;
    lightbox.openHtml(
      '<p class="media-fallback">Loading gallery from Reddit…</p>',
      opts,
    );
    const stillActive = () =>
      openSeq === mediaOpenSeq &&
      lightbox.isOpen() &&
      lastMediaFn === item.fullname;
    (async () => {
      try {
        const res = await api.postJSON(
          "/reddit/items/" +
            encodeURIComponent(item.fullname) +
            "/hydrate-gallery",
          {},
        );
        if (!stillActive()) return;
        const gallery = (res && res.gallery) || [];
        if (
          (res.status === "hydrated" || res.status === "cached") &&
          gallery.length
        ) {
          m.gallery = gallery;
          m.gallery_preview = res.gallery_preview || [];
          if (res.thumbnail) m.thumbnail = res.thumbnail;
          if (res.media_url) m.media_url = res.media_url;
          return lightbox.openGallery(
            gallery.map((u) => localUrl(item, u)),
            (m.gallery_preview || []).map((u) => localUrl(item, u)),
            opts,
          );
        }
        lightbox.openHtml(
          fallbackHtml("Full gallery images unavailable."),
          opts,
        );
      } catch (e) {
        if (!stillActive()) return;
        lightbox.openHtml(
          fallbackHtml("Couldn’t load gallery from Reddit."),
          opts,
        );
      }
    })();
    return;
  }
  /* Permalink-only item (no lightboxable media) — reddit text/post thread.
     Open the reader instead of the reddit iframe (user preference 2026-06-26). */
  if (m.permalink && item.source === "reddit") return readerUI.open(item);
  if (m.permalink) return lightbox.openMedia(m.permalink, opts);
  const url = item.url;
  if (url) window.open(url, "_blank", "noopener");
}

async function recoverArchiveTodayFromLightbox(fn, btn) {
  if (!fn || !window.confirm(archiveTodayConfirmText)) return;
  btn.disabled = true;
  btn.textContent = "checking…";
  try {
    const res = await api.recoverArchiveToday(fn, "apply");
    const media = res && res.archive_today;
    if (media && media.bytes_archived) {
      toast(
        "Recovered " +
          media.bytes_archived +
          " image" +
          (media.bytes_archived === 1 ? "" : "s") +
          ".",
      );
      const updated = await api.fetchItem(fn);
      const item = state.items.find((it) => it.fullname === fn);
      if (item && updated) Object.assign(item, updated);
      if (item && lastMediaFn === fn) openMediaFor(item);
    } else {
      btn.disabled = false;
      btn.textContent =
        media && media.result === "miss"
          ? "no archive.today hit"
          : "try archive.today later";
      toast(
        media && media.result === "miss"
          ? "No archive.today snapshot found."
          : "Archive.today did not recover media.",
      );
    }
  } catch (_e) {
    btn.disabled = false;
    btn.textContent = "Recover deleted media via archive.today";
    toast("Archive.today recovery failed.");
  }
}

const mediaBody = $("#media-body");
if (mediaBody)
  mediaBody.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-archive-today-recover]");
    if (!btn) return;
    recoverArchiveTodayFromLightbox(btn.dataset.archiveTodayRecover, btn);
  });

/* ---- bulk select (locked: avatar shade select; overlay bar; bulk undo) ---- */
const selected = new Set();
function toggleSelect(card) {
  const fn = card.dataset.fullname;
  if (selected.has(fn)) {
    selected.delete(fn);
    card.classList.remove("selected");
  } else {
    selected.add(fn);
    card.classList.add("selected");
  }
  paintBulk();
}
function clearSelection() {
  selected.clear();
  $$(".selected").forEach((el) => el.classList.remove("selected"));
  paintBulk();
}
function syncSelectionToVisibleItems() {
  const visible = new Set(state.items.map((it) => it.fullname));
  [...selected].forEach((fn) => {
    if (!visible.has(fn)) selected.delete(fn);
  });
}
function paintBulk() {
  const cnt = $("#bulkcnt");
  cnt.textContent = String(selected.size).padStart(2, "0");
  cnt.setAttribute(
    "aria-label",
    selected.size === 1 ? "1 item selected" : selected.size + " items selected",
  );
  $("#bulktray").classList.toggle("show", selected.size > 0);
}
$("#bulkclear").addEventListener("click", clearSelection);
$$("#bulktray [data-bulk]").forEach((b) =>
  b.addEventListener("click", async () => {
    const fns = [...selected],
      status = b.dataset.bulk;
    if (!fns.length) return;
    if (window.chHaptic) window.chHaptic(status);
    clearSelection();
    try {
      await api.bulkStatus(fns, status);
      clearItemFirstPageCache();
    } catch (e) {
      toast("Bulk action failed.");
      return;
    }
    const bulkRemoved = fns
      .map((fn) => {
        const i = state.items.findIndex((it) => it.fullname === fn);
        return i >= 0 ? { i, item: state.items[i] } : null;
      })
      .filter(Boolean);
    state.items = state.items.filter((it) => !fns.includes(it.fullname));
    if (state.focus) state.batchCleared += fns.length;
    bumpPulse(status === "inbox" ? 0 : fns.length);
    render();
    snackbar(
      fns.length + " — " + (COPY[status] || "logged.").toLowerCase(),
      async () => {
        const r = await api.bulkUndo(fns);
        clearItemFirstPageCache();
        bumpPulse(status === "inbox" ? 0 : -r.ok);
        // restore the rows in place (ascending index) — no full refetch/skeleton
        bulkRemoved
          .sort((a, b) => a.i - b.i)
          .forEach(({ i, item }) => {
            if (!state.items.some((it) => it.fullname === item.fullname)) {
              state.items.splice(Math.min(i, state.items.length), 0, item);
            }
          });
        render();
      },
    );
  }),
);

/* ---- pulse: pebbles, "· N new", dateline, decay line (locked #1/#2/#3/#12) ---- */
function bumpPulse(d) {
  state.pulse.cleared_today = Math.max(0, state.pulse.cleared_today + d);
  paintWins();
}
function paintWins() {
  const dots = $("#windots"),
    n = state.pulse.cleared_today;
  if (state.goal > 0) {
    dots.innerHTML = Array.from(
      { length: state.goal },
      (_, k) => "<i" + (k < n ? ' class="on"' : "") + "></i>",
    ).join("");
    $("#winnum").textContent = n + " / " + state.goal;
  } else {
    dots.innerHTML = "";
    $("#winnum").textContent = n + " cleared";
  }
}
function paintPulse() {
  const p = state.pulse;
  const newTxt = p.new_today ? "· " + p.new_today + " new" : "";
  $("#inbox-new").textContent = newTxt;
  $("#inbox-new-m").textContent = newTxt;
  const d = new Date();
  const day = d.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "long",
  });
  const freshLine = p.new_today
    ? "<b>" + p.new_today + " fresh</b> today. "
    : "<b>No fresh arrivals</b> today. ";
  $("#dateline").innerHTML =
    esc(day) + " — " + freshLine + '<em class="norush">No rush.</em>';
  $("#decayline").hidden = !p.swept_recent;
  $("#decay-n").textContent = p.swept_recent.toLocaleString();
  paintWins();
}
async function refreshPulse() {
  try {
    state.pulse = await api.getJSON("/pulse");
    paintPulse();
  } catch (e) {
    /* ambient */
  }
}

/* ---- Focus batches + stamp (locked #10) ---- */
function paintBatch() {
  document.body.classList.toggle("focus", state.focus);
  if (!state.focus) return;
  const total = state.batchTotal,
    done = Math.min(state.batchCleared, total);
  $("#segs").innerHTML = Array.from(
    { length: total },
    (_, k) => "<i" + (k < done ? ' class="on"' : "") + "></i>",
  ).join("");
  $("#batchn").textContent = done + " of " + total + " cleared";
  if (total > 0 && state.items.length === 0 && !state.stamped) {
    state.stamped = true;
    if (window.chHaptic) window.chHaptic("milestone"); // the one richer celebration
    $("#stampsub").textContent =
      total +
      " ENTRIES · " +
      new Date()
        .toLocaleDateString(undefined, {
          weekday: "short",
          day: "numeric",
          month: "short",
        })
        .toUpperCase();
    $("#stamp").classList.add("show");
  }
}
function setFocus(on) {
  state.focus = on;
  localStorage.chFocus = on ? "1" : "0";
  $("#dock-focus").setAttribute("aria-pressed", String(on));
  $$("#set-loading button").forEach((b) =>
    b.setAttribute("aria-pressed", String((b.dataset.focus === "1") === on)),
  );
  loadItems(true);
}
$("#drawagain").addEventListener("click", () => {
  $("#stamp").classList.remove("show");
  loadItems(true);
});
$("#enough").addEventListener("click", () =>
  $("#stamp").classList.remove("show"),
);
$("#dock-focus").addEventListener("click", () => setFocus(!state.focus));
itemsEl.addEventListener("click", (e) => {
  if (e.target.closest("#empty-draw")) {
    if (!state.focus) setFocus(true);
    else loadItems(true);
  }
  if (e.target.closest("#empty-surprise")) surprise();
});

/* ---- infinite scroll (off in Focus) ---- */
new IntersectionObserver(
  (entries) => {
    if (
      entries[0].isIntersecting &&
      state.hasMore &&
      !state.focus &&
      !state.loading
    )
      loadItems(false);
  },
  { rootMargin: "600px" },
).observe($("#sentinel"));

/* ---- mobile floating scroll-to-top (Epic 13 / 16) ---- */
const gotop = $("#gotop");
const GOTOP_AT = 700; // px scrolled before the affordance appears
const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
const BROWSE_TOP_EPSILON = 1;
const BROWSE_SCROLL_SETTLE_MS = 140;
const PROGRAMMATIC_TOP_MAX_MS = 1800;
const browseTopScroll = (() => {
  let active = false;
  let settleTimer = 0;
  let hardTimer = 0;
  const startCallbacks = new Set();
  const endCallbacks = new Set();
  const atTop = () => (window.scrollY || 0) <= BROWSE_TOP_EPSILON;
  const clearSettle = () => {
    clearTimeout(settleTimer);
    settleTimer = 0;
  };
  const finish = () => {
    if (!active) return;
    active = false;
    clearSettle();
    clearTimeout(hardTimer);
    hardTimer = 0;
    endCallbacks.forEach((cb) => cb());
  };
  const finishIfTop = () => {
    if (atTop()) finish();
  };
  const scheduleTopSettle = () => {
    clearSettle();
    settleTimer = setTimeout(finishIfTop, BROWSE_SCROLL_SETTLE_MS);
  };
  return {
    get active() {
      return active;
    },
    onStart(cb) {
      startCallbacks.add(cb);
    },
    onEnd(cb) {
      endCallbacks.add(cb);
    },
    begin() {
      active = true;
      clearSettle();
      clearTimeout(hardTimer);
      startCallbacks.forEach((cb) => cb());
      hardTimer = setTimeout(
        finish,
        reducedMotion?.matches ? 300 : PROGRAMMATIC_TOP_MAX_MS,
      );
    },
    noteScroll() {
      if (!active) return;
      if (atTop()) scheduleTopSettle();
      else clearSettle();
    },
    settleIfTop() {
      finishIfTop();
    },
  };
})();
let gotopTick = false;
function syncGotop() {
  gotopTick = false;
  const y = window.scrollY || 0;
  gotop.classList.toggle(
    "show",
    browseTopScroll.active ? y > BROWSE_TOP_EPSILON : y > GOTOP_AT,
  );
}
function scrollToBrowseTop() {
  browseTopScroll.begin();
  window.scrollTo({
    top: 0,
    left: 0,
    behavior: reducedMotion?.matches ? "auto" : "smooth",
  });
  if (reducedMotion?.matches) {
    requestAnimationFrame(() => {
      browseTopScroll.noteScroll();
      browseTopScroll.settleIfTop();
      syncGotop();
    });
  }
}
window.addEventListener(
  "scroll",
  () => {
    // rAF-throttled (60fps lane)
    browseTopScroll.noteScroll();
    if (!gotopTick) {
      gotopTick = true;
      requestAnimationFrame(syncGotop);
    }
  },
  { passive: true },
);
if ("onscrollend" in window)
  window.addEventListener(
    "scrollend",
    () => {
      browseTopScroll.noteScroll();
      browseTopScroll.settleIfTop();
    },
    { passive: true },
  );
gotop.addEventListener("click", scrollToBrowseTop);

/* ---- the ambient slot: resurfacing card + surprise (locked #4/#5) ---- */
const ambient = $("#ambient");
function cardHtml(c) {
  const samples = (c.sample || [])
    .map((s) => "“" + esc(s.title || "") + "”")
    .join(" · ");
  const added = c.last_added_utc
    ? new Date(c.last_added_utc * 1000).toLocaleDateString(undefined, {
        month: "short",
        year: "numeric",
      })
    : "";
  const count = Number(c.count) || 0;
  const volume =
    count <= 1 ? "One save" : count < 5 ? "A few saves" : "A small cluster";
  const exact =
    count +
    " save" +
    (count === 1 ? "" : "s") +
    " in " +
    (c.label || "this cluster");
  return (
    '<div class="amb-eyebrow">' +
    (c.reactivated ? "THIS CAME BACK AROUND" : "WORTH A GLANCE?") +
    "</div>" +
    "<h3>Want to revisit <em>" +
    esc(c.label) +
    "</em>?</h3>" +
    '<div class="amb-body"><div class="amb-meta" title="' +
    esc(exact) +
    '" aria-label="' +
    esc(exact) +
    '">' +
    volume +
    " in <b>" +
    esc(c.label) +
    "</b>" +
    (added ? " · last added " + esc(added) : "") +
    '<div class="amb-samples">' +
    samples +
    "</div></div></div>" +
    '<div class="amb-acts">' +
    '<button type="button" class="ambbtn primary" data-amb="show">Show me</button>' +
    '<button type="button" class="ambbtn" data-amb="later">Not now</button>' +
    '<button type="button" class="ambbtn letgo" data-amb="letgo">Let it rest</button></div>'
  );
}
let ambientCard = null;
let surpriseItem = null;
const SURPRISE_PREVIEW_CHARS = 260;

function surprisePreviewText(item) {
  const m = (item && item.metadata) || {};
  const candidates = [
    m.summary,
    m.description,
    m.selftext,
    m.text,
    item && item.body,
    m.ocr_text,
  ];
  const raw = candidates.find((v) => typeof v === "string" && v.trim());
  if (!raw) return "";
  return String(raw)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/!\[[^\]]*]\([^)]+\)/g, " ")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/`{1,3}([^`]+)`{1,3}/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function surprisePreviewHtml(item) {
  const text = surprisePreviewText(item);
  if (!text)
    return (
      '<div class="surp-preview empty" aria-label="Preview"><p>' +
      "No saved text preview." +
      "</p></div>"
    );
  const clipped =
    text.length > SURPRISE_PREVIEW_CHARS
      ? text.slice(0, SURPRISE_PREVIEW_CHARS - 3).trimEnd() + "..."
      : text;
  return (
    '<div class="surp-preview" aria-label="Preview"><p>' +
    esc(clipped) +
    "</p></div>"
  );
}

async function loadAmbient() {
  try {
    const r = await fetch("/resurface");
    if (r.status !== 200) return;
    ambientCard = await r.json();
    ambient.innerHTML = cardHtml(ambientCard);
    ambient.hidden = false;
  } catch (e) {
    /* ambient — never an error surface */
  }
}
ambient.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-amb]");
  if (!b) return;
  const action = b.dataset.amb;
  if (action === "open") {
    ambient.hidden = true;
    return;
  }
  if (!ambientCard) {
    ambient.hidden = true;
    return;
  }
  const cluster = ambientCard.cluster;
  if (action === "later") {
    ambient.hidden = true; // silent — never mentioned again
    api.postJSON("/resurface/dismiss", { cluster }).catch(() => {});
  } else if (action === "show") {
    ambient.hidden = true;
    $("#q").value = ambientCard.query;
    state.q = ambientCard.query;
    state.status = "";
    paintTabs();
    loadItems(true);
  } else if (action === "letgo") {
    ambient.hidden = true;
    try {
      const r = await api.postJSON("/resurface/letgo", { cluster });
      clearItemFirstPageCache();
      snackbar(
        r.total + " saves let go — resting in the archive.",
        async () => {
          await api.postJSON("/resurface/letgo/undo", {
            cluster,
            decayed_at: r.decayed_at,
          });
          clearItemFirstPageCache();
          loadItems(true);
          refreshPulse();
        },
      );
      loadItems(true);
      refreshPulse();
    } catch (err) {
      toast("Couldn't let that go — try again.");
    }
  }
});
async function surprise() {
  try {
    const r = await api.getJSON("/random?n=1");
    const it = (r.items || [])[0];
    if (!it) {
      toast("Nothing to deal — the shelves are empty.");
      return;
    }
    const m = it.metadata || {};
    const mt = mediaType(it);
    const isRedditText = it.source === "reddit" && mt.cls === "text";
    // hero: prefer the crisp card-sized thumbnail (gallery aware), fall back to any image
    const t = isRedditText ? "" : thumb(it, "card") || imageUrl(it) || "";
    const hero = t
      ? '<button type="button" class="surp-hero" data-surprise="open" aria-label="Open in reader">' +
        '<img src="' +
        esc(t) +
        '" alt="" loading="lazy"></button>'
      : "";
    const src = CH_SOURCES[it.source] || {};
    const badge =
      '<span class="surp-badge" style="--src:' +
      (src.token ? "var(" + src.token + ")" : "var(--accent)") +
      '">' +
      (src.glyph ? esc(src.glyph) : esc(it.source || "•")) +
      "</span>";
    surpriseItem = it;
    ambient.innerHTML =
      '<article class="surp-card" data-fullname="' +
      esc(it.fullname) +
      '">' +
      '<button type="button" class="surp-x" data-surprise="dismiss" aria-label="Not today">✕</button>' +
      hero +
      '<div class="surp-body">' +
      '<div class="surp-eyebrow">DEALT AT RANDOM — NO STRINGS</div>' +
      "<h3>" +
      esc(it.title || "(untitled)") +
      "</h3>" +
      '<div class="surp-meta">' +
      badge +
      '<span class="surp-metabits">' +
      metaLine(it) +
      "</span></div>" +
      surprisePreviewHtml(it) +
      '<div class="surp-acts">' +
      '<button type="button" class="surp-act a" data-surprise="archived">Archive</button>' +
      '<button type="button" class="surp-act d" data-surprise="done">Done</button>' +
      '<button type="button" class="surp-act s" data-surprise="snooze">Snooze</button>' +
      '<button type="button" class="surp-act k" data-surprise="keep">Keep</button>' +
      '<button type="button" class="surp-act surp-open" data-surprise="open">Open reader</button>' +
      "</div></div></article>";
    ambientCard = null;
    ambient.hidden = false;
    ambient.scrollIntoView({ block: "nearest", behavior: "smooth" });
  } catch (e) {
    toast("The dice jammed — try again.");
  }
}
$("#dice").addEventListener("click", surprise);
ambient.addEventListener("click", (e) => {
  const b = e.target.closest("[data-surprise]");
  if (!b) return;
  const action = b.dataset.surprise;
  const it = surpriseItem;
  if (action === "dismiss") {
    surpriseItem = null;
    ambient.hidden = true;
    return;
  }
  if (!it) return;
  const fn = it.fullname;
  // triage actions: animate the card out, then commit via the same paths as inbox rows
  if (action === "keep" || action === "archived" || action === "done") {
    const card = ambient.querySelector(".surp-card");
    if (card && !card.classList.contains("leaving")) {
      card.classList.add("leaving", "lv-" + action);
    }
    surpriseItem = null;
    // wait for the leave animation, then clear the slot and commit
    setTimeout(() => {
      ambient.hidden = true;
      ambient.innerHTML = "";
    }, 200);
    act(fn, action);
    return;
  }
  if (action === "snooze") {
    const card = ambient.querySelector(".surp-card");
    if (card && !card.classList.contains("leaving")) {
      card.classList.add("leaving", "lv-snooze");
    }
    surpriseItem = null;
    setTimeout(() => {
      ambient.hidden = true;
      ambient.innerHTML = "";
    }, 200);
    snooze(fn);
    return;
  }
  if (action !== "open") return;
  surpriseItem = null;
  ambient.hidden = true;
  if (canOpenInReader(it)) {
    readerUI.open(it);
    if (it.source === "reddit" || it.source === "hackernews") preloadNext(it);
  } else {
    openMediaFor(it);
  }
});

/* ---- tabs / rail / chips (locked #2/#7) ---- */
function isInboxHome() {
  return (
    state.status === "inbox" &&
    !state.source &&
    !state.category &&
    !state.tags.length &&
    !state.q &&
    !state.exact
  );
}

function paintTabs() {
  $$(".folder, .spill").forEach((t) => {
    t.setAttribute(
      "aria-selected",
      String((t.dataset.status ?? "") === state.status),
    );
  });
  const home = $("#dock-inbox");
  if (home) home.setAttribute("aria-pressed", String(isInboxHome()));
}
$$(".folder, .spill").forEach((t) =>
  t.addEventListener("click", () => {
    if (t.dataset.status === undefined) return;
    state.status = t.dataset.status;
    state.sort = sortForTab(state.status);
    sortSel.value = state.sort; // per-tab sort (All → smart)
    paintTabs();
    refreshRail();
    loadItems(true);
    loadCounts();
  }),
);

async function loadCounts() {
  // Keep + Done get counts (processed piles read as wins); Inbox/Archived/All never do.
  try {
    const s = await api.fetchStats({ light: 1 });
    const by = s.by_status || {};
    $$("[data-count]").forEach((el) => {
      const v =
        by[el.dataset.count] && by[el.dataset.count].toLocaleString
          ? by[el.dataset.count].toLocaleString()
          : by[el.dataset.count] || "";
      el.textContent = v || "";
    });
  } catch (e) {
    /* counts are decoration */
  }
}

function railBtn(label, value, count, kind, color) {
  const on =
    kind === "source" ? state.source === value : state.tags.includes(value);
  return (
    '<button type="button" class="rnav" data-' +
    kind +
    '="' +
    esc(value) +
    '"' +
    (color ? ' style="--src:' + color + '"' : "") +
    ' aria-pressed="' +
    on +
    '">' +
    '<span class="dot"></span>' +
    esc(label) +
    (count ? '<span class="n">' + count + "</span>" : "") +
    "</button>"
  );
}

/* The tag rail, grouped under parent headers (Epic 26 P2). Each present group renders a
   header (data-tagparent = its present child ids) that OR-selects/clears all its children in
   one click, then the indented child rows (the same per-tag toggles as before). Tags not in
   any served group (drift / a user tag that ever reaches the curated facet set) fall into a
   trailing "More" group so nothing silently vanishes. */
function railTagsHtml() {
  const present = new Map(facets.tags.map((t) => [t.id, t]));
  const grouped = new Set();
  let html = "";
  for (const g of facets.groups) {
    const kids = (g.tags || []).map((id) => present.get(id)).filter(Boolean);
    if (!kids.length) continue; // whole group filtered out (e.g. NSFW hidden)
    kids.forEach((k) => grouped.add(k.id));
    const sel = kids.filter((k) => state.tags.includes(k.id)).length;
    const selState = sel === 0 ? "none" : sel === kids.length ? "all" : "some";
    const total = kids.reduce((n, k) => n + (k.count || 0), 0);
    html +=
      '<div class="rail-group">' +
      '<button type="button" class="rnav rail-ghead" data-tagparent="' +
      esc(kids.map((k) => k.id).join(",")) +
      '" data-sel="' +
      selState +
      '" aria-pressed="' +
      (selState === "all") +
      '">' +
      '<span class="dot"></span>' +
      esc(g.label) +
      '<span class="n">' +
      total +
      "</span></button>" +
      kids.map((k) => railBtn(k.label, k.id, k.count, "tag")).join("") +
      "</div>";
  }
  const orphans = facets.tags.filter((t) => !grouped.has(t.id));
  if (orphans.length) {
    html +=
      '<div class="rail-group"><div class="rail-ghead static">More</div>' +
      orphans.map((t) => railBtn(t.label, t.id, t.count, "tag")).join("") +
      "</div>";
  }
  return html;
}
async function refreshRail() {
  try {
    // Tag/category facets cross-filter by BOTH the active status AND source (Epic 26 P2:
    // source-aware rail) — picking a source narrows the rail to that source's tags, volume-
    // ordered within each group. The source list itself stays status-only so you can still
    // switch source.
    const fp = {};
    if (state.status) fp.status = state.status;
    if (state.source) fp.source = state.source;
    const qs = new URLSearchParams(fp).toString();
    const [src, cats, tags] = await Promise.all([
      api.fetchSources(state.status || undefined),
      api.getJSON("/categories?" + qs),
      api.getJSON("/tags?" + qs),
    ]);
    // one fetch fills BOTH the desktop rail and the mobile drawer (shared facet data)
    facets.sources = src.sources || [];
    facets.categories = cats.categories || [];
    facets.tags = Object.entries(tags.tags || {})
      .map(([id, count]) => ({ id, label: id, count }))
      // hide the NSFW tag facets from the rail/drawer/autocomplete while "Hide NSFW" is on (Epic 14)
      .filter((t) => !(state.safe && /^nsfw/i.test(t.id)));
    facets.groups = tags.groups || [];
    state.curated = new Set(facets.tags.map((t) => t.id));
    $("#rail-sources").innerHTML = facets.sources
      .map((s) => railBtn(s.label, s.id, s.count, "source", s.badge_color))
      .join("");
    $("#rail-tags").innerHTML = railTagsHtml();
    renderDrawer();
    if (!state.loading) warmItemFirstPages();
  } catch (e) {
    /* rail is navigation sugar */
  }
}
document.addEventListener("click", (e) => {
  // the drawer owns its own rows (and the category facet) — see the #navdrawer handler
  if (e.target.closest("#fchips") || e.target.closest("#navdrawer")) return;
  const parent = e.target.closest("[data-tagparent]");
  if (parent) {
    // rail group header → OR-select (or clear) all of its present children at once
    const kids = parent.dataset.tagparent.split(",").filter(Boolean);
    if (kids.every((t) => state.tags.includes(t)))
      state.tags = state.tags.filter((t) => !kids.includes(t));
    else
      kids.forEach((t) => {
        if (!state.tags.includes(t)) state.tags.push(t);
      });
    paintChips();
    refreshRail();
    loadItems(true);
    return;
  }
  const r = e.target.closest("[data-source], [data-tag]");
  if (!r) return;
  if (r.dataset.source !== undefined) {
    state.source = state.source === r.dataset.source ? "" : r.dataset.source;
  } else if (r.dataset.tag !== undefined) {
    const t = r.dataset.tag,
      i = state.tags.indexOf(t);
    if (i >= 0) state.tags.splice(i, 1);
    else state.tags.push(t);
    closeSheets();
  }
  paintChips();
  refreshRail();
  loadItems(true);
});
function paintChips() {
  const chips = [];
  if (state.source) chips.push("source:" + state.source);
  if (state.category) chips.push("category:" + state.category);
  state.tags.forEach((t) => chips.push("tag:" + t));
  $("#fchips").innerHTML =
    chips
      .map(
        (label) =>
          '<button type="button" class="fchip" data-chip="' +
          esc(label) +
          '">' +
          esc(label) +
          '<span class="x">✕</span></button>',
      )
      .join("") +
    (chips.length > 1
      ? '<button type="button" class="fclear">clear all</button>'
      : "");
  paintTabs();
}
$("#fchips").addEventListener("click", (e) => {
  const chip = e.target.closest(".fchip");
  if (chip) {
    const v = chip.dataset.chip;
    if (v.startsWith("source:")) state.source = "";
    else if (v.startsWith("category:")) state.category = "";
    else {
      const t = v.slice(4);
      const i = state.tags.indexOf(t);
      if (i >= 0) state.tags.splice(i, 1);
    }
  } else if (e.target.closest(".fclear")) {
    state.source = "";
    state.category = "";
    state.tags = [];
  } else return;
  paintChips();
  refreshRail();
  loadItems(true);
});
$("#peekswept").addEventListener("click", () => {
  $("#q").value = "is:swept";
  state.q = "is:swept";
  state.status = "";
  paintTabs();
  loadItems(true);
  toast("Peeking at what rested — everything is still here.");
});

/* ---- search + operator discovery (Epic 12: visible Gmail/Discord-style operators) ---- */
const qInput = $("#q");
function focusSearchBox() {
  const head = $(".console");
  if (head) head.classList.remove("compact");
  window.scrollTo({ top: 0 });
  requestAnimationFrame(() => {
    try {
      qInput.focus({ preventScroll: true });
    } catch (e) {
      qInput.focus();
    }
  });
}
const runSearch = debounce(() => {
  if (qInput.value.startsWith(">")) return; // command mode — palette.js owns the input
  state.q = qInput.value.trim();
  paintTabs();
  loadItems(true);
}, 300);
qInput.addEventListener("input", runSearch);
initOperators(qInput, $("#oppop"), {
  // tag values come from the shared drawer/rail facet data (full curated list)
  getDyn: (which) => (which === "tags" ? facets.tags.map((t) => t.id) : []),
  onApply: () => {
    state.q = qInput.value.trim();
    paintTabs();
    loadItems(true);
  },
});
$("#exact").addEventListener("change", (e) => {
  state.exact = e.target.checked;
  paintTabs();
  loadItems(true);
});
$("#dock-search").addEventListener("click", () => {
  focusSearchBox();
});

/* ---- sort ---- */
const sortSel = $("#sort");
sortSel.value = state.sort;
if (sortSel.value !== state.sort) {
  state.sort = "first_seen_utc:desc";
  sortSel.value = state.sort;
}
sortSel.addEventListener("change", () => {
  state.sort = sortSel.value;
  try {
    localStorage.setItem(sortKey(state.status), state.sort);
  } catch (e) {} // remember per tab
  loadItems(true);
});

function goInboxHome() {
  state.status = "inbox";
  state.source = "";
  state.category = "";
  state.tags = [];
  state.q = "";
  state.exact = false;
  qInput.value = "";
  const exact = $("#exact");
  if (exact) exact.checked = false;
  state.sort = sortForTab(state.status);
  sortSel.value = state.sort;
  paintTabs();
  paintChips();
  refreshRail();
  loadItems(true);
  loadCounts();
  window.scrollTo({ top: 0 });
}
const dockInbox = $("#dock-inbox");
if (dockInbox) dockInbox.addEventListener("click", goInboxHome);

/* ---- keyboard: the one-hand map (locked at Gate 1) ---- */
let cursor = -1;
function moveCursor(d) {
  const rows = $$(".row, .pin");
  if (!rows.length) return;
  cursor = Math.min(rows.length - 1, Math.max(0, cursor + d));
  rows.forEach((r, i) => r.classList.toggle("cursor", i === cursor));
  rows[cursor].scrollIntoView({ block: "nearest" });
}
function cursorItem() {
  const r = $$(".row, .pin")[cursor];
  return r
    ? state.items.find((it) => it.fullname === r.dataset.fullname)
    : null;
}
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeSheets();
    return;
  }
  if (isTypingTarget(e.target)) return;
  if (e.ctrlKey || e.metaKey) {
    // undo/redo chords; other modifier combos pass through to the browser
    const c = e.key.toLowerCase();
    if (c === "z" && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      const u = $("#toast .toast-undo");
      if (u) u.click();
    } else if (!e.altKey && (c === "y" || (c === "z" && e.shiftKey))) {
      e.preventDefault();
      redo();
    }
    return; // never fall through to single-key actions while a modifier is held
  }
  const k = e.key.toLowerCase();
  if (k === "/") {
    e.preventDefault();
    focusSearchBox();
    return;
  }
  if (e.key === "?") {
    toggleKbd();
    return;
  }
  if (k === "w") {
    moveCursor(-1);
    return;
  }
  if (k === "s") {
    moveCursor(1);
    return;
  }
  const it = cursorItem();
  if (k === "f" && it) act(it.fullname, "keep");
  else if (k === "a" && it) act(it.fullname, "archived");
  else if (k === "d" && it) act(it.fullname, "done");
  else if (k === "x" && it && state.status !== "inbox")
    act(it.fullname, "inbox");
  else if (k === "e" && it) {
    const u = it.url;
    if (u) window.open(u, "_blank", "noopener");
  } else if (k === "t" && it) {
    tagEditor.open(it.fullname, rowEl(it.fullname));
  } else if (k === "q" && it) {
    const r = rowEl(it.fullname);
    if (r) toggleSelect(r);
  } else if (k === "z") {
    const u = $("#toast .toast-undo");
    if (u) u.click();
  } else if (k === "y") {
    redo();
  } else if (e.key === " " && it) {
    e.preventDefault();
    openMediaFor(it);
  }
});

/* ---- sheets / settings panel ---- */
const scrim = $("#scrim");
let _browseLock = 0;
let _browseLockSaved = 0; // #items scroll
let _browseBodyLockSaved = 0; // body scroll

function lockBrowseScroll() {
  if (_browseLock === 0) {
    _browseLockSaved = itemsEl.scrollTop;
    _browseBodyLockSaved = window.scrollY || document.documentElement.scrollTop;
    document.body.style.overflow = "hidden"; // lock the body too
  }
  _browseLock++;
  itemsEl.style.overflow = "hidden";
}

function unlockBrowseScroll() {
  if (_browseLock <= 0) return;
  _browseLock = Math.max(0, _browseLock - 1);
  if (_browseLock === 0) {
    itemsEl.style.overflow = "";
    document.body.style.overflow = ""; // restore the body
    if (_browseLockSaved) itemsEl.scrollTop = _browseLockSaved;
    if (_browseBodyLockSaved) {
      window.scrollTo(0, _browseBodyLockSaved); // restore body scroll position
    }
    _browseLockSaved = 0;
    _browseBodyLockSaved = 0;
  }
}
function openPanel(id) {
  closeSheets();
  $(id).classList.add("show");
  scrim.classList.add("show");
  lockBrowseScroll();
}
function closeSheets() {
  ["#settings", "#navdrawer", "#kbd", "#statsheet", "#dupesheet"].forEach((s) =>
    $(s).classList.remove("show"),
  );
  if (drawer) drawer.setAttribute("aria-hidden", "true");
  scrim.classList.remove("show");
  // also collapse any open Relay-style inline strip (Epic 16 B3)
  if (typeof closeRelay === "function") closeRelay();
  // restore browse scroll when ALL sheets are closed (Epic 16: sidebar scroll-lock)
  unlockBrowseScroll();
}

async function readError(err, fallback) {
  if (!err || typeof err.json !== "function") return fallback;
  try {
    const body = await err.json();
    return body && body.error ? body.error : fallback;
  } catch (e) {
    return fallback;
  }
}

function formatCutoffDate(ts) {
  return new Date(ts * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function paintDoneRetention() {
  const current = $("#done-retention-current");
  const preview = $("#done-retention-preview");
  const confirm = $("#done-retention-confirm");
  const purge = $("#done-retention-purge");
  const feedback = $("#done-retention-feedback");
  if (!current || !preview || !confirm || !purge || !feedback) return;

  $$("#set-done-retention button").forEach((b) =>
    b.setAttribute(
      "aria-pressed",
      String(parseInt(b.dataset.days, 10) === doneRetention.days),
    ),
  );

  if (!doneRetention.loaded) {
    current.textContent = "Loading current window...";
    preview.textContent = "Checking what would be purged...";
    confirm.checked = false;
    purge.disabled = true;
    feedback.innerHTML =
      "The purge writes a timestamped DB backup and appends <code>delete-audit.jsonl</code>.";
    return;
  }

  current.textContent =
    "Current window: " +
    doneRetention.days +
    " day" +
    (doneRetention.days === 1 ? "" : "s") +
    ".";

  const plan = doneRetention.preview;
  if (!plan) {
    preview.textContent = "Could not load the current purge preview.";
  } else if (!plan.total) {
    preview.textContent =
      "Nothing is eligible right now. Done items older than " +
      formatCutoffDate(plan.cutoff) +
      " would be purged.";
  } else {
    preview.innerHTML =
      "<b>" +
      plan.total.toLocaleString() +
      "</b> Done item" +
      (plan.total === 1 ? "" : "s") +
      " older than <b>" +
      formatCutoffDate(plan.cutoff) +
      "</b> would be permanently deleted.";
  }
  purge.disabled =
    doneRetention.loading || !plan || !plan.total || !confirm.checked;
  feedback.innerHTML = doneRetention.loading
    ? "Working..."
    : "The purge writes a timestamped DB backup and appends <code>delete-audit.jsonl</code>.";
}

async function loadDoneRetention(force) {
  if (doneRetention.loading || (doneRetention.loaded && !force)) {
    paintDoneRetention();
    return;
  }
  doneRetention.loading = true;
  paintDoneRetention();
  try {
    const data = await api.getJSON("/settings/done-retention");
    doneRetention.days = parseInt(data.retention_days, 10) || 30;
    doneRetention.preview = data.preview || null;
    doneRetention.loaded = true;
  } catch (e) {
    toast("Couldn't load Done retention.");
  } finally {
    doneRetention.loading = false;
    paintDoneRetention();
  }
}

/* ---- Relay-style inline long-press strip (Epic 16 B3) ----
   Long-press / right-click a row → the row translates aside and a horizontal action
   strip appears in its place, in the same thumb zone (no reach to mid-screen).
   The strip is injected into the row; a transparent .relay-scrim captures outside
   taps / Escape to collapse it back. */
let relayFn = null;
let relayRow = null;
const relayScrim = $("#relay-scrim");
const relayTpl = $("#relay-strip-tpl");

function relaySourceHref(it) {
  const m = it.metadata || {};
  if (it.source === "reddit" && m.subreddit)
    return "https://www.reddit.com/r/" + encodeURIComponent(m.subreddit);
  if (it.source === "youtube" && m.channel) {
    // channel id preferred when present; falls back to the handle/@name
    const id = m.channel_id || "";
    if (id) return "https://www.youtube.com/channel/" + encodeURIComponent(id);
    return "https://www.youtube.com/" + encodeURIComponent(m.channel);
  }
  if (it.source === "hackernews")
    return (
      "https://news.ycombinator.com/item?id=" +
      encodeURIComponent(it.source_id || "")
    );
  const u = itemUrl(it) || it.url || "";
  return u;
}
function relaySourceLabel(it) {
  const m = it.metadata || {};
  if (it.source === "reddit" && m.subreddit) return "r/" + m.subreddit;
  if (it.source === "youtube" && m.channel) return m.channel;
  if (it.source === "hackernews") return "HN";
  // fall back to the URL domain
  try {
    const u = itemUrl(it) || it.url || "";
    if (u) return new URL(u).hostname.replace(/^www\./, "");
  } catch (e) {}
  return it.source || "source";
}
function relayAuthorHref(it) {
  const a = (it.author || "").trim();
  if (!a) return "";
  if (it.source === "reddit")
    return "https://www.reddit.com/user/" + encodeURIComponent(a);
  if (it.source === "hackernews")
    return "https://news.ycombinator.com/user?id=" + encodeURIComponent(a);
  if (it.source === "youtube")
    return "https://www.youtube.com/" + encodeURIComponent(a);
  return "";
}
function relayAuthorLabel(it) {
  const a = it.author || "";
  if (!a) return "";
  if (it.source === "reddit" || it.source === "hackernews") return "u/" + a;
  return a;
}

function closeRelay() {
  if (!relayFn && !relayRow) return;
  if (relayRow) {
    relayRow.classList.remove("relay-open");
    const fg = relayRow.querySelector(".item-fg");
    if (fg) {
      fg.style.transition = "";
      fg.style.transform = "";
    }
    const strip = relayRow.querySelector(".relay-strip");
    if (strip) strip.remove();
  }
  relayFn = null;
  relayRow = null;
  if (relayScrim) relayScrim.classList.remove("show");
}
function openRowMenu(fn) {
  const it = state.items.find((i) => i.fullname === fn);
  if (!it) return;
  const row = rowEl(fn);
  if (!row || !relayTpl) return;
  // collapse any prior relay strip first (e.g. right-click after a long-press)
  closeSheets();
  closeRelay();

  // build the strip from the template, then hydrate the source/author links
  const frag = relayTpl.content.cloneNode(true);
  // helper: turn a <button class="relay-btn"> into a navigation <a> with the same
  // children/classes (buttons don't navigate even with href set).
  const toLink = (btn, href) => {
    const a = document.createElement("a");
    a.className = btn.className;
    a.setAttribute("data-relay", btn.dataset.relay);
    a.setAttribute("role", "menuitem");
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener";
    while (btn.firstChild) a.appendChild(btn.firstChild);
    btn.replaceWith(a);
    return a;
  };
  const srcBtn = frag.querySelector('[data-relay="source"]');
  const srcLabel = relaySourceLabel(it);
  srcBtn.setAttribute("aria-label", srcLabel);
  const srcLblEl = srcBtn.querySelector('[data-relay-label="source"]');
  if (srcLblEl) srcLblEl.textContent = srcLabel;
  const srcHref = relaySourceHref(it);
  if (srcHref) toLink(srcBtn, srcHref);
  else srcBtn.hidden = true;
  const auBtn = frag.querySelector('[data-relay="author"]');
  const auLabel = relayAuthorLabel(it);
  const auHref = relayAuthorHref(it);
  if (auHref && auLabel) {
    auBtn.setAttribute("aria-label", auLabel);
    const auLblEl = auBtn.querySelector('[data-relay-label="author"]');
    if (auLblEl) auLblEl.textContent = auLabel;
    toLink(auBtn, auHref);
  } else {
    auBtn.hidden = true;
  }

  row.appendChild(frag);
  relayFn = fn;
  relayRow = row;
  // double-rAF so the strip's enter transition runs (inserted at offset, then translated to 0)
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      row.classList.add("relay-open");
      if (relayScrim) relayScrim.classList.add("show");
    }),
  );
}
// clicks on the strip (the row's own click handler is for triage/title taps; this is
// a dedicated listener on itemsEl that only acts when a relay strip is the target)
itemsEl.addEventListener("click", (e) => {
  const btn = e.target.closest(".relay-btn[data-relay]");
  if (!btn) return;
  const action = btn.dataset.relay,
    fn = relayFn;
  // source/author are real anchors (href set above) — let them navigate, just collapse
  if (action === "source" || action === "author") {
    closeRelay();
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  closeRelay();
  if (!fn) return;
  if (action === "tag") tagEditor.open(fn, rowEl(fn));
  else if (action === "share")
    shareItem(state.items.find((i) => i.fullname === fn));
  else if (action === "snooze") snooze(fn);
});
if (relayScrim) relayScrim.addEventListener("click", closeRelay);
// Escape closes an open relay strip (the global keydown below also routes here)
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && relayFn) closeRelay();
});
// desktop has no long-press → right-click a row opens the same menu
itemsEl.addEventListener("contextmenu", (e) => {
  // Keep the native browser menu on real links so users can copy/open URLs.
  // Right-clicking row chrome/text still opens the row action strip.
  if (e.target.closest("a[href]")) return;
  const card = e.target.closest(".row[data-fullname]");
  if (!card) return;
  e.preventDefault();
  openRowMenu(card.dataset.fullname);
});
function toggleKbd() {
  const k = $("#kbd"),
    show = !k.classList.contains("show");
  closeSheets();
  if (show) {
    k.classList.add("show");
    scrim.classList.add("show");
  }
}
scrim.addEventListener("click", closeSheets);
$("#open-settings").addEventListener("click", () => {
  openPanel("#settings");
  loadDoneRetention(true);
});
$("#dock-settings").addEventListener("click", () => {
  openPanel("#settings");
  loadDoneRetention(true);
});

/* ---- loaded-version badge + Relay-style shrink-on-scroll top bar ----
   APP_VERSION is baked into THIS (cached) main.js, so the badge shows what your phone is actually
   running — not the server's latest. Bump it together with sw.js CACHE on every shippable change. */
const APP_VERSION = "v105";
(() => {
  const ver = $("#app-version");
  if (ver) ver.textContent = APP_VERSION;
  const head = $(".console");
  if (!head) return;
  // Collapsing/expanding the (sticky) header changes its height, so the browser's scroll-anchoring
  // nudges scrollY to keep content stable — near a threshold that nudge re-triggered the toggle =
  // flicker (worst near the top, where expanding GROWS the bar). Three guards: (1) a WIDE dead zone
  // (>110 collapse / <28 expand) bigger than the bar's height change, so the nudge lands inside it;
  // (2) a short LOCK after each toggle that ignores scroll while the reflow + .22s transition settle;
  // (3) defer near-top expansion until scroll settles, unless we are already effectively at y=0.
  // Once near-top expansion happens, keep it expanded through scroll-anchoring's final nudge.
  const COLLAPSE_AT = 110;
  const COLLAPSE_AFTER_TOP_AT = 260;
  const EXPAND_AT = 28;
  const SCROLL_SETTLE_MS = 120;
  let locked = false;
  let scrollIdle = true;
  let settleTimer = 0;
  let expandedNearTop = false;
  const set = (compact) => {
    if (compact === head.classList.contains("compact")) return; // already in this state
    head.classList.toggle("compact", compact);
    if (compact) expandedNearTop = false;
    locked = true;
    setTimeout(() => {
      locked = false;
      onScroll();
    }, 320); // > the collapse transition
  };
  const expandNearTop = () => {
    expandedNearTop = true;
    set(false);
  };
  browseTopScroll.onStart(expandNearTop);
  browseTopScroll.onEnd(onScroll);
  function onScroll() {
    const y = window.scrollY || 0;
    if (browseTopScroll.active) {
      if (y <= BROWSE_TOP_EPSILON) expandNearTop();
      return;
    }
    if (locked) return;
    if (y > COLLAPSE_AT) {
      if (expandedNearTop && y < COLLAPSE_AFTER_TOP_AT) return;
      set(true); // scrolled well down → shrink
    } else if (y <= BROWSE_TOP_EPSILON)
      expandNearTop(); // true top → expand immediately
    else if (y < EXPAND_AT && scrollIdle) expandNearTop(); // near top → expand after momentum settles
    // 28..110 = wide dead zone: keep the current state
  }
  function markScrollActive() {
    scrollIdle = false;
    clearTimeout(settleTimer);
    settleTimer = setTimeout(markScrollIdle, SCROLL_SETTLE_MS);
  }
  function markScrollIdle() {
    clearTimeout(settleTimer);
    scrollIdle = true;
    onScroll();
  }
  window.addEventListener(
    "scroll",
    () => {
      markScrollActive();
      onScroll();
    },
    { passive: true },
  );
  if ("onscrollend" in window)
    window.addEventListener("scrollend", markScrollIdle, { passive: true });
})();

/* ---- mobile "Jump" drawer: search + grouped facets, pin, collapse, sections ----
   The phone expression of the desktop .rail. Rows render from the SAME facet data
   refreshRail() fetches (sources/categories/tags); selecting a row drives the same
   state.source/category/tags filter + #fchips chips the rail/desktop already use.
   Deferred to a later tier: the per-row ⋮ action sheet (Mute/Rename need backend
   endpoints that don't exist yet) and a standalone "+ New tag" (tags attach to items,
   there's no standalone-tag create flow). The star (pin) + ⚙ (sections) cover the
   locked Tier-1 affordances today. */
const GROUPS = [
  { id: "sources", label: "SOURCES", kind: "source" },
  { id: "categories", label: "CATEGORIES", kind: "category" },
  { id: "tags", label: "TAGS", kind: "tag" },
];
const titleCase = (s) => s.charAt(0) + s.slice(1).toLowerCase();
function siCount(n) {
  n = +n || 0;
  if (n < 1000) return String(n);
  const unit = n < 1e6 ? "k" : "m";
  const v = n / (n < 1e6 ? 1000 : 1e6);
  return (
    (v < 10 ? v.toFixed(1).replace(/\.0$/, "") : String(Math.round(v))) + unit
  );
}
function facetRows(kind) {
  if (kind === "source")
    return facets.sources.map((s) => ({
      kind,
      value: s.id,
      label: s.label,
      count: s.count,
      color: s.badge_color,
    }));
  if (kind === "category")
    return facets.categories.map((c) => ({
      kind,
      value: c.id,
      label: c.label,
      count: c.count,
    }));
  // Categories are folded into the tag system, so /tags echoes the category names
  // (listenable/watch/wotagei/unknown) back as tags. They have their own Categories
  // group above, so drop them here — each facet should appear exactly once in the
  // drawer. (Drawer-local: the desktop .rail reads facets.tags directly and has no
  // Categories group, so it still surfaces these as its only way to reach them.)
  const catIds = new Set(
    facets.categories.map((c) => String(c.id).toLowerCase()),
  );
  return facets.tags
    .filter((t) => !catIds.has(String(t.id).toLowerCase()))
    .map((t) => ({ kind, value: t.id, label: t.label, count: t.count }));
}
const pinKey = (r) => r.kind + ":" + r.value;
function isActive(r) {
  return r.kind === "source"
    ? state.source === r.value
    : r.kind === "category"
      ? state.category === r.value
      : state.tags.includes(r.value);
}
function highlight(label, q) {
  const i = label.toLowerCase().indexOf(q);
  if (i < 0) return esc(label);
  return (
    esc(label.slice(0, i)) +
    "<mark>" +
    esc(label.slice(i, i + q.length)) +
    "</mark>" +
    esc(label.slice(i + q.length))
  );
}
function rowHtml(r) {
  const pinned = pins.has(pinKey(r));
  const q = navFilter.trim().toLowerCase();
  const mark =
    r.kind === "tag"
      ? '<span class="jmark tag" aria-hidden="true">#</span>'
      : '<span class="jmark ' +
        (r.kind === "category" ? "cat" : "") +
        '"' +
        (r.color ? ' style="--src:' + r.color + '"' : "") +
        ' aria-hidden="true"></span>';
  return (
    '<div class="jrow" role="button" tabindex="0" data-' +
    r.kind +
    '="' +
    esc(r.value) +
    '"' +
    ' aria-pressed="' +
    isActive(r) +
    '" aria-label="' +
    esc(r.label) +
    '">' +
    mark +
    '<span class="jlabel">' +
    (q ? highlight(r.label, q) : esc(r.label)) +
    "</span>" +
    '<span class="jcount" title="' +
    r.count +
    '">' +
    siCount(r.count) +
    "</span>" +
    '<button type="button" class="jstar' +
    (pinned ? " on" : "") +
    '" data-pin="' +
    esc(pinKey(r)) +
    '"' +
    ' aria-pressed="' +
    pinned +
    '" aria-label="' +
    (pinned ? "Unpin " : "Pin ") +
    esc(r.label) +
    '">' +
    (pinned ? "★" : "☆") +
    "</button></div>"
  );
}
function groupHtml(id, label, rows) {
  const col = collapsed.has(id);
  return (
    '<div class="nd-group' +
    (col ? " collapsed" : "") +
    '" data-group="' +
    id +
    '">' +
    '<button type="button" class="nd-ghead" aria-expanded="' +
    !col +
    '">' +
    '<span class="nd-glabel">' +
    label +
    "</span>" +
    '<span class="nd-gcount">' +
    rows.length +
    "</span>" +
    '<span class="nd-chev" aria-hidden="true">▸</span></button>' +
    '<div class="nd-rows">' +
    rows.map(rowHtml).join("") +
    "</div></div>"
  );
}
function renderDrawer() {
  if (!drawer) return;
  const q = navFilter.trim().toLowerCase();
  const match = (r) => !q || r.label.toLowerCase().includes(q);
  const byKey = new Map(
    []
      .concat(facetRows("source"), facetRows("category"), facetRows("tag"))
      .map((r) => [pinKey(r), r]),
  );
  const pinnedRows = [...pins]
    .map((k) => byKey.get(k))
    .filter(Boolean)
    .filter(match);

  let groups = "";
  if (pinnedRows.length) groups += groupHtml("pinned", "PINNED", pinnedRows);
  for (const g of GROUPS) {
    if (hiddenGroups.has(g.id)) continue;
    const rows = facetRows(g.kind).filter(match);
    if (rows.length) groups += groupHtml(g.id, g.label, rows);
  }
  const manage = managing
    ? '<div class="nd-managebar"><span class="nd-mlab">SHOW SECTIONS</span>' +
      GROUPS.map(
        (g) =>
          '<button type="button" class="nd-mtoggle" data-section="' +
          g.id +
          '"' +
          ' aria-pressed="' +
          !hiddenGroups.has(g.id) +
          '">' +
          titleCase(g.label) +
          "</button>",
      ).join("") +
      "</div>"
    : "";
  const empty =
    '<div class="nd-empty">' +
    (q
      ? "no matches for “" + esc(navFilter.trim()) + "”"
      : "nothing to jump to yet") +
    "</div>";
  $("#nav-list").innerHTML = manage + (groups || empty);
}
function selectFacet(kind, value) {
  if (kind === "source") state.source = state.source === value ? "" : value;
  else if (kind === "category")
    state.category = state.category === value ? "" : value;
  else {
    const i = state.tags.indexOf(value);
    if (i >= 0) state.tags.splice(i, 1);
    else state.tags.push(value);
  }
  paintChips();
  refreshRail();
  loadItems(true);
  closeSheets();
}
function openDrawer() {
  closeSheets();
  navFilter = "";
  const f = $("#nav-filter");
  if (f) f.value = "";
  managing = false;
  $("#nav-manage").setAttribute("aria-pressed", "false");
  renderDrawer();
  drawer.classList.add("show");
  scrim.classList.add("show");
  drawer.setAttribute("aria-hidden", "false");
  lockBrowseScroll();
  // Desktop only: autofocusing the filter pops the on-screen keyboard on mobile (user-reported).
  if (!isPhone())
    setTimeout(() => {
      const fi = $("#nav-filter");
      if (fi) fi.focus();
    }, 60);
}
$("#open-nav").addEventListener("click", openDrawer);
$("#nav-close").addEventListener("click", closeSheets);
$("#nav-filter").addEventListener("input", (e) => {
  navFilter = e.target.value;
  renderDrawer();
});
$("#nav-manage").addEventListener("click", () => {
  managing = !managing;
  $("#nav-manage").setAttribute("aria-pressed", String(managing));
  renderDrawer();
});
drawer.addEventListener("click", (e) => {
  // The drawer owns every click inside it. stopPropagation BEFORE any renderDrawer()
  // re-render: re-rendering detaches the clicked node mid-event, which would otherwise
  // bubble to the document rail handler and misfire (its #navdrawer guard sees an
  // orphaned node and fails). Stopping here keeps drawer clicks out of that handler.
  const ghead = e.target.closest(".nd-ghead");
  if (ghead) {
    e.stopPropagation();
    const g = ghead.closest(".nd-group").dataset.group;
    collapsed.has(g) ? collapsed.delete(g) : collapsed.add(g);
    saveSet("chDrawerCollapsed", collapsed);
    renderDrawer();
    return;
  }
  const star = e.target.closest(".jstar");
  if (star) {
    e.stopPropagation();
    const k = star.dataset.pin;
    pins.has(k) ? pins.delete(k) : pins.add(k);
    saveSet("chDrawerPins", pins);
    renderDrawer();
    toast(pins.has(k) ? "Pinned." : "Unpinned.");
    return;
  }
  const mtoggle = e.target.closest(".nd-mtoggle");
  if (mtoggle) {
    e.stopPropagation();
    const s = mtoggle.dataset.section;
    hiddenGroups.has(s) ? hiddenGroups.delete(s) : hiddenGroups.add(s);
    saveSet("chDrawerHidden", hiddenGroups);
    renderDrawer();
    return;
  }
  const row = e.target.closest(".jrow");
  if (row) {
    e.stopPropagation();
    const kind =
      row.dataset.source !== undefined
        ? "source"
        : row.dataset.category !== undefined
          ? "category"
          : "tag";
    selectFacet(kind, row.dataset[kind]);
  }
});
drawer.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const row = e.target.closest(".jrow");
  if (row && e.target === row) {
    e.preventDefault();
    row.click();
  }
});

/* left edge-swipe opens the drawer (mobile only — desktop uses the rail) */
let edgeX = null;
const isPhone = () => window.matchMedia("(max-width:700px)").matches;
document.addEventListener(
  "touchstart",
  (e) => {
    edgeX =
      !drawer.classList.contains("show") && e.touches[0].clientX <= 22
        ? e.touches[0].clientX
        : null;
  },
  { passive: true },
);
document.addEventListener(
  "touchmove",
  (e) => {
    if (edgeX == null) return;
    if (e.touches[0].clientX - edgeX > 40) {
      edgeX = null;
      if (isPhone()) openDrawer();
    }
  },
  { passive: true },
);
document.addEventListener(
  "touchend",
  () => {
    edgeX = null;
  },
  { passive: true },
);

/* Swipe-DOWN-to-dismiss for the mobile bottom sheets. Engages only at scroll-top with a
   downward drag, so it never fights the sheet's own scroll or its toggle buttons. The
   preventDefault on the engaged drag also blocks the browser's pull-to-refresh, which
   otherwise hijacks the down-swipe and reloads the page instead of closing the sheet. */
function attachSheetDismiss(panel) {
  if (!panel) return;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  let startY = 0,
    dy = 0,
    dragging = false,
    engaged = false;

  const settle = (toY, after) => {
    let fired = false;
    const fin = () => {
      if (fired) return;
      fired = true;
      panel.removeEventListener("transitionend", fin);
      if (after) after(); // before clearing inline: closeSheets removes .show while
      panel.style.transition = ""; // the sheet is already off-screen → no flash back up
      panel.style.transform = "";
    };
    if (reduced.matches) {
      panel.style.transition = "none";
      panel.style.transform = toY;
      fin();
      return;
    }
    panel.style.transition = "transform 180ms var(--ease)";
    panel.style.transform = toY;
    panel.addEventListener("transitionend", fin);
    setTimeout(fin, 240); // fallback if transitionend never fires
  };

  panel.addEventListener(
    "touchstart",
    (e) => {
      if (e.touches.length !== 1) return;
      if (!window.matchMedia("(max-width:700px)").matches) return; // bottom-sheet layout only
      startY = e.touches[0].clientY;
      dy = 0;
      dragging = true;
      engaged = panel.scrollTop <= 0; // decide once, up front
      panel.style.transition = "none";
    },
    { passive: true },
  );

  panel.addEventListener(
    "touchmove",
    (e) => {
      if (!dragging || !engaged) return;
      dy = e.touches[0].clientY - startY;
      if (dy <= 0) return; // upward → let content scroll
      e.preventDefault(); // own the gesture (no pull-to-refresh)
      panel.style.transform = "translate(-50%," + dy + "px)";
    },
    { passive: false },
  );

  const end = () => {
    if (!dragging) return;
    dragging = false;
    if (engaged && dy > Math.min(120, panel.offsetHeight * 0.3))
      settle("translate(-50%,110%)", closeSheets);
    else if (dy > 0) settle("translate(-50%,0)");
  };
  panel.addEventListener("touchend", end);
  panel.addEventListener("touchcancel", end);
}
["#settings", "#statsheet", "#dupesheet", "#tagsheet"].forEach((s) =>
  attachSheetDismiss($(s)),
);

/* ---- stats sheet (Epic 14: Stats lives in the settings menu) ---- */
function statsBarRows(obj, max) {
  return Object.entries(obj || {})
    .sort((a, b) => b[1] - a[1])
    .map(
      ([k, v]) =>
        '<div class="stat-row"><span class="sk">' +
        esc(k) +
        "</span>" +
        '<i class="bar" style="width:' +
        Math.round((v / max) * 100) +
        '%"></i>' +
        '<span class="sv">' +
        v.toLocaleString() +
        "</span></div>",
    )
    .join("");
}
function statsHtml(d) {
  const head =
    '<div class="stat-row"><span class="sk">Processed this week</span><span class="sv">' +
    (d.processed_this_week || 0).toLocaleString() +
    "</span></div>" +
    '<div class="stat-row"><span class="sk">Total saves</span><span class="sv">' +
    (d.total || 0).toLocaleString() +
    "</span></div>" +
    '<div class="stat-row"><span class="sk">With a link</span><span class="sv">' +
    (d.with_url || 0).toLocaleString() +
    "</span></div>";
  const maxOf = (o) => Math.max(...Object.values(o || {}), 1);
  return (
    head +
    '<div class="lab">BY SOURCE</div>' +
    statsBarRows(d.by_source, maxOf(d.by_source)) +
    '<div class="lab">BY STATUS</div>' +
    statsBarRows(d.by_status, maxOf(d.by_status))
  );
}
$("#open-stats").addEventListener("click", async () => {
  const list = $("#stats-list");
  list.textContent = "Counting the shelves…";
  openPanel("#statsheet");
  try {
    list.innerHTML = statsHtml(await api.fetchStats());
  } catch (e) {
    list.textContent = "Couldn't load stats — try again.";
  }
});

let dupeBy = "url";
let dupeGroups = [];
function dupeItemHtml(it, keep) {
  const title = it.title || it.url || it.fullname;
  return (
    '<div class="dup-item' +
    (it.fullname === keep ? " keep" : "") +
    '">' +
    '<span class="dup-src">' +
    esc(it.source || "") +
    "</span>" +
    '<span class="dup-title">' +
    esc(title) +
    "</span>" +
    (it.fullname === keep ? '<span class="dup-keep">keep</span>' : "") +
    "</div>"
  );
}
function dupesHtml(groups) {
  if (!groups.length)
    return '<div class="dup-empty">No duplicate groups in Inbox.</div>';
  return groups
    .map((g, i) => {
      const keep = g.suggested_keep;
      const archive = (g.items || [])
        .filter((it) => it.fullname !== keep)
        .map((it) => it.fullname);
      return (
        '<section class="dup-group" data-dupe-idx="' +
        i +
        '">' +
        '<div class="dup-head"><b>' +
        esc(g.key || "") +
        "</b><span>" +
        g.count +
        " items</span></div>" +
        '<div class="dup-items">' +
        (g.items || []).map((it) => dupeItemHtml(it, keep)).join("") +
        "</div>" +
        '<button type="button" class="ambbtn primary" data-dupe-resolve="' +
        i +
        '"' +
        (archive.length ? "" : " disabled") +
        ">Archive others</button>" +
        "</section>"
      );
    })
    .join("");
}
async function loadDupes() {
  const list = $("#dup-list");
  list.textContent = "Finding duplicate saves...";
  try {
    const data = await api.fetchDuplicates({ by: dupeBy, status: "inbox" });
    dupeGroups = data.groups || [];
    list.innerHTML = dupesHtml(dupeGroups);
  } catch (e) {
    list.textContent = "Couldn't load duplicates.";
  }
}
$("#open-dupes").addEventListener("click", () => {
  openPanel("#dupesheet");
  loadDupes();
});
$("#dupesheet").addEventListener("click", async (e) => {
  const by = e.target.closest("[data-dupe-by]");
  if (by) {
    dupeBy = by.dataset.dupeBy || "url";
    $$("#dupesheet [data-dupe-by]").forEach((b) =>
      b.setAttribute("aria-pressed", String(b === by)),
    );
    loadDupes();
    return;
  }
  const btn = e.target.closest("[data-dupe-resolve]");
  if (!btn) return;
  const group = dupeGroups[parseInt(btn.dataset.dupeResolve, 10)];
  if (!group) return;
  const keep = group.suggested_keep;
  const archive = (group.items || [])
    .filter((it) => it.fullname !== keep)
    .map((it) => it.fullname);
  if (!archive.length) return;
  btn.disabled = true;
  try {
    await api.resolveDuplicates(keep, archive);
    clearItemFirstPageCache();
    snackbar(
      "Archived " +
        archive.length +
        " duplicate" +
        (archive.length === 1 ? "." : "s."),
      async () => {
        await api.undoDuplicates(archive);
        clearItemFirstPageCache();
        loadDupes();
        loadItems(true);
        loadCounts();
        refreshPulse();
      },
    );
    loadDupes();
    loadItems(true);
    loadCounts();
    refreshPulse();
  } catch (err) {
    toast("Duplicate resolve failed.");
    btn.disabled = false;
  }
});

$$("#set-theme button").forEach((b) =>
  b.addEventListener("click", () => {
    // theme.js owns persistence; mirror its storage contract ("ch-theme")
    document.documentElement.dataset.theme = b.dataset.theme;
    try {
      localStorage.setItem("ch-theme", b.dataset.theme);
    } catch (e) {}
    $$("#set-theme button").forEach((x) =>
      x.setAttribute("aria-pressed", String(x === b)),
    );
  }),
);
$$("#set-density button").forEach((b) =>
  b.addEventListener("click", () => {
    state.density = b.dataset.d;
    localStorage.chDensity = state.density;
    $$("#set-density button").forEach((x) =>
      x.setAttribute("aria-pressed", String(x === b)),
    );
    render();
  }),
);
$$("#set-loading button").forEach((b) =>
  b.addEventListener("click", () => {
    setFocus(b.dataset.focus === "1");
  }),
);
$$("#set-goal button").forEach((b) =>
  b.addEventListener("click", () => {
    state.goal = parseInt(b.dataset.g, 10) || 0;
    localStorage.chGoal = String(state.goal);
    $$("#set-goal button").forEach((x) =>
      x.setAttribute("aria-pressed", String(x === b)),
    );
    paintWins();
  }),
);
$$("#set-nsfw button").forEach((b) =>
  b.addEventListener("click", () => {
    state.safe = b.dataset.nsfw === "hide";
    localStorage.chSafe = state.safe ? "1" : "0";
    $$("#set-nsfw button").forEach((x) =>
      x.setAttribute("aria-pressed", String(x === b)),
    );
    refreshRail(); // surface/hide the nsfw_* facets to match the toggle (Epic 14)
    loadItems(true);
  }),
);
$$("#set-archive button").forEach((b) =>
  b.addEventListener("click", () => {
    state.archiveMedia = b.dataset.archive === "on"; // prefer local /media copies (Epic 4 P1)
    localStorage.chArchiveMedia = state.archiveMedia ? "1" : "0";
    setArchivePref(state.archiveMedia);
    $$("#set-archive button").forEach((x) =>
      x.setAttribute("aria-pressed", String(x === b)),
    );
    render(); // re-render with the new media-source preference
  }),
);
$("#done-retention-confirm").addEventListener("change", paintDoneRetention);
$$("#set-done-retention button").forEach((b) =>
  b.addEventListener("click", async () => {
    if (doneRetention.loading) return;
    const days = parseInt(b.dataset.days, 10);
    if (!days || days === doneRetention.days) return;
    doneRetention.loading = true;
    $("#done-retention-confirm").checked = false;
    paintDoneRetention();
    try {
      const data = await api.postJSON("/settings/done-retention", {
        retention_days: days,
      });
      doneRetention.days = parseInt(data.retention_days, 10) || days;
      doneRetention.preview = data.preview || null;
      doneRetention.loaded = true;
      toast("Done retention set to " + doneRetention.days + " days.");
    } catch (err) {
      toast(await readError(err, "Couldn't save Done retention."));
    } finally {
      doneRetention.loading = false;
      paintDoneRetention();
    }
  }),
);
$("#done-retention-purge").addEventListener("click", async () => {
  if (
    doneRetention.loading ||
    !doneRetention.preview ||
    !doneRetention.preview.total
  )
    return;
  if (!$("#done-retention-confirm").checked) {
    paintDoneRetention();
    return;
  }
  doneRetention.loading = true;
  paintDoneRetention();
  try {
    const data = await api.postJSON("/settings/done-retention/purge", {
      expected_total: doneRetention.preview.total,
      expected_cutoff: doneRetention.preview.cutoff,
    });
    doneRetention.preview = data.preview || null;
    doneRetention.loaded = true;
    $("#done-retention-confirm").checked = false;
    toast(
      "Purged " +
        (data.purged?.total || 0) +
        " Done item" +
        ((data.purged?.total || 0) === 1 ? "." : "s."),
    );
    clearItemFirstPageCache();
    loadItems(true);
    loadCounts();
    refreshRail();
    refreshPulse();
  } catch (err) {
    let body = null;
    if (err && typeof err.json === "function") {
      try {
        body = await err.json();
      } catch (e) {}
    }
    if (body && body.preview) {
      doneRetention.preview = body.preview;
      doneRetention.loaded = true;
      $("#done-retention-confirm").checked = false;
    }
    toast((body && body.error) || "Done purge failed.");
  } finally {
    doneRetention.loading = false;
    paintDoneRetention();
  }
});

/* ---- "Sync newest": surface the /reddit incremental sync on the browse view (Epic 9) ---- */
const syncBtn = $("#open-sync");
if (syncBtn)
  syncBtn.addEventListener("click", async () => {
    if (syncBtn.disabled) return;
    const label = syncBtn.textContent;
    syncBtn.disabled = true;
    syncBtn.textContent = "Syncing newest…";
    try {
      const data = await api.postJSON("/reddit/sync", {});
      if (data.auth_error)
        toast("Sync needs a reddit_session cookie — set it up first.");
      else if (data.error) toast("Sync error: " + data.error);
      else {
        toast(
          "+" +
            data.new +
            " new (" +
            data.fetched +
            " fetched · " +
            data.stopped +
            ").",
        );
        clearItemFirstPageCache();
        loadItems(true);
        loadCounts();
        refreshRail();
        refreshPulse();
      }
    } catch (e) {
      toast("Sync failed — network error.");
    }
    syncBtn.textContent = label;
    syncBtn.disabled = false;
  });

/* reflect persisted settings into the panel */
$$("#set-density button").forEach((b) =>
  b.setAttribute("aria-pressed", String(b.dataset.d === state.density)),
);
$$("#set-loading button").forEach((b) =>
  b.setAttribute(
    "aria-pressed",
    String((b.dataset.focus === "1") === state.focus),
  ),
);
$$("#set-goal button").forEach((b) =>
  b.setAttribute(
    "aria-pressed",
    String((parseInt(b.dataset.g, 10) || 0) === state.goal),
  ),
);
$$("#set-nsfw button").forEach((b) =>
  b.setAttribute(
    "aria-pressed",
    String((b.dataset.nsfw === "hide") === state.safe),
  ),
);
$$("#set-archive button").forEach((b) =>
  b.setAttribute(
    "aria-pressed",
    String((b.dataset.archive === "on") === state.archiveMedia),
  ),
);
$$("#set-theme button").forEach((b) =>
  b.setAttribute(
    "aria-pressed",
    String(
      (document.documentElement.dataset.theme || "dark") === b.dataset.theme,
    ),
  ),
);
paintDoneRetention();

/* ---- wheel from the side gutters scrolls the list (13:385) ---- */
document.addEventListener(
  "wheel",
  (e) => {
    if (e.target === document.body || e.target === document.documentElement) {
      window.scrollBy({ top: e.deltaY });
    }
  },
  { passive: true },
);

wireTagExpanders(itemsEl);

/* persist the active view (status/source/tags) across reloads — sessionStorage so it survives a
   refresh/return within the session but a fresh app launch still starts clean at the inbox.
   (sort/density/focus/goal/nsfw already persist via localStorage.) */
const VIEW_KEY = "ch_view";
function saveView() {
  try {
    sessionStorage.setItem(
      VIEW_KEY,
      JSON.stringify({
        status: state.status,
        source: state.source,
        tags: state.tags,
      }),
    );
  } catch (e) {
    /* private mode / quota — non-fatal */
  }
}
function restoreView() {
  try {
    const v = JSON.parse(sessionStorage.getItem(VIEW_KEY) || "null");
    if (!v || typeof v !== "object") return;
    if (typeof v.status === "string") state.status = v.status;
    if (typeof v.source === "string") state.source = v.source;
    if (Array.isArray(v.tags))
      state.tags = v.tags.filter((t) => typeof t === "string");
  } catch (e) {
    /* ignore corrupt value */
  }
}
restoreView();
state.sort = sortForTab(state.status);
sortSel.value = state.sort; // apply the tab's sort once the view restores

async function openDeepLinkedReader() {
  const qs = new URLSearchParams(location.search);
  const fn = qs.get("open");
  if (!fn) return;
  try {
    const item = await api.fetchItem(fn);
    const fromTriage = qs.get("from") === "triage";
    let triageEnter = false;
    if (fromTriage) {
      try {
        triageEnter =
          qs.get("enter") === "up" ||
          sessionStorage.getItem("ch_triage_reader_enter") === fn;
        sessionStorage.removeItem("ch_triage_reader_enter");
      } catch (e) {
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
    readerUI.open(item, { from: fromTriage ? "triage" : "", triageEnter });
  } catch (e) {
    toast("Couldn't open that item.");
  }
}

/* ---- boot ---- */
paintTabs();
paintChips();
paintWins();
refreshRail();
loadCounts();
refreshPulse();
loadAmbient();
loadItems(true);
openDeepLinkedReader();

if ("serviceWorker" in navigator)
  navigator.serviceWorker.register("/static/sw.js").catch((err) => {
    // Service workers (and therefore PWA install) only work in a secure context:
    // HTTPS, or localhost/127.0.0.1. Plain HTTP over a LAN or Tailscale IP fails
    // here silently — surface it so the cause is visible. See docs/MOBILE_TAILSCALE.md.
    console.warn(
      "Service worker registration failed (needs HTTPS or localhost):",
      err,
    );
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
      if (
        (r.new || 0) > 0 ||
        (rec.unsaved || 0) > 0 ||
        (rec.promoted_done || 0) > 0
      ) {
        clearItemFirstPageCache();
        loadItems(true);
        loadCounts();
        refreshRail();
        refreshPulse();
      }
    } catch (e) {
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
    label: "Go to Triage",
    hint: "page",
    run: () => location.assign("/triage"),
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
