# SPEC — T3 relay + swipe interaction (regression fix)

**Task ID:** `t3-relay-swipe-close`
**Worktree branch:** `delegate/t3-relay-swipe-close`
**Branch off:** `staging/mobile-polish-t2` (NOT `main`)
**SW cache version on success:** `ch-shell-v87` (bump from `v86`)
**Source:** T2 regression — `MOBILE-POLISH-T3-BATCH.md` items #1 and #2

## Goal

Two related regressions in the relay-strip ↔ swipe interaction (T2 B3 + the swipe/relay mutual
exclusion shipped in `core/swipe.js`):

1. **Swipe-left reveals blank space after long-press.** After a long-press opens the relay strip
   (`.relay-open` on the row), a subsequent **leftward** swipe on the same row leaves a visible
   blank strip where the relay was, instead of being a no-op (the relay should stay open; only a
   **rightward** swipe closes it).
2. **Swipe-right from relay-open state does not close the relay.** A rightward swipe on a
   relay-open row should call `onRelayClose` (which calls `closeRelay()`). It does not fire
   reliably — the user has to try several times.

## Root cause (confirmed by reading the code)

In `src/content_hoarder/static/core/swipe.js`:

- **`pointerdown` (line 79)** sets `fg.style.transition = "none"` **unconditionally**, including
  when `relayCloseMode` is true. This inline style survives the swipe.
- **`pointermove` (line 119)** returns early when `relayCloseMode` is true — so no transform is
  applied during the drag. Good.
- **`end` (lines 153–159)** handles `relayCloseMode`: if `horizontal && dx > 40`, calls
  `onRelayClose`; **otherwise returns without calling `reset()`**. The inline
  `fg.style.transition = "none"` is left in place.
- Result: when `closeRelay()` later removes the `.relay-open` class (via scrim tap, Esc, or a
  successful right-swipe), the CSS transition that should slide `.item-fg` back from
  `translateX(-100%)` is **suppressed by the inline `transition: none`**. The item snaps
  abruptly; in some geometries the relay strip's `opacity: 0` state is briefly visible = the
  "blank space."

The right-swipe-doesn't-close half: `horizontal` is only set when `Math.abs(dx) > Math.abs(dy)`
**and** movement exceeded the 8px decide threshold (line 109). On a touch screen, a rightward
swipe that's even slightly diagonal can fail the `horizontal` test, and `relayCloseMode` then
swallows the gesture without closing. The threshold for "close the relay" should be **lower**
than the threshold for "commit a triage swipe" — any deliberate rightward motion should close it.

## Files in scope

- `src/content_hoarder/static/core/swipe.js` — the fix lives here. Touch the `pointerdown` guard
  and the `end()` `relayCloseMode` branch.
- `src/content_hoarder/static/browse/main.js` — `closeRelay()` (line 1668) should also clear the
  inline `transition`/`transform` on `.item-fg` as a belt-and-suspenders cleanup. (The
  `relay-open` class removal drives the visual; the inline-style cleanup prevents the snap.)
- `src/content_hoarder/static/sw.js` — bump `CACHE` to `ch-shell-v87`.
- `src/content_hoarder/static/browse/main.js` — bump `APP_VERSION` to the next value (currently
  `v76` on staging → `v77`).

**Do NOT touch:** `core/media.js`, `browse/tagedit.js`, `browse/reader.js`, any Python.

## Design constraints (locked)

- **`relayCloseMode` is a close-only mode.** A swipe on a relay-open row must NEVER triage
  (archive/done/keep/snooze). It either closes the relay (rightward) or is a no-op (leftward /
  vertical). This is the existing contract — don't change it.
- **Rightward close threshold = 10px, not 40px.** The 40px threshold is for committing a triage
  swipe; closing an already-open overlay should be a deliberate-but-easy gesture. 10px is well
  above the 4px noise floor but doesn't require a full commit-length swipe.
- **Don't require `horizontal` to be decided.** A rightward-by-10px swipe should close even if
  the dy/dx ratio would have failed the `horizontal` test (e.g., a slightly diagonal swipe). The
  relay-close path bypasses the `horizontal` decision entirely.
- **Always call `reset()` at the end of the `relayCloseMode` branch.** This restores the inline
  `transition` to the springy settle value and clears any transform classes, so when
  `closeRelay()` removes `.relay-open`, the `.item-fg` slides back cleanly.
- **Skip `fg.style.transition = "none"` in `pointerdown` when `relayCloseMode`.** We're not
  dragging the fg in this mode (move returns early), so we don't need to disable the transition.
  Leaving the CSS transition intact means any class change slides smoothly.
- **`closeRelay()` cleanup is defensive.** Even with the swipe.js fix, clear the inline
  `transition`/`transform` on `.item-fg` when closing, in case some other code path left them.
  This is idempotent — `style.transition = ""` removes the inline property, falling back to CSS.
- **No haptic on relay close.** The relay-open long-press already vibrated (15ms in the
  `lpTimer` callback, swipe.js line 95). Adding another on close would be noisy. Leave the
  haptic discipline as-is.

## Implementation sketch

```js
// swipe.js pointerdown, around line 79 — guard the transition disable:
relayCloseMode = el.classList.contains("relay-open");
dragging = true;
decided = false;
horizontal = false;
startX = e.clientX;
startY = e.clientY;
if (!relayCloseMode) {
  fg.style.transition = "none";   // only disable transition when we're actually dragging the fg
}

// swipe.js end(), replace the relayCloseMode branch (lines 153-159):
if (relayCloseMode) {
  relayCloseMode = false;
  // Any deliberate rightward motion closes the relay — bypass the horizontal decision.
  // (Triage swipes are disabled in relayCloseMode regardless.)
  if (dx > 10 && opts.onRelayClose) {
    opts.onRelayClose(el);
  }
  reset();   // ← ALWAYS reset, even if we didn't close: clears inline transition/transform
  return;
}
```

```js
// main.js closeRelay() — add inline-style cleanup on the fg:
function closeRelay() {
  if (!relayFn && !relayRow) return;
  if (relayRow) {
    relayRow.classList.remove("relay-open");
    const fg = relayRow.querySelector(".item-fg");
    if (fg) { fg.style.transition = ""; fg.style.transform = ""; }
    const strip = relayRow.querySelector(".relay-strip");
    if (strip) strip.remove();
  }
  relayFn = null;
  relayRow = null;
  if (relayScrim) relayScrim.classList.remove("show");
}
```

## Acceptance

1. **Long-press opens the relay strip.** (Existing behavior — verify it still works.)
2. **Left-swipe on a relay-open row is a no-op.** The relay strip stays open; no blank space
   appears; no triage fires. (This is the regression fix for item #1.)
3. **Right-swipe >10px on a relay-open row closes the relay.** The strip slides out, the
   `.item-fg` slides back to its original position with the spring transition (no abrupt snap),
   and the scrim hides. (Regression fix for item #2.)
4. **Slightly-diagonal right-swipe still closes.** A swipe with `dx=25, dy=18` (would fail the
   `horizontal` test) still closes the relay.
5. **Vertical drag on a relay-open row is a no-op.** Scrolling vertically on a relay-open row
   should not close the relay or triage. (The list doesn't scroll because the scrim catches the
   pointer, but verify a vertical drag *on the row itself* doesn't do anything destructive.)
6. **Triage swipes still work when relay is NOT open.** A normal left-swipe on a non-relay-open
   row still marks Done; a normal right-swipe still Archives; a long-right-swipe still Keeps; a
   long-left-swipe still Snoozes. (No regression to the T2 B1/B3 work.)
7. **Scrim tap, Esc, and outside-row tap still close the relay.** (Existing behavior — verify.)
8. **No snap-back visual glitch** when the relay closes by any path (right-swipe, scrim tap, Esc).
   The `.item-fg` slides back smoothly via the CSS transition.

## Validation block

```
# 1. Unit suite — same 5 known env failures, NO new failures.
git stash
.venv/Scripts/python.exe -m pytest -q -m "not ui" --tb=no 2>&1 | tail -3
git stash pop

# 2. JS syntax valid (the venv python is fine; this is just a parse check):
.venv/Scripts/python.exe -c "import subprocess,sys; subprocess.check_call([sys.executable,'-c','import esprima'] if False else ['node','-e','require(\"fs\').readFileSync(\"src/content_hoarder/static/core/swipe.js\",\"utf8\")'])" 2>/dev/null || node --check src/content_hoarder/static/core/swipe.js

# 3. SW cache bumped:
grep 'const CACHE' src/content_hoarder/static/sw.js   # → "ch-shell-v87"

# 4. APP_VERSION bumped:
grep 'APP_VERSION' src/content_hoarder/static/browse/main.js | head -1   # → v77

# 5. UI smoke (manual serve + Pixel-6):
#    a. Long-press a row → relay strip appears.
#    b. Swipe LEFT on the open relay → nothing happens (no blank space).
#    c. Swipe RIGHT >10px → relay closes with a smooth slide-back.
#    d. Try a diagonal right-swipe (dx≈25, dy≈18) → still closes.
#    e. Tap the scrim → closes smoothly (no snap).
#    f. Open relay, press Esc → closes smoothly.
#    g. On a fresh row (no relay): swipe left → Done; right → Archive; long-right → Keep.
```

## Report back

- Branch: `delegate/t3-relay-swipe-close`
- Files changed:
- Unit suite result (count of new failures vs the 5 known):
- UI smoke result (each of items a–g above):
- Anything punted to T1:
