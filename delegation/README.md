# Mobile-polish delegation records — 2026-06-27

Status: **closed**. These docs are historical build records, not active work queues.

## What shipped

Two mobile-polish waves landed on `main`:

1. **T2 batch** — initial Relay/lightbox polish:
   - `c2-lightbox-zoom`: pinch + mouse-wheel zoom, 1×–4× clamp.
   - `b4-hold-to-preview`: 250ms hold-to-peek lightbox, release-to-close, click suppression.
   - `p3-relay-icon-only`: icon-only relay strip with larger touch targets and sr-only labels.
   - `c3-lightbox-pan-close`: zoomed pan + 1× swipe-far-to-close.
   - `a2-no-feed-refresh-on-triage`: reader triage updates in memory without feed reflow/refetch.

2. **T3 regression batch** — real-device follow-up fixes:
   - relay swipe-close regressions fixed;
   - hold-to-preview flicker/race fixed;
   - tag suggestions consistently show three options when candidates exist;
   - lightbox swipe-to-close no longer scrolls the page;
   - sidebar/sheet scroll locking fixed;
   - reader triage dock intentionally removed;
   - Playwright mobile UX regression tests added in `tests/ui/test_mobile_ux.py`.

## Validation record

- T2 integration validation recorded: `python -m pytest -q -m "not ui"` showed only the known Windows env failures; `python -m pytest -m ui` passed with 20 passed / 1 skipped.
- T3 added focused Playwright coverage for the mobile UX regressions.
- Some gesture details still benefit from real-device spot checks because headless Chromium cannot fully prove physical pinch/long-press feel.

## Cleanup record

The scratch worktrees and merged local branches from these batches were removed after merge:

- `delegate/a2-no-feed-refresh-on-triage`
- `delegate/b4-hold-to-preview`
- `delegate/c2-lightbox-zoom`
- `delegate/c3-lightbox-pan-close`
- `delegate/p3-relay-icon-only`
- `delegate/t3-drop-reader-dock`
- `delegate/t3-lightbox-swipe-scroll`
- `delegate/t3-peek-flicker`
- `delegate/t3-playwright-ux-tests`
- `delegate/t3-relay-swipe-close`
- `delegate/t3-sidebar-scroll-lock`
- `delegate/t3-tag-suggest-three`

The merged remote staging branch `origin/staging/mobile-polish-t2` was also deleted after confirmation that it was an ancestor of `main`.

## Current orchestration plan

Use [`NEXT-DELEGATION.md`](NEXT-DELEGATION.md) for the current agent plan: what is done, what should happen next, which tasks require T1 vs T2/T3, and which tasks can safely run in parallel.

Current mobile work should be tracked in `BACKLOG.md`, mainly:

- Epic 16: `P3 — Scroll-deceleration physics feel (rapid scroll to top)`.
- Epic 16: `P3 — Make the Reddit view mobile-friendly`.
- Real-device QA checklist spot checks in `docs/QA-CHECKLIST.md`, especially media gestures.

## Historical specs

The old completed `SPEC-*.md` files were deleted on 2026-06-28 because every task they described had already shipped and was recorded in `BACKLOG.md`, `MOBILE-POLISH-BATCH.md`, `MOBILE-POLISH-T3-BATCH.md`, and the UI tests. The two `MOBILE-POLISH-*.md` files remain as historical implementation/regression context only; do not treat their branch/worktree instructions as current unless a new batch explicitly reactivates them.
