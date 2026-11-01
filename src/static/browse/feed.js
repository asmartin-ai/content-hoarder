/* browse/feed.js — the list surface: rendering the feed, row lookup + NSFW re-blur,
   and infinite scroll. */

import { $, $$, state, itemsEl, nsfwRevealed, selected } from "./shared.js";
import { attachSwipe } from "../core/swipe.js";
import { listHtml, emptyHtml, isNsfw } from "./render.js";
import { isFastScrollScrubbing } from "./fastscroll.js";
import { loadItems } from "./data.js";
import { act, snooze, paintBulk, syncSelectionToVisibleItems } from "./actions.js";
import { openRowMenu, closeRelay } from "./relay.js";
import { surprise } from "./ambient.js";

export function render() {
  itemsEl.hidden = false;
  itemsEl.className = "items density-" + state.density;
  syncSelectionToVisibleItems();
  paintBulk();

  if (!state.items.length) {
    itemsEl.innerHTML = emptyHtml();

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

itemsEl.addEventListener("click", (e) => {
  if (e.target.closest("#empty-surprise")) surprise();
});

/* ---- infinite scroll ---- */
new IntersectionObserver(
  (entries) => {
    if (
      entries[0].isIntersecting &&
      state.hasMore &&
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
  if (!state.hasMore || state.loading) return;
  const s = $("#sentinel").getBoundingClientRect();

  if (s.top < window.innerHeight + 600) loadItems(false);
});
