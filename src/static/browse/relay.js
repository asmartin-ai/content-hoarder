/* browse/relay.js — the Relay-style inline long-press strip (Epic 16 B3): the row
   action menu (source/author/tag/share/promote/snooze/unsave) opened by long-press
   or right-click, and the strip's own delegated click handling. */

import { $, state, itemsEl } from "./shared.js";
import { itemUrl, shareItem } from "../core/render.js";
import { rowEl } from "./feed.js";
import { snooze, unsaveRow, promoteItem } from "./actions.js";
import { tagEditor } from "./instances.js";
import { closeSheets } from "./panels.js";

/* ---- Relay-style inline long-press strip (Epic 16 B3) ----
   Long-press / right-click a row → the row translates aside and a horizontal action
   strip appears in its place, in the same thumb zone (no reach to mid-screen).
   The strip is injected into the row; a transparent .relay-scrim captures outside
   taps / Escape to collapse it back. */
let relayFn = null;

let relayRow = null;

const relayScrim = $("#relay-scrim");

const relayTpl = $("#relay-strip-tpl");

function relaySourceHref(it) {
  const m = it.metadata || {};

  if (it.source === "reddit" && m.subreddit)
    return "https://www.reddit.com/r/" + encodeURIComponent(m.subreddit);

  if (it.source === "youtube" && m.channel) {
    // channel id preferred when present; falls back to the handle/@name
    const id = m.channel_id || "";

    if (id) return "https://www.youtube.com/channel/" + encodeURIComponent(id);

    return "https://www.youtube.com/" + encodeURIComponent(m.channel);
  }

  if (it.source === "hackernews")
    return "https://news.ycombinator.com/item?id=" + encodeURIComponent(it.source_id || "");
  const u = itemUrl(it) || it.url || "";

  return u;
}

function relaySourceLabel(it) {
  const m = it.metadata || {};

  if (it.source === "reddit" && m.subreddit) return "r/" + m.subreddit;

  if (it.source === "youtube" && m.channel) return m.channel;

  if (it.source === "hackernews") return "HN";

  // fall back to the URL domain
  try {
    const u = itemUrl(it) || it.url || "";

    if (u) return new URL(u).hostname.replace(/^www\./, "");
  } catch {}

  return it.source || "source";
}

function relayAuthorHref(it) {
  const a = (it.author || "").trim();

  if (!a) return "";

  if (it.source === "reddit") return "https://www.reddit.com/user/" + encodeURIComponent(a);

  if (it.source === "hackernews")
    return "https://news.ycombinator.com/user?id=" + encodeURIComponent(a);

  if (it.source === "youtube") return "https://www.youtube.com/" + encodeURIComponent(a);

  return "";
}

function relayAuthorLabel(it) {
  const a = it.author || "";

  if (!a) return "";

  if (it.source === "reddit" || it.source === "hackernews") return "u/" + a;

  return a;
}

export function closeRelay() {
  if (!relayFn && !relayRow) return;

  if (relayRow) {
    relayRow.classList.remove("relay-open");
    const fg = relayRow.querySelector(".item-fg");

    if (fg) {
      fg.style.transition = "";
      fg.style.transform = "";
    }

    const strip = relayRow.querySelector(".relay-strip");

    if (strip) strip.remove();
  }

  relayFn = null;
  relayRow = null;

  if (relayScrim) relayScrim.classList.remove("show");
}

export function openRowMenu(fn) {
  const it = state.items.find((i) => i.fullname === fn);

  if (!it) return;
  const row = rowEl(fn);

  if (!row || !relayTpl) return;
  // collapse any prior relay strip first (e.g. right-click after a long-press)
  closeSheets();
  closeRelay();

  // build the strip from the template, then hydrate the source/author links
  const frag = relayTpl.content.cloneNode(true);

  // helper: turn a <button class="relay-btn"> into a navigation <a> with the same
  // children/classes (buttons don't navigate even with href set).
  const toLink = (btn, href) => {
    const a = document.createElement("a");
    a.className = btn.className;
    a.setAttribute("data-relay", btn.dataset.relay);
    a.setAttribute("role", "menuitem");
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener";

    while (btn.firstChild) a.appendChild(btn.firstChild);
    btn.replaceWith(a);

    return a;
  };

  const srcBtn = frag.querySelector('[data-relay="source"]');
  const srcLabel = relaySourceLabel(it);
  srcBtn.setAttribute("aria-label", srcLabel);
  const srcLblEl = srcBtn.querySelector('[data-relay-label="source"]');

  if (srcLblEl) srcLblEl.textContent = srcLabel;
  const srcHref = relaySourceHref(it);

  if (srcHref) toLink(srcBtn, srcHref);
  else srcBtn.hidden = true;
  const auBtn = frag.querySelector('[data-relay="author"]');
  const auLabel = relayAuthorLabel(it);
  const auHref = relayAuthorHref(it);

  if (auHref && auLabel) {
    auBtn.setAttribute("aria-label", auLabel);
    const auLblEl = auBtn.querySelector('[data-relay-label="author"]');

    if (auLblEl) auLblEl.textContent = auLabel;
    toLink(auBtn, auHref);
  } else {
    auBtn.hidden = true;
  }

  // Reddit-only "Unsave" — only meaningful when still in the user's Saved list.
  const unsaveBtn = frag.querySelector('[data-relay="unsave"]');

  if (unsaveBtn) {
    const show = it.source === "reddit" && it.is_saved !== 0;
    unsaveBtn.hidden = !show;
  }

  // "Promote" — hidden once a promoted receipt exists (re-promote is a no-op).
  const promoBtn = frag.querySelector('[data-relay="promote"]');

  if (promoBtn) {
    const pmd = (it.metadata || {}).promotion || {};
    promoBtn.hidden = pmd.status === "promoted";
  }

  row.appendChild(frag);
  relayFn = fn;
  relayRow = row;
  // double-rAF so the strip's enter transition runs (inserted at offset, then translated to 0)
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      row.classList.add("relay-open");

      if (relayScrim) relayScrim.classList.add("show");
    }),
  );
}

// clicks on the strip (the row's own click handler is for triage/title taps; this is
// a dedicated listener on itemsEl that only acts when a relay strip is the target)
itemsEl.addEventListener("click", (e) => {
  const btn = e.target.closest(".relay-btn[data-relay]");

  if (!btn) return;

  const action = btn.dataset.relay,
    fn = relayFn;

  // source/author are real anchors (href set above) — let them navigate, just collapse
  if (action === "source" || action === "author") {
    closeRelay();

    return;
  }

  e.preventDefault();
  e.stopPropagation();
  closeRelay();

  if (!fn) return;

  if (action === "tag") tagEditor.open(fn, rowEl(fn));
  else if (action === "share") shareItem(state.items.find((i) => i.fullname === fn));
  else if (action === "promote") promoteItem(fn);
  else if (action === "snooze") snooze(fn);
  else if (action === "unsave") unsaveRow(fn);
});

if (relayScrim) relayScrim.addEventListener("click", closeRelay);

// Escape closes an open relay strip (the global keydown below also routes here)
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && relayFn) closeRelay();
});

// desktop has no long-press → right-click a row opens the same menu
itemsEl.addEventListener("contextmenu", (e) => {
  // Keep the native browser menu on real links so users can copy/open URLs.
  // Right-clicking row chrome/text still opens the row action strip.
  if (e.target.closest("a[href]")) return;
  const card = e.target.closest(".row[data-fullname]");

  if (!card) return;
  e.preventDefault();
  openRowMenu(card.dataset.fullname);
});
