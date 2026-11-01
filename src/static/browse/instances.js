import { debounce } from "../core/util.js";
import { facets, state } from "./shared.js";
import { initReader } from "./reader.js";
import { initTagEditor } from "./tagedit.js";
import { refreshRail } from "./data.js";
import { render, reblur } from "./feed.js";
import { lightbox, openMediaFor } from "./lightbox.js";
import { closeSheets } from "./panels.js";
import { act, snooze } from "./actions.js";

export const readerUI = initReader({
  onTriage: (fn, status) => act(fn, status, { fromReader: true }),
  onSnooze: (fn) => snooze(fn, { fromReader: true }),
  onMedia: (it, opts) => openMediaFor(it, opts),
  closeSheets: () => closeSheets(),
  onClose: (fn) => reblur(fn),
  onImage: (url) => lightbox.openImage(url),
  onBodySaved: (updated) => {
    if (!updated || !updated.fullname) return;
    const it = state.items.find((x) => x.fullname === updated.fullname);

    if (it) Object.assign(it, updated);
    render();
  },
});

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
