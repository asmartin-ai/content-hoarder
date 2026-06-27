# SPEC — C2: Pinch-zoom + mouse-wheel zoom in the lightbox

**Task ID:** `c2-lightbox-zoom`
**Worktree branch:** `delegate/c2-lightbox-zoom`
**SW cache version on success:** `ch-shell-v78` (bump from `v77`)
**Source backlog item:** Epic 16, `BACKLOG.md` ~L1048 ("Pinch-zoom + mouse-wheel zoom in the lightbox")

## Goal

Inside an open lightbox, a pinch gesture (touch) or mouse-wheel (desktop) should **zoom the image**
instead of scrolling the page. Today the image renders at a fixed size with no zoom. Reset zoom on
close and on image swap (gallery tap-to-upgrade).

## Files in scope

- `src/content_hoarder/static/core/media.js` — `createLightbox` factory (lines ~349–484). The zoom
  state + listeners live here so every lightbox host (browse + triage inline) gets the behavior.
- `src/content_hoarder/static/browse/browse.css` — the `.media-img`, `.media-gallery`, `.media-fallback`
  rules. Zoom is a `transform: scale()` on the image (or gallery scroll-container); the CSS just
  needs `transform-origin: center center` (default) + `touch-action: none` on the zoomed image so
  the page doesn't pinch-zoom too.
- `src/content_hoarder/static/sw.js` — bump `CACHE` to `ch-shell-v78`, update the comment.
- `src/content_hoarder/static/browse/main.js` — bump `APP_VERSION` (~line 1637) to `v74` (lockstep
  with the SW cache; the badge shows what the phone is actually running).

**Do NOT touch:** `core/overlaynav.js`, `browse/reader.js`, the `mountVideo`/`openVideo` path, the
gallery `data-full` swap logic (just reset zoom when it fires), any Python.

## Design constraints (locked — don't relitigate)

- **Zoom target:** the `<img>` element inside the lightbox body. Single image → the `.media-img`.
  Gallery → zoom the **tapped** `.gallery-img` only (not the whole stack). Video is **not** in
  scope for zoom — leave `openVideo` alone.
- **Zoom range:** `1.0` → `4.0`. Floor at `1.0` (never zoom out smaller than fit). Cap at `4.0`.
- **Wheel zoom (desktop):** `wheel` on the image, `e.preventDefault()` (no page scroll), multiply
  current scale by `Math.exp(-e.deltaY * 0.0015)` (exponential feels linear per-notch), clamp to
  `[1, 4]`. Reset to `1` on `dblclick`.
- **Pinch zoom (touch):** `touchstart` with `touches.length === 2` records the initial
  finger-distance + initial scale; `touchmove` with 2 fingers computes the ratio and sets the new
  scale, `e.preventDefault()` (the page must not pinch-zoom — confirm the `<meta name="viewport">`
  already disables user-scale; if not, do NOT change the meta tag, just `preventDefault` + set
  `touch-action: none` on the image). On `touchend`/`touchcancel` with `< 2` fingers, if the
  settled scale is `< 1.05`, snap back to `1` (avoid a stuck near-1 zoom).
- **Reset triggers:** lightbox `closeVisual` (already in `createLightbox`), gallery image swap
  (the existing `im.addEventListener("click", …)` block in `openGallery`, lines ~465–470 — reset
  zoom on the swapped image before/after the src change), and `dblclick` (desktop).
- **`prefers-reduced-motion`:** zoom is instant (no transition) under
  `@media (prefers-reduced-motion: reduce)`. Otherwise a short `transition: transform 120ms` on the
  image is fine for the wheel/notch stepping — but **not** during an active pinch (the transition
  lags the fingers). Toggle a class like `.zooming` on the image during pinch that disables the
  transition; remove it on `touchend`.

## Implementation sketch (the agent may deviate if it has a cleaner shape, but the seams are fixed)

```js
// inside createLightbox, after the existing body/modal/lockEl setup:
let zoomScale = 1;
let zoomImg = null;          // the <img> currently being zoomed (or null)
let pinchStartDist = 0;
let pinchStartScale = 1;

const setZoom = (img, s) => {
  zoomScale = Math.max(1, Math.min(4, s));
  img.style.transform = `scale(${zoomScale})`;
  img.classList.toggle("zoomed", zoomScale > 1.001);
};
const resetZoom = () => {
  if (zoomImg) { setZoom(zoomImg, 1); zoomImg = null; }
};

// wheel — desktop. Attach per-image after open(), or delegate on body.
body.addEventListener("wheel", (e) => {
  const img = e.target.closest(".media-img, .gallery-img");
  if (!img) return;
  e.preventDefault();
  zoomImg = img;
  setZoom(img, (zoomImg.style.transform ? zoomScale : 1) * Math.exp(-e.deltaY * 0.0015));
}, { passive: false });

// dblclick resets
body.addEventListener("dblclick", (e) => {
  const img = e.target.closest(".media-img, .gallery-img");
  if (!img) return;
  setZoom(img, 1);
});

// pinch — touch. Two-finger only.
body.addEventListener("touchstart", (e) => {
  if (e.touches.length !== 2) return;
  const img = e.target.closest(".media-img, .gallery-img");
  if (!img) return;
  zoomImg = img;
  pinchStartDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX,
                              e.touches[0].clientY - e.touches[1].clientY);
  pinchStartScale = zoomScale;
  img.classList.add("zooming"); // disable transition during pinch
}, { passive: true });
body.addEventListener("touchmove", (e) => {
  if (e.touches.length !== 2 || !zoomImg) return;
  e.preventDefault();
  const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX,
                       e.touches[0].clientY - e.touches[1].clientY);
  setZoom(zoomImg, pinchStartScale * (d / (pinchStartDist || 1)));
}, { passive: false });
body.addEventListener("touchend", (e) => {
  if (e.touches.length >= 2 || !zoomImg) return;
  zoomImg.classList.remove("zooming");
  if (zoomScale < 1.05) setZoom(zoomImg, 1);
}, { passive: true });
```

Then in `closeVisual`, call `resetZoom()` before `body.innerHTML = ""`. In `openGallery`'s
per-image click handler, call `resetZoom()` (or `setZoom(im, 1)`) before swapping `im.src`.

CSS additions in `browse.css` near the existing `.media-img` rule:

```css
.media-img, .gallery-img {
    transform-origin: center center;
    transition: transform 120ms var(--ease);
    touch-action: pan-y pinch-zoom; /* allow vertical scroll-close (C3), capture pinch */
}
.media-img.zooming, .gallery-img.zooming {
    transition: none;
}
@media (prefers-reduced-motion: reduce) {
    .media-img, .gallery-img { transition: none; }
}
```

**Note on `touch-action`:** if C3 ("swipe-to-pan + swipe-far-to-close") lands later, the
`touch-action` value here may need to change to `none` when zoomed (so the swipe closes instead of
pans). For THIS task, `pan-y pinch-zoom` is correct — vertical swipes pass through (page scroll,
which is locked anyway via `lockScrollEl`), horizontal swipes do nothing special yet. Do NOT
pre-implement C3's pan; that's a separate spec.

## Acceptance

1. **Wheel zoom (desktop):** open a single-image lightbox, mouse-wheel over the image → it zooms
   smoothly; the page does not scroll. Wheel up zooms in, wheel down out. Caps at 4×, floors at 1×.
   `dblclick` resets to 1×.
2. **Pinch zoom (touch, Pixel-6):** open an image lightbox, two-finger pinch in/out → image scales
   between 1× and 4×. Releasing with a near-1 scale snaps back to 1×. The page behind does not
   move (the `lockScrollEl` scroll-lock from the shipped C1 already covers this; verify it still
   holds during a pinch).
3. **Gallery:** open a multi-image gallery, pinch-zoom the **tapped** image only; tapping to
   upgrade to the full-res original resets the zoom first (no janky scaled-then-swapped state).
4. **Close resets:** close the lightbox (backdrop / Esc / OS-back) → next open starts at 1×. No
   leftover `transform` style on a recycled image node.
5. **Reduced motion:** with `prefers-reduced-motion: reduce`, zoom snaps (no 120ms transition).
6. **Video path untouched:** `openVideo` lightbox still plays normally; the zoom listeners don't
   fire on `<video>` (the `closest(".media-img, .gallery-img")` returns null).

## Validation block (the agent runs this before reporting done)

```
# 1. Unit suite — no new failures vs main (the 5 known env failures are pre-existing).
git stash  # if any uncommitted noise
python -m pytest -q -m "not ui" 2>&1 | tail -20
git stash pop

# 2. Confirm the 5 known env failures are the ONLY failures on main, and your branch adds none:
git checkout main
python -m pytest tests/test_rsm_threads.py tests/test_hackernews.py tests/test_connectors.py::test_hackernews_favorite_db -q 2>&1 | tail -8
git checkout delegate/c2-lightbox-zoom
python -m pytest -q -m "not ui" 2>&1 | tail -20   # same 5, no more

# 3. UI smoke (manual; agent runs the server, the human reviews on device if available):
python -m content_hoarder serve --db data/app.db   # or a synthetic temp DB
# then open http://127.0.0.1:8788, click an image item, mouse-wheel zoom, Esc to close.
# If chromium is installed: pytest -m ui -k lightbox  # only if such a test exists; do NOT write a new one in this task.

# 4. SW cache version bumped:
grep 'const CACHE' src/content_hoarder/static/sw.js   # -> "ch-shell-v78"
grep 'APP_VERSION' src/content_hoarder/static/browse/main.js | head -1   # -> "v74"
```

## Report back (the agent fills this in)

- Branch: `delegate/c2-lightbox-zoom`
- Files changed:
- Unit suite result (same 5 env failures, no new):
- UI smoke result (what the agent verified locally; what it couldn't):
- Deviations from the sketch + why:
- Anything punted to C3 (pan/close) or to T1:
