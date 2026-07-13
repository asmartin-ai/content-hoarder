# #46 — Mobile-friendly scrollbar

**Status: IMPLEMENTED on `feat/46-mobile-fastscroll` (2026-07-12).**

Spec: `docs/specs/mobile-scrollbar.md` (`fastscroll.js`, right-edge scrub pill).

## Shipped

| Piece | Location |
|---|---|
| Module | `src/content_hoarder/static/browse/fastscroll.js` |
| CSS | `.fastscroll-handle` in `browse.css` |
| Wire | `installFastScroll(itemsEl)` in `browse/main.js` |
| Cache | SW shell + `APP_VERSION` v120 on feature branch; **v121** on staging stack |
| Tests | `tests/ui/test_fastscroll.py` (right-edge scrubs, left-edge no-op, fade) |

## Implementation note

Browse scrolls the **document** (`document.scrollingElement`), not `#items` overflow.
Hit-test still starts on `#items` within 24px of the right edge; scrub maps finger Y →
document `scrollTop`. Desktop (`hover:hover` + `pointer:fine`) is a no-op / CSS-hidden.

## Staging

Also merged into `staging/test-stack-2026-07-12` for multi-feature device testing.
