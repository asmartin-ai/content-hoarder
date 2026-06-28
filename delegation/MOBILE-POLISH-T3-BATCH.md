# T3 delegation batch — 2026-06-27 (mobile polish regression fixes)

The T2 mobile-polish sprint (`staging/mobile-polish-t2`) shipped 17 items but the real-device pass
surfaced 8 regressions + 1 missing feature. This batch fixes them via parallel T2 sub-agents in
**separate git worktrees** branched off **`staging/mobile-polish-t2`** (NOT `main` — T2 hasn't merged
to main yet, and these fixes build directly on T2's code).

## Source of the bug list

`MOBILE-POLISH-BATCH.md` records what T2 shipped. The 8 user-reported regressions came from a
real-device session on the staging branch 2026-06-27:

1. Swipe-left reveals blank space after long-press (relay + swipe interaction broken)
2. Swipe-right from relay-open state does not close the relay strip
3. Hold-to-preview media opens/closes the lightbox repeatedly (peek flicker)
4. Only 1 tag suggestion shown in the tag editor (D1 was supposed to surface 3)
5. Vertical swipe on the lightbox scrolls the underlying page instead of closing the lightbox
6. Scrolling with the sidebar (navdrawer) open still scrolls the browse view
7. The reader `.rd-foot` triage dock looks wrong — **drop it** (user will redesign later)
8. **No UX verification tooling** — Playwright harness exists but covers none of these gestures

## Outcome (2026-06-27, planned — fill in as agents report)

| Task | Branch | Method | Outcome |
|------|--------|--------|--------|
| `t3-relay-swipe-close` | `delegate/t3-relay-swipe-close` | T2 sub-agent | (pending) |
| `t3-peek-flicker` | `delegate/t3-peek-flicker` | T2 sub-agent | (pending) |
| `t3-tag-suggest-three` | `delegate/t3-tag-suggest-three` | T2 sub-agent | (pending) |
| `t3-lightbox-swipe-scroll` | `delegate/t3-lightbox-swipe-scroll` | T2 sub-agent | (pending) |
| `t3-sidebar-scroll-lock` | `delegate/t3-sidebar-scroll-lock` | T2 sub-agent | (pending) |
| `t3-drop-reader-dock` | `delegate/t3-drop-reader-dock` | T2 sub-agent | (pending) |
| `t3-playwright-ux-tests` | `delegate/t3-playwright-ux-tests` | T2 sub-agent | (pending) |

**Staging target:** `staging/mobile-polish-t3`, branched off `staging/mobile-polish-t2`.

## How to run an agent on one of these

Each task has its own spec file in this directory (`SPEC-t3-<id>.md`). The agent:

1. Creates a worktree from `staging/mobile-polish-t2` (NOT `main`):
   ```
   git worktree add -b delegate/t3-<task-id> ../content-hoarder-t3-<task-id> staging/mobile-polish-t2
   cd ../content-hoarder-t3-<task-id>
   ```
2. Reads its spec file (`delegation/SPEC-t3-<id>.md`) end-to-end **and** the files it names.
3. Implements, runs the validation block at the bottom of its spec, commits.
4. Reports back: branch name, files touched, test results, anything it punted on.

## Shared context every agent must read first

- `AGENTS.md` (repo root) — architecture, the source-badge contract, the recovery-chain shapes,
  the merge_upsert non-destructive rule, and the **hard rules** (never commit `*.db` / exports /
  `.env`; tests stay offline + deterministic). The "Mobile / PWA rules" section in
  `.agents/skills/frontend-design/SKILL.md` is also required reading for any UI task.
- `delegation/MOBILE-POLISH-BATCH.md` — what T2 shipped and the design decisions locked for it.
  Several T3 fixes correct T2 regressions, so the agent needs to know what T2 was *trying* to do.
- `delegation/README.md` — the T2 batch README. Its "Cross-cutting rules" + "Known-failing tests"
  sections apply identically here.

## Cross-cutting rules for this batch (carry over from T2, with diffs)

1. **One task per worktree.** Don't touch files outside the spec's "Files in scope" list. If a
   change is needed elsewhere, note it in the report and stop.
2. **Branch off `staging/mobile-polish-t2`, not `main`.** All T3 fixes build on T2's code (e.g.
   `t3-peek-flicker` patches B4's hold-to-preview, which only exists on staging). Branching off
   `main` would force the agent to re-implement T2 first.
3. **Bump the service-worker cache version on any shipped UI change.** `src/content_hoarder/static/sw.js`
   line 7: `const CACHE = "ch-shell-v86";` (current on staging). Each spec names its next version
   string — use it. The `APP_VERSION` constant in `static/browse/main.js` bumps in lockstep.
4. **No backend / DB / Python changes** except in `t3-playwright-ux-tests` (which adds test files
   only — still no app Python). All other tasks are pure frontend (JS / CSS / HTML template).
5. **Validation = the unit suite + the spec's UI smoke check.** The unit suite
   (`python -m pytest -q -m "not ui"`) must show **no new failures** vs the baseline below. The
   spec's "UI smoke" is a manual `serve` + click check (or, for `t3-playwright-ux-tests`, the
   new Playwright tests themselves).
6. **Known-failing tests are NOT yours to fix.** The same 5 env failures from T2 still fail on
   this machine (`tmp_path` resolves to a `//?/` UNC path that breaks `sqlite3.connect(file:…,
   uri=True)`):
   - `tests/test_rsm_threads.py` (4 tests)
   - `tests/test_hackernews.py::test_hn_saved_and_read`
   - `tests/test_connectors.py::test_hackernews_favorite_db`

   Confirm they were already failing on `staging/mobile-polish-t2` before your change
   (`git stash && python -m pytest <those> -q; git stash pop`). If your change adds **new**
   failures, that's yours. If it only leaves those five failing, you're clean.
7. **Commit message** per the global AGENTS.md commit style. One commit per task is fine; squash
   WIP commits before reporting done.
8. **Don't reformat unrelated code.** Surgical edits; preserve surrounding style.
9. **The relay strip + hold-to-preview share pointer handlers on the same `itemsEl`.**
   `t3-relay-swipe-close` and `t3-peek-flicker` both touch `browse/main.js`'s `itemsEl`
   pointerdown/up handlers and `core/swipe.js`. Run them in **separate worktrees** and expect a
   conflict in `itemsEl.addEventListener("pointerdown", …)` when merging. Merge
   `t3-relay-swipe-close` first (it restructures the swipe path), then rebase
   `t3-peek-flicker` onto it.
10. **The lightbox pointer handlers and `t3-lightbox-swipe-scroll` overlap with C3's pan/close
    code.** That's expected — the fix patches C3. Branch off staging (which has C3), edit in place.

## Tasks in this batch

| ID | Spec | Scope summary | SW cache |
|----|------|---------------|----------|
| `t3-relay-swipe-close` | `SPEC-t3-relay-swipe-close.md` | Fix blank-space-on-left-swipe + swipe-right-doesn't-close-relay | `ch-shell-v87` |
| `t3-peek-flicker` | `SPEC-t3-peek-flicker.md` | Fix hold-to-preview opening/closing the lightbox repeatedly | `ch-shell-v88` |
| `t3-tag-suggest-three` | `SPEC-t3-tag-suggest-three.md` | Always show 3 tag suggestions (backfill tags when <2 categories) | `ch-shell-v89` |
| `t3-lightbox-swipe-scroll` | `SPEC-t3-lightbox-swipe-scroll.md` | Lightbox vertical drag must close, not scroll the page | `ch-shell-v90` |
| `t3-sidebar-scroll-lock` | `SPEC-t3-sidebar-scroll-lock.md` | Lock body scroll (not just #items) when sidebar/dock opens | `ch-shell-v91` |
| `t3-drop-reader-dock` | `SPEC-t3-drop-reader-dock.md` | Remove the `.rd-foot` triage dock + its handlers; reader relies on swipe/keys | `ch-shell-v92` |
| `t3-playwright-ux-tests` | `SPEC-t3-playwright-ux-tests.md` | Add Playwright tests for relay, peek, tag-suggest, lightbox-swipe, sidebar-lock | (none — test-only) |

## Dependency + merge order

```
t3-relay-swipe-close   ──┐
t3-peek-flicker        ──┴──> merge relay first, rebase peek onto it (shared itemsEl pointerdown)
t3-tag-suggest-three   ─────> independent
t3-lightbox-swipe-scroll ──> independent (patches C3 in place)
t3-sidebar-scroll-lock ────> independent
t3-drop-reader-dock    ────> independent (removes code; do before t3-playwright-ux-tests merges so
                              the dock tests don't get written then deleted)
t3-playwright-ux-tests ────> merge LAST so its assertions match the final shipped behavior
```

Suggested merge order onto `staging/mobile-polish-t3`:

1. `t3-drop-reader-dock` (deletion — clean base for the rest)
2. `t3-relay-swipe-close`
3. `t3-peek-flicker` (rebase onto #2)
4. `t3-tag-suggest-three`
5. `t3-lightbox-swipe-scroll`
6. `t3-sidebar-scroll-lock`
7. `t3-playwright-ux-tests` (last — assertions match final shipped behavior)

After all seven land on `staging/mobile-polish-t3`, run the full Playwright `pytest -m ui` suite
on the integration branch before promoting to `main`.

## Not in this batch (stays on T1)

- **Real-device verification** of the fixes (Pixel-6). The Playwright suite covers what it can, but
  swipe/long-press/pinch races need a real finger. T1 does the final device pass.
- **E2 — scroll-deceleration physics** (BACKLOG.md ~L1028). Still needs a diagnostic pass; not a
  regression from T2, just still broken. Carries over from the T2 batch's "Not in this batch" list.
- **Redesigning the reader triage dock.** `t3-drop-reader-dock` removes it; the user will design
  its replacement in a later session. Don't sneak a redesign into the deletion task.
- **Epic 20 P2 — triage visual rework.** Design bakeoff; needs the `frontend-design` skill.

## Merging the worktrees back

After the agents report done, T1 (you, the orchestrator) will:

1. For each branch: re-review the diff, run `python -m pytest -q -m "not ui"`, run the spec's UI
   smoke check on the real device if it had one.
2. Merge in the order above to minimize conflicts.
3. After all seven land on `staging/mobile-polish-t3`, do one combined SW-cache bump pass if any
   version strings drifted, then a full Playwright `pytest -m ui` run on the integration branch
   before tagging.
4. Promote `staging/mobile-polish-t3` to `main` once the device pass is clean.
