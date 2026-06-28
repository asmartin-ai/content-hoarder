# Next delegation plan — 2026-06-28

Purpose: this is the current handoff for orchestrating agents after the mobile-polish batches. The old
`SPEC-*.md` task specs in this directory were deleted because every named task had already shipped and
was recorded in `MOBILE-POLISH-BATCH.md`, `MOBILE-POLISH-T3-BATCH.md`, `BACKLOG.md`, and the UI tests.

## Current state: what is done

Confirmed from the current docs/code state:

- **T2 mobile polish batch is closed.** Shipped: reader triage no-feed-refresh, Reddit thumbnail → reader,
  snooze long-left swipe, relay-style row menu, hold-to-preview, lightbox zoom/pan/close, sidebar/lightbox
  scroll-lock, mobile tag-editor flow, and surprise-me card rework.
- **T3 regression batch is closed and merged to `main`.** Shipped: relay swipe-close fixes, peek flicker
  guard, 3 tag suggestions, lightbox swipe no-scroll, body scroll-lock for drawers/sheets, reader dock
  removal, and `tests/ui/test_mobile_ux.py` regression coverage.
- **Reader triage dock is not current UI.** It shipped in T2, was rejected on device, and was deliberately
  removed by T3. Do not resurrect `.rd-foot` unless there is a new design decision.
- **Backlog already records the mobile completions.** Epic 16 has the per-item T3 entries, and the older
  reader-dock backlog wording has been reconciled to "shipped then removed" in the working tree.
- **QA checklist already reflects the current mobile state.** `docs/QA-CHECKLIST.md` includes the no-dock
  reader state and marks the shipped gesture features as needing real-device spot checks rather than rebuilds.

## Tier definitions

Use these tiers when assigning work:

| Tier | Use for | Avoid giving it |
|---|---|---|
| **T3** | Mechanical edits with a clear oracle: CSS-only polish, docs reconciliation, fixture/test additions, small UI test coverage. | Ambiguous design, external APIs, live/private data, destructive actions, multi-file architecture seams. |
| **T2** | Bounded implementation with tests: one feature seam, offline fixtures, dry-run default, easy review surface. | Irreversible external actions, UX taste decisions, broad refactors, unclear schemas/API docs. |
| **T1** | Diagnosis, orchestration, design gates, live-data decisions, safety-sensitive flows, cross-cutting architecture. | Routine test/spec/doc work that can be parallelized safely. |

## Immediate T1 decision gates before delegating

These are next because they unblock safe parallel work:

1. **Real-device mobile QA pass** on Pixel-6-class Chrome PWA.
   - Check: hold-to-preview, physical pinch, zoomed pan clamp, 1× swipe-to-close, reader no-feed-refresh,
     drawer/sheet scroll-lock, tag editor no-keyboard path.
   - Output: either "verified" or one bug per finding in `BACKLOG.md` with a repro.
2. **Scroll-deceleration diagnosis** for Epic 16 E2.
   - Do not hand this directly to T2/T3 yet. First capture a repro and identify whether the culprit is
     smooth-scroll, native fling interaction, infinite `loadMore`, top-button behavior, or compact-header scroll handling.
3. **Pick one implementation batch.** The strongest next batches are listed below; do not run all at once.

## Good parallel batches

### Batch A — QA + small UI polish (mostly T3, safe to run now)

This batch is low-risk and can run in parallel because the write sets are mostly disjoint.

| ID | Tier | Task | Write scope | Parallel notes |
|---|---:|---|---|---|
| `qa-mobile-story-coverage` | T3 | Add/extend Playwright coverage for one uncovered QA story. | `tests/ui/*` only unless a test fixture helper is needed. | Can run with any non-test task. Use synthetic data; no live DB. |
| `focus-mode-wide-desktop` | T3 | Epic 14: make Focus mode wider on desktop, mobile unchanged. | Likely `src/content_hoarder/static/browse/browse.css`; maybe template if needed. | UI cache bump needed. Avoid parallel CSS merges with another CSS-only task unless assigning line scopes. |
| `qa-doc-reconcile` | T3 | Reconcile QA/backlog/delegation wording after the latest pass. | `docs/QA-CHECKLIST.md`, `BACKLOG.md`, `delegation/*.md`. | Can run with code tasks, but merge last to reflect final state. |
| `app-icon-assets` | T3 after asset decision | Replace icon assets for the approved backwards-E/H mark. | `src/content_hoarder/static/icon.svg`, PNG icons, manifest. | Needs a visual/asset decision first; otherwise keep on T1. |

Recommended merge order for Batch A: tests → CSS/assets → docs. T1 should do the final service-worker cache
version reconciliation after UI assets/CSS merge.

### Batch B — Bounded feature implementation (T2, after T1 supplies decisions/samples)

Current kickoff notes live in [`BATCH-B-START.md`](BATCH-B-START.md). The first active implementation spec is
[`SPEC-redgifs-resolver-dryrun.md`](SPEC-redgifs-resolver-dryrun.md).

These can run in parallel if each agent is assigned the listed write scope and fixtures.

| ID | Tier | Task | T1 input required | Suggested write scope | Conflict risk |
|---|---:|---|---|---|---|
| `redgifs-resolver-dryrun` | T2 | Epic 4: resolve dead Gfycat IDs against RedGifs, dry-run first. | Confirm NSFW opt-in policy; decide metadata rewrite only vs archive bytes. | New resolver/provider module + CLI/API seam + offline tests/fixtures. | Medium if it touches recovery providers. Keep archive.today code unchanged. |
| `watch-later-import-sample` | T2 | Epic 7: support WL3 / browser Watch Later export shape. | Provide a representative export sample and decide one-shot vs recurring workflow. | YouTube connector/parser tests + fixture. | Low if restricted to connector + tests. |
| `firefox-tabs-manual-push` | T2 | Epic 7: manual push of currently-open Firefox tabs. | Choose WebExtension vs bookmarklet/local endpoint vs sessionstore reader. | Chosen ingest endpoint/connector reuse + tests; maybe docs. | Medium; avoid touching generic import modal unless explicitly scoped. |
| `tag-coverage-expansion` | T2 | Epic 9/26: extend heuristic tag coverage. | T1/user names desired buckets and precision constraints. | `categorize.py` maps + dry-run tests. | Low; run after reviewing dry-run counts. |
| `keyboard-map-implementation` | T2 | Epic 5: rework keyboard controls. | Approved mapping from user/T1. | JS key handlers + `?` cheatsheet + Playwright/unit tests. | Medium; overlaps browse/triage handlers. Run alone or split browse vs triage. |

### Batch C — Research/design spikes (T1-led, maybe subagent research only)

Do not give these as direct implementation tasks yet. T1 should either do them or delegate only narrow research/output.

| Task | Why T1-led | Delegable subtask |
|---|---|---|
| Epic 16 `scroll-deceleration` | Needs real-device reproduction and careful root-cause isolation before edits. | Ask a subagent to inspect scroll handlers/CSS and list hypotheses; no edits. |
| Epic 16 mobile `/reddit` view | Design/system-level UI work; old `/reddit` is desktop-first and overlaps Epic 17 unification. | Ask a design subagent for 2–3 mobile layout proposals using `frontend-design`; no code. |
| Epic 12 OCR search | Engine choice affects dependencies, privacy, performance, and storage. | Ask one agent to compare Tesseract vs local vision on a tiny sample; another to map search wiring after `metadata.ocr_text` exists. |
| Epic 4 `v.redd.it` video archiving | Large storage/network design; can create multi-GB data and backup implications. | Ask for a dry-run design: count candidates, estimate sizes, storage shape, and skip/resume semantics. |
| Epic 4 archive.today live smoke + `/recover` opt-in | Live external service with rate limits/Cloudflare and low hit rate. | T1 runs against a DB copy; a subagent may prepare an offline-safe checklist. |
| Epic 9 bulk-unsave by tag | External irreversible-ish Reddit write path; requires dry-run/count/confirm/audit safety. | Use the `agent-money-action-safety` pattern before designing or executing. |

## Parallelization rules for subagents

1. **One task per worktree.** Use `git worktree add -b delegate/<id> ../content-hoarder-<id> main` unless T1
   explicitly names an integration branch.
2. **Disjoint write sets.** Do not run two agents against the same JS/CSS module unless T1 has split line-level
   scopes. `browse/main.js`, `core/media.js`, `core/swipe.js`, and `browse.css` are common conflict zones.
3. **Service-worker cache bumps.** Any shipped UI/asset change must bump `src/content_hoarder/static/sw.js`
   and `APP_VERSION` in `static/browse/main.js` if applicable. In a parallel batch, T1 may assign unique versions
   or do a final combined bump during integration; agents must state what they changed.
4. **No live/private data in agent tasks by default.** Agents use synthetic fixtures and `:memory:`/temporary DBs.
   Live DB copies and external network probes stay T1 unless explicitly authorized.
5. **Validation per task.** Prefer the narrowest proof first:
   - Python/backend: targeted tests, then `python -m pytest -q -m "not ui"` when feasible.
   - UI: targeted Playwright test or manual smoke; run `pytest -m ui` for merged UI batches.
   - Docs-only: no code test required, but run a status/diff review.
6. **Known Windows env failures.** Historical mobile batches saw five env-specific failures around UNC `tmp_path`
   and SQLite URI paths. Agents should report new failures separately from known baseline failures; do not rewrite
   unrelated code to silence them.
7. **Frontend design tasks must use the `frontend-design` skill.** Especially for visual redesigns, mobile `/reddit`,
   triage visual rework, app icon, and any GLM design bakeoff.

## Suggested next action

Recommended next move: run **Batch A** after the real-device QA pass. It is the smallest closeable batch and
improves confidence before bigger feature work. Done-when: no stale active specs in `delegation/`, QA findings
are either verified or filed, and any added UI tests pass locally.
