/* browse/actions.js — triage on the feed: live clear + undo/redo, the delegated row
   interactions (status buttons, media, title→reader), bulk select + its tray, the
   predictive next-thread preload, and the row-menu unsave/promote actions. */

import * as api from "../core/api.js";
import { toast, snackbar } from "../core/toast.js";
import { imageUrl } from "../core/media.js";
import { isNsfw } from "./render.js";
import { canOpenInReader } from "./reader.js";
import { $, $$, state, itemsEl, selected, nsfwRevealed, COPY } from "./shared.js";
import { clearItemFirstPageCache } from "./data.js";
import { render, rowEl } from "./feed.js";
import { openMediaFor } from "./lightbox.js";
import { readerUI, tagEditor } from "./instances.js";

/* ---- actions: live clear + undo/redo (locked #11) ---- */
/* Single-level redo buffer: the last single-item action that was undone, so it can
   be replayed. Mirrors the single-level snackbar undo (only the most recent action is
   undoable, so only one is redoable). Any new act() clears it. */
let lastUndone = null;

export async function act(fullname, status, opts = {}) {
  lastUndone = null; // a fresh action invalidates the redo buffer

  if (window.chHaptic) window.chHaptic(status); // tactile confirm on the decision (covers swipe + buttons)

  /* SPEC A2: reader triage skips leave-anim, cache clear, item removal, and render().
     The item stays in state.items with its status updated lazily; undo just reverts
     the in-memory status. No redo tracking for the reader path. */
  if (opts.fromReader) {
    try {
      await api.setStatus(fullname, status);
    } catch {
      toast("That didn't stick — try again.");

      return;
    }

    const item = state.items.find((it) => it.fullname === fullname);
    const prevStatus = item ? item.status : null;

    if (item) item.status = status;

    snackbar(COPY[status] || "Logged.", async () => {
      if (window.chHaptic) window.chHaptic("undo");

      try {
        await api.undoItem(fullname);

        if (item) item.status = prevStatus;
      } catch {
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
  } catch {
    if (row) row.classList.remove("leaving", "lv-" + status);
    toast("That didn't stick — try again.");

    return;
  }

  const undoIdx = state.items.findIndex((it) => it.fullname === fullname);
  const undoItem = undoIdx >= 0 ? state.items[undoIdx] : null;
  state.items = state.items.filter((it) => it.fullname !== fullname);

  render();
  snackbar(COPY[status] || "Logged.", async () => {
    if (window.chHaptic) window.chHaptic("undo");

    try {
      await api.undoItem(fullname);
      clearItemFirstPageCache();

      // restore the row in place — no full refetch/skeleton, keeps the scroll position
      if (undoItem && !state.items.some((it) => it.fullname === fullname)) {
        state.items.splice(Math.min(undoIdx, state.items.length), 0, undoItem);
      }

      render();
      lastUndone = { fullname, status }; // now redoable
    } catch {
      toast("Undo failed.");
    }
  });
}

export async function snooze(fullname, opts = {}) {
  lastUndone = null;

  if (window.chHaptic) window.chHaptic("skip");

  /* SPEC A2: reader snooze skips leave-anim, cache clear, item removal, and render().
     The item stays in state.items with its status updated lazily; undo reverts status. */
  if (opts.fromReader) {
    let res;

    try {
      res = await api.snoozeItem(fullname, { window_days: 7 });
    } catch {
      toast("Snooze didn't stick - try again.");

      return;
    }

    const item = state.items.find((it) => it.fullname === fullname);
    const prevStatus = item ? item.status : null;
    const escalated = !!(res && res.decayed_at);

    if (item && escalated) item.status = "archived";

    snackbar(escalated ? "Archived after repeat snoozes." : "Snoozed for 7 days.", async () => {
      try {
        const undoBody =
          res && res.snoozed_wave
            ? { snoozed_wave: res.snoozed_wave }
            : { decayed_at: res.decayed_at };

        await api.undoSnooze(undoBody);

        if (item) item.status = prevStatus;
      } catch {
        toast("Undo failed.");
      }
    });

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
  } catch {
    if (row) row.classList.remove("leaving", "lv-snooze");
    toast("Snooze didn't stick - try again.");

    return;
  }

  const undoIdx = state.items.findIndex((it) => it.fullname === fullname);
  const undoItem = undoIdx >= 0 ? state.items[undoIdx] : null;
  state.items = state.items.filter((it) => it.fullname !== fullname);
  const escalated = !!(res && res.decayed_at);

  render();
  snackbar(escalated ? "Archived after repeat snoozes." : "Snoozed for 7 days.", async () => {
    try {
      const undoBody =
        res && res.snoozed_wave
          ? { snoozed_wave: res.snoozed_wave }
          : { decayed_at: res.decayed_at };

      await api.undoSnooze(undoBody);
      clearItemFirstPageCache();

      if (undoItem && !state.items.some((it) => it.fullname === fullname)) {
        state.items.splice(Math.min(undoIdx, state.items.length), 0, undoItem);
      }

      render();
    } catch {
      toast("Undo failed.");
    }
  });
}

/* Redo: replay the last undone single-item action (re-applies the status + shows a
   fresh undo snackbar). act() resets lastUndone, so it's a clean one-step toggle. */
export function redo() {
  if (!lastUndone) {
    toast("Nothing to redo.");

    return;
  }

  act(lastUndone.fullname, lastUndone.status);
}

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

const threadPath = (item) =>
  item && item.source === "hackernews"
    ? "/hackernews/items/" + encodeURIComponent(item.fullname) + "/thread"
    : item && item.source === "reddit"
      ? "/reddit/items/" + encodeURIComponent(item.fullname) + "/thread"
      : "";

export function preloadNext(opened) {
  if (!opened) return;
  const i = state.items.indexOf(opened);

  if (i < 0) return;
  let next = null; // nearest following discussion item (small look-ahead)

  for (let j = i + 1; j < state.items.length && j <= i + 4; j++) {
    if (state.items[j].source === "reddit" || state.items[j].source === "hackernews") {
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
    } catch {}
  }

  _preloadCtl = new AbortController();
  // sort is irrelevant for warming (hydration caches the whole thread; sort is applied at read time)
  const path = threadPath(next);

  if (path) fetch(path, { signal: _preloadCtl.signal }).catch(() => {});
}

/* ---- bulk select (locked: avatar shade select; overlay bar; bulk undo) ---- */
export function toggleSelect(card) {
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

export function syncSelectionToVisibleItems() {
  const visible = new Set(state.items.map((it) => it.fullname));
  [...selected].forEach((fn) => {
    if (!visible.has(fn)) selected.delete(fn);
  });
}

export function paintBulk() {
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

    // Bulk "Unsave" is reddit-only and queues locally; it does not change triage
    // status, so it bypasses the bulkStatus path entirely. Only reddit items with
    // is_saved !== 0 are queued; others are silently skipped (with a toast count).
    if (status === "unsave") {
      const targets = state.items.filter(
        (it) => fns.includes(it.fullname) && it.source === "reddit" && it.is_saved !== 0,
      );

      clearSelection();

      if (!targets.length) {
        toast("No queueable reddit items selected.");

        return;
      }

      try {
        await Promise.all(targets.map((it) => api.unsaveItem(it.fullname)));
        const byFn = new Map(targets.map((it) => [it.fullname, it]));
        state.items.forEach((it) => {
          if (byFn.has(it.fullname)) it.is_saved = 0;
        });
        render();
        snackbar(targets.length + " queued for unsave. Drain contacts Reddit.", () =>
          api
            .unsaveDrain({ dry_run: true })
            .then((d) => toast(d && d.scope ? "Drain preview: " + d.scope : "Drain preview ready")),
        );
      } catch {
        toast("Bulk unsave failed partway.");
      }

      return;
    }

    clearSelection();

    try {
      await api.bulkStatus(fns, status);
      clearItemFirstPageCache();
    } catch {
      toast("Bulk action failed.");

      return;
    }

    const bulkRemoved = [];

    for (const fullname of fns) {
      const i = state.items.findIndex((it) => it.fullname === fullname);

      if (i >= 0) bulkRemoved.push({ i, item: state.items[i] });
    }

    state.items = state.items.filter((it) => !fns.includes(it.fullname));

    render();
    snackbar(fns.length + " — " + (COPY[status] || "logged.").toLowerCase(), async () => {
      await api.bulkUndo(fns);
      clearItemFirstPageCache();
      // restore the rows in place (ascending index) — no full refetch/skeleton
      bulkRemoved
        .sort((a, b) => a.i - b.i)
        .forEach(({ i, item }) => {
          if (!state.items.some((it) => it.fullname === item.fullname)) {
            state.items.splice(Math.min(i, state.items.length), 0, item);
          }
        });
      render();
    });
  }),
);

/* Queue one reddit item for unsave from the row menu. Local-only until
   /reddit/unsave/drain runs; surface that as a follow-up snackbar action. */
export async function unsaveRow(fn) {
  const it = state.items.find((i) => i.fullname === fn);

  if (!it) return;

  try {
    await api.unsaveItem(fn);
    it.is_saved = 0;
    const r = rowEl(fn);

    if (r) r.dataset.saved = "0";
    snackbar("Queued for unsave. Drain contacts Reddit.", () =>
      api
        .unsaveDrain({ dry_run: true })
        .then((d) => toast(d && d.scope ? "Drain preview: " + d.scope : "Drain preview ready")),
    );
  } catch {
    toast("Unsave failed.");
  }
}

/* Promote the row item into PKMS (Spec 15 §7): POST the bridge route, mirror
   the server-stamped metadata.promotion onto the local item so the row menu
   hides the Promote button on re-open, snackbar the PKMS response body.
   Errors toast data.error (unconfigured 400, transport 502). Item stays in
   the feed — no re-render needed. */
export async function promoteItem(fn) {
  const it = state.items.find((i) => i.fullname === fn);

  if (!it) return;

  try {
    const res = await api.promoteItem(fn);
    // Server always stamps status "promoted" (replay is a transient HTTP
    // answer); mirror that so the menu's hide rule matches the receipt.
    const promotion = { status: res.status === "replay" ? "promoted" : res.status };

    if (res.response) promotion.response = res.response;
    promotion.receipt = res.receipt;
    it.metadata = Object.assign({}, it.metadata, { promotion });
    snackbar(res.response || "Promoted.");
  } catch (e) {
    toast((e && e.data && e.data.error) || "Promote failed.");
  }
}
