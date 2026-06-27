# Mobile UX polish batch — 2026-06-26

A batch of mobile-app friction items from a real usage session, folded into BACKLOG.md (Epics 15 + 16).
This file sequences them into **startable, closable** chunks with the literal next action for each.
Many are independent → parallelizable across sandbox agents (disjoint write scopes noted per group).

> **Source of truth:** the items live in `BACKLOG.md` under Epic 15 (reader/navigation) + Epic 16
> (mobile/lightbox/tagging). This file is the **execution plan** — groupings, sequencing, and the
> delegation shape. Delete it once the batch is shipped.

---

## Group A — Reader triage flow (Epic 15) · sequential, design-gated first

| # | Item | Status |
|---|------|--------|
| A1 | Reader triage dock rework (GLM-5.2 design bakeoff) | ✅ **DONE** |
| A2 | Don't refresh the feed on reader Done/Archive/Keep | **pending** (after A1) |
| A3 | Reddit thread thumbnail → reader (not iframe) | ✅ **DONE** |

**Next action (A1):** Hand the dock rework to GLM-5.2 with the `frontend-design` skill loaded. Scope: a
thumb-reachable dock honoring friction-asymmetry (Archive/Done cheapest, Keep pricier, Snooze between).
The current `.rd-foot` (4 flat buttons, `index.html:277-280`) + the F/A/D key shortcuts are the baseline.
**Lock the design via visual review before build.**

**Next action (A3 — can start now):** In `main.js openMediaFor` (~L534), add a predicate: if the item
has no lightboxable media (`!imageUrl(item)` and `media_type` not in `{image,gallery,reddit_video}`)
→ route to `readerUI.open(item)` instead of the lightbox. Mirror the empty-gallery gate at L549.

---

## Group B — Browse row gestures + menus (Epic 16)

| # | Item | Status |
|---|------|--------|
| B1 | Snooze on extended left swipe (browse row) | ✅ **DONE** |
| B2 | Remove Snooze from the long-press row menu | ✅ **DONE** |
| B3 | Relay-style long-press: pan + extended menu | ✅ **DONE** |
| B4 | Hold-to-preview media (Relay press-and-hold lightbox) | pending |

**Next action (B1):** Add `onLeftLong: () => snooze(fn)` to the `attachSwipe` call at `main.js:248-255`,
mirroring the existing `onRightLong` (Keep) threshold + underlay swap. Then B2 = delete the
`[data-rowmenu="snooze"]` branch at L1399 + the button in `index.html`.

**Next action (B3):** Design bakeoff candidate — hand to GLM-5.2 with the `frontend-design` skill.
Reference: Relay for reddit's long-press (item pans aside, extended menu fans out in-place). Must
coexist with the swipe gesture (B1) + the Android edge deadzone.

---

## Group C — Lightbox / media viewer (Epic 16)

| # | Item | Status |
|---|------|--------|
| C1 | Scroll-lock the browse list while lightbox open | ✅ **DONE** |
| C2 | Pinch-zoom + mouse-wheel zoom | pending (builds on C1) |
| C3 | Swipe-to-pan + swipe-far-to-close (Relay-style) | pending (builds on C1) |

**Next action:** C2 + C3 touch `core/media.js createLightbox` — do them in one pass. The swipe-close
must call the lightbox's `close()` (which `popOverlay`s from the history stack), not a raw `history.back()`.

---

## Group D — Mobile tagging UX (Epic 16) · ✅ DONE 2026-06-26

---

## Group E — Polish / feel (Epic 16)

| # | Item | Status |
|---|------|--------|
| E1 | Sidebar open → defocus + scroll-lock browse | ✅ **DONE** |
| E2 | Scroll-deceleration physics (rapid scroll to top) | pending (low priority) |
| E3 | Surprise-me view rework | ✅ **DONE** |

---

## Status summary

- ✅ **DONE:** A1, A3, B1, B2, B3, C1, D1-D4, E1, E3 (11 items)
- **Pending:** A2 (no-refresh-on-done), B4 (hold-to-preview), C2 (pinch-zoom), C3 (swipe-to-pan/close), E2 (scroll physics) (5 items)

## Remaining sequencing

1. **Design bakeoff (GLM-5.2, `frontend-design` skill):** A1 (reader dock), B3 (Relay long-press),
   E3 (surprise-me). Lock all three via visual review before build.
2. **After A1 lands:** A2 (no-refresh-on-done — pairs with the dock).
3. **After C1 lands:** C2 + C3 (zoom + pan — build on the lock).
4. **Whenever:** B4 (hold-to-preview), E2 (scroll physics — low priority).
