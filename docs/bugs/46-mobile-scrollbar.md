# #46 — Mobile-friendly scrollbar

**Status: IMPLEMENTED (Nova rework) on `feat/46-mobile-fastscroll`.**

Original pill spec: `docs/specs/mobile-scrollbar.md`. Device feedback → always-visible
track + proportional handle (Nova Launcher style). Spec file still describes the
pre-rework edge-zone pill; this note is the source of truth for what shipped.

## Shipped

| Piece | Location |
|---|---|
| Module | `src/content_hoarder/static/browse/fastscroll.js` |
| CSS | `.fastscroll-bar` / `.fastscroll-track` / `.fastscroll-handle` in `browse.css` |
| Wire | `installFastScroll(itemsEl)` in `browse/main.js` (`listEl` unused; bar on `body`) |
| Cache | SW shell + `APP_VERSION` **v122** on feature branch |
| Tests | `tests/ui/test_fastscroll.py` (visible, proportional+follow, drag scrub, handle-in-track, track-tap range, scrub pauses infinite scroll, desktop hidden) |

## Implementation note

- Browse scrolls the **document** (`document.scrollingElement`), not `#items` overflow.
- Right-edge **22px** fixed bar (track 4px, proportional handle); scrub + track-tap jump.
- Track vertical inset via `--fastscroll-track-top/bottom` on `.fastscroll-bar` (read from
  the bar in JS — not `:root`).
- Desktop (`hover:hover` + `pointer:fine`, and JS `maxTouchPoints` gate) is a no-op / CSS-hidden.

## Open follow-ups (device)

| Issue | Note |
|---|---|
| Visual jitter while dragging / scrolling | Deferred to **Fable 5** (user). |
| Scrub → cascade of `/items` GETs | **FIXED** (`e43854f`, shell v122). See `docs/bugs/46-fastscroll-scrub-loads.md`. |

## Staging

Also merged into `staging/test-stack-2026-07-12` for multi-feature device testing.
