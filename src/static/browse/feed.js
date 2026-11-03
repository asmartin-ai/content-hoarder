import { $, $$, state, itemsEl, nsfwRevealed, selected } from "./shared.js";
import { attachSwipe } from "../core/swipe.js";
import { listHtml, emptyHtml } from "./render.js";
import { isVeiled } from "../core/veil.js";
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

  itemsEl.innerHTML = listHtml(state.items, state, listOpts());
  $$(".row, .pin").forEach(wireRow);
}

export function appendRows(items, start) {
  if (!start || !itemsEl.querySelector("[data-fullname]")) return render();

  const before = itemsEl.children.length;

  itemsEl.insertAdjacentHTML(
    "beforeend",
    listHtml(items, state, { ...listOpts(), start, after: state.items[start - 1] }),
  );

  for (const el of [...itemsEl.children].slice(before)) {
    if (el.matches(".row, .pin")) wireRow(el);
  }
}

export function removeRow(fullname) {
  const row = rowEl(fullname);
  const numbered = state.density !== "comfortable" && state.density !== "card";

  if (!row || numbered || !state.items.length) return render();

  const prev = row.previousElementSibling;
  const next = row.nextElementSibling;

  row.remove();

  if (prev?.classList.contains("grouphead") && (!next || next.classList.contains("grouphead")))
    prev.remove();
  syncSelectionToVisibleItems();
  paintBulk();
}

function listOpts() {
  return { view: state.status, curated: state.curated, nsfwRevealed: false };
}

function wireRow(row) {
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
}

export function rowEl(fullname) {
  return itemsEl.querySelector('[data-fullname="' + CSS.escape(fullname) + '"]');
}

export function reblur(fn) {
  if (!fn) return;
  nsfwRevealed.delete(fn);
  const item = state.items.find((it) => it.fullname === fn);

  if (!item || !isVeiled(item)) return;
  const row = rowEl(fn);

  if (row) row.querySelectorAll(".monitor, .screen").forEach((el) => el.classList.add("nsfw"));
}

itemsEl.addEventListener("click", (e) => {
  if (e.target.closest("#empty-surprise")) surprise();
});

new IntersectionObserver(
  (entries) => {
    if (entries[0].isIntersecting && state.hasMore && !state.loading && !isFastScrollScrubbing())
      loadItems(false);
  },
  { rootMargin: "600px" },
).observe($("#sentinel"));

window.addEventListener("fastscroll:settle", () => {
  if (!state.hasMore || state.loading) return;
  const s = $("#sentinel").getBoundingClientRect();

  if (s.top < window.innerHeight + 600) loadItems(false);
});
