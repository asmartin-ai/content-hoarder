import { esc, debounce, isTypingTarget } from "../core/util.js";
import { toast } from "../core/toast.js";
import { $, $$, state, facets, sortForTab, sortKey } from "./shared.js";
import { loadCounts, loadItems, refreshRail } from "./data.js";
import { rowEl } from "./feed.js";
import { act, redo, toggleSelect } from "./actions.js";
import { openMediaFor } from "./lightbox.js";
import { tagEditor } from "./instances.js";
import { closeSheets, toggleKbd } from "./panels.js";
import { initOperators } from "./operators.js";

export function paintTabs() {
  $$(".folder, .spill").forEach((t) => {
    t.setAttribute("aria-selected", String((t.dataset.status ?? "") === state.status));
  });
}

$$(".folder, .spill").forEach((t) =>
  t.addEventListener("click", () => {
    if (t.dataset.status === undefined) return;
    state.status = t.dataset.status;
    state.sort = sortForTab(state.status);
    sortSel.value = state.sort;
    paintTabs();
    refreshRail();
    loadItems(true);
    loadCounts();
  }),
);

let dragFullname = null;

function dropTargetFrom(e) {
  const t = e.target.closest(
    ".folder[data-status], .spill[data-status], .statuspills [data-status]",
  );

  return t && t.dataset.status ? t : null;
}

function setDropTargets(on) {
  dragTargets().forEach((t) => t.classList.toggle("drop-armed", on));
}

function dragTargets() {
  return $$(".folder[data-status], .spill[data-status], .statuspills [data-status]").filter(
    (t) => t.dataset.status,
  );
}

document.addEventListener("dragstart", (e) => {
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

  if (status === (state.status || "")) return;
  setDropTargets(false);

  act(dragFullname, status);

  dragFullname = null;
});

document.addEventListener("click", (e) => {
  if (e.target.closest("#fchips") || e.target.closest("#navdrawer")) return;
  const parent = e.target.closest("[data-tagparent]");

  if (parent) {
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

    if (state.source !== "reddit") state.subreddit = "";
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
  if (qInput.value.startsWith(">")) return;
  state.q = qInput.value.trim();
  paintTabs();
  loadItems(true);
}, 300);

qInput.addEventListener("input", runSearch);

initOperators(qInput, $("#oppop"), {
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

$("#open-search")?.addEventListener("click", () => {
  focusSearchBox();
});

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
  } catch {}

  loadItems(true);
});

export function syncSortControl() {
  state.sort = sortForTab(state.status);
  sortSel.value = state.sort;
}

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

  if (e.ctrlKey || e.metaKey) {
    const c = e.key.toLowerCase();

    if (c === "z" && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      const u = $("#toast .toast-undo");

      if (u) u.click();
    } else if (!e.altKey && (c === "y" || (c === "z" && e.shiftKey))) {
      e.preventDefault();
      redo();
    }

    return;
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
