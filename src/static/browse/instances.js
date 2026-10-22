/* browse/instances.js — the three injected sub-surfaces the browse page owns: deck
   mode, the in-app reader, and the per-item tag editor. Each is built once here with
   the callbacks the rest of the browse modules provide, so every module can import the
   instance instead of threading it through a parameter list. */

import * as api from "../core/api.js";
import { toast, snackbar } from "../core/toast.js";
import { attachSwipe } from "../core/swipe.js";
import { debounce } from "../core/util.js";
import { metaLine } from "../core/render.js";
import { COPY, deckHostEl, facets, state } from "./shared.js";
import { initDeck, setHost as setDeckHost } from "./deck.js";
import { canOpenInReader, initReader } from "./reader.js";
import { initTagEditor } from "./tagedit.js";
import { bumpPulse } from "./chrome.js";
import { refreshRail } from "./data.js";
import { render, reblur, toggleDeck } from "./feed.js";
import { lightbox, openMediaFor } from "./lightbox.js";
import { closeSheets } from "./panels.js";
import { act, snooze } from "./actions.js";

/* v3 deck mode (?deck=1) — one card at a time, /random-driven, with swipe
   + decision keys + Undo. Body in ./deck.js. */
export const deck = initDeck({
  api,
  toast,
  snackbar,
  attachSwipe,
  COPY: {
    get keep() {
      return COPY.keep;
    },
    get archived() {
      return COPY.archived;
    },
    get done() {
      return COPY.done;
    },
    get inbox() {
      return COPY.inbox;
    },
  },
  glyph: (it) => (it.source ? it.source[0] || "·" : "·"),
  metaLine,
  snooze: (fn) => snooze(fn),
  openReader: (it) => {
    if (canOpenInReader(it)) readerUI.open(it, { triageEnter: true });
    else if (it.url) window.open(it.url, "_blank", "noopener");
  },
  bumpPulse,
  toggleDeck: (on) => toggleDeck(on),
});

if (deckHostEl) setDeckHost(deckHostEl);

/* the in-app thread reader — replaces external handoff for Reddit/HN discussion
   threads. act/openMediaFor/closeSheets are hoisted function declarations. */
export const readerUI = initReader({
  onTriage: (fn, status) => act(fn, status, { fromReader: true }),
  onSnooze: (fn) => snooze(fn, { fromReader: true }),
  onMedia: (it, opts) => openMediaFor(it, opts),
  closeSheets: () => closeSheets(),
  onClose: (fn) => reblur(fn),
  onImage: (url) => lightbox.openImage(url), // inline comment/selftext image → lightbox
  onBodySaved: (updated) => {
    if (!updated || !updated.fullname) return;
    const it = state.items.find((x) => x.fullname === updated.fullname);

    if (it) Object.assign(it, updated);
    render();
  },
});

/* per-item manual tag editor (browse surface, Epic 5/26 P2) — opens from the ＋ trigger on
   a row/card or the `t` key. Writes the server's returned tag list back to state, re-renders
   so the row's chips update, and re-syncs the rail (debounced) — note db.tag_counts restricts
   facets to the curated FILTER_TAGS, so a brand-new user tag shows on the row but NOT in the
   rail until a user-tag vocab registry exists (Epic 26 follow-up). */
const refreshRailSoon = debounce(() => refreshRail(), 350);

export const tagEditor = initTagEditor({
  getItem: (fn) => state.items.find((it) => it.fullname === fn),
  getKnownTags: () => facets.tags.map((t) => t.id),
  onChange: (fn, tags) => {
    const it = state.items.find((x) => x.fullname === fn);

    if (it) {
      it.metadata = it.metadata || {};
      it.metadata.tags = tags;
    }

    render();
    refreshRailSoon();
  },
});
