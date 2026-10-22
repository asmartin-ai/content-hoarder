/* browse/drawer.js — the mobile "Jump" drawer (the phone expression of the desktop
   .rail): grouped facets, filter, pin/collapse/sections, plus the left-edge swipe
   that opens it. */

import { esc } from "../core/util.js";
import { toast } from "../core/toast.js";
import {
  $,
  state,
  facets,
  drawer,
  pins,
  hiddenGroups,
  collapsed,
  saveSet,
  isPhone,
} from "./shared.js";
import { loadItems, refreshRail } from "./data.js";
import { paintChips } from "./nav.js";
import { closeSheets, lockBrowseScroll, scrim } from "./panels.js";

let navFilter = "";

let managing = false;

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
  const catIds = new Set(facets.categories.map((c) => String(c.id).toLowerCase()));

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

export function renderDrawer() {
  if (!drawer) return;
  const q = navFilter.trim().toLowerCase();
  const match = (r) => !q || r.label.toLowerCase().includes(q);

  const byKey = new Map(
    []
      .concat(facetRows("source"), facetRows("category"), facetRows("tag"))
      .map((r) => [pinKey(r), r]),
  );

  const pinnedRows = [];

  for (const key of pins) {
    const row = byKey.get(key);

    if (row && match(row)) pinnedRows.push(row);
  }

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
    (q ? "no matches for “" + esc(navFilter.trim()) + "”" : "nothing to jump to yet") +
    "</div>";

  $("#nav-list").innerHTML = manage + (groups || empty);
}

function selectFacet(kind, value) {
  if (kind === "source") state.source = state.source === value ? "" : value;
  else if (kind === "category") state.category = state.category === value ? "" : value;
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

export function openDrawer() {
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

$("#nav-close").addEventListener("click", () => closeSheets());

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

    if (collapsed.has(g)) collapsed.delete(g);
    else collapsed.add(g);
    saveSet("chDrawerCollapsed", collapsed);
    renderDrawer();

    return;
  }

  const star = e.target.closest(".jstar");

  if (star) {
    e.stopPropagation();
    const k = star.dataset.pin;

    if (pins.has(k)) pins.delete(k);
    else pins.add(k);
    saveSet("chDrawerPins", pins);
    renderDrawer();
    toast(pins.has(k) ? "Pinned." : "Unpinned.");

    return;
  }

  const mtoggle = e.target.closest(".nd-mtoggle");

  if (mtoggle) {
    e.stopPropagation();
    const s = mtoggle.dataset.section;

    if (hiddenGroups.has(s)) hiddenGroups.delete(s);
    else hiddenGroups.add(s);
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
