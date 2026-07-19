# Plan: pause infinite scroll during fastscroll scrub (#46 follow-up)

**Goal:** kill the `/items?limit=50&offset=…` cascade while scrubbing the
fast-scroll bar (see `docs/bugs/46-fastscroll-scrub-loads.md`). Minimal slice —
option 1 from the bug doc (pause during drag + settle window), no API changes.

## Design

1. `fastscroll.js` owns a module-level scrub flag:
   - `export function isFastScrollScrubbing()` — true from `pointerdown`
     until `SETTLE_MS` (250 ms) after drag end.
   - On settle, dispatch `window` event `fastscroll:settle` so the loader can
     re-check.
2. `main.js` sentinel `IntersectionObserver` gains one extra guard:
   `!isFastScrollScrubbing()`.
3. `main.js` listens for `fastscroll:settle`: if the sentinel is within the
   same 600 px zone and `hasMore && !focus && !loading`, call
   `loadItems(false)` **once**. (Needed because the observer only fires on
   intersection *changes* — a load suppressed mid-drag would otherwise never
   resume.)
4. Normal finger scroll untouched (flag is only set by bar pointer events).

## Non-goals

- Coalesced/targeted offset loads (bug doc option 2) — needs API thought.
- rootMargin tuning during scroll (option 3).
- Fastscroll visual jitter polish (separate item).
- Desktop (bar is a no-op).

## Files

- `static/browse/fastscroll.js` — flag + settle event + teardown reset.
- `static/browse/main.js` — observer guard + settle listener; APP_VERSION
  v121→v122.
- `static/sw.js` — CACHE v121→v122.
- `tests/ui/test_fastscroll.py` — new regression test: drag handle deep on a
  long list; assert 0 `/items?offset>0` requests mid-drag, ≤1 after settle.

## Done-when

- New UI test green + existing 6 fastscroll UI tests green + unit suite green.
- Device check (user): scrub with network panel open — no mid-drag GET burst,
  at most one page load after release.
