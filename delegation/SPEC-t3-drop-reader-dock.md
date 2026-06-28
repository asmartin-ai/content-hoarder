# SPEC — T3 drop the reader triage dock

**Task ID:** `t3-drop-reader-dock`
**Worktree branch:** `delegate/t3-drop-reader-dock`
**Branch off:** `staging/mobile-polish-t2` (NOT `main`)
**SW cache version on success:** `ch-shell-v92` (bump from `v91` after `t3-sidebar-scroll-lock`
merges, or the next free version — coordinate with orchestrator)
**Source:** User decision 2026-06-27 — `MOBILE-POLISH-T3-BATCH.md` item #7

## Goal

The reader's bottom triage dock (`.rd-foot` with the "Actions" pill that fans into a
semi-circle of Archive/Snooze/Keep/Tag/Done buttons) **looks wrong** on mobile. The user wants
to **scrap it entirely** for now and will design a replacement in a later session. The reader
must still be fully usable via swipe + keyboard shortcuts (which already exist).

This is a **deletion task**, not a redesign. Don't sneak in a replacement.

## What gets removed

- The entire `.rd-foot` element in `templates/index.html` (lines 617–696): the dock tab, the
  `.rd-dock` toolbar with its 5 `.rd-act` buttons, and the `.rd-dock-scrim` backdrop.
- The reader.js handlers that reference `.rd-foot` / `.rd-dock` / `data-dock` /
  `data-dock-toggle` / `dockToggle` / `closeDock` / `isDockOpen` (around lines 1332–1337,
  1406–1415, 1445–1452, 1614–1686).
- The CSS rules in `browse.css` for `.rd-foot`, `.rd-dock`, `.rd-dock-tab`, `.rd-dock-chev`,
  `.rd-act`, `.rd-dock-scrim`, `[data-dock]`, `[data-slot]` (around lines 4017–4141 and
  wherever else they appear — grep for `rd-foot|rd-dock|rd-act`).
- The keyboard shortcut handling that opens the dock: the `t` key in the reader (line ~1445)
  currently sets `data-dock="open"` before calling `openReaderTagAdd()`. After deletion, `t`
  should just open the tag editor directly (no dock).
- The Esc-key handling that closes the dock first (line ~1406): after deletion, Esc just closes
  the reader directly.

## What stays

- **The reader itself** — the header, scroll area, post, comments. Untouched.
- **Swipe-right to return to feed** (reader.js line ~1688). Untouched.
- **Keyboard shortcuts** — F (keep), A (archive), D (done), T (tag), S (snooze), E (open), etc.
  These already work without the dock (they call `onTriage`/`onSnooze`/`openReaderTagAdd`
  directly). Verify they still work after the dock's removal.
- **The inline tag editor** in the reader (`openReaderTagAdd`, `tagEditorHtml`, the
  `.rd-tag*` CSS). The dock's Tag button was ONE way to open it; the `T` key is another. Don't
  remove the editor itself.
- **The reader's media lightbox** (`onMedia`/`onImage` callbacks). Untouched.

## Files in scope

- `src/content_hoarder/templates/index.html` — delete the `.rd-foot` block (lines 617–696).
- `src/content_hoarder/static/browse/reader.js` — delete the dock handlers (~lines 1332–1337,
  1406–1415, 1445–1452, 1614–1686). Adjust the `t` key and Esc handlers to not reference the
  dock.
- `src/content_hoarder/static/browse/browse.css` — delete the `.rd-foot` / `.rd-dock` / `.rd-act`
  rules. Grep for `rd-foot|rd-dock|rd-act|rd-dock-tab|rd-dock-chev|rd-dock-scrim` and remove
  every rule that's ONLY about the dock. (Don't remove rules that incidentally mention these
  strings in a comment but govern other elements — check each.)
- `src/content_hoarder/static/sw.js` — bump `CACHE` to `ch-shell-v92` (or next free).
- `src/content_hoarder/static/browse/main.js` — bump `APP_VERSION`.

**Do NOT touch:** `core/media.js`, `browse/tagedit.js`, `core/swipe.js`, any Python.

## Design constraints (locked)

- **Deletion only.** No new UI elements. No "replacement placeholder." The reader's bottom edge
  is just the bottom of the `.rd-scroll` area after this task.
- **Don't break the safe-area inset.** The `.rd-foot` had `padding-bottom: env(safe-area-inset-*)`
  to clear the Pixel-6 gesture bar. After deletion, verify the reader's content doesn't tuck
  under the gesture bar. If it does, add `padding-bottom: env(safe-area-inset-bottom)` to
  `.rd-scroll` or the reader's post element. (The agent should verify on the Pixel-6 viewport
  in the UI smoke.)
- **The `t` key still opens the tag editor.** Without the dock, `t` calls
  `openReaderTagAdd()` directly. No `data-dock="open"` first.
- **Esc still closes the reader.** Without the dock's "first Esc collapses the dock" behavior,
  Esc just closes the reader. One press, one action.
- **The reader's `data-dock="closed"` reset on open** (line 1332) goes away — there's no dock
  to reset.
- **Keep the `.rd-foot` class name in any selector that's shared with other elements.** Grep
  carefully — if `.rd-foot` appears in a compound selector with non-dock elements, don't delete
  the whole rule; just remove the `.rd-foot` part. (Unlikely, but verify.)
- **The dock's touch swipe-down-to-collapse handler** (lines 1656–1685) goes away entirely.
- **Don't touch the `chIcon("archive"/"keep"/"done")` hydration** that the dock used (line 1626).
  It was only for the dock's buttons; with the dock gone, the hydration call goes too. Verify
  no other element depends on those icons being hydrated.

## Implementation sketch

```html
<!-- index.html — delete the entire .rd-foot block (lines 617-696).
     The </div> for .rd-scroll (line 616) stays; the </section> for #reader (line 697) stays. -->
```

```js
// reader.js — delete these blocks:
// - Line 1332-1337 (the footEl0 data-dock reset on openReader)
// - Line 1406-1415 (the Esc-key "first Esc closes dock" branch — simplify to just closeReader)
// - Line 1445-1452 (the t-key data-dock="open" + openReaderTagAdd — simplify to just
//   openReaderTagAdd)
// - Line 1614-1686 (the entire `const foot = reader.querySelector(".rd-foot"); if (foot) {…}`
//   block — dock toggle, click handler, touch swipe-down)

// After deletion, the t-key handler should be:
if (k === "t") {
  e.stopPropagation();
  e.preventDefault();
  openReaderTagAdd();
  return;
}

// And the Esc handler should be:
if (e.key === "Escape") {
  e.stopPropagation();
  e.preventDefault();
  closeReader(false);
  return;
}
```

```css
/* browse.css — delete every rule that targets ONLY the dock. Grep first:
   grep -n 'rd-foot\|rd-dock\|rd-act\|rd-dock-tab\|rd-dock-chev\|rd-dock-scrim' src/content_hoarder/static/browse/browse.css
   Then delete each rule that's solely about the dock. The block at ~L4017-4141 is the main one.
   Verify no shared selectors (e.g. `.rd-foot, .some-other-class { … }`) — if found, remove only
   the .rd-foot / .rd-dock part, keep the rest. */
```

## Acceptance

1. **The reader has no bottom dock.** Open any item in the reader → the bottom of the screen is
   the bottom of the post/comments, NOT an "Actions" pill. (This is the deletion.)
2. **The reader's content clears the Pixel-6 gesture bar.** Scroll to the bottom of a long
   comment thread → the last comment isn't tucked under the gesture bar. (Safe-area inset
   preserved.)
3. **Keyboard shortcuts still work.** With the reader open, press F → keep; A → archive; D →
   done; T → tag editor opens inline; S → snooze; E → open original; Esc → close reader.
4. **Swipe-right still closes the reader.** Existing behavior — verify.
5. **OS-back still closes the reader.** Existing behavior — verify.
6. **The inline tag editor still opens** (via `T` key) and works (add/remove tags).
7. **No console errors** referencing `.rd-foot` or `.rd-dock` (the deleted handlers are gone,
   no stale references).
8. **No leftover CSS rules** for `.rd-foot`/`.rd-dock`/`.rd-act` (grep returns nothing).
9. **The lightbox (open from the reader's media) still works.** Untouched, but verify.
10. **Desktop reader works too.** Open the reader at desktop viewport → no dock, keyboard
    shortcuts work, layout is clean.

## Validation block

```
# 1. Unit suite — same 5 known env failures, NO new failures.
git stash
.venv/Scripts/python.exe -m pytest -q -m "not ui" --tb=no 2>&1 | tail -3
git stash pop

# 2. SW cache bumped:
grep 'const CACHE' src/content_hoarder/static/sw.js   # → "ch-shell-v92" (or next free)

# 3. APP_VERSION bumped:
grep 'APP_VERSION' src/content_hoarder/static/browse/main.js | head -1

# 4. No leftover dock references in templates/JS:
grep -rn 'rd-foot\|rd-dock\|data-dock\|dockToggle\|closeDock\|isDockOpen' src/content_hoarder/templates/index.html src/content_hoarder/static/browse/reader.js
# → expect ZERO hits (the t-key and Esc handlers no longer reference the dock)

# 5. No leftover dock CSS:
grep -n 'rd-foot\|rd-dock\|rd-act\|rd-dock-tab\|rd-dock-chev\|rd-dock-scrim' src/content_hoarder/static/browse/browse.css
# → expect ZERO hits

# 6. UI smoke (manual serve + Pixel-6):
#    a. Open any item in the reader → no "Actions" pill at the bottom.
#    b. Scroll to the bottom of a long thread → last comment clears the gesture bar.
#    c. Press F → item is kept (reader closes, feed shows the keep state).
#    d. Reopen, press A → archived.
#    e. Reopen, press D → done.
#    f. Reopen, press T → inline tag editor opens.
#    g. Reopen, press Esc → reader closes.
#    h. Reopen, swipe right → reader closes.
#    i. Open DevTools console → perform a–h → no errors.
#    j. Desktop: open reader at ≥1100px → no dock, F/A/D/T/Esc all work.
```

## Report back

- Branch: `delegate/t3-drop-reader-dock`
- Files changed:
- Unit suite result:
- UI smoke result (each of items a–j):
- Did you need to add safe-area-inset padding to `.rd-scroll` or the post? If so, where?:
- Anything punted to T1:
