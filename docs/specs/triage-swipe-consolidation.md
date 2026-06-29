# Triage swipe consolidation spec

> Snapshot as of 2026-06-29. Implemented 2026-06-29.

Source: curated from the deleted `content-hoarder-flash-triage-swipe` delegation note, 2026-06-28.

## Goal

Reduce duplicated swipe logic in `src/content_hoarder/static/triage.js` by reusing the shared `attachSwipe` helper from `src/content_hoarder/static/core/swipe.js` where it fits, without changing the current triage gesture contract.

This started as a handoff spec and now records the implemented consolidation.

## Current triage gesture contract

| Gesture | Threshold | Current action |
|---|---:|---|
| Swipe right | `dx >= 80px` | `commit("archived")` |
| Swipe left | `80px <= abs(dx) < 170px` | `commit("done")` |
| Long swipe left | `abs(dx) >= 170px` | `commitSnooze()` |
| Swipe up | `dy <= -80px` | `openCurrentInReader()` |
| Swipe down | `dy >= 80px` | `skip()` |
| Tap / short drag | under threshold | Let delegated card click handlers run |

Important existing constraints:

- Android gesture navigation safety: ignore pointer starts within `30px` of the left/right screen edge.
- Triage has no long-press action.
- Keep is not currently a triage swipe action.
- Vertical gestures are part of the triage UX and must not regress.
- Haptics are triggered by the action functions (`commit`, `commitSnooze`, `skip`, `undo`).

## Shared helper fit

`core/swipe.js` currently handles horizontal swipe decisions for browse rows/cards:

- `onRight`
- `onRightLong`
- `onLeft`
- `onLeftLong`
- `edge`
- `commit`
- `commit2`
- touch-only by default

It already had the same edge-deadzone shape and horizontal-vs-vertical decision gate. Implementation changed it to support the triage contract:

- `commit2` is enabled when either `onRightLong` **or** `onLeftLong` is present, so triage long-left snooze does not require adding a right-long Keep gesture.
- optional `onUp` / `onDown` callbacks claim vertical gestures only for callers that opt in; browse rows/cards keep native vertical scrolling.
- `haptics:false` disables helper detent pulses so triage keeps tactile feedback at the action functions (`commit`, `commitSnooze`, `skip`, `undo`).

## Recommended approach

Implemented approach: extend `core/swipe.js` slightly, then use one shared handler for triage rather than running the shared horizontal handler plus a second local vertical pointer handler on the same card.

Implemented helper changes:

- enabled `commit2` for `onLeftLong` as well as `onRightLong`;
- added optional `onUp` / `onDown` vertical callbacks, preserving browse's current vertical-scroll behavior when those callbacks are absent;
- added `haptics:false` for callers that want action-level haptics only.

Horizontal mapping:

```js
attachSwipe(card, {
  edge: EDGE_DEADZONE,
  commit: COMMIT_PX,
  commit2: LONG_LEFT_PX,
  onRight: function () { commit("archived"); },
  onLeft: function () { commit("done"); },
  onLeftLong: function () { commitSnooze(); },
});
```

Triage passes no `onRightLong`; adding a right-long Keep gesture would be a behavior change.

## Implementation cautions

- `attachSwipe` owns horizontal transforms/classes; verify its class names match triage card CSS (`swipe-arch`, `swipe-done`, `swipe-snooze`) before deleting local animation code.
- The helper has its own threshold `navigator.vibrate()` detents. Current triage haptics are action-level. Accepting the extra threshold tick may be fine, but it is a behavior change and should be reviewed on-device.
- Do not remove `suppressNextClick()` unless all remaining vertical/tap behavior still suppresses synthetic clicks correctly. The helper's suppressor is internal and does not cover a separate local vertical handler.
- Do not remove vertical swipe handling unless `core/swipe.js` grows explicit `onUp` / `onDown` support with tests.
- Keep the `30px` edge deadzone explicit even though the helper defaults to `30`; it documents the Android back-gesture requirement.

## Verification

Automated or manual checks should cover:

- Right swipe archives via `POST /items/<fn>/status` with `"archived"`.
- Left swipe marks done via `POST /items/<fn>/status` with `"done"`.
- Long-left swipe calls `/items/<fn>/snooze`.
- Up swipe opens the reader/current item.
- Down swipe skips without committing a status.
- Short tap on links/media still opens the existing target and does not commit.
- Edge starts within `30px` do not start an app gesture.
- On real Android hardware, browser back gesture and haptic feel remain acceptable.

## Relevant files

- `src/content_hoarder/static/triage.js`
- `src/content_hoarder/static/core/swipe.js`
- `tests/ui/`
