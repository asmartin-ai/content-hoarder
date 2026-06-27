# SPEC — B4: Hold-to-preview media (Relay-style press-and-hold lightbox)

**Task ID:** `b4-hold-to-preview`
**Worktree branch:** `delegate/b4-hold-to-preview`
**SW cache version on success:** `ch-shell-v81` (bump from `v77`)
**Source backlog item:** Epic 16, `BACKLOG.md` ~L1021 ("Hold-to-preview media (Relay-style press-and-hold lightbox)")

## Goal

Pressing and **holding** a media thumbnail (~250ms) opens the lightbox **temporarily** — it stays
open while the finger is down and closes on release (a quick peek, Relay-style). A quick tap still
opens the lightbox persistently (existing behavior). The row long-press (which opens the relay
strip) and the swipe gesture must NOT conflict.

## Files in scope

- `src/content_hoarder/static/browse/main.js` — the `[data-media]` click handler that routes to
  `openMediaFor` (find it via `grep -n 'data-media' src/content_hoarder/static/browse/main.js`).
  The hold listener attaches here, alongside the existing tap + long-press handling.
- `src/content_hoarder/static/core/swipe.js` — already guards long-press when touching
  `[data-media]` (line ~90 per the backlog). Confirm the guard; don't change it. The hold-to-preview
  listener is on `main.js`'s side, not `swipe.js`.
- `src/content_hoarder/static/core/media.js` — `createLightbox` needs a way to open in "peek mode":
  registers with `pushOverlay` (so OS-back closes it) but auto-closes on `pointerup`/`pointercancel`.
  The cleanest shape: a new `openPeek(html, { onRelease })` method on the lightbox API, OR an option
  to `openHtml` / `openImage` / `openGallery` / `openVideo`. The agent picks — see sketch.
- `src/content_hoarder/static/sw.js` — bump `CACHE` to `ch-shell-v81`, update the comment.
- `src/content_hoarder/static/browse/main.js` — bump `APP_VERSION` to `v74`.

**Do NOT touch:** `core/overlaynav.js` (use its existing `pushOverlay`/`settleTop`), the relay
strip code, any Python.

## Design constraints (locked)

1. **Hold delay: ~250ms.** A `pointerdown` on `[data-media]` starts a 250ms timer; if the finger is
   still down (no `pointerup`/`pointercancel`/`pointermove` beyond a small slop) when it fires, open
   the lightbox in peek mode. If the finger lifts before 250ms, it's a tap → open persistently
   (existing behavior, no change).
2. **Peek mode closes on release.** While peeking, `pointerup` or `pointercancel` anywhere (the
   finger can drift onto the lightbox image itself) → call the lightbox's `close()`. The close
   path runs `closeVisual()` (tears down the DOM) + `settleTop()` (unwinds the history entry the
   peek pushed). Same close path as a manual close — no special teardown.
3. **Tap ≠ hold.** A tap (down + up within 250ms, minimal movement) opens the lightbox
   **persistently** (the existing behavior — no auto-close on release). The existing `[data-media]`
   click handler stays. The hold timer is canceled on `pointerup` before the click fires; if the
   timer already fired (peek opened), suppress the subsequent click (track a `peeking` flag).
4. **No conflict with swipe.** `swipe.js`'s pointer handler is separate (it listens on the row, not
   `[data-media]` specifically, and has its own movement threshold). If a swipe starts (the finger
   moves past swipe.js's slop), cancel the hold timer. The agent should verify this by reading
   `swipe.js`'s pointer handlers — the hold listener and swipe.js both see `pointerdown`, but
   swipe.js's commit threshold (~80px) is well beyond the hold listener's slop (~10px), so a swipe
   that crosses 10px cancels the peek but doesn't yet commit. If `swipe.js` calls
   `e.stopPropagation()` on pointerdown, the hold listener won't fire at all on swiped rows — that's
   fine, just document it.
5. **No conflict with the row long-press (relay strip).** The backlog note says swipe.js already
   guards long-press when touching `[data-media]` (line ~90). Confirm: the row long-press (which
   opens `openRowMenu`) does NOT fire when the touch started on `[data-media]`. So holding a media
   thumbnail opens the peek, NOT the relay strip. The 250ms hold delay should be **shorter** than
   `swipe.js`'s long-press delay (find it via `grep -n 'longpress\|long-press\|LONGPRESS' src/content_hoarder/static/core/swipe.js`)
   so the peek wins the race cleanly.
6. **Peek registers with `overlaynav`.** OS-back during a peek closes it (returns to the feed, not
   exits the app). This is automatic if the peek opens via the lightbox's normal `open()` path
   (which calls `pushOverlay`).
7. **Peek + C2/C3 zoom:** if C2/C3 have landed, the peek opens at scale 1 (no zoom) and the
   pinch/pan handlers don't fire meaningfully (the finger is the one holding the thumbnail open — a
   second finger could pinch, but that's an edge case; if it happens, the peek closes on the first
   finger's release and the pinch is interrupted — acceptable). Don't special-case this.
8. **`prefers-reduced-motion`:** no special handling — the lightbox opens/closes with its existing
   transition.

## Implementation sketch

```js
// main.js — near the [data-media] click handler
let holdTimer = null;
let peeking = false;
let peekPointerId = null;
const HOLD_DELAY = 250;
const HOLD_SLOP = 10;   // px of movement that cancels the hold

// attach on itemsEl (delegated) or per-row at render time — match the existing pattern
itemsEl.addEventListener("pointerdown", (e) => {
  const media = e.target.closest("[data-media]");
  if (!media) return;
  if (e.pointerType === "mouse" && e.button !== 0) return;
  const fn = media.closest("[data-fullname]")?.dataset.fullname;
  if (!fn) return;
  const startX = e.clientX, startY = e.clientY;
  peekPointerId = e.pointerId;
  holdTimer = setTimeout(() => {
    holdTimer = null;
    peeking = true;
    openMediaFor(fn, { peek: true });   // openMediaFor gains an opts arg; peek:true → lightbox.openPeek(...)
  }, HOLD_DELAY);
});

itemsEl.addEventListener("pointermove", (e) => {
  if (holdTimer === null || e.pointerId !== peekPointerId) return;
  // movement beyond slop cancels the hold (it's becoming a swipe or scroll)
  if (Math.hypot(e.clientX - startX, e.clientY - startY) > HOLD_SLOP) {
    clearTimeout(holdTimer);
    holdTimer = null;
  }
});

itemsEl.addEventListener("pointerup", (e) => {
  if (holdTimer !== null) {
    clearTimeout(holdTimer);
    holdTimer = null;
    // it was a tap (< 250ms, no movement) → let the existing click handler open the lightbox persistently
    return;
  }
  if (peeking) {
    peeking = false;
    lightbox.close();   // closeVisual + settleTop — same as a manual close
  }
});
itemsEl.addEventListener("pointercancel", (e) => {
  if (holdTimer !== null) { clearTimeout(holdTimer); holdTimer = null; }
  if (peeking) { peeking = false; lightbox.close(); }
});

// Suppress the click that follows a peek-opening pointerup (otherwise the [data-media] click
// handler would open the lightbox again, persistently, right after the peek closed).
itemsEl.addEventListener("click", (e) => {
  if (peekJustClosed) {   // set in the pointerup branch above, cleared after this click
    e.stopPropagation();
    e.preventDefault();
    peekJustClosed = false;
  }
}, true);   // capture phase — runs before the existing [data-media] click handler
```

In `core/media.js createLightbox`, the `peek` option:

```js
// Option A (cleanest): openHtml/openImage/openGallery/openVideo gain an opts arg
openImage(url, opts = {}) {
  if (!safeUrl(url)) return;
  open(/* existing html */);
  if (opts.peek) attachPeekRelease();   // sets a one-shot pointerup/pointercancel listener on window
}

const attachPeekRelease = () => {
  const release = () => {
    window.removeEventListener("pointerup", release);
    window.removeEventListener("pointercancel", release);
    close();   // the lightbox's own close — closeVisual + settleTop
  };
  // listen on window so release fires even if the finger drifts off the original target
  window.addEventListener("pointerup", release);
  window.addEventListener("pointercancel", release);
};
```

**Why window-level release:** the finger that started the hold may drift onto the lightbox image
(the thumbnail is replaced by the full-size image). Listening on `itemsEl` for `pointerup` would
miss the release. The `main.js` pointerup handler above is the *thumbnail-side* cancel (for
taps); the *lightbox-side* release (for the actual close) must be on `window`. The agent should
pick ONE place to put the release logic — putting it on `window` in `createLightbox`'s peek path
is cleaner than splitting it. If the agent prefers, it can remove the `peeking` close from
`main.js`'s pointerup and rely solely on the window listener. Just don't double-close.

**Coordination with `openMediaFor`:** the agent needs to read `openMediaFor` in `main.js`
(grep for it) and thread the `{peek}` option through to whichever of `openImage`/`openGallery`/
`openVideo`/`openMedia` it dispatches to. The peek option is just passed through.

## Acceptance

1. **Quick tap opens persistently (unchanged):** tap a media thumbnail → lightbox opens and stays
   open until Esc / backdrop / OS-back. (Verify the existing behavior still works — the new
   pointerdown handler must not break it.)
2. **Hold opens peek, release closes:** press and hold a media thumbnail ~250ms → lightbox opens.
   Release the finger → lightbox closes. The peek shows the same content a persistent open would
   (image / gallery / video).
3. **No click-after-peek:** after a peek closes on release, no `click` event re-opens the lightbox
   persistently. (The capture-phase click suppressor catches it.)
4. **Movement cancels hold:** press, move >10px (start a swipe or scroll) → no peek opens. The
   swipe or scroll proceeds normally.
5. **Swipe still works:** swipe on a row (across the thumbnail) → swipe.js's behavior (Archive/
   Done/Keep/Snooze) fires. No peek opens.
6. **Row long-press (relay strip) still works on the row body:** long-press on the row's text/title
   area → relay strip opens. Long-press on the `[data-media]` thumbnail → peek opens (NOT the relay
   strip — confirm swipe.js's `[data-media]` guard).
7. **OS-back during peek:** open a peek, press OS-back → peek closes, feed is restored (not the app
   exiting). (Automatic via `pushOverlay`.)
8. **Video peek:** hold a video thumbnail → inline `<video>` lightbox opens (muted? autoplay? —
   match the existing `openVideo` behavior; don't add special mute logic). Release → closes +
   playback stops (the existing `videoTeardown` in `closeVisual` handles this).
9. **Gallery peek:** hold a gallery thumbnail → stacked gallery lightbox opens. Release → closes.

## Validation block

```
# 1. Unit suite — same 5 known env failures, no new.
python -m pytest -q -m "not ui" 2>&1 | tail -20

# 2. Confirm swipe.js's [data-media] long-press guard is still in place:
grep -n 'data-media' src/content_hoarder/static/core/swipe.js

# 3. SW + APP_VERSION bumped:
grep 'const CACHE' src/content_hoarder/static/sw.js   # -> "ch-shell-v81"
grep 'APP_VERSION' src/content_hoarder/static/browse/main.js | head -1   # -> "v74"

# 4. UI smoke (manual):
python -m content_hoarder serve
# - tap a media thumbnail → persistent lightbox (unchanged), Esc closes
# - press + hold 250ms → peek opens, release → closes
# - press, move 20px → no peek (swipe/scroll wins)
# - swipe across a row → swipe action fires, no peek
# - long-press the row title → relay strip opens (NOT peek)
# - long-press the row thumbnail → peek opens (NOT relay strip)
# - open a peek, OS-back → peek closes, app stays
# - hold a video thumbnail → video peek, release → closes + audio stops
# - hold a gallery thumbnail → gallery peek, release → closes
```

## Report back

- Branch: `delegate/b4-hold-to-preview`
- Files changed:
- Unit suite result:
- UI smoke result (each of the 9 acceptance checks):
- Did `openMediaFor` need changes to thread `{peek}` through? (yes/no — what shape):
- Did you put the release listener on `window` (in `createLightbox`) or on `itemsEl` (in `main.js`)?
- Anything punted to T1 (especially: interaction with C2/C3 if those have landed):
