# SPEC — T3 hold-to-preview flicker (regression fix)

**Task ID:** `t3-peek-flicker`
**Worktree branch:** `delegate/t3-peek-flicker`
**Branch off:** `staging/mobile-polish-t2` (NOT `main`)
**SW cache version on success:** `ch-shell-v88` (bump from `v87` after `t3-relay-swipe-close`
merges, or `v86` if it hasn't merged yet — coordinate with the orchestrator)
**Source:** T2 regression — `MOBILE-POLISH-T3-BATCH.md` item #3

## Goal

The T2 B4 hold-to-preview feature (press-and-hold a media thumbnail → lightbox opens temporarily,
closes on finger release) **flickers**: holding a thumbnail opens and closes the lightbox
repeatedly from a single hold. The user sees the lightbox blink open-shut-open-shut while their
finger is still down.

## Root cause (confirmed by reading the code)

The peek path has **no idempotency guard**, and three independent listener sets fire on the same
pointer lifecycle:

1. **`browse/main.js` itemsEl `pointerdown`** (line 582) sets a 250ms `holdTimer`. When it fires,
   it opens the lightbox with `{peek: true}` and sets `peeking = true`.
2. **`core/media.js createLightbox` `_attachPeekRelease`** (line 523) adds a `window`-level
   `pointerup`/`pointercancel` listener that calls `close()` on release.
3. **`browse/main.js` itemsEl `pointerup`** (line 607) sets `_suppressNextClick = true` when
   `peeking` is true, so the trailing click doesn't re-open the lightbox persistently.

The flicker comes from **two separate issues**:

- **(a) The window-level release listener can fire MORE THAN ONCE.** `pointerup` and
  `pointercancel` can both fire for the same gesture (the browser fires `pointercancel` if the
  pointer is hijacked — e.g., a scroll takes over — and then a synthetic `pointerup` follows).
  The `_attachPeekRelease` removes itself on the first event, but only from whichever event
  type fired; the other listener stays registered. A second event then calls `close()` again,
  which calls `closeVisual()` (no-op if already hidden) **and `settleTop()`** — and `settleTop`
  calls `history.back()`, which can pop an unrelated overlay state and cause a re-render that
  re-opens the lightbox via some other path.
- **(b) `swipe.js`'s long-press timer (450ms) is NOT cleared by the peek path.** When the 250ms
  peek timer fires, the swipe handler's 450ms `lpTimer` is still running. It fires 200ms later
  (still during the hold!) — but `swipe.js` line 89 guards `!e.target.closest("[data-media]")`,
  so the swipe's `onLongPress` does NOT fire on a media element. **However**, the swipe's
  `lpTimer` callback also calls `suppressNextClick()` (line 94), which adds a `capture: true`
  click suppressor. That suppressor can swallow a later legitimate click, OR — if the user
  releases right at the 450ms mark — fire concurrently with the peek release and produce a
  double-close → re-open race.

The net effect: a single hold can produce `open → close → open → close` cycles as the listener
race and the history popstate churn settle.

## Files in scope

- `src/content_hoarder/static/browse/main.js` — the itemsEl `pointerdown`/`pointerup`/
  `pointercancel` peek handlers (lines 565–644). Add an idempotency guard, clear the swipe
  long-press timer explicitly, and ensure `_suppressNextClick` is reset cleanly.
- `src/content_hoarder/static/core/media.js` — `_attachPeekRelease` (line 523) inside
  `createLightbox`. Make the release listener remove itself from BOTH events on first fire, and
  make `close()` idempotent during a peek.
- `src/content_hoarder/static/core/swipe.js` — expose a way for the itemsEl pointerdown to cancel
  the swipe's long-press timer. The cleanest fix: in `swipe.js pointerdown`, if the target is a
  `[data-media]`, **don't start the lpTimer at all** (the swipe can't long-press media anyway —
  line 89 already guards `onLongPress`; just move the guard to also skip the timer). This is a
  one-line move, not a new API.
- `src/content_hoarder/static/sw.js` — bump `CACHE` to `ch-shell-v88` (or the next free version
  after `t3-relay-swipe-close` — confirm with orchestrator).
- `src/content_hoarder/static/browse/main.js` — bump `APP_VERSION` to the next value after
  `t3-relay-swipe-close`'s.

**Do NOT touch:** `browse/reader.js`, `browse/tagedit.js`, any Python.

## Design constraints (locked)

- **Peek opens at 250ms, closes on release.** The 250ms HOLD_DELAY stays. Don't tune the delay;
  the bug is the flicker, not the timing.
- **A quick tap (<250ms, no movement) opens the lightbox persistently.** Existing behavior —
  don't break it. The `_suppressNextClick` capture-phase handler is for the **peek** path only;
  the tap path must let the normal click through.
- **The release listener must fire exactly once.** Whether `pointerup` or `pointercancel` fires
  first, the other must be removed before it can fire. Use a shared `fired` flag.
- **`close()` must be idempotent during a peek.** A second `close()` call (from a stray event)
  must NOT call `settleTop()` again. The existing `if (modal.hidden) return;` guard in `close()`
  is **not enough** — `settleTop()` runs after `closeVisual()`, and `closeVisual()` sets
  `modal.hidden = true` first, so a second `close()` would hit the `return` and skip
  `settleTop()`. Verify this is actually the case; if not, add an explicit `_closing` guard.
- **`swipe.js` must not start its lpTimer on a `[data-media]` target.** Move the
  `!e.target.closest("[data-media]")` guard from the `lpTimer` body (line 89) to the
  `if (opts.onLongPress && …)` condition (line 89) so the timer is never armed on media. This
  prevents the 450ms callback's `suppressNextClick()` from racing the peek release.
- **Don't break the swipe-on-media gesture.** A swipe that *starts* on a media thumbnail must
  still be recognized as a swipe (so the user can swipe-archive from the thumbnail). The
  `pointerdown` still sets `dragging = true`; only the `lpTimer` arming is skipped.
- **No haptic on peek open/close.** The existing 250ms path doesn't vibrate; leave it. (If a
  haptic is desired, that's a separate enhancement, not this fix.)

## Implementation sketch

```js
// main.js — replace the itemsEl pointerdown peek handler (line 582) with a version that
// explicitly bails on the swipe long-press race:
let _peekOpen = false;   // idempotency: a peek is in progress

itemsEl.addEventListener("pointerdown", (e) => {
  const media = e.target.closest("[data-media]");
  if (!media) return;
  const fn = media.closest("[data-fullname]")?.dataset.fullname;
  if (!fn) return;
  if (e.pointerType === "mouse" && e.button !== 0) return;
  // bail if a peek is already in progress (e.g., a second finger lands on a different thumb)
  if (_peekOpen) return;
  peekStartX = e.clientX;
  peekStartY = e.clientY;
  peekPointerId = e.pointerId;
  holdTimer = setTimeout(() => {
    holdTimer = null;
    _peekOpen = true;            // ← set BEFORE openMediaFor so the release listener sees it
    peeking = true;
    const item = state.items.find((it) => it.fullname === fn);
    if (item) openMediaFor(item, { peek: true });
  }, HOLD_DELAY);
});

// itemsEl pointerup (line 607) — clear the guard when the peek closes:
itemsEl.addEventListener("pointerup", (e) => {
  if (holdTimer !== null) {
    clearTimeout(holdTimer);
    holdTimer = null;
    return;
  }
  if (peeking) {
    peeking = false;
    _suppressNextClick = true;
    // _peekOpen is cleared by the lightbox's close() callback (see media.js below),
    // OR by the pointercancel handler if the release never fires.
  }
});

// itemsEl pointercancel — also clear the guard:
itemsEl.addEventListener("pointercancel", (e) => {
  if (holdTimer !== null) {
    clearTimeout(holdTimer);
    holdTimer = null;
  }
  if (peeking) {
    peeking = false;
    _peekOpen = false;   // ← pointercancel means no pointerup will fire; clear here
  }
});
```

```js
// media.js _attachPeekRelease — make the listener fire exactly once and clear the guard:
const _attachPeekRelease = (onClosed) => {
  let fired = false;
  const release = (e) => {
    if (fired) return;
    fired = true;
    window.removeEventListener("pointerup", release);
    window.removeEventListener("pointercancel", release);
    _peekRelease = null;
    close();
    if (typeof onClosed === "function") onClosed();
  };
  _peekRelease = release;
  window.addEventListener("pointerup", release);
  window.addEventListener("pointercancel", release);
};

// Where openMediaFor calls _attachPeekRelease (in openHtml/openImage/openGallery/etc.),
// pass a callback that clears the itemsEl guard:
//   if (opts_ && opts_.peek) _attachPeekRelease(() => { /* main.js clears _peekOpen */ });
// The cleanest way: expose a small callback API. main.js's createLightbox call already passes
//   an onClose option (line 698) — use it to clear _peekOpen.
```

```js
// swipe.js pointerdown — move the [data-media] guard to the timer-arm condition (line 89):
// BEFORE:
//   if (opts.onLongPress && !e.target.closest("[data-media]")) {
//     clearTimeout(lpTimer);
//     lpTimer = setTimeout(() => { … }, opts.longPressMs || 450);
//   }
// AFTER:
if (opts.onLongPress) {
  clearTimeout(lpTimer);
  // arm the timer ONLY if the press didn't start on a media element — media has its own
  // hold-to-preview (B4) and the swipe long-press's suppressNextClick would race the peek release
  const target = e.target;
  lpTimer = setTimeout(() => {
    lpTimer = null;
    if (horizontal) return;
    if (target.closest("[data-media]")) return;   // double-check inside the callback too
    suppressNextClick();
    if (navigator.vibrate) navigator.vibrate(15);
    opts.onLongPress(el);
  }, opts.longPressMs || 450);
}
```

## Acceptance

1. **Hold a media thumbnail → lightbox opens ONCE, stays open while the finger is down, closes
   ONCE on release.** No flicker. (This is the regression fix.)
2. **Quick tap (<250ms) on a media thumbnail → lightbox opens persistently.** Existing behavior
   — don't break it. (The `_suppressNextClick` capture handler must NOT swallow the tap's click.)
3. **Hold, then move >10px → peek cancels, no lightbox opens.** Existing behavior — the
   `pointermove` slop check (line 599) clears `holdTimer`. Verify it still works.
4. **Hold, then a second finger lands → no second peek opens.** The `_peekOpen` guard prevents
   a second `pointerdown` from arming a second timer. (Multi-touch on the same thumbnail is
   undefined behavior; just don't open a second lightbox.)
5. **Hold, then `pointercancel` fires (e.g., browser hijacks the gesture) → lightbox closes
   cleanly, no stuck state.** `_peekOpen` and `peeking` both clear; the next tap works normally.
6. **Swipe starting on a media thumbnail still works.** A left-swipe starting on the thumbnail
   still marks Done; a right-swipe still Archives. (The swipe.js fix only skips the lpTimer
   arming; the swipe itself is unaffected.)
7. **Long-press on a NON-media part of the row still opens the relay strip.** Existing behavior
   — verify the swipe.js fix didn't break the relay long-press.
8. **No console errors** during a peek cycle (open → release → tap-to-open-persistently).

## Validation block

```
# 1. Unit suite — same 5 known env failures, NO new failures.
git stash
.venv/Scripts/python.exe -m pytest -q -m "not ui" --tb=no 2>&1 | tail -3
git stash pop

# 2. SW cache bumped:
grep 'const CACHE' src/content_hoarder/static/sw.js   # → "ch-shell-v88" (or next free)

# 3. APP_VERSION bumped:
grep 'APP_VERSION' src/content_hoarder/static/browse/main.js | head -1

# 4. UI smoke (manual serve + Pixel-6):
#    a. Hold a thumbnail 300ms → lightbox opens. Keep holding 2s → stays open (NO flicker).
#       Release → closes.
#    b. Tap a thumbnail quickly → lightbox opens persistently. Close button → closes.
#    c. Hold, then move finger 20px → no lightbox opens.
#    d. Hold, then a second finger taps elsewhere → no second lightbox.
#    e. Hold, then drag to scroll (pointercancel fires) → lightbox closes cleanly.
#    f. Swipe-left starting on a thumbnail → row marks Done.
#    g. Long-press on the row text (not thumbnail) → relay strip opens.
#    h. Open DevTools console → perform a–g → no errors logged.
```

## Report back

- Branch: `delegate/t3-peek-flicker`
- Was `t3-relay-swipe-close` already merged into your starting branch? (yes/no — affects whether
  you could reuse its swipe.js changes)
- Files changed:
- Unit suite result:
- UI smoke result (each of items a–h):
- Did you need to add an explicit `_closing` guard in `close()`, or was the existing
  `if (modal.hidden) return;` sufficient?:
- Anything punted to T1:
