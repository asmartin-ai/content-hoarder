## Role & tier
You are the EXECUTOR for one bounded task handed down by a T1-frontier orchestrator.
Do exactly the task; do not re-scope, refactor beyond it, or touch unrelated files.

## Environment
- User: Kenja. OS: Windows.
- CWD / repo root: K:\Projects\content-hoarder (branch feat/46-mobile-fastscroll)
- Use --edit-format diff style edits.

## Task: fastscroll visual jitter polish (#46 follow-up)
The mobile fast-scroll bar in src/content_hoarder/static/browse/fastscroll.js has visual jitter during handle drag. Four root causes, fix all of them:

### 1. fastscroll.js — freeze metrics during drag (lines 82-100, 115-123)
Currently scrubToTrackY() calls metrics() on every requestAnimationFrame frame while dragging. metrics() calls getComputedStyle(bar) and reads se.scrollHeight each time — both force synchronous style/layout recalculation per frame, stalling the compositor.
Fix:
- In onPointerDown (near line 138), compute metrics() ONCE and store the result in a `let dragMt = null;` closure variable.
- scrubToTrackY(clientY) must use the stored dragMt while dragging instead of calling metrics() again. Keep the exact same math (rel, targetTop clamp, ratio, se.scrollTop write, handle transform write).
- In endDrag (near line 181), clear dragMt.
- Content cannot change mid-drag (infinite scroll is already paused by isFastScrollScrubbing), so a frozen snapshot is safe.

### 2. fastscroll.js — defer layout() while dragging (near line 102)
The MutationObserver / resize handler can call layout() mid-drag, rewriting handle.style.transform and height and fighting the finger.
Fix: at the top of layout(), if `dragging` is true, set a `layoutPending = true` flag and return. In endDrag, after dragging is set false, if layoutPending is true, clear it and call layout().

### 3. fastscroll.js — add ResizeObserver (near lines 228-237)
The MutationObserver watches childList only; image loads change document scrollHeight WITHOUT a DOM mutation, leaving the handle stale.
Fix: alongside the existing MutationObserver, create a ResizeObserver observing document.body that schedules the SAME rAF-coalesced layout (reuse the identical `if (layoutRaf) return; layoutRaf = requestAnimationFrame(...)` pattern — extract that scheduling into a small helper function, e.g. `scheduleLayout()`, and use it from both observers). Guard with `typeof ResizeObserver !== "undefined"` so tests/old engines do not crash. Disconnect it in the returned teardown function.

### 4. fastscroll.js + browse.css — suppress opacity transition at grab
When the finger presses the bar, the CSS `transition: opacity 0.25s var(--ease)` on .fastscroll-bar fires (0.32 to 0.85) at the same time the handle starts moving — reads as a jump.
Fix:
- fastscroll.js: in onPointerDown add `bar.classList.add("dragging")`; in endDrag remove it (immediately at drag end, not after the settle timer).
- browse.css: after the `.fastscroll-bar.active` rule (around line 2360-2362), add:

.fastscroll-bar.dragging {
  transition: none;
}

### 5. browse.css — soften handle color flip (line 2382)
The rule `.fastscroll-bar.active .fastscroll-handle { background: var(--accent); }` flips instantly.
Fix: Add `transition: background 0.15s var(--ease);` to the `.fastscroll-handle` rule (the one with will-change, around line 2372-2381). Also, inside the existing `@media (prefers-reduced-motion: reduce)` block at lines 2385-2389, add `.fastscroll-handle { transition: none; }` alongside the existing .fastscroll-bar rule.

### 6. Version bumps (repo convention, lockstep)
- src/content_hoarder/static/browse/main.js: APP_VERSION string "v122" to "v123".
- src/content_hoarder/static/sw.js: CACHE name "ch-shell-v122" to "ch-shell-v123".
Touch NOTHING else in these two files.

### 7. tests/ui/test_fastscroll.py — two new regression tests
Follow the existing test_fastscroll_dragging_handle_scrubs_document style (synthetic PointerEvent dispatch on .fastscroll-bar via page.evaluate, pointerId 9, pointerType touch). Add:

a) test_fastscroll_mid_drag_mutation_does_not_move_handle(pixel6_page):
- _wait_rows(page); pointerdown on the handle center, pointermove to 50% of viewport height. Then record handle.getBoundingClientRect().
- While still dragging (no pointerup yet), append a tall div: `const d = document.createElement('div'); d.style.height = '3000px'; document.querySelector('#items').appendChild(d);`, wait 2 animation frames (page.wait_for_timeout(100)).
- Assert handle rect is unchanged (the deferred-layout guard holds it in place).
- Then dispatch pointerup. Keep within one page.evaluate Promise.

b) test_fastscroll_dragging_class_toggles(pixel6_page):
- _wait_rows(page); dispatch pointerdown on handle center. Wait 50ms. Assert `.fastscroll-bar` has classList "dragging". Dispatch pointerup. Wait 50ms. Assert "dragging" is gone.

## Done-when
- All 7 change items applied exactly; no other files touched.
- Do NOT run pytest. The orchestrator verifies.
