/* browse/nav.js — navigation, filters, search and the keymap: status tabs, the
   rail/chip filters and their delegated clicks, drag-and-drop onto status buckets,
   the search box with operator discovery, per-tab sort, and the one-hand keymap. */

import { esc, debounce, isTypingTarget } from "../core/util.js";
import { toast } from "../core/toast.js";
import { $, $$, state, facets, sortForTab, sortKey } from "./shared.js";
import { loadCounts, loadItems, refreshRail } from "./data.js";
import { rowEl } from "./feed.js";
import { act, redo, toggleSelect } from "./actions.js";
import { openMediaFor } from "./lightbox.js";
import { deck, tagEditor } from "./instances.js";
import { closeSheets, toggleKbd } from "./panels.js";
import { initOperators } from "./operators.js";

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

export function paintTabs() {
  $$(".folder, .spill").forEach((t) => {
    t.setAttribute("aria-selected", String((t.dataset.status ?? "") === state.status));
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

/* Drag-and-drop to status buckets (desktop). Rows + deck cards are draggable
   (native HTML5 DnD — no library; mobile keeps swipe, the friction-asymmetry
   cheapest gesture). Drop targets are the four real status buckets (the "All"
   tab has data-status="" and is not a bucket). List drops reuse act(); deck
   drops route through deck.commit so the queue advances and undo works. */
let dragFullname = null;

function dropTargetFrom(e) {
  const t = e.target.closest(
    ".folder[data-status], .spill[data-status], .statuspills [data-status]",
  );

  return t && t.dataset.status ? t : null; // "All" (empty status) is not a bucket
}

function setDropTargets(on) {
  dragTargets().forEach((t) => t.classList.toggle("drop-armed", on));
}

function dragTargets() {
  // Real buckets only: a non-empty data-status, excluding the "All" tab.
  return $$(".folder[data-status], .spill[data-status], .statuspills [data-status]").filter(
    (t) => t.dataset.status,
  );
}

document.addEventListener("dragstart", (e) => {
  // Reset first: dragend is not guaranteed (spec skips it when the source
  // node is removed mid-drag), so never trust leftover state from a prior drag.
  dragFullname = null;
  setDropTargets(false);
  const row = e.target.closest("[data-fullname]");

  if (!row) return;
  dragFullname = row.dataset.fullname;
  e.dataTransfer.setData("text/plain", dragFullname);
  e.dataTransfer.effectAllowed = "move";
  setDropTargets(true);
});

document.addEventListener("dragend", () => {
  dragFullname = null;
  setDropTargets(false);
});

document.addEventListener("dragover", (e) => {
  if (!dragFullname) return;
  const t = dropTargetFrom(e);

  if (!t) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
});

document.addEventListener("drop", (e) => {
  if (!dragFullname) return;
  const t = dropTargetFrom(e);

  if (!t) return;
  e.preventDefault();
  const status = t.dataset.status;

  if (status === (state.status || "")) return; // dropping onto the active bucket = no-op
  setDropTargets(false);

  if (state.deck) {
    // Deck mode has its own commit path: leave-anim, queue advance, undo.
    deck.commit(state, { fullname: dragFullname }, status);
  } else {
    act(dragFullname, status);
  }

  dragFullname = null;
});

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

  const r = e.target.closest("[data-source], [data-tag], [data-subreddit]");

  if (!r) return;

  if (r.dataset.source !== undefined) {
    state.source = state.source === r.dataset.source ? "" : r.dataset.source;

    /* Subreddit is a reddit-only facet — clear it when leaving reddit. */
    if (state.source !== "reddit") state.subreddit = "";
    /* Leaving or entering reddit re-renders the subreddit facet via refreshRail. */
  } else if (r.dataset.subreddit !== undefined) {
    state.subreddit = state.subreddit === r.dataset.subreddit ? "" : r.dataset.subreddit;
    closeSheets();
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

export function paintChips() {
  const chips = [];

  if (state.source) chips.push("source:" + state.source);

  if (state.category) chips.push("category:" + state.category);

  if (state.subreddit) chips.push("subreddit:" + state.subreddit);
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
    (chips.length > 1 ? '<button type="button" class="fclear">clear all</button>' : "");
  paintTabs();
}

$("#fchips").addEventListener("click", (e) => {
  const chip = e.target.closest(".fchip");

  if (chip) {
    const v = chip.dataset.chip;

    if (v.startsWith("source:")) state.source = "";
    else if (v.startsWith("category:")) state.category = "";
    else if (v.startsWith("subreddit:")) state.subreddit = "";
    else {
      const t = v.slice(4);
      const i = state.tags.indexOf(t);

      if (i >= 0) state.tags.splice(i, 1);
    }
  } else if (e.target.closest(".fclear")) {
    state.source = "";
    state.category = "";
    state.subreddit = "";
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
export const qInput = $("#q");

function focusSearchBox() {
  const head = $(".console");

  if (head) head.classList.remove("compact");
  window.scrollTo({ top: 0 });
  requestAnimationFrame(() => {
    try {
      qInput.focus({ preventScroll: true });
    } catch {
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
export const sortSel = $("#sort");

sortSel.value = state.sort;

if (sortSel.value !== state.sort) {
  state.sort = "first_seen_utc:desc";
  sortSel.value = state.sort;
}

sortSel.addEventListener("change", () => {
  state.sort = sortSel.value;

  try {
    localStorage.setItem(sortKey(state.status), state.sort);
  } catch {} // remember per tab

  loadItems(true);
});

/* Re-apply the restored tab's sort to the control. Called from main.js after the
   session view is restored (per-tab sort memory wins over the initial default). */
export function syncSortControl() {
  state.sort = sortForTab(state.status);
  sortSel.value = state.sort; // apply the tab's sort once the view restores
}

export function goInboxHome() {
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

  return r ? state.items.find((it) => it.fullname === r.dataset.fullname) : null;
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeSheets();

    return;
  }

  if (isTypingTarget(e.target)) return;

  /* Deck-mode keymap (s/e/y/u/z/space) — only when state.deck is active.
     List-mode s/e/y are unchanged because deckKey returns false then. */
  if (state.deck && deck.key(e, state)) return;

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
  else if (k === "x" && it && state.status !== "inbox") act(it.fullname, "inbox");
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
