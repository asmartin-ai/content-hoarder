/* browse/deck.js — v3 deck mode (?deck=1).
   One card at a time, drawn from /random, with swipe + decision keys + Undo.
   Body lives here (not in main.js) to keep the surface split clean.
   Dependencies are injected by initDeck so this module is unit-testable
   with the FAKE_DOM pattern (see tests/test_browse_deck.py). */

import { esc } from "../core/util.js";
import { itemUrl, srcAccent } from "../core/render.js";
import { chIcon } from "../core/icons.js";
import { thumb, mediaType } from "../core/media.js";

const BATCH_SIZES = [10, 20, 30, 50];

const MODES = [
  ["smart", "Smart"],
  ["recent", "Newest"],
  ["random", "Random"],
];

/* Deck-local state. Kept module-local so list-mode never sees it. */
let host = null; // the #deck-host element when deck is open

let queue = []; // remaining items in the current batch

let batchIdx = 0; // count dealt from the current batch (for "X of N" badge)

let batchSize = 20;

let batchMode = "smart";

let busy = false; // gates commit + fetch so a fast double-key can't race

/* Injected dependencies (set in initDeck). */
let deps = null;

export function initDeck(injected) {
  deps = injected;

  return {
    open: openDeck,
    close: closeDeck,
    key: deckKey,
    commit, // status change + queue advance (deck-mode DnD drops route here)
    syncFromUrl,
    isDeckUrl,
    mountToggleHandlers,
    render: renderDeck,
  };
}

/* ---- URL sync ---- */

export function isDeckUrl(search) {
  return new URLSearchParams(search || "").get("deck") === "1";
}

/* Re-read ?deck=1 from the current location. Returns true if state changed. */
function syncFromUrl(state) {
  const next = isDeckUrl(typeof location !== "undefined" ? location.search : "");

  if (!!state.deck !== next) {
    state.deck = next;

    return true;
  }

  return false;
}

/* ---- open / close ---- */

async function openDeck(state) {
  if (busy) return;

  state.deck = true;

  if (typeof document !== "undefined") document.body.classList.add("deck-mode");
  showHost();
  await fillQueue(state);
  renderDeck(state);
}

function closeDeck(state) {
  state.deck = false;
  queue = [];
  batchIdx = 0;

  if (typeof document !== "undefined") document.body.classList.remove("deck-mode");
  hideHost();
}

function showHost() {
  if (host) host.hidden = false;
}

function hideHost() {
  if (host) host.hidden = true;
}

/* ---- batch fetch ---- */

function randomUrl(state) {
  const p = new URLSearchParams();
  p.set("n", String(batchSize));
  p.set("mode", batchMode);

  if (state.source) p.set("source", state.source);

  if (state.category) p.set("category", state.category);

  for (const t of state.tags) p.append("tag", t);

  if (state.status) p.set("unprocessed", state.status === "inbox" ? "1" : "0");

  return "/random?" + p.toString();
}

async function fillQueue(state) {
  busy = true;

  try {
    const r = await deps.api.getJSON(randomUrl(state));
    queue = (r && r.items) || [];
    batchIdx = 0;
  } catch {
    queue = [];
    deps.toast("Deck draw failed — try again.");
  } finally {
    busy = false;
  }
}

/* ---- render ---- */

function renderDeck(state) {
  if (!host) return;

  if (!queue.length) {
    host.innerHTML = deckChrome(state, null);
    mountChromeHandlers(state);

    return;
  }

  const it = queue[0];
  host.innerHTML = deckChrome(state, it);
  mountChromeHandlers(state);
  attachCardSwipe(state, it);
}

/* The chrome (selectors + card slot + back button). `it` is the current card
   or null when the queue is empty. */
function deckChrome(state, it) {
  const sizes = BATCH_SIZES.map(
    (n) => `<button type="button" data-size="${n}" aria-pressed="${n === batchSize}">${n}</button>`,
  ).join("");

  const modes = MODES.map(
    ([v, label]) =>
      `<button type="button" data-mode="${v}" aria-pressed="${v === batchMode}">${label}</button>`,
  ).join("");

  const card = it ? deckCard(it) : emptyDeck();
  const left = it ? `${queue.length} left` : "0 left";

  return `<div class="deck-bar">
      <button type="button" class="deck-back" id="deck-back" aria-label="Back to list">
        <span aria-hidden="true">←</span> List
      </button>
      <div class="deck-seg" id="deck-size" aria-label="Batch size">${sizes}</div>
      <div class="deck-seg" id="deck-mode" aria-label="Draw mode">${modes}</div>
      <span class="deck-left" id="deck-left">${left}</span>
    </div>
    <div class="deck-stage">${card}</div>`;
}

const SOURCE_LABEL = {
  reddit: "Reddit",
  youtube: "YouTube",
  hackernews: "Hacker News",
  firefox: "Firefox",
  obsidian: "Obsidian",
  keep: "Google Keep",
  twitter: "X",
};

function deckCard(it) {
  const title = it.title ? esc(it.title) : "<em>(no title)</em>";
  const src = SOURCE_LABEL[it.source] || it.source || "";
  const glyph = deps.glyph(it);
  const meta = deps.metaLine ? deps.metaLine(it) : "";
  const body = it.body ? `<p class="deck-body">${esc(snippet(it.body, 560))}</p>` : "";
  const sub = it.subreddit ? `<span class="deck-sub">r/${esc(it.subreddit)}</span>` : "";
  const url = itemUrl(it);
  const t = thumb(it, "list");
  const mt = mediaType(it);
  const nsfw = !!(it.metadata || {}).over_18;
  // A text post has no picture: its "thumb" is a link preview that often 404s,
  // so the deck shows the copy alone instead of an empty monitor.
  const hasMedia = !!t && mt.cls !== "text" && mt.cls !== "comment" && mt.cls !== "link";

  const media = hasMedia
    ? `<figure class="deck-media${nsfw ? " nsfw" : ""}">
         <img src="${esc(t)}" alt="" loading="lazy" decoding="async" />
         ${nsfw ? '<figcaption class="deck-nsfw">NSFW</figcaption>' : `<span class="deck-kind">${esc(mt.label)}</span>`}
       </figure>`
    : "";

  const act = (kind, label, key, icon) =>
    `<button type="button" class="deck-act act-${kind}" data-deck-act="${kind}">
       <span class="da-ico" aria-hidden="true">${icon}</span>
       <span class="da-lab">${label}</span>
       <kbd>${key}</kbd>
     </button>`;

  const titleHtml = url
    ? `<a href="${esc(url)}" target="_blank" rel="noopener">${title}</a>`
    : title;

  return `<article class="deck-card${media ? " has-media" : ""}" style="--src:${srcAccent(it.source)}" data-fullname="${esc(it.fullname)}" draggable="true" aria-label="Triage card">
      <header class="deck-head">
        <span class="deck-src"><span class="deck-glyph">${glyph}</span>${esc(src)}</span>
        ${sub}
      </header>
      <div class="deck-main">
        <div class="deck-copy">
          <h2 class="deck-title">${titleHtml}</h2>
          <div class="deck-meta">${meta}</div>
          ${body}
        </div>
        ${media}
      </div>
      <div class="deck-actions" role="group" aria-label="Decide">
        ${act("keep", "Keep", "F", chIcon("keep"))}
        ${act("archived", "Archive", "→", chIcon("archive"))}
        ${act("done", "Done", "←", chIcon("done"))}
        <span class="deck-actions-spacer"></span>
        ${act("reader", "Read", "↑", "↗")}
        ${act("skip", "Skip", "↓", "⇥")}
      </div>
      <div class="deck-hint">Swipe or use the keys · hold ← to snooze · undo from the toast</div>
    </article>`;
}

function emptyDeck() {
  return (
    '<div class="deck-empty">' +
    "<h3>Batch cleared.</h3>" +
    '<button type="button" class="deck-draw" id="deck-draw">Draw another batch</button>' +
    "</div>"
  );
}

function snippet(s, n) {
  s = String(s || "")
    .replace(/\s+/g, " ")
    .trim();

  return s.length > n ? s.slice(0, n) + "…" : s;
}

/* ---- chrome wiring ---- */

function mountChromeHandlers(state) {
  const back = host.querySelector("#deck-back");

  if (back) back.addEventListener("click", () => deps.toggleDeck(false));

  host.querySelectorAll("[data-deck-act]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const it = queue[0];

      if (!it || busy) return;

      const action = btn.dataset.deckAct;

      if (action === "skip") advance(state);
      else if (action === "reader") deps.openReader(it);
      else commit(state, it, action);
    }),
  );

  // A thumb URL can be dead (archived post, missing media). Drop the frame
  // instead of showing the browser's broken-image glyph on the card.
  host.querySelectorAll(".deck-media img").forEach((img) => {
    img.addEventListener("error", () => img.closest(".deck-media")?.remove());
  });

  const draw = host.querySelector("#deck-draw");

  if (draw)
    draw.addEventListener("click", async () => {
      await fillQueue(state);
      renderDeck(state);
    });
  host.querySelectorAll("#deck-size button").forEach((b) =>
    b.addEventListener("click", async () => {
      batchSize = parseInt(b.dataset.size, 10) || 20;
      host
        .querySelectorAll("#deck-size button")
        .forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      await fillQueue(state);
      renderDeck(state);
    }),
  );
  host.querySelectorAll("#deck-mode button").forEach((b) =>
    b.addEventListener("click", async () => {
      batchMode = b.dataset.mode || "smart";
      host
        .querySelectorAll("#deck-mode button")
        .forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      await fillQueue(state);
      renderDeck(state);
    }),
  );
}

/* ---- swipe on the current card ---- */

function attachCardSwipe(state, it) {
  const card = host.querySelector(".deck-card");

  if (!card) return;
  deps.attachSwipe(card, {
    commit: 80,
    commit2: 170,
    haptics: true,
    onRight: () => commit(state, it, "archived"),
    onLeft: () => commit(state, it, "done"),
    onLeftLong: () => deps.snooze(it.fullname),
    onUp: () => deps.openReader(it),
    onDown: () => advance(state),
  });
}

/* ---- commit / advance / undo ---- */

async function commit(state, it, status) {
  if (busy || !it) return;
  busy = true;

  if (typeof window !== "undefined" && window.chHaptic) window.chHaptic(status);
  const card = host.querySelector(".deck-card");

  if (card) {
    card.classList.add("leaving", "lv-" + status);
    await new Promise((r) => setTimeout(r, 160));
  }

  let ok = true;

  try {
    await deps.api.setStatus(it.fullname, status);
  } catch {
    ok = false;
    deps.toast("That didn't stick — try again.");

    if (card) card.classList.remove("leaving", "lv-" + status);
  }

  busy = false;

  if (!ok) return;
  batchIdx += 1;
  deps.bumpPulse(status === "inbox" ? 0 : 1);
  const undoItem = queue.shift();
  advance(state, true);
  deps.snackbar((deps.COPY && deps.COPY[status]) || "Logged.", async () => {
    try {
      await deps.api.undoItem(undoItem.fullname);
      deps.bumpPulse(status === "inbox" ? 0 : -1);
      queue.unshift(undoItem);
      renderDeck(state);
    } catch {
      deps.toast("Undo failed.");
    }
  });
}

/* Advance to the next card; if `decided`, just render the next item; otherwise
   (skip) the head item is requeued to the back of the current batch so the
   user can return to it later. */
function advance(state, decided) {
  if (!queue.length) {
    renderDeck(state);

    return;
  }

  if (!decided) {
    const head = queue.shift();
    queue.push(head);
  }

  if (queue.length === 0) {
    renderDeck(state);

    return;
  }

  renderDeck(state);
}

/* ---- keymap (delegated from main.js's keydown handler) ---- */

function deckKey(e, state) {
  if (!state || !state.deck) return false;

  // Escape falls through to the main handler (closes deck via its sheet-close path).
  if (e.key === "Escape") return false;
  const k = (e.key || "").toLowerCase();
  const it = queue[0];

  if (k === "s") {
    e.preventDefault();
    commit(state, it, "keep");

    return true;
  }

  if (k === "e" || k === "arrowright") {
    e.preventDefault();
    commit(state, it, "archived");

    return true;
  }

  if (k === "y" || k === "arrowleft") {
    e.preventDefault();
    commit(state, it, "done");

    return true;
  }

  if (k === "u" || k === "z") {
    // defer to main.js's undo handler so the snackbar .toast-undo path runs
    return false;
  }

  if (k === " ") {
    e.preventDefault();
    advance(state, false);

    return true;
  }

  // Any other key we don't own: don't consume.
  return false;
}

/* ---- dock + settings toggle wiring ---- */

function mountToggleHandlers(state) {
  const dockBtn = typeof document !== "undefined" && document.getElementById("dock-deck");

  if (dockBtn) dockBtn.addEventListener("click", () => deps.toggleDeck(!state.deck));
  const settingsBtn = typeof document !== "undefined" && document.getElementById("set-deck-enter");

  if (settingsBtn) settingsBtn.addEventListener("click", () => deps.toggleDeck(true));
}

/* Inject the host element reference (called by main.js once the DOM is up). */
export function setHost(el) {
  host = el;
}

/* Test hooks — export the queue length so tests can assert state without DOM. */
export const _test = {
  getQueue: () => queue,
  setQueue: (q) => {
    queue = q.slice();
  },
  setBatchSize: (n) => {
    batchSize = n;
  },
  setBatchMode: (m) => {
    batchMode = m;
  },
  commit,
  advance,
  deckKey,
};
