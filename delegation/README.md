# T2 delegation batch — 2026-06-27

Five self-contained frontend tasks carved off the just-shipped mobile-polish sprint for parallel
T2 agents in **separate git worktrees**. The remaining (more complex) mobile-polish items stay on
T1 — see "Not in this batch" below.

## Outcome (2026-06-27)

Three of five tasks were attempted by T2 agents and merged into **`staging/mobile-polish-t2`**:

| Task | Branch | Outcome |
|------|--------|--------|
| `c2-lightbox-zoom` | `delegate/c2-lightbox-zoom` (commit `ae3925c`) | ✅ Merged. Pinch + wheel zoom, 1×–4× clamp, full CSS (transform-origin/transition/touch-action/`.zooming`/reduced-motion). Faithful to spec. |
| `b4-hold-to-preview` | `delegate/b4-hold-to-preview` (commit `1e93bb5`) | ✅ Merged. 250ms hold → peek, window-level release listener, click-after-peek suppression, `{peek}` threaded through all `openMediaFor` branches. Faithful to spec. |
| `p3-relay-icon-only` | `delegate/p3-relay-icon-only` (commit `664f0f1`) | ✅ Merged. Sr-only labels, 64×72 buttons, 32px icons, narrow-screen shrink, `title` attrs. Faithful to spec. |
| `c3-lightbox-pan-close` | — | ⏸ Not started (was serial-after-C2; now unblocked — spec ready). |
| `a2-no-feed-refresh-on-triage` | — | ❌ Not attempted. No worktree, branch, stash, or reflog trace. Spec is current and ready for T1. |

**Staging validation:** `python -m pytest -q -m "not ui"` → same 5 known env failures, no new.
`python -m pytest -m ui` → 20 passed, 1 skipped. JS syntax valid across all touched files. App
serves the merged JS/CSS/HTML with no conflict markers. SW cache bumped to `ch-shell-v83`.

**Merge notes:**
- Order: P3 → C2 → B4 (P3 first as the cleanest; C2 next; B4 last since it touches the most).
- Two conflicts, both resolved: `sw.js` (each branch set a different cache version → picked v83
  with a combined comment) and `core/media.js` (C2's zoom state + B4's peek-release helper both
  inserted after the same `videoTeardown` line → kept both blocks; the `close()` cleanup and
  `closeVisual`'s `resetZoom()` call auto-merged cleanly below the conflict).
- `APP_VERSION` in `main.js` auto-merged (all three branches set it to `v74`).
- The sage-moth worktree had a duplicate P3 layer on top of C2 (an agent conflated tasks);
  discarded that uncommitted layer, used the zinc-comet P3 branch instead.

**Still pending on T1:**
- **A2** — spec ready, unattempted. The implementation sketch (an `{fromReader:true}` option on
  `act()` that skips `clearItemFirstPageCache` + `render()`) is current; `snooze()` needs the same
  treatment.
- **C3** — spec ready, unblocked. Builds on C2's zoom state inside `createLightbox`.
- **Real-device verification** of B4 (swipe/long-press race, click-after-peek) and C2 (real
  two-finger pinch on a Pixel-6) — the unit + UI smoke suites can't exercise these.
- **E2 scroll-deceleration** — needs diagnosis before fix; was always T1.

## How to run an agent on one of these (for the remaining tasks)

Each task has its own spec file in this directory. The agent:

1. Creates a worktree from `main`:
   ```
   git worktree add -b delegate/<task-id> ../content-hoarder-<task-id> main
   cd ../content-hoarder-<task-id>
   ```
   (Worktree paths live **outside** the main repo dir so the agent's edits don't pollute the
   primary working tree. The `worktrees/` dir inside the repo is `.gitignore`d and stays empty.)
2. Reads its spec file (`delegation/<SPEC>.md`) end-to-end **and** the files it names.
3. Implements, runs the validation block at the bottom of its spec, commits.
4. Reports back: branch name, files touched, test results, anything it punted on.

## Shared context every agent must read first

- `AGENTS.md` (repo root) — architecture, the source-badge contract, the recovery-chain shapes,
  the merge_upsert non-destructive rule, and the **hard rules** (never commit `*.db` / exports /
  `.env`; tests stay offline + deterministic).
- `docs/QA-CHECKLIST.md` — the manual acceptance bar; the "Reader triage dock" + "Media viewer"
  sections are the relevant ones for this batch.
- `docs/design/mobile-nav-redesign/relay-observations.md` — the Relay-for-Reddit reference the
  relay strip + lightbox gestures are modeled on. The agent should NOT copy Relay wholesale; it
  implements the spec, which already distilled the relevant observations.

## Cross-cutting rules for this batch

1. **One task per worktree.** Don't touch files outside the spec's "Files in scope" list. If a
   change is needed elsewhere, note it in the report and stop.
2. **Bump the service-worker cache version** on any shipped UI change. `src/content_hoarder/static/sw.js`
   line 7: `const CACHE = "ch-shell-v77";`. Each spec names its next version string — use it. The
   `APP_VERSION` constant in `static/browse/main.js` (~line 1637) bumps in lockstep.
3. **No backend / DB / Python changes.** All five tasks are pure frontend (JS / CSS / HTML
   template). If a task seems to need a backend change, the spec is wrong — stop and report.
4. **Validation = the unit suite + the spec's UI smoke check.** Don't run the Playwright `tests/ui/`
   suite unless the spec says to; it needs `pip install -e .[ui] && playwright install chromium`
   and may not be available in the worktree env. The spec's "UI smoke" is a manual `serve` + click
   check; the agent runs the unit suite (`python -m pytest -q -m "not ui"`) to prove no regressions.
5. **Known-failing tests on `main` are NOT yours to fix.** Five tests fail on this machine for
   environmental reasons (pytest `tmp_path` resolves to a `//?/` UNC path that breaks
   `sqlite3.connect(file:…, uri=True)`):
   - `tests/test_rsm_threads.py` (4 tests)
   - `tests/test_hackernews.py::test_hn_saved_and_read`
   - `tests/test_connectors.py::test_hackernews_favorite_db`

   Confirm they were already failing on `main` before your change (`git stash && python -m pytest
   <those> -q; git stash pop`). If your change adds **new** failures, that's yours. If it only
   leaves those five failing, you're clean.
6. **Commit message** per the global AGENTS.md commit style. One commit per task is fine; squash
   WIP commits before reporting done.
7. **Don't reformat unrelated code.** Surgical edits; preserve surrounding style.

## Tasks in this batch

| ID | Spec | Scope summary | SW cache |
|----|------|---------------|----------|
| `c2-lightbox-zoom` | `SPEC-c2-lightbox-zoom.md` | Pinch-zoom + mouse-wheel zoom in the lightbox | `ch-shell-v78` |
| `c3-lightbox-pan-close` | `SPEC-c3-lightbox-pan-close.md` | Swipe-to-pan (zoomed) + swipe-far-to-close | `ch-shell-v79` |
| `a2-no-feed-refresh-on-triage` | `SPEC-a2-no-feed-refresh-on-triage.md` | Reader triage must not refetch / reflow the feed | `ch-shell-v80` |
| `b4-hold-to-preview` | `SPEC-b4-hold-to-preview.md` | Press-and-hold a thumbnail → temporary lightbox peek | `ch-shell-v81` |
| `p3-relay-icon-only` | `SPEC-p3-relay-icon-only.md` | Drop text labels from the relay strip, enlarge icons | `ch-shell-v82` |

**Dependency note:** `c2` and `c3` both extend `core/media.js createLightbox` and touch the same
CSS block. Run them in **separate worktrees** and merge `c2` before rebasing `c3` (or merge `c3`
first and rebase `c2` — either order works, but expect a small conflict in `createLightbox`'s
close/reset path). `a2`, `b4`, `p3` are independent of each other and of the lightbox pair —
safe to run in parallel with anything.

## Not in this batch (stays on T1)

- **E2 — scroll-deceleration physics** (`BACKLOG.md` ~L1028). Needs a diagnostic pass before any
  fix; the symptom (overshoot / abrupt stop on fling-to-top) could be `scroll-behavior:smooth`,
  the loadMore trigger, or the `.console.compact` scroll handler. T2 would guess; T1 diagnoses.
- **Epic 20 P2 — triage visual rework.** Design bakeoff; needs the `frontend-design` skill.
- **Mobile-friendly `/reddit` view** (Epic 16 P3). Larger; design judgment.
- **Pinch-zoom gesture coordination with `b4` hold-to-preview.** If both ship, the lightbox's
  pinch handler and `b4`'s pointer hold must not fight over the same `pointerdown`. The specs
  are written to keep them on different elements (`b4` listens on `[data-media]`; `c2` listens
  inside the lightbox modal), but a real-device pass after both land is the final check — T1.

## Merging the worktrees back

After the agents report done, T1 (you, the orchestrator) will:

1. For each branch: re-review the diff, run `python -m pytest -q -m "not ui"`, run the spec's UI
   smoke check on the real device if it had one.
2. Merge in this order to minimize conflicts: `p3-relay-icon-only` → `a2-no-feed-refresh-on-triage`
   → `b4-hold-to-preview` → `c2-lightbox-zoom` → `c3-lightbox-pan-close` (rebase `c3` onto the
   merged `c2`).
3. After all five land on `main`, do one combined SW-cache bump pass if any version strings
   drifted, then a full Playwright `pytest -m ui` run on the integration branch before tagging.
