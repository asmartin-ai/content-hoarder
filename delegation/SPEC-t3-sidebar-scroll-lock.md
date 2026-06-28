# SPEC — T3 sidebar scroll-lock (lock body, not just #items)

**Task ID:** `t3-sidebar-scroll-lock`
**Worktree branch:** `delegate/t3-sidebar-scroll-lock`
**Branch off:** `staging/mobile-polish-t2` (NOT `main`)
**SW cache version on success:** `ch-shell-v91` (bump from `v90` after `t3-lightbox-swipe-scroll`
merges, or the next free version — coordinate with orchestrator)
**Source:** T2 regression — `MOBILE-POLISH-T3-BATCH.md` item #6

## Goal

The T2 E1 sidebar scroll-lock (`lockBrowseScroll()`/`unlockBrowseScroll()` in
`browse/main.js`) sets `itemsEl.style.overflow = "hidden"` when a panel/drawer opens. **But
scrolling with the sidebar open still scrolls the browse view.** The lock is incomplete: it
locks `#items`, but the **body** (or the `.console` header, or some other scroll container) is
still scrollable, and a touch scroll on the sidebar's scrim area chains to the body.

## Root cause (confirmed by reading the code)

In `src/content_hoarder/static/browse/main.js`:

- `lockBrowseScroll()` (line 1483) sets `itemsEl.style.overflow = "hidden"` and saves
  `itemsEl.scrollTop`.
- `unlockBrowseScroll()` (line 1488) restores it.

The bug: `#items` may not be the only scroll container. On mobile, the **body** can also scroll
(if the layout's height exceeds the viewport), and touch-scroll chaining via the scrim can move
it. Setting `overflow: hidden` on `#items` doesn't prevent body scroll.

Additionally, the `.navdrawer` CSS (`browse.css` line ~2680) has no `overscroll-behavior`
rule, so a scroll that reaches the end of the sidebar's content chains to the underlying page.

## Files in scope

- `src/content_hoarder/static/browse/main.js` — `lockBrowseScroll()`/`unlockBrowseScroll()`
  (lines 1483–1496). Also lock the body (and restore it).
- `src/content_hoarder/static/browse/browse.css` — add `overscroll-behavior: contain` to
  `.navdrawer` (and any other panel that scrolls internally: `#statsheet`, `#dupesheet`,
  `#settings`, `#kbd` if they scroll). This prevents scroll chaining at the panel's edges.
- `src/content_hoarder/static/sw.js` — bump `CACHE` to `ch-shell-v91` (or next free).
- `src/content_hoarder/static/browse/main.js` — bump `APP_VERSION`.

**Do NOT touch:** `core/overlaynav.js`, `browse/reader.js`, any Python.

## Design constraints (locked)

- **The lock is ref-counted.** `lockBrowseScroll()` increments `_browseLock`;
  `unlockBrowseScroll()` decrements it; the body lock follows the same counter. Don't break the
  nesting (e.g., open stats sheet from inside the navdrawer — both call `lockBrowseScroll`).
- **Restore the saved scroll position on unlock.** Both `itemsEl.scrollTop` AND
  `window.scrollY` (or `document.documentElement.scrollTop`) must be restored. The body lock
  must save the body's scroll position before setting `overflow: hidden`, because toggling
  overflow can reset it.
- **`overscroll-behavior: contain` on the panels, NOT on `#items`.** `#items` is the feed; its
  overscroll should chain to the body normally (so the user can fling through the feed). The
  panels (navdrawer, stats, dupes, settings) are the ones that should NOT chain — when the
  user reaches the bottom of the sidebar's content, the scroll should NOT pass through to the
  feed behind it.
- **Don't lock the body permanently.** Every `lockBrowseScroll` call MUST be matched by an
  `unlockBrowseScroll` call. Verify the existing call sites (openPanel, openDrawer) pair
  correctly with closeSheets. The ref-counting already handles this; just make sure the body
  lock follows the same discipline.
- **Don't break the lightbox scroll-lock (C1).** The lightbox's `lockEl` option (separate from
  `lockBrowseScroll`) locks `#items` directly. Don't conflate the two — the lightbox doesn't
  need a body lock because the lightbox modal covers the body entirely.
- **Touch-action on the scrim.** The `#scrim` element catches outside-panel taps to close. It
  should NOT allow touch-scrolling — set `touch-action: none` on it so a drag on the scrim
  doesn't scroll anything. (Verify the current CSS; add the rule if missing.)

## Implementation sketch

```js
// main.js — replace lockBrowseScroll / unlockBrowseScroll (lines 1483-1496):
const scrim = $("#scrim");
let _browseLock = 0;
let _browseLockSaved = 0;       // #items scroll
let _browseBodyLockSaved = 0;   // body scroll

function lockBrowseScroll() {
  if (_browseLock === 0) {
    _browseLockSaved = itemsEl.scrollTop;
    _browseBodyLockSaved = window.scrollY || document.documentElement.scrollTop;
    document.body.style.overflow = "hidden";   // ← lock the body too
  }
  _browseLock++;
  itemsEl.style.overflow = "hidden";
}

function unlockBrowseScroll() {
  if (_browseLock <= 0) return;
  _browseLock = Math.max(0, _browseLock - 1);
  if (_browseLock === 0) {
    itemsEl.style.overflow = "";
    document.body.style.overflow = "";          // ← restore the body
    if (_browseLockSaved) itemsEl.scrollTop = _browseLockSaved;
    if (_browseBodyLockSaved) {
      window.scrollTo(0, _browseBodyLockSaved); // ← restore body scroll position
    }
    _browseLockSaved = 0;
    _browseBodyLockSaved = 0;
  }
}
```

```css
/* browse.css — add overscroll-behavior to the panels that scroll internally.
   This prevents scroll chaining: when the user reaches the edge of the panel's
   content, the scroll does NOT pass through to the underlying page. */
.navdrawer,
#statsheet,
#dupesheet,
#settings,
#kbd {
    overscroll-behavior: contain;
}

/* If the scrim doesn't already have touch-action: none, add it so a drag on the
   scrim doesn't scroll the underlying feed. (Verify the current rule first —
   don't duplicate it.) */
#scrim {
    touch-action: none;
}
```

## Acceptance

1. **Open the navdrawer. Scroll the feed (touch-drag on the visible feed area to the right of
   the drawer) → the feed does NOT scroll.** (This is the regression fix.)
2. **Open the navdrawer. Scroll WITHIN the drawer → the drawer scrolls, not the feed.** Existing
   behavior — verify.
3. **Scroll to the bottom of the drawer's content → the scroll does NOT chain to the feed.**
   (The `overscroll-behavior: contain` fix.)
4. **Close the drawer → the feed's scroll position is restored** to where it was before opening.
   (Existing behavior — verify the body scroll restore too.)
5. **Open the stats sheet, then open the dupes sheet from inside it (if the UI allows) → both
   locks stack, both unlocks restore correctly.** (Ref-counting test.)
6. **Open the lightbox (C1's `lockEl`) → the feed locks AND the body locks (via the lightbox's
   own `lockEl` path, which sets `overflow: hidden` on `#items` but NOT the body — that's fine,
   the lightbox modal covers the body). Verify the lightbox still works.** Don't break C1.
7. **Open a panel, then OS-back to close it → the lock releases cleanly** (no stuck
   `overflow: hidden` on the body). Verify via the existing `closeSheets` path.
8. **Desktop (mouse wheel) — open the navdrawer, wheel-scroll over the feed area → the feed
   doesn't scroll.** (The body lock should catch this too.)
9. **No layout shift** when the body lock toggles. Setting `overflow: hidden` on the body can
   hide the scrollbar and shift the layout ~15px on desktop. If this is visible, add
   `padding-right: <scrollbar-width>` compensation, OR use `overflow: hidden` on
   `document.documentElement` instead (which has the same effect but is sometimes less janky).
   The agent should pick whichever is cleaner and document the choice.

## Validation block

```
# 1. Unit suite — same 5 known env failures, NO new failures.
git stash
.venv/Scripts/python.exe -m pytest -q -m "not ui" --tb=no 2>&1 | tail -3
git stash pop

# 2. SW cache bumped:
grep 'const CACHE' src/content_hoarder/static/sw.js   # → "ch-shell-v91" (or next free)

# 3. APP_VERSION bumped:
grep 'APP_VERSION' src/content_hoarder/static/browse/main.js | head -1

# 4. Confirm the body lock is in place:
grep -c 'document.body.style.overflow' src/content_hoarder/static/browse/main.js   # → 2 (lock + unlock)

# 5. Confirm overscroll-behavior on the panels:
grep -c 'overscroll-behavior' src/content_hoarder/static/browse/browse.css   # → ≥1

# 6. UI smoke (manual serve + Pixel-6):
#    a. Scroll the feed down 300px. Open the navdrawer.
#    b. Touch-drag on the feed area (right of the drawer) → feed does NOT scroll.
#    c. Scroll within the drawer → drawer scrolls.
#    d. Scroll to the bottom of the drawer → no chain to the feed.
#    e. Close the drawer → feed scroll position restored to ~300px.
#    f. Open the stats sheet, close it → body overflow restored, no stuck lock.
#    g. Open the lightbox → still works (C1 not broken).
#    h. Desktop: open navdrawer, wheel-scroll over the feed → no scroll.
```

## Report back

- Branch: `delegate/t3-sidebar-scroll-lock`
- Files changed:
- Unit suite result:
- UI smoke result (each of items a–h):
- Did you use `document.body` or `document.documentElement` for the body lock? Why?:
- Did you need scrollbar-width compensation on desktop?:
- Anything punted to T1:
