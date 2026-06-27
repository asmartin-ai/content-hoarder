# Mobile UX polish batch — 2026-06-27 (closed)

All items from the 2026-06-26 real-usage session have been triaged.
This file is kept as a reconciliation record for the ~2h build sprint.

## Shipped (13 items)

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

## Remaining (5 items, folded into BACKLOG.md Epics 15-16)

| # | Item | BACKLOG line |
|---|------|-------------|
| A2 | Don't refresh feed on reader triage | Epic 15, after dock |
| B4 | Hold-to-preview media (press-and-hold lightbox) | Epic 16 mobile |
| C2 | Pinch-zoom + mouse-wheel zoom in lightbox | Epic 16 lightbox |
| C3 | Swipe-to-pan + swipe-far-to-close lightbox | Epic 16 lightbox |
| E2 | Scroll-deceleration physics | Epic 16 polish |

## Design decisions locked (review these on the next build pass)

- **A1:** Bottom tab pulls up into semi-circle dock: [Archive] [Snooze] top arc, [Keep] [Tag] [Done] bottom arc
- **B3:** Relay-style horizontal row (Source, Author, Tag, Share, Snooze) — icon over label, evenly spaced
  - Refinements requested 2026-06-27: larger buttons, no text on buttons (icons only per relay-observations), fix text overlap
- **E3:** Pinboard-sized card, treated as inbox item, opens reader/thread with same controls
