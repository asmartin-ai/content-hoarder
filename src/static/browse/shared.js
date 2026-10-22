/* browse/shared.js — the browse surface's shared state + helpers.
   One mutable `state` object every view module reads, the facet payload the rail
   and drawer both render, the selection/pins/drawer sets, the copy strings, and the
   session-scoped view persistence. No imports: this is the bottom of the graph. */

export const $ = (s) => document.querySelector(s);

export const $$ = (s) => [...document.querySelectorAll(s)];

/* ---- state ---- */
export const state = {
  status: "inbox",
  source: "",
  category: "",
  subreddit: "",
  tags: [],
  q: "",
  exact: false,
  sort: localStorage.chSort || "first_seen_utc:desc",
  density: localStorage.chDensity || "comfortable",
  focus: localStorage.chFocus === "1",
  safe: localStorage.chSafe !== "0", // default ON: hide NSFW unless the user opted into "Show all"
  archiveMedia: localStorage.chArchiveMedia === "1", // default OFF: prefer local /media copies (Epic 4 P1)
  goal: localStorage.chGoal === undefined ? 8 : parseInt(localStorage.chGoal, 10) || 0,
  offset: 0,
  hasMore: false,
  loading: false,
  items: [],
  batchTotal: 0, // Focus: size of the dealt batch
  batchCleared: 0, // Focus: cleared from THIS batch (session-local)
  stamped: false, // Focus: celebration shown for this batch
  curated: new Set(),
  pulse: { new_today: 0, cleared_today: 0, swept_recent: 0 },
  deck: new URLSearchParams(location.search).get("deck") === "1",
};

export const FOCUS_BATCH = 25;

/* Per-tab sort memory (Epic 10 / item 412): each status tab remembers its own sort, and the
   "All" view (status "") defaults to the learned easy-to-triage "smart" sort. Falls back to the
   legacy global chSort, then newest-saved. (smart degrades to recency until triage_score is
   learned, so it's safe on an untrained DB — see db._order_clause NULLS LAST.) */
const SORT_DEFAULT = "first_seen_utc:desc";

const SORT_BY_TAB = { "": "smart:desc" };

export const sortKey = (status) => "chSort:" + (status || "all");

export function sortForTab(status) {
  try {
    const v = localStorage.getItem(sortKey(status));

    if (v) return v;
  } catch {}

  return SORT_BY_TAB[status] || localStorage.chSort || SORT_DEFAULT;
}

export const nsfwRevealed = new Set();

/* Bulk selection (avatar shade select → overlay bar → bulk undo). */
export const selected = new Set();

export const itemsEl = $("#items");

export const deckHostEl = $("#deck-host");

export const doneRetention = {
  loaded: false,
  loading: false,
  days: 30,
  preview: null,
};

/* ---- mobile "Jump" drawer state (the phone expression of the .rail) ---- */
export const drawer = $("#navdrawer");

export const facets = { sources: [], categories: [], tags: [], groups: [] };

const loadJSON = (k, f) => {
  try {
    const v = JSON.parse(localStorage.getItem(k));

    return v ?? f;
  } catch {
    return f;
  }
};

export const saveSet = (k, s) => {
  try {
    localStorage.setItem(k, JSON.stringify([...s]));
  } catch {}
};

export const pins = new Set(loadJSON("chDrawerPins", []));

export const hiddenGroups = new Set(loadJSON("chDrawerHidden", []));

export const collapsed = new Set(loadJSON("chDrawerCollapsed", []));

export const COPY = {
  keep: "Kept — filed, worth revisiting.",
  archived: "Archived — set aside, out of the way.",
  done: "Done — finished with it.",
  inbox: "Back in the inbox.",
};

export function storedString(value) {
  try {
    return String.prototype.valueOf.call(value);
  } catch {
    return null;
  }
}

export const isPhone = () => window.matchMedia("(max-width:700px)").matches;

/* persist the active view (status/source/tags) across reloads — sessionStorage so it survives a
   refresh/return within the session but a fresh app launch still starts clean at the inbox.
   (sort/density/focus/goal/nsfw already persist via localStorage.) */
const VIEW_KEY = "ch_view";

export function saveView() {
  try {
    sessionStorage.setItem(
      VIEW_KEY,
      JSON.stringify({
        status: state.status,
        source: state.source,
        tags: state.tags,
      }),
    );
  } catch {
    /* private mode / quota — non-fatal */
  }
}

export function restoreView() {
  try {
    const view = Object(JSON.parse(sessionStorage.getItem(VIEW_KEY) || "null"));
    const status = storedString(view.status);
    const source = storedString(view.source);

    if (status !== null) state.status = status;

    if (source !== null) state.source = source;

    if (Array.isArray(view.tags)) {
      const tags = [];

      for (const tag of view.tags) {
        const value = storedString(tag);

        if (value !== null) tags.push(value);
      }

      state.tags = tags;
    }
  } catch {
    /* ignore corrupt value */
  }
}
