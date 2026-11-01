export const $ = (s) => document.querySelector(s);

export const $$ = (s) => [...document.querySelectorAll(s)];

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
  safe: localStorage.chSafe !== "0",
  archiveMedia: localStorage.chArchiveMedia === "1",
  goal: localStorage.chGoal === undefined ? 8 : parseInt(localStorage.chGoal, 10) || 0,
  offset: 0,
  hasMore: false,
  loading: false,
  items: [],
  curated: new Set(),
  pulse: { new_today: 0, swept_recent: 0 },
};

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

export const selected = new Set();

export const itemsEl = $("#items");

export const doneRetention = {
  loaded: false,
  loading: false,
  days: 30,
  preview: null,
};

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
  } catch {}
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
  } catch {}
}
