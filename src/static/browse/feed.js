/* browse/feed.js — the list surface: rendering the feed, row lookup + NSFW re-blur,
   Focus batches and their stamp, infinite scroll, and the ?deck=1 URL toggle. */

import { $, $$, state, itemsEl, nsfwRevealed, selected } from "./shared.js";
import { attachSwipe } from "../core/swipe.js";
import { listHtml, emptyHtml, isNsfw } from "./render.js";
import { isFastScrollScrubbing } from "./fastscroll.js";
import { loadItems } from "./data.js";
import { deck } from "./instances.js";
import { act, snooze, paintBulk, syncSelectionToVisibleItems } from "./actions.js";
import { openRowMenu, closeRelay } from "./relay.js";
import { surprise } from "./ambient.js";

export function render() {
  // Deck mode: hide the list, show the deck host. Deck owns its own render.
  const deckHost = document.getElementById("deck-host");

  if (state.deck) {
    if (deckHost) deckHost.hidden = false;
    itemsEl.hidden = true;
    deck.render(state);
    paintBulk();

    return;
  }

  if (deckHost) deckHost.hidden = true;
  itemsEl.hidden = false;
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

export function rowEl(fullname) {
  return itemsEl.querySelector('[data-fullname="' + CSS.escape(fullname) + '"]');
}

/* Re-blur an NSFW item's feed thumbnail — the reverse of the tap-reveal. Called when
   the reader/lightbox opened for it closes, so a reveal doesn't persist across close
   (Epic 13 P2). Idempotent and a no-op for non-NSFW items. */
export function reblur(fn) {
  if (!fn) return;
  nsfwRevealed.delete(fn);
  const item = state.items.find((it) => it.fullname === fn);

  if (!item || !isNsfw(item)) return;
  const row = rowEl(fn);

  if (row) row.querySelectorAll(".monitor, .screen").forEach((el) => el.classList.add("nsfw"));
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

export function setFocus(on) {
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

$("#enough").addEventListener("click", () => $("#stamp").classList.remove("show"));

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
      !state.loading &&
      !isFastScrollScrubbing() // pause page loads mid-scrub (#46 follow-up)
    )
      loadItems(false);
  },
  { rootMargin: "600px" },
).observe($("#sentinel"));

// A load suppressed mid-scrub never re-fires the observer (it only reports
// intersection CHANGES), so re-check once when the scrub settles.
window.addEventListener("fastscroll:settle", () => {
  if (!state.hasMore || state.focus || state.loading) return;
  const s = $("#sentinel").getBoundingClientRect();

  if (s.top < window.innerHeight + 600) loadItems(false);
});

/* ---- deck mode (?deck=1) toggle ----
   URL-driven: entering pushState's ?deck=1, leaving strips it. Toggling does
   NOT refetch or reset filters — same state machine, different renderer. */
function pushDeckUrl(on) {
  const url = new URL(location.href);

  if (on) url.searchParams.set("deck", "1");
  else url.searchParams.delete("deck");
  history.pushState({}, "", url);
}

export function syncDeckToggles() {
  const on = !!state.deck;
  const dock = $("#dock-deck");

  if (dock) dock.setAttribute("aria-pressed", String(on));
  const enter = $("#set-deck-enter");

  if (enter) enter.setAttribute("aria-pressed", String(on));
}

export async function toggleDeck(on) {
  if (!!state.deck === on) return;
  state.deck = on;
  pushDeckUrl(on);
  syncDeckToggles();

  if (on) {
    await deck.open(state);
  } else {
    deck.close(state);
    render();
  }
}

$("#dock-deck")?.addEventListener("click", () => toggleDeck(!state.deck));

$("#set-deck-enter")?.addEventListener("click", () => toggleDeck(true));

window.addEventListener("popstate", () => {
  const next = new URLSearchParams(location.search).get("deck") === "1";

  if (!!state.deck === next) return;
  state.deck = next;
  syncDeckToggles();

  if (next) deck.open(state);
  else {
    deck.close(state);
    render();
  }
});

/* On initial load, if ?deck=1 is set, open the deck — done in main.js, after every
   module has finished evaluating (deck.open is imported from ./instances.js). */
