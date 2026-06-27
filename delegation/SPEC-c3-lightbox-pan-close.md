# SPEC — C3: Swipe-to-pan + swipe-far-to-close in the lightbox

**Task ID:** `c3-lightbox-pan-close`
**Worktree branch:** `delegate/c3-lightbox-pan-close`
**SW cache version on success:** `ch-shell-v79` (bump from `v78` after C2 merges, or `v77` if C2
hasn't merged yet — coordinate with the orchestrator)
**Source backlog item:** Epic 16, `BACKLOG.md` ~L1053 ("Swipe-to-pan + swipe-far-to-close in the lightbox")

## Goal

When zoomed in (after C2 ships), swiping pans the image; when **not** zoomed (scale 1), a large
up/down swipe **closes** the lightbox Relay-style (dismiss-on-pan-beyond-edge). One-finger swipe =
pan when zoomed, close when at scale 1. Must coordinate with `core/overlaynav.js` (the close calls
the lightbox's `close()`, NOT a raw `history.back()`).

## Prerequisite

**C2 must land first** (or be merged into this branch as a starting point). This task builds on
C2's zoom state (`zoomScale`, `zoomImg`, `setZoom`, `resetZoom` inside `createLightbox`). If the
agent is given this spec before C2 merges, the orchestrator will rebase this branch onto C2's
merge commit; the agent should write against the C2 shape as documented in
`SPEC-c2-lightbox-zoom.md`.

## Files in scope

- `src/content_hoarder/static/core/media.js` — `createLightbox`. Adds pan state + a one-finger
  pointer/touch drag handler on the image. Reuses C2's `zoomScale`/`zoomImg`/`resetZoom`.
- `src/content_hoarder/static/browse/browse.css` — `.media-img`/`.gallery-img` `touch-action` (now
  `none` when zoomed so the drag pans), cursor + grab-grabbing states, `transform: translate() scale()`
  composition.
- `src/content_hoarder/static/sw.js` — bump `CACHE` to `ch-shell-v79` (or the next free version
  after whatever C2 used — confirm with the orchestrator), update the comment.
- `src/content_hoarder/static/browse/main.js` — bump `APP_VERSION` to the next value after C2's.

**Do NOT touch:** `core/overlaynav.js` (call its existing `settleTop` via the lightbox's existing
`close()` — don't reach into the coordinator directly), `browse/reader.js`, any Python.

## Design constraints (locked)

- **Pan only when zoomed (`zoomScale > 1.001`).** At scale 1, a one-finger drag does NOT pan (there's
  nothing to pan — the image fits) and instead is a **close candidate** (see below).
- **Close-on-swipe-far (Relay dismiss):** at scale 1, a one-finger drag tracks the image's
  `translateY` (mostly vertical — Relay's dismiss direction). If the user releases with
  `|translateY| > 120px` (or `> 25% of viewport height`, whichever is smaller), call the lightbox's
  `close()`. Otherwise spring back to `translate(0,0)`. Horizontal drag at scale 1 does nothing
  special — don't close on horizontal swipe (avoid conflicts with the OS back-gesture edge deadzone).
- **Pan when zoomed:** track `translateX` + `translateY` from a one-finger drag. Clamp so the image
  can't be dragged entirely off-screen (leave at least ~25% of the image visible on each axis based
  on the over-scroll amount = `(scale - 1) * imgSize / 2`). Release: keep the translate where it
  was clamped (no spring-back — the user deliberately panned).
- **Two-finger gestures belong to C2 (pinch).** This task's handlers must ignore `touchstart` /
  `pointerdown` when `e.touches.length === 2` (touch) or when a multi-pointer session is active
  (Pointer Events: track `pointerId`s in a `Set`; only pan with a single active pointer).
- **Close calls the lightbox's `close()`, not `history.back()`.** The existing `close()` already
  runs `closeVisual()` (tears down the DOM) + `settleTop()` (unwinds the history entry the lightbox
  pushed on open). Calling `history.back()` directly would double-unwind and desync the overlay
  stack — `core/overlaynav.js`'s header comment is explicit about this.
- **Coordinate with C2's `touch-action`:** C2 set `touch-action: pan-y pinch-zoom` on the image.
  This task needs `touch-action: none` when zoomed (so the pan drag isn't stolen by the browser's
  scroll). Set it via the `.zoomed` class C2 already toggles:
  ```css
  .media-img.zoomed, .gallery-img.zoomed { touch-action: none; }
  ```
  Keep C2's base `pan-y pinch-zoom` for the unzoomed state so the close-on-vertical-swipe still
  composes with the page scroll-lock.
- **Don't conflict with the existing backdrop-click close.** The lightbox's modal `click` handler
  (line ~385) closes on backdrop click. A drag that ends off-image should NOT also fire a backdrop
  click — call `e.stopPropagation()` on the image's `pointerup`/`touchend` when it was a drag
  (moved more than ~5px), so the modal click handler doesn't double-close.
- **`prefers-reduced-motion`:** the spring-back at scale 1 is instant (no transition).

## Implementation sketch

```js
// inside createLightbox, after C2's zoom state:
let panX = 0, panY = 0;
let dragStart = null;   // {x, y, origPanX, origPanY, moved} or null
const DRAG_CLOSE_THRESHOLD = 120; // px at scale 1, vertical

const applyTransform = (img) => {
  img.style.transform = `translate(${panX}px, ${panY}px) scale(${zoomScale})`;
};

// one-finger drag (pointer events — works for mouse + touch + pen)
body.addEventListener("pointerdown", (e) => {
  if (e.pointerType === "mouse" && e.button !== 0) return;
  const img = e.target.closest(".media-img, .gallery-img");
  if (!img) return;
  // C2's pinch handles 2-finger touch; bail if a second pointer is already down
  // (track active pointers if mixing pointer + touch gets messy — see note below)
  zoomImg = img;
  dragStart = { x: e.clientX, y: e.clientY, origPanX: panX, origPanY: panY, moved: false };
  img.setPointerCapture(e.pointerId);
});
body.addEventListener("pointermove", (e) => {
  if (!dragStart) return;
  const dx = e.clientX - dragStart.x;
  const dy = e.clientY - dragStart.y;
  if (Math.abs(dx) > 4 || Math.abs(dy) > 4) dragStart.moved = true;
  if (zoomScale > 1.001) {
    // PAN (zoomed): clamp so ~25% of the over-scroll area stays visible
    const img = zoomImg;
    const maxX = Math.max(0, (img.clientWidth * (zoomScale - 1)) / 2);
    const maxY = Math.max(0, (img.clientHeight * (zoomScale - 1)) / 2);
    panX = Math.max(-maxX, Math.min(maxX, dragStart.origPanX + dx));
    panY = Math.max(-maxY, Math.min(maxY, dragStart.origPanY + dy));
    applyTransform(img);
  } else {
    // CLOSE candidate (scale 1): track vertical translate only
    panX = 0;
    panY = dy; // unclamped during the drag so it follows the finger
    applyTransform(zoomImg);
  }
});
body.addEventListener("pointerup", (e) => {
  if (!dragStart) return;
  const wasDrag = dragStart.moved;
  const img = zoomImg;
  dragStart = null;
  if (wasDrag) e.stopPropagation(); // suppress the modal click → backdrop close
  if (zoomScale > 1.001) {
    // keep pan where it was clamped (no spring-back)
  } else if (Math.abs(panY) > DRAG_CLOSE_THRESHOLD) {
    close(); // the lightbox's own close — calls closeVisual + settleTop (NOT history.back)
  } else {
    // spring back to 0,0
    panX = 0; panY = 0;
    if (img) applyTransform(img);
  }
});
```

Reset `panX`/`panY` to `0` in `closeVisual` (next to C2's `resetZoom`), and on gallery image swap
(alongside C2's zoom reset).

**Pointer-vs-touch note:** C2 uses `touchstart`/`touchmove`/`touchend` for pinch (because
two-finger tracking is cleaner there), and this task uses Pointer Events for the one-finger pan.
They compose as long as: (a) the pinch handler bails when `e.touches.length !== 2`, and (b) this
pan handler bails when a 2-finger touch is in progress (check `e.isPrimary === false` on
pointerdown, or maintain a `Set` of active `pointerId`s). If the agent finds the two systems
fighting, the cleanest fix is to convert C2's pinch to Pointer Events too — but that's a
deviation, document it in the report.

## Acceptance

1. **Zoomed pan (touch + mouse):** pinch-zoom an image to 2× (C2), then one-finger drag → the
   image pans, clamped so it can't leave the viewport. Release → stays where you panned. Pan again
   → continues from there.
2. **Close-on-swipe-far at scale 1:** with the image at 1×, drag down >120px and release → the
   lightbox closes (and the underlying feed is intact, scroll position restored — verify the
   `lockScrollEl` restore from C1 still fires). Drag down <120px and release → springs back, lightbox
   stays open.
3. **No double-close:** a drag-to-close does not also trigger the backdrop-click close (no console
   errors, no overlay-stack desync — verify OS-back still closes the next overlay correctly after a
   swipe-close).
4. **No conflict with pinch:** a two-finger pinch does not also start a pan (the pan handler bails
   on the second pointer). A pinch that ends with one finger lifted does not leave a stuck pan
   state.
5. **No conflict with OS back-gesture:** a horizontal swipe at the screen edge does not pan or
   close (it should hit the Android back-gesture deadzone, which is outside the lightbox's
   concern — but verify a horizontal drag inside the image area at scale 1 doesn't accidentally
   close).
6. **Reduced motion:** spring-back is instant under `prefers-reduced-motion: reduce`.
7. **Gallery:** pan/close applies to the tapped gallery image only; the rest of the stack doesn't
   move. Swiping far to close on a gallery image closes the whole lightbox (not just that image).

## Validation block

```
# Same shape as SPEC-c2's validation block. Key points:
# - Unit suite: same 5 known env failures, NO new failures.
# - Confirm C2 is in the branch: grep for setZoom / zoomScale in core/media.js — must be present.
# - SW cache: ch-shell-v79 (or the next free version after C2 — confirm with orchestrator).
# - UI smoke: pinch-zoom an image, then one-finger pan; release at scale 1 + drag down 150px → closes.
# - OS-back after a swipe-close still works (open lightbox again, OS-back closes it).
git stash
python -m pytest -q -m "not ui" 2>&1 | tail -20
git stash pop
grep 'const CACHE' src/content_hoarder/static/sw.js
grep -c 'setZoom\|zoomScale' src/content_hoarder/static/core/media.js   # >0 (C2 present)
```

## Report back

- Branch: `delegate/c3-lightbox-pan-close`
- Was C2 present in the starting branch? (yes/no — if no, the orchestrator needs to rebase before merge)
- Files changed:
- Unit suite result:
- UI smoke result (pan + close + OS-back-after-close):
- Did you convert C2's pinch to Pointer Events? (yes/no + why):
- Anything punted to T1:
