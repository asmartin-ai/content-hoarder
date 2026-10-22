/* browse/ambient.js — the one ambient slot: the resurfacing cluster card and the
   "surprise me" random save (locked #4/#5). Never both, never a count. */

import { esc } from "../core/util.js";
import * as api from "../core/api.js";
import { toast, snackbar } from "../core/toast.js";
import { chIcon } from "../core/icons.js";
import { imageUrl, mediaType, thumb } from "../core/media.js";
import { CH_SOURCES, metaLine } from "../core/render.js";
import { canOpenInReader } from "./reader.js";
import { $, state, storedString } from "./shared.js";
import { clearItemFirstPageCache, loadItems, refreshPulse } from "./data.js";
import { act, snooze, preloadNext } from "./actions.js";
import { openMediaFor } from "./lightbox.js";
import { readerUI } from "./instances.js";
import { paintTabs } from "./nav.js";

/* ---- the ambient slot: resurfacing card + surprise (locked #4/#5) ---- */
const ambient = $("#ambient");

function cardHtml(c) {
  const samples = (c.sample || []).map((s) => "“" + esc(s.title || "") + "”").join(" · ");

  const added = c.last_added_utc
    ? new Date(c.last_added_utc * 1000).toLocaleDateString(undefined, {
        month: "short",
        year: "numeric",
      })
    : "";

  const count = Number(c.count) || 0;

  const volume = count <= 1 ? "One save" : count < 5 ? "A few saves" : "A small cluster";

  const exact = count + " save" + (count === 1 ? "" : "s") + " in " + (c.label || "this cluster");

  return (
    '<div class="amb-eyebrow">' +
    (c.reactivated ? "THIS CAME BACK AROUND" : "WORTH A GLANCE?") +
    "</div>" +
    "<h3>Want to revisit <em>" +
    esc(c.label) +
    "</em>?</h3>" +
    '<div class="amb-body"><div class="amb-meta" title="' +
    esc(exact) +
    '" aria-label="' +
    esc(exact) +
    '">' +
    volume +
    " in <b>" +
    esc(c.label) +
    "</b>" +
    (added ? " · last added " + esc(added) : "") +
    '<div class="amb-samples">' +
    samples +
    "</div></div></div>" +
    '<div class="amb-acts">' +
    '<button type="button" class="ambbtn primary" data-amb="show">Show me</button>' +
    '<button type="button" class="ambbtn" data-amb="later">Not now</button>' +
    '<button type="button" class="ambbtn letgo" data-amb="letgo">Let it rest</button></div>'
  );
}

let ambientCard = null;

let surpriseItem = null;

const SURPRISE_PREVIEW_CHARS = 260;

function surprisePreviewText(item) {
  const m = (item && item.metadata) || {};

  const candidates = [m.summary, m.description, m.selftext, m.text, item && item.body, m.ocr_text];

  const raw = candidates.map(storedString).find((text) => text && text.trim());

  if (!raw) return "";

  return String(raw)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/!\[[^\]]*]\([^)]+\)/g, " ")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/`{1,3}([^`]+)`{1,3}/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function surprisePreviewHtml(item) {
  const text = surprisePreviewText(item);

  if (!text)
    return (
      '<div class="surp-preview empty" aria-label="Preview"><p>' +
      "No saved text preview." +
      "</p></div>"
    );

  const clipped =
    text.length > SURPRISE_PREVIEW_CHARS
      ? text.slice(0, SURPRISE_PREVIEW_CHARS - 3).trimEnd() + "..."
      : text;

  return '<div class="surp-preview" aria-label="Preview"><p>' + esc(clipped) + "</p></div>";
}

export async function loadAmbient() {
  try {
    const r = await fetch("/resurface");

    if (r.status !== 200) return;
    ambientCard = await r.json();
    ambient.innerHTML = cardHtml(ambientCard);
    ambient.hidden = false;
  } catch {
    /* ambient — never an error surface */
  }
}

ambient.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-amb]");

  if (!b) return;
  const action = b.dataset.amb;

  if (action === "open") {
    ambient.hidden = true;

    return;
  }

  if (!ambientCard) {
    ambient.hidden = true;

    return;
  }

  const cluster = ambientCard.cluster;

  if (action === "later") {
    ambient.hidden = true; // silent — never mentioned again
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
      clearItemFirstPageCache();
      snackbar(r.total + " saves let go — resting in the archive.", async () => {
        await api.postJSON("/resurface/letgo/undo", {
          cluster,
          decayed_at: r.decayed_at,
        });
        clearItemFirstPageCache();
        loadItems(true);
        refreshPulse();
      });
      loadItems(true);
      refreshPulse();
    } catch {
      toast("Couldn't let that go — try again.");
    }
  }
});

export async function surprise() {
  try {
    const r = await api.getJSON("/random?n=1");
    const it = (r.items || [])[0];

    if (!it) {
      toast("Nothing to deal — the shelves are empty.");

      return;
    }

    const mt = mediaType(it);
    const isRedditText = it.source === "reddit" && mt.cls === "text";
    // hero: prefer the crisp card-sized thumbnail (gallery aware), fall back to any image
    const t = isRedditText ? "" : thumb(it, "card") || imageUrl(it) || "";

    const hero = t
      ? '<button type="button" class="surp-hero" data-surprise="open" aria-label="Open in reader">' +
        '<img src="' +
        esc(t) +
        '" alt="" loading="lazy"></button>'
      : "";

    const src = CH_SOURCES[it.source] || {};

    const badge =
      '<span class="surp-badge" aria-hidden="true" style="--src:' +
      (src.token ? "var(" + src.token + ")" : "var(--accent)") +
      '">' +
      (src.glyph ? esc(src.glyph) : esc(it.source || "•")) +
      "</span>";

    const actionIcon = (name) =>
      '<span class="surp-act-ico" aria-hidden="true">' +
      (name === "snooze" ? "◷" : chIcon(name, { size: "1em" })) +
      "</span>";

    surpriseItem = it;
    ambient.innerHTML =
      '<article class="surp-card" data-fullname="' +
      esc(it.fullname) +
      '">' +
      '<button type="button" class="surp-x" data-surprise="dismiss" aria-label="Not today">✕</button>' +
      hero +
      '<div class="surp-body">' +
      '<div class="surp-eyebrow">Random save · no strings</div>' +
      "<h3>" +
      esc(it.title || "(untitled)") +
      "</h3>" +
      '<div class="surp-meta">' +
      '<span class="surp-metabits">' +
      badge +
      metaLine(it) +
      "</span></div>" +
      surprisePreviewHtml(it) +
      '<div class="surp-acts">' +
      '<button type="button" class="surp-act a" data-surprise="archived">' +
      actionIcon("archive") +
      "<span>Archive</span></button>" +
      '<button type="button" class="surp-act d" data-surprise="done">' +
      actionIcon("done") +
      "<span>Done</span></button>" +
      '<button type="button" class="surp-act s" data-surprise="snooze">' +
      actionIcon("snooze") +
      "<span>Snooze</span></button>" +
      '<button type="button" class="surp-act k" data-surprise="keep">' +
      actionIcon("keep") +
      "<span>Keep</span></button>" +
      '<button type="button" class="surp-act surp-open" data-surprise="open">Open reader</button>' +
      "</div></div></article>";
    ambientCard = null;
    ambient.hidden = false;
    ambient.scrollIntoView({ block: "nearest", behavior: "smooth" });
  } catch {
    toast("The dice jammed — try again.");
  }
}

$("#dice").addEventListener("click", surprise);

ambient.addEventListener("click", (e) => {
  const b = e.target.closest("[data-surprise]");

  if (!b) return;
  const action = b.dataset.surprise;
  const it = surpriseItem;

  if (action === "dismiss") {
    surpriseItem = null;
    ambient.hidden = true;

    return;
  }

  if (!it) return;
  const fn = it.fullname;

  // triage actions: animate the card out, then commit via the same paths as inbox rows
  if (action === "keep" || action === "archived" || action === "done") {
    const card = ambient.querySelector(".surp-card");

    if (card && !card.classList.contains("leaving")) {
      card.classList.add("leaving", "lv-" + action);
    }

    surpriseItem = null;
    // wait for the leave animation, then clear the slot and commit
    setTimeout(() => {
      ambient.hidden = true;
      ambient.innerHTML = "";
    }, 200);
    act(fn, action);

    return;
  }

  if (action === "snooze") {
    const card = ambient.querySelector(".surp-card");

    if (card && !card.classList.contains("leaving")) {
      card.classList.add("leaving", "lv-snooze");
    }

    surpriseItem = null;
    setTimeout(() => {
      ambient.hidden = true;
      ambient.innerHTML = "";
    }, 200);
    snooze(fn);

    return;
  }

  if (action !== "open") return;
  surpriseItem = null;
  ambient.hidden = true;

  if (canOpenInReader(it)) {
    readerUI.open(it);

    if (it.source === "reddit" || it.source === "hackernews") preloadNext(it);
  } else {
    openMediaFor(it);
  }
});
