# Mobile UX polish batch — 2026-06-27 (closed)

All items from the 2026-06-26 real-usage session have been triaged.
This file is kept as a reconciliation record for the ~2h build sprint.

## Shipped (17 items)

| # | Item | Where |
|---|------|-------|
| A1 | Reader triage dock (semi-circle, pull-up tab) | `.rd-foot` in `index.html:617-695` + `browse.css:3989-4141` |
| A3 | Reddit thread thumbnail → reader | `main.js openMediaFor` predicate |
| B1 | Snooze on extended left swipe | `main.js:264` `onLeftLong: () => snooze(fn)` |
| B2 | Remove Snooze from long-press rowmenu | No `data-rowmenu="snooze"` in template |
| B3 | Relay-style long-press (pan + extended strip) | `openRowMenu` + `.relay-strip` template + CSS |
| C1 | Scroll-lock browse while lightbox open | `createLightbox lockScrollEl` + `lockBrowseScroll` |
| D1 | Tag suggestions: last 2 categories + 1 tag | `tagedit.js _recentCategories()` + `options()` |
| D2 | Tap suggestion → no keyboard | `tagedit.js:257` `add(tag, {focus:false})` |
| D3 | Close editor on Enter (mobile) | `tagedit.js:219-221` `isPhone() → close()` |
| D4 | Single-tag mobile flow | Same as D3 |
| E1 | Sidebar defocus + scroll-lock | `lockBrowseScroll`/`unlockBrowseScroll` |
| E3 | Surprise-me view (pinboard card, reader flow) | `main.js surprise()` |
| — | Swipe+relay mutual exclusion | `swipe.js relayCloseMode` |
| A2 | No feed refresh on reader triage | `main.js act()` `{fromReader:true}` option |
| B4 | Hold-to-preview media (press-and-hold lightbox) | `core/media.js createLightbox` `_attachPeekRelease` |
| C2 | Pinch-zoom + mouse-wheel zoom in lightbox | `core/media.js createLightbox` zoom state |
| C3 | Swipe-to-pan + swipe-far-to-close lightbox | `core/media.js` pointer-events pan + `close()` |

## Remaining (1 item, folded into BACKLOG.md Epic 16)

| # | Item | BACKLOG line |
|---|------|-------------|
| E2 | Scroll-deceleration physics | Epic 16 polish |

## Design decisions locked (review these on the next build pass)

- **A1:** Bottom tab pulls up into semi-circle dock: [Archive] [Snooze] top arc, [Keep] [Tag] [Done] bottom arc
  - **REVERSED 2026-06-27 (T3 batch):** the dock shipped but looked wrong on mobile. User scrapped it.
    `t3-drop-reader-dock` deletes the `.rd-foot` element + handlers + CSS. The reader relies on
    swipe + keyboard (F/A/D/T/S/Esc) until a redesigned dock ships in a later session.
- **B3:** Relay-style horizontal row (Source, Author, Tag, Share, Snooze) — icon over label, evenly spaced
  - Refinements requested 2026-06-27: larger buttons, no text on buttons (icons only per relay-observations), fix text overlap
  - **T3 regression (2026-06-27):** swipe-left revealed blank space after long-press; swipe-right
    didn't close the relay. Fixed in `t3-relay-swipe-close`.
- **B4:** Hold-to-preview (press-and-hold lightbox peek)
  - **T3 regression (2026-06-27):** the peek flickered (opened/closed repeatedly). Fixed in
    `t3-peek-flicker` (idempotency guard + swipe.js lpTimer skip on `[data-media]`).
- **C3:** Swipe-to-pan + swipe-far-to-close lightbox
  - **T3 regression (2026-06-27):** vertical swipe scrolled the page instead of closing. Fixed in
    `t3-lightbox-swipe-scroll` (`preventDefault` + `touch-action: none` during drag).
- **D1:** Tag suggestions: last 2 categories + 1 tag
  - **T3 regression (2026-06-27):** only 1 suggestion showed (categories were sparse). Fixed in
    `t3-tag-suggest-three` (backfill with tags to always reach 3).
- **E1:** Sidebar defocus + scroll-lock
  - **T3 regression (2026-06-27):** browse view still scrolled when the sidebar was open. Fixed in
    `t3-sidebar-scroll-lock` (lock body too + `overscroll-behavior: contain`).
- **E3:** Pinboard-sized card, treated as inbox item, opens reader/thread with same controls

## T3 follow-up batch (2026-06-27)

Real-device pass surfaced 8 regressions + 1 missing feature. Fix batch lives in
`MOBILE-POLISH-T3-BATCH.md` (7 T2-delegated tasks, branched off `staging/mobile-polish-t2`).
BACKLOG.md Epic 16 has the per-item entries under "T3 mobile-polish regression batch".
