# Overnight build batch — specs index

Status: **EXECUTED (backend) 2026-06-14.** Specs **01, 02, 03, 07 SHIPPED to `main`** via the Fireworks
bakeoff + a delegated subagent — 01 `b92fe63` (glm-5p1), 02 `bb5b1d8` (subagent), 03 `254cb91` (qwen3p7-plus),
07 = verified no-op (already imported). Frontend specs **04/05/06 NOT built** — no objective offline test
(weak bakeoff substrate), deferred. Base is now `254cb91`. The run-order/gates below are the original plan (historical).
Created 2026-06-14.

Context: frontend-v3 *design* work is parked pending Fable 5 (see memory `frontend-v3-parked`).
These are the **non-design, offline-testable backlog features** safe to build unsupervised.
Each is grounded in a real-code dossier (signatures + file:line verified 2026-06-14).

## The batch (7 items)

| Spec | Feature | BACKLOG | Tier | Touches | Effort |
|---|---|---|---|---|---|
| [01](01-search-model-b.md) | Model B multi-value search (`source:a,b`, repeat=OR) | Epic 12 #335 | A | backend (search_query.py, db.py) | med |
| [02](02-http-helper-unify.md) | Unify the 4 HTTP timeout/retry helpers | Epic 19 #540 | A | backend (new `_http.py`) | med |
| [03](03-archive-fallback-threads.md) | Archive fallback for deleted threads (404) | Epic 24 #749 | A | backend (reddit_hydrate, archival) | med-high |
| [04](04-hn-nav-chips.md) | HN author link + article chip | Epic 15 #471/#473 | B | frontend (browse/render.js) | low |
| [05](05-reddit-image-opens-thread.md) | Reddit image-link opens comments thread | Epic 15 #468 | B | frontend (browse/main.js) | low |
| [06](06-sync-newest-and-relabel.md) | "Sync newest" in browse + relabel drain | Epic 9 #240/#243 | B | frontend + route | med |
| [07](07-firefox-tabexports-import.md) | Import remaining Firefox TabExports | Epic 7 #135 | data | CLI data job (live DB) | low |

Plus [parity-ideas.md](parity-ideas.md) — cross-item-type parity features (suggestions, not yet queued).

## Recommended run order & branching

One feature branch per spec, off `main`, so each stays independently reviewable/revertible:
`feat/search-model-b`, `feat/http-unify`, `feat/archive-fallback`, `feat/hn-nav-chips`,
`feat/reddit-image-thread`, `feat/sync-newest`, `chore/import-tabexports`.

Order (low-risk → higher, so a failure late doesn't block easy wins):
1. **04 HN chips** + **05 reddit-image** (smallest, preview-verifiable) — warm up.
2. **01 Model B search** (clean backend, big value).
3. **02 HTTP unify** (mechanical refactor; do after 01 so the suite baseline is fresh).
4. **06 Sync-newest** (route + browse wiring).
5. **03 Archive fallback** (meatiest; has decision gates pre-decided in its spec).
6. **07 TabExports import** — **LAST and SEPARATELY**: it writes the live `data/app.db`. Auto-backup
   first (mirror `cmd_delete`'s `conn.backup()`), import the 163 files, verify counts, then STOP.

## Verification gates (autonomous-mode)

- Capture the baseline: `python -m pytest` count BEFORE any change (record pass/fail + names).
- Every code spec: new offline tests + full suite green; "no regressions" only vs the recorded baseline.
- Frontend specs (04/05/06): preview-verify per `claude-preview-verify` (seed items via `models.new_item`).
- **No irreversible external actions.** 07 backs up the DB first. Nothing hits live Reddit/network
  in tests. Do NOT run the hydration backfill or anything that mutates live data beyond 07's import.
- Commit per-branch with the `Co-Authored-By` trailer; do NOT push or merge to main — leave branches
  for Kenja's review unless the handoff paste says otherwise.

## Premise corrections found during grounding (read before building)

- **06:** `#btn-sync` on `/reddit` ALREADY reads "Sync newest"; the mislabeled button is
  `#ru-sync-triage` ("Sync now") in triage — `#ru-sync` does not exist. The browse view has NO sync
  control yet (that's the build).
- **07:** the firefox connector is single-file only (`can_import` requires `p.is_file()`), so loop
  over the 163 files; `import` has NO built-in backup — add one.
- **03:** a 404 is currently indistinguishable from a network blip (both → `network_error`); the spec
  adds a distinct signal. Decision gates (marker location, status name) are pre-decided in spec 03.

## Later additions (post-batch)

- [08](08-reddit-title-hydration.md) — Hydrate real titles for "(untitled)" Reddit **comments**
  (`submission_title`). ✅ SHIPPED 2026-06-15 (Phase 1 + 2, on main); branch `feat/reddit-title-hydration` off
  `staging/session-2026-06-14`. 106 local-backfillable, 41 network, 3 deleted. Supersedes the
  `73e16ab` body-snippet stopgap. **Mutates live `data/app.db` — backup first.**
- [09](09-devstral-batch.md) — Devstral batch of offline-backend backlog tasks. **Task A (HN
  comment-thread viewer backend) ✅ SHIPPED 2026-06-25** (`92c8877`: `hn_thread.py` + route +
  16 tests). Task B (note→youtube promotion) is in progress in a continue.dev worktree;
  Tasks C (note-body edit backend) + D (HN favorites auto-sync) not started.
