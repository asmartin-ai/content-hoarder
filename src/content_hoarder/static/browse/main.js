/* browse/main.js — v3 browse page entry (Epic 20 Stage C).
   Spec: 05-log-book-2.html + 06-adhd-round.html (LOCKED 2026-06-11).
   State, fetching, infinite scroll / Focus batches, keyboard, swipe, bulk,
   the ambient resurfacing slot, win pebbles, and the settings panel. */

import { esc, debounce, isTypingTarget } from "../core/util.js";
import * as api from "../core/api.js";
import { toast, snackbar } from "../core/toast.js";
import { createLightbox, imageUrl, imageUrls, redditUrl, playableVideoSrc, localUrl, setArchivePref, thumb } from "../core/media.js";
import { attachSwipe } from "../core/swipe.js";
import { wireTagExpanders, shareItem } from "../core/render.js";
import { listHtml, emptyHtml, isNsfw } from "./render.js";
import { initReader } from "./reader.js";
import { initPalette } from "./palette.js";
import { initOperators } from "./operators.js";
import { initTagEditor } from "./tagedit.js";

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
  safe: localStorage.chSafe !== "0",   // default ON: hide NSFW unless the user opted into "Show all"
  archiveMedia: localStorage.chArchiveMedia === "1",  // default OFF: prefer local /media copies (Epic 4 P1)
  goal: localStorage.chGoal === undefined ? 8 : parseInt(localStorage.chGoal, 10) || 0,
  offset: 0,
  hasMore: false,
  loading: false,
  items: [],
  batchTotal: 0,     // Focus: size of the dealt batch
  batchCleared: 0,   // Focus: cleared from THIS batch (session-local)
  stamped: false,    // Focus: celebration shown for this batch
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
  try { const v = localStorage.getItem(sortKey(status)); if (v) return v; } catch (e) {}
  return SORT_BY_TAB[status] || localStorage.chSort || SORT_DEFAULT;
}
setArchivePref(state.archiveMedia);  // tell core/media.js whether to prefer local /media copies
const nsfwRevealed = new Set();
const itemsEl = $("#items");

/* ---- mobile "Jump" drawer state (the phone expression of the .rail) ---- */
const drawer = $("#navdrawer");
let facets = { sources: [], categories: [], tags: [], groups: [] };
let navFilter = "";
let managing = false;
const loadJSON = (k, f) => { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? f; } catch (e) { return f; } };
const saveSet = (k, s) => { try { localStorage.setItem(k, JSON.stringify([...s])); } catch (e) {} };
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
  const p = { sort: state.sort.split(":")[0], order: state.sort.split(":")[1], ...extra };
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

let loadGen = 0;
async function loadItems(reset) {
  // an append during a load is a duplicate; a RESET supersedes whatever is in
  // flight (generation check below — otherwise clearing a slow search drops the
  // user's newest intent on the floor)
  if (!reset && state.loading) return;
  const gen = ++loadGen;
  state.loading = true;
  if (reset) {
    state.offset = 0;
    state.items = [];
    state.batchCleared = 0;
    state.stamped = false;
    saveView();   // persist the active view so a reload/return keeps your place
    // keep the current rows on screen (dimmed) during a refetch — only blank to the skeleton on a
    // cold start, so changing filter/sort/status/source no longer flashes the whole list away
    if (itemsEl.querySelector("[data-fullname]")) itemsEl.classList.add("loading");
    else itemsEl.innerHTML = '<div class="skeleton">FETCHING…</div>';
  }
  try {
    const limit = state.focus ? FOCUS_BATCH : 50;
    const offset = state.offset;
    const r = await api.getJSON("/items?" + params({ limit, offset }));
    if (gen !== loadGen) return;  // a newer load superseded this one
    state.items = state.items.concat(r.items);
    state.hasMore = state.focus ? false : r.has_more;
    state.offset += r.items.length;
    if (reset && state.focus) state.batchTotal = r.items.length;
    render();
  } catch (e) {
    if (gen === loadGen) {
      itemsEl.classList.remove("loading");
      itemsEl.innerHTML = '<div class="skeleton">COULDN’T LOAD — IS THE SERVER UP?</div>';
    }
  } finally {
    if (gen === loadGen) state.loading = false;
  }
}

function render() {
  itemsEl.className = "items density-" + state.density;
  if (!state.items.length) {
    itemsEl.innerHTML = emptyHtml(state.focus);
    paintBatch();
    return;
  }
  itemsEl.innerHTML = listHtml(state.items, state, {
    view: state.status, curated: state.curated,
    nsfwRevealed: false,
  });
  // re-apply NSFW reveals + attach swipe per row (touch-only inside attachSwipe)
  $$(".row, .pin").forEach((row) => {
    const fn = row.dataset.fullname;
    if (nsfwRevealed.has(fn)) {
      row.querySelectorAll(".monitor.nsfw, .screen.nsfw").forEach((el) => el.classList.remove("nsfw"));
    }
    if (row.classList.contains("row")) {
      attachSwipe(row, {
        commit: 80, commit2: 170,
        onRight: () => act(fn, "archived"),
        onRightLong: () => act(fn, "keep"),
        onLeft: () => act(fn, "done"),
        onLongPress: () => openRowMenu(fn),
      });
    }
  });
  paintBatch();
}

/* ---- actions: live clear + undo/redo (locked #11) ---- */
function rowEl(fullname) {
  return itemsEl.querySelector('[data-fullname="' + CSS.escape(fullname) + '"]');
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
  if (row) row.querySelectorAll(".monitor, .screen").forEach((el) => el.classList.add("nsfw"));
}

/* Single-level redo buffer: the last single-item action that was undone, so it can
   be replayed. Mirrors the single-level snackbar undo (only the most recent action is
   undoable, so only one is redoable). Any new act() clears it. */
let lastUndone = null;

async function act(fullname, status) {
  lastUndone = null;                                // a fresh action invalidates the redo buffer
  if (window.chHaptic) window.chHaptic(status);   // tactile confirm on the decision (covers swipe + buttons)
  const row = rowEl(fullname);
  if (row && !row.classList.contains("leaving")) {
    row.classList.add("leaving", "lv-" + status);
    await new Promise((r) => setTimeout(r, 180));
  }
  try {
    await api.setStatus(fullname, status);
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
      bumpPulse(status === "inbox" ? 0 : -1);
      if (state.focus) state.batchCleared = Math.max(0, state.batchCleared - 1);
      // restore the row in place — no full refetch/skeleton, keeps the scroll position
      if (undoItem && !state.items.some((it) => it.fullname === fullname)) {
        state.items.splice(Math.min(undoIdx, state.items.length), 0, undoItem);
      }
      render();
      lastUndone = { fullname, status };           // now redoable
    } catch (e) { toast("Undo failed."); }
  });
}

async function snooze(fullname) {
  lastUndone = null;
  if (window.chHaptic) window.chHaptic("skip");
  const row = rowEl(fullname);
  if (row && !row.classList.contains("leaving")) {
    row.classList.add("leaving", "lv-snooze");
    await new Promise((r) => setTimeout(r, 180));
  }
  let res;
  try {
    res = await api.snoozeItem(fullname, { window_days: 7 });
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
  snackbar(escalated ? "Archived after repeat snoozes." : "Snoozed for 7 days.", async () => {
    try {
      const undoBody = res && res.snoozed_wave
        ? { snoozed_wave: res.snoozed_wave }
        : { decayed_at: res.decayed_at };
      await api.undoSnooze(undoBody);
      if (state.focus) state.batchCleared = Math.max(0, state.batchCleared - 1);
      if (escalated) bumpPulse(-1);
      if (undoItem && !state.items.some((it) => it.fullname === fullname)) {
        state.items.splice(Math.min(undoIdx, state.items.length), 0, undoItem);
      }
      render();
    } catch (e) { toast("Undo failed."); }
  });
}

/* Redo: replay the last undone single-item action (re-applies the status + shows a
   fresh undo snackbar). act() resets lastUndone, so it's a clean one-step toggle. */
function redo() {
  if (!lastUndone) { toast("Nothing to redo."); return; }
  act(lastUndone.fullname, lastUndone.status);
}

/* the in-app thread reader — replaces external handoff for Reddit/HN discussion
   threads. act/openMediaFor/closeSheets are hoisted function declarations. */
const readerUI = initReader({
  onTriage: act, onSnooze: snooze, onMedia: openMediaFor, closeSheets, onClose: reblur,
  onImage: (url) => lightbox.openImage(url),   // inline comment/selftext image → lightbox
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
    if (it) { it.metadata = it.metadata || {}; it.metadata.tags = tags; }
    render();
    refreshRailSoon();
  },
});

/* delegated row interactions */
itemsEl.addEventListener("click", (e) => {
  const actBtn = e.target.closest(".act");
  const card = e.target.closest("[data-fullname]");
  if (!card) return;
  const fn = card.dataset.fullname;
  if (actBtn && actBtn.dataset.act) { act(fn, actBtn.dataset.act); return; }   // status acts carry data-act
  if (e.target.closest("[data-select]")) { toggleSelect(card); return; }
  const tagBtn = e.target.closest("[data-tagedit]");
  if (tagBtn) { e.stopPropagation(); tagEditor.open(fn, tagBtn); return; }
  const media = e.target.closest("[data-media]");
  if (media) {
    const item = state.items.find((it) => it.fullname === fn);
    if (!item) return;
    if (isNsfw(item) && !nsfwRevealed.has(fn)) {  // first tap reveals, second opens
      nsfwRevealed.add(fn);
      media.classList.remove("nsfw");             // veil hidden by CSS; re-blurs on reader/lightbox close
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
  if (rItem && (rItem.source === "reddit" || rItem.source === "hackernews" ||
                rItem.source === "keep" || rItem.source === "obsidian")) {
    const a = e.target.closest("a");
    const onTitle = a && a.parentElement && a.parentElement.tagName === "H3";
    const onText = !a && e.target.closest(".title, .snippet, .pin h3");
    if (onTitle || onText) {
      e.preventDefault();
      readerUI.open(rItem);
      if (rItem.source === "reddit" || rItem.source === "hackernews") preloadNext(rItem);
    }
  }
});

/* ---- predictive preload: on reader-open, warm the NEXT discussion thread + its media (Epic 8 P2) ----
   Sequential reading is the common path, so when an item opens we pre-hydrate the next Reddit/HN
   comment thread (a GET lazily hydrates it server-side → the next open is instant) and prime its media
   image. Bounded + safe: ONE thread fetch per open (de-duped via _preloaded), only discussion items have
   threads, and an in-flight preload is aborted when a newer one starts. */
let _preloadCtl = null;
const _preloaded = new Set();
const threadPath = (item) => item && item.source === "hackernews"
  ? "/hackernews/items/" + encodeURIComponent(item.fullname) + "/thread"
  : item && item.source === "reddit"
    ? "/reddit/items/" + encodeURIComponent(item.fullname) + "/thread"
    : "";
function preloadNext(opened) {
  if (!opened) return;
  const i = state.items.indexOf(opened);
  if (i < 0) return;
  let next = null;                                  // nearest following discussion item (small look-ahead)
  for (let j = i + 1; j < state.items.length && j <= i + 4; j++) {
    if (state.items[j].source === "reddit" || state.items[j].source === "hackernews") { next = state.items[j]; break; }
  }
  if (!next) return;
  const mu = imageUrl(next);                         // prime media (CDN/local — no rate-limit concern)
  if (mu) { const im = new Image(); im.src = mu; }
  if (_preloaded.has(next.fullname)) return;         // warm each thread at most once
  _preloaded.add(next.fullname);
  if (_preloadCtl) { try { _preloadCtl.abort(); } catch (_e) {} }
  _preloadCtl = new AbortController();
  // sort is irrelevant for warming (hydration caches the whole thread; sort is applied at read time)
  const path = threadPath(next);
  if (path) fetch(path, { signal: _preloadCtl.signal }).catch(() => {});
}

/* ---- media lightbox ---- */
let lastMediaFn = null;   // item whose media is open in the lightbox → re-blurred on close
const lightbox = createLightbox({ modal: "#media-modal", body: "#media-body", onClose: () => reblur(lastMediaFn) });
function openMediaFor(item) {
  lastMediaFn = item.fullname;
  const m = item.metadata || {};
  if (Array.isArray(m.gallery) && m.gallery.length)
    // sized variants load first (Epic 13 P2); prefer locally-archived copies when present (Epic 4 P1)
    return lightbox.openGallery(m.gallery.map((u) => localUrl(item, u)),
                               (m.gallery_preview || []).map((u) => localUrl(item, u)));
  const imgs = imageUrls(item);
  if (imgs.length > 1) return lightbox.openGallery(imgs, imgs);
  const vsrc = playableVideoSrc(item);   // shared playability test (same as the reader's inline player)
  if (vsrc) return lightbox.openVideo(vsrc, m.thumbnail);
  const img = imageUrl(item);
  if (img) return lightbox.openImage(img);
  /* Gallery without captured image URLs — show a clean placeholder, not a reddit iframe
     (the 33 empty-gallery items have no local images to stack; the iframe was a bad
     fallback — user preference 2026-06-22). */
  if (m.media_type === "gallery" || /\/gallery\//i.test(item.url || "")) {
    const url = redditUrl(m.permalink || item.url);
    return lightbox.openHtml(url ? '<p class="media-fallback">Gallery images unavailable (not archived).</p>' +
      '<a class="media-fallback" href="' + esc(url) + '" target="_blank" rel="noopener">Open on Reddit ↗</a>'
      : '<p class="media-fallback">Gallery images unavailable.</p>');
  }
  if (m.permalink) return lightbox.openMedia(m.permalink);
  const url = item.url; if (url) window.open(url, "_blank", "noopener");
}

/* ---- bulk select (locked: avatar shade select; overlay bar; bulk undo) ---- */
const selected = new Set();
function toggleSelect(card) {
  const fn = card.dataset.fullname;
  if (selected.has(fn)) { selected.delete(fn); card.classList.remove("selected"); }
  else { selected.add(fn); card.classList.add("selected"); }
  paintBulk();
}
function clearSelection() {
  selected.clear();
  $$(".selected").forEach((el) => el.classList.remove("selected"));
  paintBulk();
}
function paintBulk() {
  $("#bulkcnt").textContent = String(selected.size).padStart(2, "0");
  $("#bulktray").classList.toggle("show", selected.size > 0);
}
$("#bulkclear").addEventListener("click", clearSelection);
$$("#bulktray [data-bulk]").forEach((b) => b.addEventListener("click", async () => {
  const fns = [...selected], status = b.dataset.bulk;
  if (!fns.length) return;
  if (window.chHaptic) window.chHaptic(status);
  clearSelection();
  try { await api.bulkStatus(fns, status); }
  catch (e) { toast("Bulk action failed."); return; }
  const bulkRemoved = fns.map((fn) => {
    const i = state.items.findIndex((it) => it.fullname === fn);
    return i >= 0 ? { i, item: state.items[i] } : null;
  }).filter(Boolean);
  state.items = state.items.filter((it) => !fns.includes(it.fullname));
  if (state.focus) state.batchCleared += fns.length;
  bumpPulse(status === "inbox" ? 0 : fns.length);
  render();
  snackbar(fns.length + " — " + (COPY[status] || "logged.").toLowerCase(), async () => {
    const r = await api.bulkUndo(fns);
    bumpPulse(status === "inbox" ? 0 : -r.ok);
    // restore the rows in place (ascending index) — no full refetch/skeleton
    bulkRemoved.sort((a, b) => a.i - b.i).forEach(({ i, item }) => {
      if (!state.items.some((it) => it.fullname === item.fullname)) {
        state.items.splice(Math.min(i, state.items.length), 0, item);
      }
    });
    render();
  });
}));

/* ---- pulse: pebbles, "· N new", dateline, decay line (locked #1/#2/#3/#12) ---- */
function bumpPulse(d) {
  state.pulse.cleared_today = Math.max(0, state.pulse.cleared_today + d);
  paintWins();
}
function paintWins() {
  const dots = $("#windots"), n = state.pulse.cleared_today;
  if (state.goal > 0) {
    dots.innerHTML = Array.from({ length: state.goal },
      (_, k) => "<i" + (k < n ? ' class="on"' : "") + "></i>").join("");
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
  const day = d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "long" });
  $("#dateline").innerHTML = esc(day) + " — <b>" + p.new_today + " new</b> today. " +
    '<em class="norush">No rush.</em>';
  $("#decayline").hidden = !p.swept_recent;
  $("#decay-n").textContent = p.swept_recent.toLocaleString();
  paintWins();
}
async function refreshPulse() {
  try { state.pulse = await api.getJSON("/pulse"); paintPulse(); } catch (e) { /* ambient */ }
}

/* ---- Focus batches + stamp (locked #10) ---- */
function paintBatch() {
  document.body.classList.toggle("focus", state.focus);
  if (!state.focus) return;
  const total = state.batchTotal, done = Math.min(state.batchCleared, total);
  $("#segs").innerHTML = Array.from({ length: total },
    (_, k) => "<i" + (k < done ? ' class="on"' : "") + "></i>").join("");
  $("#batchn").textContent = done + " of " + total + " cleared";
  if (total > 0 && state.items.length === 0 && !state.stamped) {
    state.stamped = true;
    if (window.chHaptic) window.chHaptic("milestone");   // the one richer celebration
    $("#stampsub").textContent = total + " ENTRIES · " +
      new Date().toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }).toUpperCase();
    $("#stamp").classList.add("show");
  }
}
function setFocus(on) {
  state.focus = on;
  localStorage.chFocus = on ? "1" : "0";
  $("#dock-focus").setAttribute("aria-pressed", String(on));
  $$("#set-loading button").forEach((b) =>
    b.setAttribute("aria-pressed", String((b.dataset.focus === "1") === on)));
  loadItems(true);
}
$("#drawagain").addEventListener("click", () => {
  $("#stamp").classList.remove("show");
  loadItems(true);
});
$("#enough").addEventListener("click", () => $("#stamp").classList.remove("show"));
$("#dock-focus").addEventListener("click", () => setFocus(!state.focus));
itemsEl.addEventListener("click", (e) => {
  if (e.target.closest("#empty-draw")) { if (!state.focus) setFocus(true); else loadItems(true); }
  if (e.target.closest("#empty-surprise")) surprise();
});

/* ---- infinite scroll (off in Focus) ---- */
new IntersectionObserver((entries) => {
  if (entries[0].isIntersecting && state.hasMore && !state.focus && !state.loading) loadItems(false);
}, { rootMargin: "600px" }).observe($("#sentinel"));

/* ---- mobile floating scroll-to-top (Epic 13) ---- */
const gotop = $("#gotop");
const GOTOP_AT = 700;            // px scrolled before the affordance appears
let gotopTick = false;
function syncGotop() {
  gotopTick = false;
  gotop.classList.toggle("show", window.scrollY > GOTOP_AT);
}
window.addEventListener("scroll", () => {          // rAF-throttled (60fps lane)
  if (!gotopTick) { gotopTick = true; requestAnimationFrame(syncGotop); }
}, { passive: true });
gotop.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));

/* ---- the ambient slot: resurfacing card + surprise (locked #4/#5) ---- */
const ambient = $("#ambient");
function cardHtml(c) {
  const samples = (c.sample || []).map((s) => "“" + esc(s.title || "") + "”").join(" · ");
  const added = c.last_added_utc
    ? new Date(c.last_added_utc * 1000).toLocaleDateString(undefined, { month: "short", year: "numeric" })
    : "";
  return '<div class="amb-eyebrow">' + (c.reactivated ? "YOU’RE BACK ON THIS?" : "REMEMBER?") + "</div>" +
    "<h3>Still interested in <em>" + esc(c.label) + "</em>?</h3>" +
    '<div class="amb-body"><div class="amb-meta">' +
    c.count + " saves in <b>" + esc(c.label) + "</b>" + (added ? " · last added " + esc(added) : "") +
    '<div class="amb-samples">' + samples + "</div></div></div>" +
    '<div class="amb-acts">' +
    '<button type="button" class="ambbtn primary" data-amb="show">Show me</button>' +
    '<button type="button" class="ambbtn" data-amb="later">Not now</button>' +
    '<button type="button" class="ambbtn letgo" data-amb="letgo">Let it go</button></div>';
}
let ambientCard = null;
let surpriseItem = null;
async function loadAmbient() {
  try {
    const r = await fetch("/resurface");
    if (r.status !== 200) return;
    ambientCard = await r.json();
    ambient.innerHTML = cardHtml(ambientCard);
    ambient.hidden = false;
  } catch (e) { /* ambient — never an error surface */ }
}
ambient.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-amb]");
  if (!b) return;
  const action = b.dataset.amb;
  if (action === "open") { ambient.hidden = true; return; }
  if (!ambientCard) { ambient.hidden = true; return; }
  const cluster = ambientCard.cluster;
  if (action === "later") {
    ambient.hidden = true;                      // silent — never mentioned again
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
      snackbar(r.total + " saves let go — resting in the archive.", async () => {
        await api.postJSON("/resurface/letgo/undo", { cluster, decayed_at: r.decayed_at });
        loadItems(true); refreshPulse();
      });
      loadItems(true); refreshPulse();
    } catch (err) { toast("Couldn't let that go — try again."); }
  }
});
async function surprise() {
  try {
    const r = await api.getJSON("/random?n=1");
    const it = (r.items || [])[0];
    if (!it) { toast("Nothing to deal — the shelves are empty."); return; }
    const m = it.metadata || {};
    const t = thumb(it, "list") || imageUrl(it) || "";
    const media = t ? '<div class="amb-thumb"><img src="' + esc(t) + '" alt="" loading="lazy"></div>' : "";
    surpriseItem = it;
    ambient.innerHTML = '<div class="amb-eyebrow">DEALT AT RANDOM — NO STRINGS</div>' +
      "<h3>“" + esc(it.title || "(untitled)") + "”</h3>" +
      '<div class="amb-body">' + media + '<div class="amb-meta">' +
      (m.subreddit ? "<b>r/" + esc(m.subreddit) + "</b> · " : "") +
      (it.created_utc ? "from " + new Date(it.created_utc * 1000).getFullYear() : "") +
      "</div></div>" +
      '<div class="amb-acts">' +
      '<button type="button" class="ambbtn primary" data-surprise="open">Open</button>' +
      '<button type="button" class="ambbtn" data-surprise="dismiss">Not today</button></div>';
    ambientCard = null;
    ambient.hidden = false;
    ambient.scrollIntoView({ block: "nearest", behavior: "smooth" });
  } catch (e) { toast("The dice jammed — try again."); }
}
$("#dice").addEventListener("click", surprise);
ambient.addEventListener("click", (e) => {
  const b = e.target.closest("[data-surprise]");
  if (!b) return;
  const action = b.dataset.surprise;
  if (action === "dismiss") {
    surpriseItem = null;
    ambient.hidden = true;
    return;
  }
  if (action !== "open" || !surpriseItem) return;
  const it = surpriseItem;
  surpriseItem = null;
  ambient.hidden = true;
  if (it.source === "reddit" || it.source === "hackernews" ||
      it.source === "keep" || it.source === "obsidian") {
    readerUI.open(it);
    if (it.source === "reddit" || it.source === "hackernews") preloadNext(it);
  } else {
    openMediaFor(it);
  }
});

/* ---- tabs / rail / chips (locked #2/#7) ---- */
function paintTabs() {
  $$(".folder, .spill").forEach((t) => {
    t.setAttribute("aria-selected", String((t.dataset.status ?? "") === state.status));
  });
}
$$(".folder, .spill").forEach((t) => t.addEventListener("click", () => {
  if (t.dataset.status === undefined) return;
  state.status = t.dataset.status;
  state.sort = sortForTab(state.status); sortSel.value = state.sort;   // per-tab sort (All → smart)
  paintTabs(); refreshRail(); loadItems(true); loadCounts();
}));

async function loadCounts() {
  // Keep + Done get counts (processed piles read as wins); Inbox/Archived/All never do.
  try {
    const s = await api.fetchStats({ light: 1 });
    const by = s.by_status || {};
    $$("[data-count]").forEach((el) => {
      const v = (by[el.dataset.count] && by[el.dataset.count].toLocaleString)
        ? by[el.dataset.count].toLocaleString() : (by[el.dataset.count] || "");
      el.textContent = v || "";
    });
  } catch (e) { /* counts are decoration */ }
}

function railBtn(label, value, count, kind, color) {
  const on = kind === "source" ? state.source === value : state.tags.includes(value);
  return '<button type="button" class="rnav" data-' + kind + '="' + esc(value) + '"' +
    (color ? ' style="--src:' + color + '"' : "") + ' aria-pressed="' + on + '">' +
    '<span class="dot"></span>' + esc(label) +
    (count ? '<span class="n">' + count + "</span>" : "") + "</button>";
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
    if (!kids.length) continue;                      // whole group filtered out (e.g. NSFW hidden)
    kids.forEach((k) => grouped.add(k.id));
    const sel = kids.filter((k) => state.tags.includes(k.id)).length;
    const selState = sel === 0 ? "none" : sel === kids.length ? "all" : "some";
    const total = kids.reduce((n, k) => n + (k.count || 0), 0);
    html += '<div class="rail-group">' +
      '<button type="button" class="rnav rail-ghead" data-tagparent="' +
        esc(kids.map((k) => k.id).join(",")) + '" data-sel="' + selState +
        '" aria-pressed="' + (selState === "all") + '">' +
      '<span class="dot"></span>' + esc(g.label) +
      '<span class="n">' + total + "</span></button>" +
      kids.map((k) => railBtn(k.label, k.id, k.count, "tag")).join("") +
      "</div>";
  }
  const orphans = facets.tags.filter((t) => !grouped.has(t.id));
  if (orphans.length) {
    html += '<div class="rail-group"><div class="rail-ghead static">More</div>' +
      orphans.map((t) => railBtn(t.label, t.id, t.count, "tag")).join("") + "</div>";
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
    $("#rail-sources").innerHTML = facets.sources.map((s) =>
      railBtn(s.label, s.id, s.count, "source", s.badge_color)).join("");
    $("#rail-tags").innerHTML = railTagsHtml();
    renderDrawer();
  } catch (e) { /* rail is navigation sugar */ }
}
document.addEventListener("click", (e) => {
  // the drawer owns its own rows (and the category facet) — see the #navdrawer handler
  if (e.target.closest("#fchips") || e.target.closest("#navdrawer")) return;
  const parent = e.target.closest("[data-tagparent]");
  if (parent) {   // rail group header → OR-select (or clear) all of its present children at once
    const kids = parent.dataset.tagparent.split(",").filter(Boolean);
    if (kids.every((t) => state.tags.includes(t)))
      state.tags = state.tags.filter((t) => !kids.includes(t));
    else
      kids.forEach((t) => { if (!state.tags.includes(t)) state.tags.push(t); });
    paintChips(); refreshRail(); loadItems(true);
    return;
  }
  const r = e.target.closest("[data-source], [data-tag]");
  if (!r) return;
  if (r.dataset.source !== undefined) {
    state.source = state.source === r.dataset.source ? "" : r.dataset.source;
  } else if (r.dataset.tag !== undefined) {
    const t = r.dataset.tag, i = state.tags.indexOf(t);
    if (i >= 0) state.tags.splice(i, 1); else state.tags.push(t);
    closeSheets();
  }
  paintChips(); refreshRail(); loadItems(true);
});
function paintChips() {
  const chips = [];
  if (state.source) chips.push("source:" + state.source);
  if (state.category) chips.push("category:" + state.category);
  state.tags.forEach((t) => chips.push("tag:" + t));
  $("#fchips").innerHTML = chips.map((label) =>
    '<button type="button" class="fchip" data-chip="' + esc(label) + '">' + esc(label) +
    '<span class="x">✕</span></button>').join("") +
    (chips.length > 1 ? '<button type="button" class="fclear">clear all</button>' : "");
}
$("#fchips").addEventListener("click", (e) => {
  const chip = e.target.closest(".fchip");
  if (chip) {
    const v = chip.dataset.chip;
    if (v.startsWith("source:")) state.source = "";
    else if (v.startsWith("category:")) state.category = "";
    else { const t = v.slice(4); const i = state.tags.indexOf(t); if (i >= 0) state.tags.splice(i, 1); }
  } else if (e.target.closest(".fclear")) {
    state.source = ""; state.category = ""; state.tags = [];
  } else return;
  paintChips(); refreshRail(); loadItems(true);
});
$("#peekswept").addEventListener("click", () => {
  $("#q").value = "is:swept";
  state.q = "is:swept";
  state.status = "";
  paintTabs(); loadItems(true);
  toast("Peeking at what rested — everything is still here.");
});

/* ---- search + operator discovery (Epic 12: visible Gmail/Discord-style operators) ---- */
const qInput = $("#q");
const runSearch = debounce(() => {
  if (qInput.value.startsWith(">")) return;  // command mode — palette.js owns the input
  state.q = qInput.value.trim();
  loadItems(true);
}, 300);
qInput.addEventListener("input", runSearch);
initOperators(qInput, $("#oppop"), {
  // tag values come from the shared drawer/rail facet data (full curated list)
  getDyn: (which) => which === "tags" ? facets.tags.map((t) => t.id) : [],
  onApply: () => { state.q = qInput.value.trim(); loadItems(true); },
});
$("#exact").addEventListener("change", (e) => { state.exact = e.target.checked; loadItems(true); });
$("#dock-search").addEventListener("click", () => { qInput.focus(); window.scrollTo({ top: 0 }); });

/* ---- sort ---- */
const sortSel = $("#sort");
sortSel.value = state.sort;
if (sortSel.value !== state.sort) { state.sort = "first_seen_utc:desc"; sortSel.value = state.sort; }
sortSel.addEventListener("change", () => {
  state.sort = sortSel.value;
  try { localStorage.setItem(sortKey(state.status), state.sort); } catch (e) {}   // remember per tab
  loadItems(true);
});

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
  return r ? state.items.find((it) => it.fullname === r.dataset.fullname) : null;
}
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { closeSheets(); return; }
  if (isTypingTarget(e.target)) return;
  if (e.ctrlKey || e.metaKey) {                    // undo/redo chords; other modifier combos pass through to the browser
    const c = e.key.toLowerCase();
    if (c === "z" && !e.shiftKey && !e.altKey) { e.preventDefault(); const u = $("#toast .toast-undo"); if (u) u.click(); }
    else if (!e.altKey && (c === "y" || (c === "z" && e.shiftKey))) { e.preventDefault(); redo(); }
    return;                                         // never fall through to single-key actions while a modifier is held
  }
  const k = e.key.toLowerCase();
  if (k === "/") { e.preventDefault(); qInput.focus(); return; }
  if (e.key === "?") { toggleKbd(); return; }
  if (k === "w") { moveCursor(-1); return; }
  if (k === "s") { moveCursor(1); return; }
  const it = cursorItem();
  if (k === "f" && it) act(it.fullname, "keep");
  else if (k === "a" && it) act(it.fullname, "archived");
  else if (k === "d" && it) act(it.fullname, "done");
  else if (k === "x" && it && state.status !== "inbox") act(it.fullname, "inbox");
  else if (k === "e" && it) { const u = it.url; if (u) window.open(u, "_blank", "noopener"); }
  else if (k === "t" && it) { tagEditor.open(it.fullname, rowEl(it.fullname)); }
  else if (k === "q" && it) { const r = rowEl(it.fullname); if (r) toggleSelect(r); }
  else if (k === "z") { const u = $("#toast .toast-undo"); if (u) u.click(); }
  else if (k === "y") { redo(); }
  else if (e.key === " " && it) { e.preventDefault(); openMediaFor(it); }
});

/* ---- sheets / settings panel ---- */
const scrim = $("#scrim");
function openPanel(id) { closeSheets(); $(id).classList.add("show"); scrim.classList.add("show"); }
function closeSheets() {
  ["#settings", "#navdrawer", "#kbd", "#statsheet", "#rowmenu"].forEach((s) => $(s).classList.remove("show"));
  if (drawer) drawer.setAttribute("aria-hidden", "true");
  scrim.classList.remove("show");
}

/* ---- long-press / right-click row action menu (Tag · Share) — Epic 16 ---- */
let rowMenuFn = null;
const rowMenu = $("#rowmenu");
function openRowMenu(fn) {
  const it = state.items.find((i) => i.fullname === fn);
  if (!it) return;
  rowMenuFn = fn;
  const title = $("#rowmenu-title");
  if (title) title.textContent = it.title || "(untitled)";
  closeSheets();
  rowMenu.classList.add("show");
  scrim.classList.add("show");
}
rowMenu.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-rowmenu]");
  if (!btn) return;
  const action = btn.dataset.rowmenu, fn = rowMenuFn;
  closeSheets();
  if (!fn) return;
  if (action === "tag") tagEditor.open(fn, rowEl(fn));
  else if (action === "snooze") snooze(fn);
  else if (action === "share") shareItem(state.items.find((i) => i.fullname === fn));
});
// desktop has no long-press → right-click a row opens the same menu
itemsEl.addEventListener("contextmenu", (e) => {
  const card = e.target.closest(".row[data-fullname]");
  if (!card) return;
  e.preventDefault();
  openRowMenu(card.dataset.fullname);
});
function toggleKbd() {
  const k = $("#kbd"), show = !k.classList.contains("show");
  closeSheets();
  if (show) { k.classList.add("show"); scrim.classList.add("show"); }
}
scrim.addEventListener("click", closeSheets);
$("#open-settings").addEventListener("click", () => openPanel("#settings"));
$("#dock-settings").addEventListener("click", () => openPanel("#settings"));

/* ---- loaded-version badge + Relay-style shrink-on-scroll top bar ----
   APP_VERSION is baked into THIS (cached) main.js, so the badge shows what your phone is actually
   running — not the server's latest. Bump it together with sw.js CACHE on every shippable change. */
const APP_VERSION = "v71";
(() => {
  const ver = $("#app-version"); if (ver) ver.textContent = APP_VERSION;
  const head = $(".console"); if (!head) return;
  // Collapsing/expanding the (sticky) header changes its height, so the browser's scroll-anchoring
  // nudges scrollY to keep content stable — near a threshold that nudge re-triggered the toggle =
  // flicker (worst near the top, where expanding GROWS the bar). Two guards: (1) a WIDE dead zone
  // (>110 collapse / <28 expand) bigger than the bar's height change, so the nudge lands inside it;
  // (2) a short LOCK after each toggle that ignores scroll while the reflow + .22s transition settle,
  // then re-checks once from the settled position. Together they can't oscillate.
  let locked = false;
  const set = (compact) => {
    if (compact === head.classList.contains("compact")) return;   // already in this state
    head.classList.toggle("compact", compact);
    locked = true;
    setTimeout(() => { locked = false; onScroll(); }, 320);       // > the collapse transition
  };
  function onScroll() {
    if (locked) return;
    const y = window.scrollY || 0;
    if (y > 110) set(true);          // scrolled well down → shrink
    else if (y < 28) set(false);     // back near the top → expand
    // 28..110 = wide dead zone: keep the current state
  }
  window.addEventListener("scroll", onScroll, { passive: true });
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
  return (v < 10 ? v.toFixed(1).replace(/\.0$/, "") : String(Math.round(v))) + unit;
}
function facetRows(kind) {
  if (kind === "source")
    return facets.sources.map((s) => ({ kind, value: s.id, label: s.label, count: s.count, color: s.badge_color }));
  if (kind === "category")
    return facets.categories.map((c) => ({ kind, value: c.id, label: c.label, count: c.count }));
  // Categories are folded into the tag system, so /tags echoes the category names
  // (listenable/watch/wotagei/unknown) back as tags. They have their own Categories
  // group above, so drop them here — each facet should appear exactly once in the
  // drawer. (Drawer-local: the desktop .rail reads facets.tags directly and has no
  // Categories group, so it still surfaces these as its only way to reach them.)
  const catIds = new Set(facets.categories.map((c) => String(c.id).toLowerCase()));
  return facets.tags
    .filter((t) => !catIds.has(String(t.id).toLowerCase()))
    .map((t) => ({ kind, value: t.id, label: t.label, count: t.count }));
}
const pinKey = (r) => r.kind + ":" + r.value;
function isActive(r) {
  return r.kind === "source" ? state.source === r.value
    : r.kind === "category" ? state.category === r.value
    : state.tags.includes(r.value);
}
function highlight(label, q) {
  const i = label.toLowerCase().indexOf(q);
  if (i < 0) return esc(label);
  return esc(label.slice(0, i)) + "<mark>" + esc(label.slice(i, i + q.length)) +
    "</mark>" + esc(label.slice(i + q.length));
}
function rowHtml(r) {
  const pinned = pins.has(pinKey(r));
  const q = navFilter.trim().toLowerCase();
  const mark = r.kind === "tag"
    ? '<span class="jmark tag" aria-hidden="true">#</span>'
    : '<span class="jmark ' + (r.kind === "category" ? "cat" : "") + '"' +
      (r.color ? ' style="--src:' + r.color + '"' : "") + ' aria-hidden="true"></span>';
  return '<div class="jrow" role="button" tabindex="0" data-' + r.kind + '="' + esc(r.value) + '"' +
    ' aria-pressed="' + isActive(r) + '" aria-label="' + esc(r.label) + '">' + mark +
    '<span class="jlabel">' + (q ? highlight(r.label, q) : esc(r.label)) + "</span>" +
    '<span class="jcount" title="' + r.count + '">' + siCount(r.count) + "</span>" +
    '<button type="button" class="jstar' + (pinned ? " on" : "") + '" data-pin="' + esc(pinKey(r)) + '"' +
    ' aria-pressed="' + pinned + '" aria-label="' + (pinned ? "Unpin " : "Pin ") + esc(r.label) + '">' +
    (pinned ? "★" : "☆") + "</button></div>";
}
function groupHtml(id, label, rows) {
  const col = collapsed.has(id);
  return '<div class="nd-group' + (col ? " collapsed" : "") + '" data-group="' + id + '">' +
    '<button type="button" class="nd-ghead" aria-expanded="' + !col + '">' +
    '<span class="nd-glabel">' + label + "</span>" +
    '<span class="nd-gcount">' + rows.length + "</span>" +
    '<span class="nd-chev" aria-hidden="true">▸</span></button>' +
    '<div class="nd-rows">' + rows.map(rowHtml).join("") + "</div></div>";
}
function renderDrawer() {
  if (!drawer) return;
  const q = navFilter.trim().toLowerCase();
  const match = (r) => !q || r.label.toLowerCase().includes(q);
  const byKey = new Map([].concat(facetRows("source"), facetRows("category"), facetRows("tag"))
    .map((r) => [pinKey(r), r]));
  const pinnedRows = [...pins].map((k) => byKey.get(k)).filter(Boolean).filter(match);

  let groups = "";
  if (pinnedRows.length) groups += groupHtml("pinned", "PINNED", pinnedRows);
  for (const g of GROUPS) {
    if (hiddenGroups.has(g.id)) continue;
    const rows = facetRows(g.kind).filter(match);
    if (rows.length) groups += groupHtml(g.id, g.label, rows);
  }
  const manage = managing
    ? '<div class="nd-managebar"><span class="nd-mlab">SHOW SECTIONS</span>' +
      GROUPS.map((g) => '<button type="button" class="nd-mtoggle" data-section="' + g.id + '"' +
        ' aria-pressed="' + !hiddenGroups.has(g.id) + '">' + titleCase(g.label) + "</button>").join("") +
      "</div>"
    : "";
  const empty = '<div class="nd-empty">' +
    (q ? "no matches for “" + esc(navFilter.trim()) + "”" : "nothing to jump to yet") + "</div>";
  $("#nav-list").innerHTML = manage + (groups || empty);
}
function selectFacet(kind, value) {
  if (kind === "source") state.source = state.source === value ? "" : value;
  else if (kind === "category") state.category = state.category === value ? "" : value;
  else { const i = state.tags.indexOf(value); if (i >= 0) state.tags.splice(i, 1); else state.tags.push(value); }
  paintChips(); refreshRail(); loadItems(true);
  closeSheets();
}
function openDrawer() {
  closeSheets();
  navFilter = ""; const f = $("#nav-filter"); if (f) f.value = "";
  managing = false; $("#nav-manage").setAttribute("aria-pressed", "false");
  renderDrawer();
  drawer.classList.add("show"); scrim.classList.add("show");
  drawer.setAttribute("aria-hidden", "false");
  // Desktop only: autofocusing the filter pops the on-screen keyboard on mobile (user-reported).
  if (!isPhone()) setTimeout(() => { const fi = $("#nav-filter"); if (fi) fi.focus(); }, 60);
}
$("#open-nav").addEventListener("click", openDrawer);
$("#nav-close").addEventListener("click", closeSheets);
$("#nav-filter").addEventListener("input", (e) => { navFilter = e.target.value; renderDrawer(); });
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
    saveSet("chDrawerCollapsed", collapsed); renderDrawer(); return;
  }
  const star = e.target.closest(".jstar");
  if (star) {
    e.stopPropagation();
    const k = star.dataset.pin;
    pins.has(k) ? pins.delete(k) : pins.add(k);
    saveSet("chDrawerPins", pins); renderDrawer();
    toast(pins.has(k) ? "Pinned." : "Unpinned."); return;
  }
  const mtoggle = e.target.closest(".nd-mtoggle");
  if (mtoggle) {
    e.stopPropagation();
    const s = mtoggle.dataset.section;
    hiddenGroups.has(s) ? hiddenGroups.delete(s) : hiddenGroups.add(s);
    saveSet("chDrawerHidden", hiddenGroups); renderDrawer(); return;
  }
  const row = e.target.closest(".jrow");
  if (row) {
    e.stopPropagation();
    const kind = row.dataset.source !== undefined ? "source"
      : row.dataset.category !== undefined ? "category" : "tag";
    selectFacet(kind, row.dataset[kind]);
  }
});
drawer.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const row = e.target.closest(".jrow");
  if (row && e.target === row) { e.preventDefault(); row.click(); }
});

/* left edge-swipe opens the drawer (mobile only — desktop uses the rail) */
let edgeX = null;
const isPhone = () => window.matchMedia("(max-width:700px)").matches;
document.addEventListener("touchstart", (e) => {
  edgeX = (!drawer.classList.contains("show") && e.touches[0].clientX <= 22) ? e.touches[0].clientX : null;
}, { passive: true });
document.addEventListener("touchmove", (e) => {
  if (edgeX == null) return;
  if (e.touches[0].clientX - edgeX > 40) { edgeX = null; if (isPhone()) openDrawer(); }
}, { passive: true });
document.addEventListener("touchend", () => { edgeX = null; }, { passive: true });

/* Swipe-DOWN-to-dismiss for the mobile bottom sheets. Engages only at scroll-top with a
   downward drag, so it never fights the sheet's own scroll or its toggle buttons. The
   preventDefault on the engaged drag also blocks the browser's pull-to-refresh, which
   otherwise hijacks the down-swipe and reloads the page instead of closing the sheet. */
function attachSheetDismiss(panel) {
  if (!panel) return;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  let startY = 0, dy = 0, dragging = false, engaged = false;

  const settle = (toY, after) => {
    let fired = false;
    const fin = () => {
      if (fired) return;
      fired = true;
      panel.removeEventListener("transitionend", fin);
      if (after) after();           // before clearing inline: closeSheets removes .show while
      panel.style.transition = "";  // the sheet is already off-screen → no flash back up
      panel.style.transform = "";
    };
    if (reduced.matches) { panel.style.transition = "none"; panel.style.transform = toY; fin(); return; }
    panel.style.transition = "transform 180ms var(--ease)";
    panel.style.transform = toY;
    panel.addEventListener("transitionend", fin);
    setTimeout(fin, 240);           // fallback if transitionend never fires
  };

  panel.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) return;
    if (!window.matchMedia("(max-width:700px)").matches) return;  // bottom-sheet layout only
    startY = e.touches[0].clientY; dy = 0; dragging = true;
    engaged = panel.scrollTop <= 0;                               // decide once, up front
    panel.style.transition = "none";
  }, { passive: true });

  panel.addEventListener("touchmove", (e) => {
    if (!dragging || !engaged) return;
    dy = e.touches[0].clientY - startY;
    if (dy <= 0) return;                                          // upward → let content scroll
    e.preventDefault();                                          // own the gesture (no pull-to-refresh)
    panel.style.transform = "translate(-50%," + dy + "px)";
  }, { passive: false });

  const end = () => {
    if (!dragging) return;
    dragging = false;
    if (engaged && dy > Math.min(120, panel.offsetHeight * 0.3)) settle("translate(-50%,110%)", closeSheets);
    else if (dy > 0) settle("translate(-50%,0)");
  };
  panel.addEventListener("touchend", end);
  panel.addEventListener("touchcancel", end);
}
["#settings", "#statsheet", "#tagsheet"].forEach((s) => attachSheetDismiss($(s)));

/* ---- stats sheet (Epic 14: Stats lives in the settings menu) ---- */
function statsBarRows(obj, max) {
  return Object.entries(obj || {})
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) =>
      '<div class="stat-row"><span class="sk">' + esc(k) + "</span>" +
      '<i class="bar" style="width:' + Math.round((v / max) * 100) + '%"></i>' +
      '<span class="sv">' + v.toLocaleString() + "</span></div>")
    .join("");
}
function statsHtml(d) {
  const head =
    '<div class="stat-row"><span class="sk">Processed this week</span><span class="sv">' +
    (d.processed_this_week || 0).toLocaleString() + "</span></div>" +
    '<div class="stat-row"><span class="sk">Total saves</span><span class="sv">' +
    (d.total || 0).toLocaleString() + "</span></div>" +
    '<div class="stat-row"><span class="sk">With a link</span><span class="sv">' +
    (d.with_url || 0).toLocaleString() + "</span></div>";
  const maxOf = (o) => Math.max(...Object.values(o || {}), 1);
  return head +
    '<div class="lab">BY SOURCE</div>' + statsBarRows(d.by_source, maxOf(d.by_source)) +
    '<div class="lab">BY STATUS</div>' + statsBarRows(d.by_status, maxOf(d.by_status));
}
$("#open-stats").addEventListener("click", async () => {
  const list = $("#stats-list");
  list.textContent = "Counting the shelves…";
  openPanel("#statsheet");
  try { list.innerHTML = statsHtml(await api.fetchStats()); }
  catch (e) { list.textContent = "Couldn't load stats — try again."; }
});

$$("#set-theme button").forEach((b) => b.addEventListener("click", () => {
  // theme.js owns persistence; mirror its storage contract ("ch-theme")
  document.documentElement.dataset.theme = b.dataset.theme;
  try { localStorage.setItem("ch-theme", b.dataset.theme); } catch (e) {}
  $$("#set-theme button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
}));
$$("#set-density button").forEach((b) => b.addEventListener("click", () => {
  state.density = b.dataset.d;
  localStorage.chDensity = state.density;
  $$("#set-density button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
  render();
}));
$$("#set-loading button").forEach((b) => b.addEventListener("click", () => {
  setFocus(b.dataset.focus === "1");
}));
$$("#set-goal button").forEach((b) => b.addEventListener("click", () => {
  state.goal = parseInt(b.dataset.g, 10) || 0;
  localStorage.chGoal = String(state.goal);
  $$("#set-goal button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
  paintWins();
}));
$$("#set-nsfw button").forEach((b) => b.addEventListener("click", () => {
  state.safe = b.dataset.nsfw === "hide";
  localStorage.chSafe = state.safe ? "1" : "0";
  $$("#set-nsfw button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
  refreshRail();   // surface/hide the nsfw_* facets to match the toggle (Epic 14)
  loadItems(true);
}));
$$("#set-archive button").forEach((b) => b.addEventListener("click", () => {
  state.archiveMedia = b.dataset.archive === "on";   // prefer local /media copies (Epic 4 P1)
  localStorage.chArchiveMedia = state.archiveMedia ? "1" : "0";
  setArchivePref(state.archiveMedia);
  $$("#set-archive button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
  render();   // re-render with the new media-source preference
}));

/* ---- "Sync newest": surface the /reddit incremental sync on the browse view (Epic 9) ---- */
const syncBtn = $("#open-sync");
if (syncBtn) syncBtn.addEventListener("click", async () => {
  if (syncBtn.disabled) return;
  const label = syncBtn.textContent;
  syncBtn.disabled = true;
  syncBtn.textContent = "Syncing newest…";
  try {
    const data = await api.postJSON("/reddit/sync", {});
    if (data.auth_error) toast("Sync needs a reddit_session cookie — set it up first.");
    else if (data.error) toast("Sync error: " + data.error);
    else {
      toast("+" + data.new + " new (" + data.fetched + " fetched · " + data.stopped + ").");
      loadItems(true); loadCounts(); refreshRail(); refreshPulse();
    }
  } catch (e) { toast("Sync failed — network error."); }
  syncBtn.textContent = label;
  syncBtn.disabled = false;
});

/* reflect persisted settings into the panel */
$$("#set-density button").forEach((b) =>
  b.setAttribute("aria-pressed", String(b.dataset.d === state.density)));
$$("#set-loading button").forEach((b) =>
  b.setAttribute("aria-pressed", String((b.dataset.focus === "1") === state.focus)));
$$("#set-goal button").forEach((b) =>
  b.setAttribute("aria-pressed", String((parseInt(b.dataset.g, 10) || 0) === state.goal)));
$$("#set-nsfw button").forEach((b) =>
  b.setAttribute("aria-pressed", String((b.dataset.nsfw === "hide") === state.safe)));
$$("#set-archive button").forEach((b) =>
  b.setAttribute("aria-pressed", String((b.dataset.archive === "on") === state.archiveMedia)));
$$("#set-theme button").forEach((b) =>
  b.setAttribute("aria-pressed",
    String((document.documentElement.dataset.theme || "dark") === b.dataset.theme)));

/* ---- wheel from the side gutters scrolls the list (13:385) ---- */
document.addEventListener("wheel", (e) => {
  if (e.target === document.body || e.target === document.documentElement) {
    window.scrollBy({ top: e.deltaY });
  }
}, { passive: true });

wireTagExpanders(itemsEl);

/* persist the active view (status/source/tags) across reloads — sessionStorage so it survives a
   refresh/return within the session but a fresh app launch still starts clean at the inbox.
   (sort/density/focus/goal/nsfw already persist via localStorage.) */
const VIEW_KEY = "ch_view";
function saveView() {
  try {
    sessionStorage.setItem(VIEW_KEY,
      JSON.stringify({ status: state.status, source: state.source, tags: state.tags }));
  } catch (e) { /* private mode / quota — non-fatal */ }
}
function restoreView() {
  try {
    const v = JSON.parse(sessionStorage.getItem(VIEW_KEY) || "null");
    if (!v || typeof v !== "object") return;
    if (typeof v.status === "string") state.status = v.status;
    if (typeof v.source === "string") state.source = v.source;
    if (Array.isArray(v.tags)) state.tags = v.tags.filter((t) => typeof t === "string");
  } catch (e) { /* ignore corrupt value */ }
}
restoreView();
state.sort = sortForTab(state.status); sortSel.value = state.sort;   // apply the tab's sort once the view restores

async function openDeepLinkedReader() {
  const qs = new URLSearchParams(location.search);
  const fn = qs.get("open");
  if (!fn) return;
  try {
    const item = await api.fetchItem(fn);
    readerUI.open(item, { from: qs.get("from") === "triage" ? "triage" : "" });
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
    if (now - lastPing < 60000) return;          // client guard; server debounce is the real gate
    lastPing = now;
    try {
      const data = await api.postJSON("/reddit/sync/auto", {});
      if (!data || data.skipped) return;         // disabled / debounced -> nothing changed
      const r = data.result || {}, rec = r.reconcile || {};
      if ((r.new || 0) > 0 || (rec.unsaved || 0) > 0 || (rec.promoted_done || 0) > 0) {
        loadItems(true); loadCounts(); refreshRail(); refreshPulse();
      }
    } catch (e) { /* offline / network — silent; retried on next focus */ }
  }
  ping();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") ping();
  });
})();

/* ---- command palette (locked Epic 20: ">" flips search to command mode) ---- */
initPalette(qInput, [
  { label: "Go to Triage", hint: "page", run: () => location.assign("/triage") },
  { label: "Go to Reddit saved", hint: "page", run: () => location.assign("/reddit") },
  { label: "Theme: dark", hint: "view", run: () => { const b = $('#set-theme [data-theme="dark"]'); if (b) b.click(); } },
  { label: "Theme: light", hint: "view", run: () => { const b = $('#set-theme [data-theme="light"]'); if (b) b.click(); } },
  { label: "Density: comfortable", hint: "view", run: () => { const b = $('#set-density [data-d="comfortable"]'); if (b) b.click(); } },
  { label: "Density: compact", hint: "view", run: () => { const b = $('#set-density [data-d="compact"]'); if (b) b.click(); } },
  { label: "Density: card", hint: "view", run: () => { const b = $('#set-density [data-d="card"]'); if (b) b.click(); } },
  { label: "Sort: newest saved", hint: "sort", run: () => { sortSel.value = "first_seen_utc:desc"; sortSel.dispatchEvent(new Event("change")); } },
  { label: "Sort: oldest post", hint: "sort", run: () => { sortSel.value = "created_utc:asc"; sortSel.dispatchEvent(new Event("change")); } },
  { label: "Sort: shortest", hint: "sort", run: () => { sortSel.value = "duration:asc"; sortSel.dispatchEvent(new Event("change")); } },
]);
