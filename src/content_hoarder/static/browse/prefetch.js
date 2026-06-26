/* Bounded /items first-page cache + warmer for the browse feed.
   Scope is intentionally narrow: blank query, offset-0 slices only. */

export const PREFETCH_LIMITS = Object.freeze({
  SOURCES: 4,        // includes the all-sources slice when no source filter is active
  SORTS: 3,
  SLICE_SIZE: 50,
  CONCURRENCY: 2,
  TTL_MS: 45000,
  MAX_ENTRIES: 24,
});

const clampPositive = (v, fallback) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

function withLimits(limits) {
  return { ...PREFETCH_LIMITS, ...(limits || {}) };
}

export function normalizedItemsKey(params) {
  const sp = params instanceof URLSearchParams ? params : new URLSearchParams(params || "");
  const entries = [...sp.entries()]
    .filter(([k, v]) => v !== undefined && v !== null && String(v) !== "")
    .sort((a, b) => a[0] === b[0] ? String(a[1]).localeCompare(String(b[1])) : a[0].localeCompare(b[0]));
  return entries.map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v)).join("&");
}

export function isFirstPageCacheable(params, limits = PREFETCH_LIMITS) {
  const lim = withLimits(limits);
  const sp = params instanceof URLSearchParams ? params : new URLSearchParams(params || "");
  if ((sp.get("q") || "").trim()) return false;
  if (sp.get("exact") === "1") return false;
  if (clampPositive(sp.get("offset") || "0", 0) !== 0) return false;
  const n = clampPositive(sp.get("limit") || lim.SLICE_SIZE, lim.SLICE_SIZE);
  return n <= lim.SLICE_SIZE;
}

export function createFirstPageCache(options = {}) {
  const limits = withLimits(options.limits);
  const now = options.now || (() => Date.now());
  const entries = new Map();
  const inflight = new Map();

  function prune() {
    const t = now();
    for (const [key, entry] of entries) {
      if (entry.expires <= t) entries.delete(key);
    }
    while (entries.size > limits.MAX_ENTRIES) {
      entries.delete(entries.keys().next().value);
    }
  }

  function get(params) {
    if (!isFirstPageCacheable(params, limits)) return null;
    prune();
    const key = normalizedItemsKey(params);
    const entry = entries.get(key);
    if (!entry) return null;
    entries.delete(key);
    entries.set(key, entry);
    return entry.value;
  }

  function set(params, value) {
    if (!isFirstPageCacheable(params, limits)) return;
    const key = normalizedItemsKey(params);
    entries.delete(key);
    entries.set(key, { value, expires: now() + limits.TTL_MS });
    prune();
  }

  async function fetch(params, fetchJSON, opts = {}) {
    const key = normalizedItemsKey(params);
    const hit = get(params);
    if (hit) return hit;
    if (!isFirstPageCacheable(params, limits)) {
      return fetchJSON("/items?" + key, opts);
    }
    if (inflight.has(key)) return inflight.get(key);
    const p = fetchJSON("/items?" + key, opts).then((value) => {
      set(params, value);
      return value;
    }).finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  return {
    get,
    set,
    fetch,
    clear() { entries.clear(); inflight.clear(); },
    size() { prune(); return entries.size; },
    keys() { prune(); return [...entries.keys()]; },
  };
}

const uniq = (values) => {
  const seen = new Set();
  const out = [];
  for (const v of values) {
    const s = typeof v === "string" ? v : (v && (v.id || v.value || v.source)) || "";
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
};

export function buildFirstPageWarmParams(context = {}, sources = [], sorts = [], limits = PREFETCH_LIMITS) {
  const lim = withLimits(limits);
  if ((context.q || "").trim() || context.exact || context.focus) return [];

  const sourceChoices = context.source
    ? [context.source]
    : uniq(["", ...sources]).slice(0, lim.SOURCES);
  const sortChoices = uniq([context.sort || "first_seen_utc:desc", ...sorts]).slice(0, lim.SORTS);
  const tags = Array.isArray(context.tags) ? context.tags.filter(Boolean) : [];
  const out = [];

  for (const source of sourceChoices) {
    for (const sortValue of sortChoices) {
      const [sort, order] = String(sortValue || "first_seen_utc:desc").split(":");
      const sp = new URLSearchParams({
        sort: sort || "first_seen_utc",
        order: order || "desc",
        limit: String(lim.SLICE_SIZE),
        offset: "0",
      });
      if (context.status) sp.set("status", context.status);
      if (source) sp.set("source", source);
      if (context.category) sp.set("category", context.category);
      if (context.safe) sp.set("safe", "1");
      tags.forEach((t) => sp.append("tag", t));
      out.push(sp);
    }
  }
  return out;
}

export function createFirstPagePrefetcher(options = {}) {
  const limits = withLimits(options.limits);
  const cache = options.cache || createFirstPageCache({ limits });
  const fetchJSON = options.fetchJSON;
  let runId = 0;
  let controller = null;

  function abort() {
    runId += 1;
    if (controller) {
      try { controller.abort(); } catch (_e) {}
      controller = null;
    }
  }

  async function warm(paramList) {
    abort();
    if (!fetchJSON || !Array.isArray(paramList) || !paramList.length) return;
    const myRun = runId;
    controller = typeof AbortController === "undefined" ? null : new AbortController();
    const queue = paramList
      .filter((p) => isFirstPageCacheable(p, limits) && !cache.get(p))
      .slice(0, limits.MAX_ENTRIES);
    let cursor = 0;

    async function worker() {
      while (myRun === runId && cursor < queue.length) {
        const p = queue[cursor++];
        try {
          await cache.fetch(p, fetchJSON, controller ? { signal: controller.signal } : {});
        } catch (_e) {
          /* warming is opportunistic */
        }
      }
    }

    await Promise.all(Array.from(
      { length: Math.min(limits.CONCURRENCY, queue.length) },
      () => worker(),
    ));
  }

  return { warm, abort, clear() { abort(); cache.clear(); } };
}
