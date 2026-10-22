/* browse/data.js — the browse view's data layer: query params, the first-page
   prefetch cache, feed loading/paging, status counts, rail facets, and the ambient
   pulse refresh (with its repeated-failure staleness signal). */

import { esc } from "../core/util.js";
import * as api from "../core/api.js";
import { toast } from "../core/toast.js";
import { $, $$, state, facets, itemsEl, FOCUS_BATCH, saveView } from "./shared.js";
import { paintPulse } from "./chrome.js";
import { render } from "./feed.js";
import { renderDrawer } from "./drawer.js";
import {
  PREFETCH_LIMITS,
  buildFirstPageWarmParams,
  createFirstPageCache,
  createFirstPagePrefetcher,
} from "./prefetch.js";

/* ---- fetching + rendering ---- */
function params(extra) {
  const p = {
    sort: state.sort.split(":")[0],
    order: state.sort.split(":")[1],
    ...extra,
  };

  if (state.status) p.status = state.status;

  if (state.source) p.source = state.source;

  if (state.category) p.category = state.category;

  if (state.subreddit) p.subreddit = state.subreddit;

  if (state.q) p.q = state.q;

  if (state.exact) p.exact = "1";

  if (state.safe) p.safe = "1";
  const sp = new URLSearchParams(p);
  state.tags.forEach((t) => sp.append("tag", t));

  return sp;
}

const itemFirstPageCache = createFirstPageCache();

const itemFirstPagePrefetch = createFirstPagePrefetcher({
  cache: itemFirstPageCache,
  fetchJSON: (url, opts) => api.getJSON(url, opts),
});

const TOP_PREFETCH_SORTS = ["smart:desc", "first_seen_utc:desc", "created_utc:desc"];

function topSourceIds() {
  return facets.sources.map((s) => s && s.id).filter(Boolean);
}

function warmItemFirstPages() {
  const warmParams = buildFirstPageWarmParams(
    {
      status: state.status,
      source: state.source,
      category: state.category,
      tags: state.tags,
      q: state.q,
      exact: state.exact,
      safe: state.safe,
      focus: state.focus,
      sort: state.sort,
    },
    topSourceIds(),
    TOP_PREFETCH_SORTS,
    PREFETCH_LIMITS,
  );

  if (!warmParams.length) {
    itemFirstPagePrefetch.abort();

    return;
  }

  itemFirstPagePrefetch.warm(warmParams);
}

export function clearItemFirstPageCache() {
  itemFirstPagePrefetch.clear();
}

let loadGen = 0;

export async function loadItems(reset) {
  // an append during a load is a duplicate; a RESET supersedes whatever is in
  // flight (generation check below — otherwise clearing a slow search drops the
  // user's newest intent on the floor)
  if (!reset && state.loading) return;
  const gen = ++loadGen;
  state.loading = true;

  if (reset) itemFirstPagePrefetch.abort();

  if (reset) {
    state.offset = 0;
    state.items = [];
    state.batchCleared = 0;
    state.stamped = false;
    saveView(); // persist the active view so a reload/return keeps your place

    // keep the current rows on screen (dimmed) during a refetch — only blank to the skeleton on a
    // cold start, so changing filter/sort/status/source no longer flashes the whole list away
    if (itemsEl.querySelector("[data-fullname]")) itemsEl.classList.add("loading");
    else itemsEl.innerHTML = '<div class="skeleton">FETCHING…</div>';
  }

  try {
    const limit = state.focus ? FOCUS_BATCH : 50;
    const offset = state.offset;
    const query = params({ limit, offset });
    let r = itemFirstPageCache.get(query);
    const fromCache = !!r;

    if (!r) {
      r = await api.getJSON("/items?" + query);
    }

    if (gen !== loadGen) return; // a newer load superseded this one

    if (!fromCache) itemFirstPageCache.set(query, r);
    state.items = state.items.concat(r.items);
    state.hasMore = state.focus ? false : r.has_more;
    state.offset += r.items.length;

    if (reset && state.focus) state.batchTotal = r.items.length;
    render();

    if (reset) warmItemFirstPages();
  } catch {
    if (gen === loadGen) {
      itemsEl.classList.remove("loading");
      itemsEl.innerHTML = '<div class="skeleton">COULDN’T LOAD — IS THE SERVER UP?</div>';
    }
  }
}

export async function refreshPulse() {
  try {
    state.pulse = await api.getJSON("/pulse");
    paintPulse();
    _facetStaleReset();
  } catch (e) {
    /* ambient — but count toward the staleness signal so a persistent failure
       (which also freezes the "cleared today" pebbles) isn't silent. */
    _facetStaleBump(e);
  }
}

/* ---- Staleness signal (audit High 2026-07-02): repeated consecutive failures of
   the ambient rail/pulse fetches surface one subtle toast + a console log, so a
   dead server is distinguishable from "nothing to show". One signal per stall,
   not per failure; resets on the first success. ---- */
let _staleFailCount = 0;

let _staleSignaled = false;

const _STALE_FAIL_THRESHOLD = 3;

function _facetStaleBump(e) {
  _staleFailCount++;
  console.warn("refreshRail/refreshPulse failed (", _staleFailCount, "):", e);

  if (_staleFailCount >= _STALE_FAIL_THRESHOLD && !_staleSignaled) {
    _staleSignaled = true;

    try {
      toast("Couldn’t reach the server — showing cached state.");
    } catch {
      /* toast opt */
    }
  }
}

function _facetStaleReset() {
  _staleFailCount = 0;
  _staleSignaled = false;
}

export async function loadCounts() {
  // Keep + Done get counts (processed piles read as wins); Inbox/Archived/All never do.
  try {
    const s = await api.fetchStats({ light: 1 });
    const by = s.by_status || {};
    $$("[data-count]").forEach((el) => {
      const v =
        by[el.dataset.count] && by[el.dataset.count].toLocaleString
          ? by[el.dataset.count].toLocaleString()
          : by[el.dataset.count] || "";

      el.textContent = v || "";
    });
  } catch {
    /* counts are decoration */
  }
}

function railBtn(label, value, count, kind, color) {
  const on =
    kind === "source"
      ? state.source === value
      : kind === "subreddit"
        ? state.subreddit === value
        : state.tags.includes(value);

  return (
    '<button type="button" class="rnav' +
    (kind === "subreddit" ? " rnav-sub" : "") +
    '" data-' +
    kind +
    '="' +
    esc(value) +
    '"' +
    (color ? ' style="--src:' + color + '"' : "") +
    ' aria-pressed="' +
    on +
    '">' +
    '<span class="dot"></span>' +
    esc(label) +
    (count ? '<span class="n">' + count + "</span>" : "") +
    "</button>"
  );
}

/* The tag rail, grouped under parent headers (Epic 26 P2). Each present group renders a
   header (data-tagparent = its present child ids) that OR-selects/clears all its children in
   one click, then the indented child rows (the same per-tag toggles as before). Tags not in
   any served group (drift / a user tag that ever reaches the curated facet set) fall into a
   trailing "More" group so nothing silently vanishes. */
function railTagsHtml() {
  const present = new Map(facets.tags.map((t) => [t.id, t]));
  const grouped = new Set();
  let html = "";

  for (const g of facets.groups) {
    const kids = (g.tags || []).map((id) => present.get(id)).filter(Boolean);

    if (!kids.length) continue; // whole group filtered out (e.g. NSFW hidden)
    kids.forEach((k) => grouped.add(k.id));
    const sel = kids.filter((k) => state.tags.includes(k.id)).length;
    const selState = sel === 0 ? "none" : sel === kids.length ? "all" : "some";
    const total = kids.reduce((n, k) => n + (k.count || 0), 0);
    html +=
      '<div class="rail-group">' +
      '<button type="button" class="rnav rail-ghead" data-tagparent="' +
      esc(kids.map((k) => k.id).join(",")) +
      '" data-sel="' +
      selState +
      '" aria-pressed="' +
      (selState === "all") +
      '">' +
      '<span class="dot"></span>' +
      esc(g.label) +
      '<span class="n">' +
      total +
      "</span></button>" +
      kids.map((k) => railBtn(k.label, k.id, k.count, "tag")).join("") +
      "</div>";
  }

  const orphans = facets.tags.filter((t) => !grouped.has(t.id));

  if (orphans.length) {
    html +=
      '<div class="rail-group"><div class="rail-ghead static">More</div>' +
      orphans.map((t) => railBtn(t.label, t.id, t.count, "tag")).join("") +
      "</div>";
  }

  return html;
}

export async function refreshRail() {
  try {
    // Tag/category facets cross-filter by BOTH the active status AND source (Epic 26 P2:
    // source-aware rail) — picking a source narrows the rail to that source's tags, volume-
    // ordered within each group. The source list itself stays status-only so you can still
    // switch source.
    const fp = {};

    if (state.status) fp.status = state.status;

    if (state.source) fp.source = state.source;
    const qs = new URLSearchParams(fp).toString();

    const [src, cats, tags] = await Promise.all([
      api.fetchSources(state.status || undefined),
      api.getJSON("/categories?" + qs),
      api.getJSON("/tags?" + qs),
    ]);

    _facetStaleReset();
    // one fetch fills BOTH the desktop rail and the mobile drawer (shared facet data)
    facets.sources = src.sources || [];
    facets.categories = cats.categories || [];
    facets.tags = Object.entries(tags.tags || {})
      .map(([id, count]) => ({ id, label: id, count }))
      // hide the NSFW tag facets from the rail/drawer/autocomplete while "Hide NSFW" is on (Epic 14)
      .filter((t) => !(state.safe && /^nsfw/i.test(t.id)));
    facets.groups = tags.groups || [];
    state.curated = new Set(facets.tags.map((t) => t.id));
    $("#rail-sources").innerHTML = facets.sources
      .map((s) => railBtn(s.label, s.id, s.count, "source", s.badge_color))
      .join("");

    /* P3.3: second-tier subreddit facet — only when source=reddit is the
       active filter. Fetches from /reddit/subreddits (status-scoped). */
    if (state.source === "reddit") {
      try {
        const srQs = new URLSearchParams();

        if (state.status) srQs.set("status", state.status);
        const sr = await api.getJSON("/reddit/subreddits?" + srQs.toString());
        const subs = (sr.subreddits || []).slice(0, 25);

        const subHtml = subs.length
          ? '<div class="rail-sub-head">SUBREDDITS</div>' +
            subs.map((s) => railBtn("r/" + s.subreddit, s.subreddit, s.count, "subreddit")).join("")
          : "";

        const slot = document.createElement("div");
        slot.id = "rail-subreddits";
        slot.className = "rail-sub";
        slot.innerHTML = subHtml;
        $("#rail-sources").appendChild(slot);
      } catch {
        /* subreddit facet is sugar — never block the rail on it */
      }
    }

    $("#rail-tags").innerHTML = railTagsHtml();
    renderDrawer();

    if (!state.loading) warmItemFirstPages();
  } catch (e) {
    /* rail is navigation sugar — keep quiet on a one-off failure, but surface a
       subtle staleness signal after repeated consecutive failures so a dead
       server isn't indistinguishable from an empty inbox. Audit High 2026-07-02. */
    _facetStaleBump(e);
  }
}
