# Fastscroll scrub → cascade of `/items` page loads

**Status: FIXED 2026-07-15** on `feat/46-mobile-fastscroll` (`e43854f`).
Plan: `docs/specs/46-fastscroll-scrub-loads-plan.md`. Shell v121→v122.

## Symptom (device)

Scrubbing the Nova-style right-edge bar (or otherwise jumping far down the list)
fires a **burst of HTTP GET `/items?limit=50&offset=…`** as the list grows. Feels
like posts are loading too fast for a scrub gesture; network panel fills with
page fetches.

## Why (confirmed in code)

| Piece | Behavior |
|---|---|
| Infinite scroll | `IntersectionObserver` on `#sentinel` with `rootMargin: "600px"` (`browse/main.js`) calls `loadItems(false)` whenever the sentinel is near the viewport. |
| Page size | Browse non-Focus pages are **50** rows per `/items` (`limit = 50`). |
| Guard | Only `state.loading` + `state.hasMore` — no scrub/throttle/cooldown. |
| Fastscroll | Sets `document.scrollingElement.scrollTop` directly (often near the bottom of *currently loaded* content). That keeps the sentinel in the expand zone after each append → chain: scrub → near end → load page N → render taller → sentinel still near → load N+1 … until lag or top of remaining range. |
| Prefetch | First-page cache (`prefetch.js`) does **not** cover offset>0 slices, so every append is a real network GET. |

So the flood is not “fastscroll doing N requests itself” — it is **document scrub + eager infinite scroll** cooperating. Same risk exists for any jump-to-end gesture (e.g. long fling) once enough rows are loaded; scrub makes it obvious.

## Fix (option 1 from plan — shipped)

1. `fastscroll.js` owns `isFastScrollScrubbing()` — true from `pointerdown` until
   `SETTLE_MS` (250 ms) after drag end; dispatches `fastscroll:settle` on clear.
2. Sentinel `IntersectionObserver` in `main.js` skips `loadItems` while scrubbing.
3. On `fastscroll:settle`, if the sentinel is still in the 600 px zone and
   `hasMore && !focus && !loading`, call `loadItems(false)` **once** (observer
   only fires on intersection *changes*, so a mid-drag suppress needs a re-check).
4. Normal finger scroll untouched (flag is only set by bar pointer events).

Still icebox / non-goals: coalesced offset loads (option 2), rootMargin tuning
(option 3), visual jitter polish (Fable 5).

## Out of scope here

- Fastscroll visual jitter (user deferred polish to **Fable 5**).
- Changing default page size for normal scroll.
- Desktop (bar is a no-op).

## Verification when implemented

- Playwright: drag handle to ~80% of track on a long list; assert `/items` request count during drag is 0 (or ≤1), and only after release does at most one batch load fire if needed.
- Device: scrub end-to-end with DevTools network open — no multi-GET cascade mid-drag.

## Related

- Spec: `docs/specs/mobile-scrollbar.md`
- Bug ship note: `docs/bugs/46-mobile-scrollbar.md`
- Code: `static/browse/fastscroll.js`, infinite scroll + `loadItems` in `static/browse/main.js`
