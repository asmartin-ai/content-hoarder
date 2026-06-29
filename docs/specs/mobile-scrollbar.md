# Mobile fast-scroll handle — implementation spec

> Snapshot as of 2026-06-29.

**Epic:** 16 (Mobile UX) · **Priority:** P3 · **Tier:** T3 after spec

## What

A Nova-Launcher-style fast-scroll handle on the right edge of the browse list.
A narrow draggable pill that appears on touch-start near the right edge, lets the
user scrub to any position in the list instantly, and fades out on release.

## Design

- **Appearance:** a thin (~4px wide, ~36px tall) rounded pill, semi-transparent
  (`var(--text-dim)` at ~40% opacity), positioned `fixed` on the right edge of the
  viewport (respecting `env(safe-area-inset-right)`).
- **Behavior:** appears on `pointerdown` within 24px of the right viewport edge
  while the finger is over the `#items` list. Tracks vertical `pointermove` —
  maps finger Y to scroll position proportionally (`scrollTop = (fingerY / listHeight) * scrollHeight`).
  Fades out 300ms after `pointerup`/`pointercancel`.
- **State:** hidden by default (`opacity:0`); becomes visible (`opacity:0.4`)
  during drag. No haptics needed (the scroll position is the feedback).
- **Throttle:** rAF-throttled pointermove handler (mirrors existing scroll-to-top button).
- **Touch target:** the detection zone is 24px from the right edge (generous enough
  to hit, narrow enough not to steal horizontal swipes). The visible pill is narrower
  (4px) — purely visual indicator; the hit area is the detection zone.

## Implementation scope

### New file: `src/content_hoarder/static/browse/fastscroll.js`
ES module exporting `installFastScroll(listEl)`:
- `pointerdown` listener on `listEl`: if `clientX > window.innerWidth - 24`, enter drag mode
- `pointermove` (window-level, rAF-throttled): map Y to scroll position
- `pointerup`/`pointercancel`: exit drag mode, fade out after 300ms
- Create/destroy a single DOM node (`.fastscroll-handle`) on demand
- Import and call from `browse/main.js` init

### CSS: `src/content_hoarder/static/browse/browse.css`
```css
.fastscroll-handle {
  position: fixed;
  right: max(6px, env(safe-area-inset-right, 6px));
  top: 0;
  width: 4px;
  height: 36px;
  border-radius: 4px;
  background: var(--text-dim);
  opacity: 0;
  transform: translateY(var(--fastscroll-y, 0px));
  transition: opacity 0.3s var(--ease);
  pointer-events: none;
  z-index: 50;
}
.fastscroll-handle.active { opacity: 0.4; }
@media (prefers-reduced-motion: reduce) {
  .fastscroll-handle { transition: none; }
}
```

### Integration: `browse/main.js`
- Import `installFastScroll` from `./fastscroll.js`
- Call `installFastScroll(document.getElementById("items"))` during init
- No template changes needed

### Service worker: `sw.js`
- Version bump (add `fastscroll.js` to shell cache)
- `APP_VERSION` bump in `browse/main.js`

## Validation
- Playwright test: touch-start near right edge, drag down, verify scroll position moves;
  release, verify handle fades; verify handle does NOT appear on left-edge touch.
- Verify `env(safe-area-inset-right)` respected on notched devices.
- Verify `prefers-reduced-motion` disables fade transition.
- Verify no horizontal scroll/page-shift when the handle appears.

## Non-goals
- No alphabetical-jump indicator (contacts-app style A-Z scrubber) — the list is
  sorted, not alphabetical.
- No scrollbar replacement on desktop — desktop keeps native scrollbar.
- No haptic feedback — the scroll movement is the feedback.
