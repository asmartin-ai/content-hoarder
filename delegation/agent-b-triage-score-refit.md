# Agent B — Triage-score feedback loop (periodic re-fit + drift signal)

> **Sandbox-safe.** Pure compute over the DB; no network, no live DB. `:memory:` SQLite +
> synthetic fixtures. Isolated to `triage_score.py` + one `cli.py` subcommand.

## Context (from BACKLOG.md Epic 10 #472)

The "likely-done" triage score (`triage_score.py`) learns from triage history which items the
user tends to process. It is currently **fit once** via `learn-triage` (dry-run default,
`--apply` writes `metadata.triage_score` + persists the model to `settings.triage_model`).

Open item: **re-fit periodically (or after every N triage actions) so the score tracks drift
in what the user cares about.** This is the feedback loop — today the model is static until a
human re-runs `learn-triage --apply`.

## Write scope (only these)

- `src/content_hoarder/triage_score.py` — add the drift detection + an incremental-refit entry
- `src/content_hoarder/cli.py` — add **one** subcommand (e.g. `learn-triage --check-drift` or
  a sibling `triage-drift`) exposing the new capability. **Append your argparse setup at the
  END of the existing argparse block** so it doesn't collide with Agent D's `cli.py` addition.

**Do not touch** `db.py`, `web.py`, `resurface.py`, `search_query.py`, connectors, or any
frontend file. You only need to read rows the DB already exposes and write to
`settings.triage_model` (via `db.set_setting`, the existing seam).

## What exists (verified anchors — read these first)

- `triage_score.py` (read the whole file — it's ~190 lines):
  - `fit(conn, *, min_support=20, alpha=50.0)` → model dict (version, fitted_utc, trained_on,
    processed count, prior, per-feature `[n, k, rate]` table).
  - `learn(conn, *, apply=False, …)` → fits + (with `apply`) writes scores + persists model.
  - `MODEL_SETTING_KEY = "triage_model"` is where the model JSON lives in `settings`.
  - `db.set_setting(conn, key, json)` / `db.get_setting(conn, key)` are the persistence seam.
  - Training already **excludes decayed/swept rows** (the `WHERE json_extract(metadata,
    '$.decayed_at') IS NULL AND … '$.decay_label' IS NULL` clause) — keep that invariant.
- `cli.py` — find `cmd_learn_triage` (the existing `learn-triage` subcommand) and mirror its
  shape (dry-run default, `--apply` gate, clear summary output). It already reads the live DB
  connection the right way.

## Build

The goal is a **drift signal + re-fit trigger**, not a background scheduler (no always-on
process; the user runs the CLI). Two halves:

1. **Drift detection** — `def drift(prev_model: dict, curr_model: dict) -> dict` in
   `triage_score.py`. Pure function (no DB). Compares two fitted models and reports how much
   the world moved since the last fit:
   - `features_added`, `features_dropped` (newly-supported vs fell-below-`min_support`).
   - `rate_drift`: for features present in both, the max + mean absolute change in `rate`, and
     a sorted top-N of the biggest movers (feature, old_rate, new_rate, delta).
   - `prior_drift`: change in the global processed-prior.
   - A single summary number suitable for a CLI one-liner, e.g. `drift_score` = mean abs
     `rate` delta across shared features (0 = no drift).
   This is the oracle for "is it worth re-applying scores."

2. **`triage-drift` CLI** (or `learn-triage --check-drift` — pick one, document it): loads the
   persisted model from `settings.triage_model`, re-fits on the current rows, prints the drift
   report. With `--apply`: re-runs the full `learn(..., apply=True)` (refit + rescore inbox +
   persist). Dry-run (default) prints the report only — **no writes**. Mirror the existing
   `learn-triage` dry-run/`--apply` safety shape exactly.

   Optional (low effort, high value): a `--since-processed <utc>` flag so a caller can refit
   only when N new triage actions have happened since the last fit (compare
   `model.fitted_utc` vs `COUNT(*) WHERE processed_utc > fitted_utc`). Print that count in the
   dry-run report as "N new decisions since last fit."

## Guardrails

- **Synchronous** — plain functions, no async (AGENTS.md gotcha).
- **No network**, no live DB writes in tests. The CLI `--apply` writes the model + rescors
  inbox rows exactly as the existing `learn-triage --apply` does — that's the only write, and
  it's user-gated.
- Preserve the **decay-exclusion** training invariant verbatim.
- Don't change the model `version` schema or the on-disk `metadata.triage_score` shape — this
  is additive (a drift report + a re-apply path), not a model redesign. If you must bump
  `version`, document the migration.
- Don't fold in the local-LLM or heuristic-category extra features (that's a separate Epic 10
  #472 sub-item) — drift/refit only.

## Tests (the oracle)

Add `tests/test_triage_score_drift.py` (mirror the existing `tests/test_triage_score*.py`
style — `:memory:` SQLite, synthetic rows via `models.new_item`):

1. `drift()` on two identical models → zero drift, empty added/dropped.
2. Add rows that push a feature over `min_support` → it appears in `features_added`; drop
   enough rows that another falls below → `features_dropped`.
3. Craft two models where a feature's `rate` moved meaningfully → `rate_drift` top-mover lists
   it with the right delta; `drift_score` > 0.
4. CLI: `triage-drift` dry-run prints a report and **writes nothing** (assert
   `settings.triage_model` unchanged). `--apply` rewrites the model + rescors (assert
   `fitted_utc` advanced and inbox rows carry fresh `triage_score`).
5. Decay invariant: rows stamped `metadata.decayed_at` are excluded from the refit just as in
   `fit()`.

`python -m pytest` stays green vs baseline.

## Done when

- `triage_score.drift()` exists, is pure, and is unit-tested.
- `triage-drift` (or `learn-triage --check-drift`) prints a drift report; `--apply` refits +
  rescors + persists, mirroring `learn-triage`'s safety shape.
- New tests + full suite green vs baseline.
- Committed on `feat/triage-score-drift`; not pushed/merged.
