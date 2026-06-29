## Epic 5 — Inbox redesign follow-ups  (`enhancement`, `area:ui`)
*Shipped: bigger cards + list swipe + undo snackbar; **sources as top tabs**; **status as a left
sidebar** (with counts) + mobile hamburger drawer; **Gmail-style swipe-reveal icons** (trash/keep);
import modal; Keep/Archive/Done legend. Remaining patterns (ref
[team-inbox/inbox-reborn](https://github.com/team-inbox/inbox-reborn)):*

- [x] ~~**Sources as top tabs.**~~ Shipped (`#source-tabs`).
- [x] ~~**Status as a left sidebar.**~~ Shipped (`#status-nav` + mobile drawer).
- [x] ~~**Triage card parity.**~~ Shipped: Tinder-style swipe stamps + an inline Reddit click-to-load
  embed on the triage card.
- [ ] **P3 — Smooth drag-and-drop to buckets.** Drag cards onto category/status buckets.
  [SortableJS](https://github.com/SortableJS/Sortable) (~20 KB, touch-capable) or
  [html5sortable](https://github.com/lukasoppermann/html5sortable) (~4 KB).
- [x] ~~**P3 — Consolidate triage swipe onto `swipe.js`.**~~ ✅ Shipped 2026-06-29: `triage.js`
  now uses shared `core/swipe.js` for horizontal + vertical card gestures. The helper grew left-long
  `commit2` support, optional `onUp`/`onDown` callbacks, and `haptics:false` so triage keeps
  action-level haptics. Node-backed regressions cover left-long snooze without right-long Keep,
  opt-in vertical callbacks, and haptics opt-out. Spec: [`docs/specs/triage-swipe-consolidation.md`](docs/specs/triage-swipe-consolidation.md).
- [x] ~~**Cross-filtered counts.**~~ Shipped: `/stats?source=` + `/sources?status=` cross-filter the
  sidebar status counts and the source-tab counts (the tab list stays stable at 0).

- [x] ~~**Card-view text clipping.**~~ Fixed in the v2 row pass: card is now card-head + adaptive
  hero + a bottom tag/action row (no fixed crop, no title overlap).
- [x] ~~**P2 — Categories in the sidebar / as a tag type.**~~ ✅ SHIPPED / FOLDED:
  processing categories are mirrored into the curated tag vocabulary (`PROCESSING_TAGS`), `/categories`
  cross-filters by source/status, and the browse rail/drawer exposes categories alongside source/tag rows.
  The larger structural model question remains tracked under Epic 26's overall taxonomy reorg.
- [x] ~~**P3 — Zoom into the image / gallery modal.**~~ ✅ SUPERSEDED + SHIPPED via Epic 16
  mobile-lightbox work (2026-06-27): pinch/mouse-wheel zoom (C2) plus zoomed pan and 1× swipe-far-to-close
  (C3) now live in `core/media.js createLightbox`. This v2-era item is closed here so it is not delegated
  twice; the old `app.js` references are stale post-v3.
- [ ] **P2 — Rework the keyboard controls.** *(User-requested 2026-06-08.)* The current map (browse
  J/K · S/E/Y · X; triage S/E/Y) needs a redesigned, more ergonomic one-hand scheme — propose a new
  mapping for review. (The `?` cheatsheet already ships.)
   - Proposed Gmail-aligned keymap ready for review (see archived delegation notes): j/k movement, f keep, e archive, d done, b snooze, x select, t tag, o/Enter open, / search, ? help, z undo. Awaiting user approval before implementation.
- [x] ~~**P2 — Share button on items.**~~ ✅ SHIPPED 2026-06-22 (browser-verified): Web-Share with clipboard fallback, sharing the **source permalink** — `shareItem()` in `core/render.js` (navigator.share on mobile; clipboard + "Link copied" toast on desktop; reuses `itemUrl()` per source). On the row/card action cluster (`browse/render.js` actsHtml, `data-share`; hidden on touch ROWS where swipe owns the acts, shown on cards) + the reader header (`#reader-share`). Tabler share icon, SW v63. *(User-requested 2026-06-17.)* Orig scope: Add a Share affordance to the item
  (row/card + reader). **Open scope:** native Web Share API (`navigator.share` — works on the mobile PWA,
  falls back to clipboard on desktop) vs. a plain "copy permalink" button; and decide *what* is shared — the
  source permalink (reddit/HN/youtube/firefox URL) vs. a deep-link back into content-hoarder. Lean
  Web-Share-with-clipboard-fallback so it works on the Pixel-6 target.
- [x] ~~**P2 — Defer/Skip as a first-class triage action.**~~ ✅ **Snooze backend SHIPPED 2026-06-26:** `db.snooze`
  (`metadata.snoozed_until` monotonic wave), `is:snoozed` operator, escalation after N snoozes → decay.
  **Frontend SHIPPED 2026-06-26:** snooze button on triage card + browse row, `POST /items/<fn>/snooze` +
  `POST /items/<fn>/unsnooze` routes, triage-batch exclusion. **Skip SHIPPED** (triage-skip: a no-decision "pass,
  show me the next" via button + Space, on main). Honors the project guardrails: friction-asymmetry, no guilt
  mechanics, escalation flows into the Epic 21 decay path. Relates to Epic 10 (a skipped/deferred item is a weak
  training signal — decide whether it counts).
