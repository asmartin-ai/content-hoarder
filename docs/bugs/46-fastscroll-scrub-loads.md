# Fastscroll scrub → cascade of `/items` page loads

**Status: NOTED 2026-07-14 — not fixing in #46.** Follow-up to #46 / mobile fast-scroll.

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

## Desired direction (icebox / next slice)

Batch / lazy-load policy for **scrub / jump**, not a full redesign of infinite scroll:

1. **While fastscroll is dragging** (or for a short settle window after scrub): do not call `loadItems` from the sentinel observer (or pause the observer). Resume after `pointerup` + idle.
2. Optional: **coalesce** append loads — if scrub lands deep, one request for a larger window / target offset rather than walking 50-row pages through intermediate offsets (bigger product decision; needs API support or client “fill until offset”).
3. Optional: reduce `rootMargin` during non-idle scroll, or require sentinel **stable** for N ms before fetch.
4. Do **not** gate normal finger-scroll near the bottom the same way — keep progressive load for reading through the list.

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
