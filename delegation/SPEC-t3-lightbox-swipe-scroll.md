# SPEC — T3 lightbox swipe-to-close must not scroll the page

**Task ID:** `t3-lightbox-swipe-scroll`
**Worktree branch:** `delegate/t3-lightbox-swipe-scroll`
**Branch off:** `staging/mobile-polish-t2` (NOT `main`)
**SW cache version on success:** `ch-shell-v90` (bump from `v89` after `t3-tag-suggest-three`
merges, or the next free version — coordinate with orchestrator)
**Source:** T2 regression — `MOBILE-POLISH-T3-BATCH.md` item #5

## Goal

The T2 C3 swipe-to-pan + swipe-far-to-close feature doesn't work: a vertical swipe on the
lightbox image at scale 1× **scrolls the underlying page** instead of closing the lightbox. The
user can't dismiss the lightbox by swiping down on the image.

## Root cause (confirmed by reading the code)

In `src/content_hoarder/static/core/media.js createLightbox`, the C3 pointer handlers
(lines 451–519) set up a one-finger drag on the image:

- `pointerdown` (line 451) calls `img.setPointerCapture(e.pointerId)` and adds the `zooming`
  class (which disables the CSS transition).
- `pointermove` (line 469) updates `panX`/`panY` and calls `applyTransform(img)` — but **does
  NOT call `e.preventDefault()`**. Without `preventDefault`, the browser's default touch-action
  behavior continues: the page scrolls.
- The CSS on `.media-img` (browse.css line 2630) is `touch-action: pan-y pinch-zoom`. The
  `pan-y` allows the browser to handle vertical panning (scrolling) — which is what's stealing
  the gesture.
- The `.zoomed` class sets `touch-action: none` (line 2657), but at scale 1× the image is NOT
  zoomed, so `pan-y` is active and the browser scrolls.

The fix has two parts:

1. **Add `e.preventDefault()` in the `pointermove` handler when a drag is active.** This claims
   the gesture so the browser doesn't scroll.
2. **Set `touch-action: none` on the image during the drag** (in `pointerdown`), restore it in
   `pointerup`/`pointercancel`. This prevents the browser from even STARTING a scroll gesture,
   which is more reliable than `preventDefault` alone (Chrome sometimes ignores
   `preventDefault` on passive touchmove events).

## Files in scope

- `src/content_hoarder/static/core/media.js` — the C3 pointer handlers in `createLightbox`
  (lines 451–519). Add `preventDefault` + `touch-action` management.
- `src/content_hoarder/static/browse/browse.css` — change the base `touch-action` on
  `.media-img`/`.gallery-img` from `pan-y pinch-zoom` to `none` (the drag handler now manages
  the gesture entirely). Keep `pinch-zoom` available via the `.zooming` class for the C2 pinch
  path. (See Design constraints for the exact rule.)
- `src/content_hoarder/static/sw.js` — bump `CACHE` to `ch-shell-v90` (or next free).
- `src/content_hoarder/static/browse/main.js` — bump `APP_VERSION`.

**Do NOT touch:** `core/swipe.js` (the swipe handler is for rows, not the lightbox),
`browse/reader.js`, any Python.

## Design constraints (locked)

- **At scale 1×, a vertical drag >120px closes the lightbox.** Existing C3 behavior — don't
  change the threshold or the close call. Only the gesture-capture is broken.
- **At scale >1× (zoomed), a one-finger drag pans the image (clamped).** Existing C3 behavior.
- **Two-finger pinch (C2) must still work.** The pinch handler uses `touchstart`/`touchmove`/
  `touchend` (lines 404–441) with its own `e.preventDefault()` in `touchmove`. Don't break it.
- **`setPointerCapture` stays.** It ensures the `pointermove`/`pointerup` events keep going to
  the image even if the finger drifts off it. Don't remove it.
- **`touch-action: none` on the image is safe because the drag handler is now the sole gesture
  owner.** The C3 handler covers both pan (zoomed) and close (1×); there's no case where the
  browser should scroll the image. The pinch handler (C2) operates on the body, not the image,
  and uses touch events (which `touch-action: none` doesn't block).
- **Reduced motion:** the spring-back at scale 1× is instant under `prefers-reduced-motion`.
  Existing behavior — the `.zooming` class disables the transition; the reduced-motion CSS rule
  (browse.css line ~2666) handles the rest.
- **Don't break the backdrop-click close.** The modal's `click` handler (line 565) closes on
  backdrop click. A drag that ends off-image must not also fire a backdrop click — the existing
  `e.stopPropagation()` on `pointerup` when `wasDrag` (line 499) handles this. Verify it still
  works after the `preventDefault` change.
- **Don't break the gallery tap-to-upgrade.** The gallery image's `click` handler (line 652)
  swaps the sized preview up to the full original. A tap (no drag) must still fire this click.
  The `dragStart.moved` flag (set only when movement >4px) protects this — verify.

## Implementation sketch

```js
// media.js — C3 pointerdown (line 451), add touch-action management:
body.addEventListener("pointerdown", (e) => {
  if (e.pointerType === "mouse" && e.button !== 0) return;
  const img = e.target.closest(".media-img, .gallery-img");
  if (!img) return;
  if (zoomScale > 1.001 && dragStart) return; // pinch owns multi-touch
  dragStart = {
    x: e.clientX,
    y: e.clientY,
    origPanX: panX,
    origPanY: panY,
    moved: false,
    img,
    pointerId: e.pointerId,
  };
  img.classList.add("zooming"); // disable transition during drag
  img.setPointerCapture(e.pointerId);
  img.style.touchAction = "none"; // ← ADD: claim the gesture exclusively
});

// media.js — C3 pointermove (line 469), add preventDefault:
body.addEventListener("pointermove", (e) => {
  if (!dragStart) return;
  if (e.pointerId !== dragStart.pointerId) return;
  const dx = e.clientX - dragStart.x;
  const dy = e.clientY - dragStart.y;
  if (Math.abs(dx) > 4 || Math.abs(dy) > 4) dragStart.moved = true;
  if (!dragStart.moved) return;
  if (e.cancelable) e.preventDefault(); // ← ADD: stop the browser from scrolling
  const img = dragStart.img;
  if (zoomScale > 1.001) {
    // PAN mode — clamp within zoomed bounds
    const maxX = Math.max(0, (img.clientWidth * (zoomScale - 1)) / 2);
    const maxY = Math.max(0, (img.clientHeight * (zoomScale - 1)) / 2);
    panX = Math.max(-maxX, Math.min(maxX, dragStart.origPanX + dx));
    panY = Math.max(-maxY, Math.min(maxY, dragStart.origPanY + dy));
    applyTransform(img);
  } else {
    // 1× — vertical drag only (tracks finger for close gesture)
    panX = 0;
    panY = dy;
    applyTransform(img);
  }
});

// media.js — C3 pointerup (line 492), restore touch-action:
body.addEventListener("pointerup", (e) => {
  if (!dragStart) return;
  if (e.pointerId !== dragStart.pointerId) return;
  const wasDrag = dragStart.moved;
  const img = dragStart.img;
  dragStart = null;
  if (img) {
    img.classList.remove("zooming");
    img.style.touchAction = ""; // ← ADD: restore (falls back to CSS)
  }
  if (wasDrag) e.stopPropagation(); // suppress backdrop click
  if (zoomScale > 1.001) {
    // keep pan where clamped — no spring-back
  } else if (Math.abs(panY) > DRAG_CLOSE_THRESHOLD) {
    close(); // swipe-far-to-close
  } else {
    panX = 0;
    panY = 0;
    if (img) applyTransform(img); // spring back
  }
});

// media.js — C3 pointercancel (line 511), restore touch-action:
body.addEventListener("pointercancel", () => {
  if (!dragStart) return;
  const img = dragStart.img;
  dragStart = null;
  if (img) {
    img.classList.remove("zooming");
    img.style.touchAction = ""; // ← ADD
  }
  panX = 0;
  panY = 0;
  if (zoomScale <= 1.001 && img) applyTransform(img);
});
```

```css
/* browse.css — change the base touch-action on .media-img / .gallery-img.
   The C3 drag handler now manages the gesture via setPointerCapture + preventDefault,
   so the browser doesn't need pan-y. Pinch (C2) uses touch events on the body, which
   aren't affected by touch-action on the image. */
#media-body .media-img {
    max-width: 100%;
    max-height: 82vh;
    border-radius: var(--r-sm);
    transform-origin: center center;
    transition: transform 120ms var(--ease);
    touch-action: none; /* ← was: pan-y pinch-zoom */
}
#media-body .gallery-img {
    background: var(--surface-inset);
    cursor: zoom-in;
    transform-origin: center center;
    transition: transform 120ms var(--ease);
    touch-action: none; /* ← was: pan-y pinch-zoom */
}
/* The .zoomed class rule (touch-action: none) is now redundant but harmless — leave it. */
```

## Acceptance

1. **Open the lightbox on a single image (1×). Drag down >120px and release → lightbox closes.**
   (This is the regression fix — previously the page scrolled instead.)
2. **Drag down <120px and release → springs back, lightbox stays open.** Existing behavior.
3. **The underlying feed does NOT scroll during the drag.** Verify by opening the lightbox over a
   scrolled-down feed, dragging down on the image, and confirming the feed's scroll position is
   unchanged after the lightbox closes.
4. **Pinch-zoom (C2) still works.** Two-finger pinch on the image zooms it. (The pinch handler
   uses touch events on the body, unaffected by the image's `touch-action`.)
5. **Zoomed pan (C3) still works.** Pinch to 2×, then one-finger drag → pans, clamped. Release
   → stays. (Existing behavior — verify.)
6. **Backdrop click still closes.** Tap the dark area around the image → lightbox closes.
7. **Gallery tap-to-upgrade still works.** Tap (no drag) on a gallery image → swaps to full-res.
8. **No double-close.** A drag-to-close does not also fire the backdrop-click close (the
   `e.stopPropagation()` on `pointerup` when `wasDrag` prevents this).
9. **Reduced motion.** Under `prefers-reduced-motion: reduce`, the spring-back is instant.
10. **Mouse drag (desktop) still works.** Click-drag down on the image → closes (C3 supports
    mouse via Pointer Events). Verify.

## Validation block

```
# 1. Unit suite — same 5 known env failures, NO new failures.
git stash
.venv/Scripts/python.exe -m pytest -q -m "not ui" --tb=no 2>&1 | tail -3
git stash pop

# 2. SW cache bumped:
grep 'const CACHE' src/content_hoarder/static/sw.js   # → "ch-shell-v90" (or next free)

# 3. APP_VERSION bumped:
grep 'APP_VERSION' src/content_hoarder/static/browse/main.js | head -1

# 4. Confirm C2's pinch handler is intact (its touchstart/touchmove/touchend on the body):
grep -c 'pinchStartDist\|touchstart' src/content_hoarder/static/core/media.js   # >0

# 5. UI smoke (manual serve + Pixel-6):
#    a. Open the lightbox on an image. Scroll the feed down 200px first.
#    b. Drag DOWN on the image 150px → lightbox closes. Feed scroll position unchanged.
#    c. Reopen. Drag down 50px → springs back, lightbox stays open.
#    d. Pinch to 2× → image zooms. One-finger drag → pans.
#    e. Tap the backdrop → closes.
#    f. Open a gallery. Tap an image → swaps to full-res.
#    g. Mouse-drag down on desktop → closes.
```

## Report back

- Branch: `delegate/t3-lightbox-swipe-scroll`
- Files changed:
- Unit suite result:
- UI smoke result (each of items a–g):
- Did you keep the `.zoomed { touch-action: none; }` CSS rule, or remove it as redundant?:
- Anything punted to T1:
