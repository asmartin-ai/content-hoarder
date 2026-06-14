/* browse/main.js — v3 browse page entry (Epic 20 Stage C).
   Spec: 05-log-book-2.html + 06-adhd-round.html (LOCKED 2026-06-11).
   State, fetching, infinite scroll / Focus batches, keyboard, swipe, bulk,
   the ambient resurfacing slot, win pebbles, and the settings panel. */

import { esc, debounce, isTypingTarget } from "../core/util.js";
import * as api from "../core/api.js";
import { toast, snackbar } from "../core/toast.js";
import { createLightbox, imageUrl, mediaType, redditUrl } from "../core/media.js";
import { attachSwipe } from "../core/swipe.js";
import { wireTagExpanders } from "../core/render.js";
import { listHtml, emptyHtml, isNsfw, displayTitle } from "./render.js";
import { initPalette } from "./palette.js";
import { initOperators } from "./operators.js";

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

/* ---- state ---- */
const state = {
  status: "inbox",
  source: "",
  tags: [],
  q: "",
  exact: false,
  sort: localStorage.chSort || "first_seen_utc:desc",
  density: localStorage.chDensity || "comfortable",
  focus: localStorage.chFocus === "1",
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
const nsfwRevealed = new Set();
const itemsEl = $("#items");

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
  if (state.q) p.q = state.q;
  if (state.exact) p.exact = "1";
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
    itemsEl.innerHTML = '<div class="skeleton">FETCHING…</div>';
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
    if (gen === loadGen)
      itemsEl.innerHTML = '<div class="skeleton">COULDN’T LOAD — IS THE SERVER UP?</div>';
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
      row.querySelectorAll(".monitor.nsfw, .screen.nsfw").forEach((el) => {
        el.classList.remove("nsfw");
        const v = el.querySelector(".veil"); if (v) v.remove();
      });
    }
    if (row.classList.contains("row")) {
      attachSwipe(row, {
        commit: 80, commit2: 170,
        onRight: () => act(fn, "archived"),
        onRightLong: () => act(fn, "keep"),
        onLeft: () => act(fn, "done"),
      });
    }
  });
  paintBatch();
}

/* ---- actions: live clear + undo (locked #11) ---- */
function rowEl(fullname) {
  return itemsEl.querySelector('[data-fullname="' + CSS.escape(fullname) + '"]');
}

async function act(fullname, status) {
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
      loadItems(true);
    } catch (e) { toast("Undo failed."); }
  });
}

/* delegated row interactions */
itemsEl.addEventListener("click", (e) => {
  const actBtn = e.target.closest(".act");
  const card = e.target.closest("[data-fullname]");
  if (!card) return;
  const fn = card.dataset.fullname;
  if (actBtn) { act(fn, actBtn.dataset.act); return; }
  if (e.target.closest("[data-select]")) { toggleSelect(card); return; }
  const media = e.target.closest("[data-media]");
  if (media) {
    const item = state.items.find((it) => it.fullname === fn);
    if (!item) return;
    if (isNsfw(item) && !nsfwRevealed.has(fn)) {  // first tap reveals, second opens
      nsfwRevealed.add(fn);
      media.classList.remove("nsfw");
      const v = media.querySelector(".veil"); if (v) v.remove();
      return;
    }
    openMediaFor(item);
  }
});

/* ---- media lightbox ---- */
const lightbox = createLightbox({ modal: "#media-modal", body: "#media-body" });
function openMediaFor(item) {
  const m = item.metadata || {};
  if (Array.isArray(m.gallery) && m.gallery.length) return lightbox.openGallery(m.gallery);
  const mt = mediaType(item);
  if (mt.cls === "video" && m.media_url) return lightbox.openVideo(m.media_url, m.thumbnail);
  const img = imageUrl(item);
  if (img) return lightbox.openImage(img);
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
  state.items = state.items.filter((it) => !fns.includes(it.fullname));
  if (state.focus) state.batchCleared += fns.length;
  bumpPulse(status === "inbox" ? 0 : fns.length);
  render();
  snackbar(fns.length + " — " + (COPY[status] || "logged.").toLowerCase(), async () => {
    const r = await api.bulkUndo(fns);
    bumpPulse(status === "inbox" ? 0 : -r.ok);
    loadItems(true);
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
    ambient.innerHTML = '<div class="amb-eyebrow">DEALT AT RANDOM — NO STRINGS</div>' +
      "<h3>“" + esc(displayTitle(it)) + "”</h3>" +
      '<div class="amb-body"><div class="amb-meta">' +
      (m.subreddit ? "<b>r/" + esc(m.subreddit) + "</b> · " : "") +
      (it.created_utc ? "from " + new Date(it.created_utc * 1000).getFullYear() : "") +
      "</div></div>" +
      '<div class="amb-acts">' +
      '<a class="ambbtn primary" href="' + esc(it.url || "#") + '" target="_blank" rel="noopener">Open it</a>' +
      '<button type="button" class="ambbtn" data-amb="open">Not today</button></div>';
    ambientCard = null;
    ambient.hidden = false;
    ambient.scrollIntoView({ block: "nearest", behavior: "smooth" });
  } catch (e) { toast("The dice jammed — try again."); }
}
$("#dice").addEventListener("click", surprise);

/* ---- tabs / rail / chips (locked #2/#7) ---- */
function paintTabs() {
  $$(".folder, .spill:not(.tagsbtn)").forEach((t) => {
    t.setAttribute("aria-selected", String((t.dataset.status ?? "") === state.status));
  });
}
$$(".folder, .spill:not(.tagsbtn)").forEach((t) => t.addEventListener("click", () => {
  if (t.dataset.status === undefined) return;
  state.status = t.dataset.status;
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
async function refreshRail() {
  try {
    const [src, tags] = await Promise.all([
      api.fetchSources(state.status || undefined),
      api.getJSON("/tags?" + new URLSearchParams(state.status ? { status: state.status } : {})),
    ]);
    $("#rail-sources").innerHTML = src.sources.map((s) =>
      railBtn(s.label, s.id, s.count, "source", s.badge_color)).join("");
    const entries = Object.entries(tags.tags || {});
    state.curated = new Set(entries.map(([t]) => t));
    $("#rail-tags").innerHTML = entries.slice(0, 12).map(([t, n]) =>
      railBtn(t, t, n, "tag")).join("");
    $("#tagsheet-list").innerHTML = entries.map(([t, n]) =>
      '<button type="button" class="tag-chip" data-tag="' + esc(t) + '">' + esc(t) + " · " + n + "</button>").join("");
  } catch (e) { /* rail is navigation sugar */ }
}
document.addEventListener("click", (e) => {
  const r = e.target.closest("[data-source], [data-tag]");
  if (!r || e.target.closest("#fchips")) return;
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
  if (state.source) chips.push(["source", "source:" + state.source]);
  state.tags.forEach((t) => chips.push(["tag:" + t, "tag:" + t]));
  $("#fchips").innerHTML = chips.map(([, label]) =>
    '<button type="button" class="fchip" data-chip="' + esc(label) + '">' + esc(label) +
    '<span class="x">✕</span></button>').join("") +
    (chips.length > 1 ? '<button type="button" class="fclear">clear all</button>' : "");
}
$("#fchips").addEventListener("click", (e) => {
  const chip = e.target.closest(".fchip");
  if (chip) {
    const v = chip.dataset.chip;
    if (v.startsWith("source:")) state.source = "";
    else { const t = v.slice(4); const i = state.tags.indexOf(t); if (i >= 0) state.tags.splice(i, 1); }
  } else if (e.target.closest(".fclear")) {
    state.source = ""; state.tags = [];
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
  // tag values come from the curated tag-sheet already loaded client-side (full list)
  getDyn: (which) => which === "tags"
    ? [...document.querySelectorAll("#tagsheet-list [data-tag]")].map((b) => b.dataset.tag)
    : [],
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
  localStorage.chSort = state.sort;
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
  else if (k === "q" && it) { const r = rowEl(it.fullname); if (r) toggleSelect(r); }
  else if (k === "z") { const u = $("#toast .toast-undo"); if (u) u.click(); }
  else if (e.key === " " && it) { e.preventDefault(); openMediaFor(it); }
});

/* ---- sheets / settings panel ---- */
const scrim = $("#scrim");
function openPanel(id) { closeSheets(); $(id).classList.add("show"); scrim.classList.add("show"); }
function closeSheets() {
  ["#settings", "#tagsheet", "#kbd", "#statsheet"].forEach((s) => $(s).classList.remove("show"));
  scrim.classList.remove("show");
}
function toggleKbd() {
  const k = $("#kbd"), show = !k.classList.contains("show");
  closeSheets();
  if (show) { k.classList.add("show"); scrim.classList.add("show"); }
}
scrim.addEventListener("click", closeSheets);
$("#open-settings").addEventListener("click", () => openPanel("#settings"));
$("#dock-settings").addEventListener("click", () => openPanel("#settings"));
$("#open-tags-phone").addEventListener("click", () => openPanel("#tagsheet"));

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

/* reflect persisted settings into the panel */
$$("#set-density button").forEach((b) =>
  b.setAttribute("aria-pressed", String(b.dataset.d === state.density)));
$$("#set-loading button").forEach((b) =>
  b.setAttribute("aria-pressed", String((b.dataset.focus === "1") === state.focus)));
$$("#set-goal button").forEach((b) =>
  b.setAttribute("aria-pressed", String((parseInt(b.dataset.g, 10) || 0) === state.goal)));
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

/* ---- boot ---- */
paintTabs();
paintChips();
paintWins();
refreshRail();
loadCounts();
refreshPulse();
loadAmbient();
loadItems(true);

if ("serviceWorker" in navigator)
  navigator.serviceWorker.register("/static/sw.js").catch(() => {});

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
