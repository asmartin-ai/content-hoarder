# CH-B7 delegation spec — Triage high-skip-bucket detection

## Role & tier
You are the EXECUTOR for one bounded task handed down by a T1-frontier orchestrator.
Do exactly the task; do not re-scope, refactor beyond it, or touch unrelated files.

## Environment
- User: Kenja. OS: Windows.
- CWD / repo root: K:\Projects\content-hoarder
- Python exe: K:\Projects\content-hoarder\.venv\Scripts\python.exe
- pytest path args: forward slashes (K:/Projects/content-hoarder/tests/test_bakeoff_ch_b7_high_skip_buckets.py).

## Edit format (NON-NEGOTIABLE)
- Use --edit-format diff.

## Goal
Make `tests/test_bakeoff_ch_b7_high_skip_buckets.py` pass without modifying the test file.

The oracle pins this contract:
- `triage_score.high_skip_buckets(model, *, min_skip_rate=0.9, min_support=2)`
  returns the feature buckets of a fitted triage model whose skip-rate is at or
  above `min_skip_rate` (i.e. processed-rate <= 1 - min_skip_rate), provided
  the bucket's support `n` is at least `min_support`.

  "Skip rate" = 1 - processed_rate. A bucket with `processed_rate` near 0
  (the user almost never processes items from this bucket) is a high-skip bucket.

- The function accepts a fitted model dict (as produced by `triage_score.fit`)
  and returns a list of dicts, one per qualifying bucket.
- Each returned dict MUST identify the bucket via a `feature` key (the feature
  string) and report `n` (support), `k` (processed count), `processed_rate`,
  and `skip_rate = 1 - processed_rate`.
- A bucket with high skip rate (e.g. `processed_rate=0.0`, skip_rate=1.0) AND
  `n >= min_support` MUST appear in the result.
- A bucket with low skip rate (`processed_rate` near 1, skip_rate near 0) MUST
  NOT appear.
- A bucket with high skip rate but `n < min_support` MUST NOT appear
  (low-confidence buckets excluded).
- `min_skip_rate` and `min_support` MUST be honored when passed as keyword
  arguments. The default is `min_skip_rate=0.9, min_support=2`.
- The threshold comparison is inclusive: a bucket with `skip_rate == min_skip_rate`
  IS included (e.g. `min_skip_rate=0.9`, `skip_rate=0.9` → included).

The model dict shape (from `triage_score.fit`) is:
```python
{
    "version": 1,
    "fitted_utc": <int>,
    "trained_on": <int>,
    "processed": <int>,
    "prior": <float>,
    "alpha": <float>,
    "min_support": <int>,    # the fit-time min_support; high_skip_buckets's min_support is independent
    "features": {
        "<feature_key>": [<n>, <k>, <rate>],
        ...                # [n, k, rate] tuple/list — rate is the processed_rate (k/n smoothed)
    }
}
```

## Files in scope (the ONLY files you may edit)
- `src/content_hoarder/triage_score.py`

## Approach (suggested)
1. Add `def high_skip_buckets(model, *, min_skip_rate=0.9, min_support=2) -> list[dict]:`
2. Iterate `model["features"].items()`. For each `(feature, (n, k, rate))`:
   - Skip if `n < min_support`.
   - Compute `processed_rate = rate` (the stored rate IS the processed rate).
   - Compute `skip_rate = 1.0 - processed_rate`.
   - If `skip_rate >= min_skip_rate`: append `{"feature": feature, "n": n, "k": k,
     "processed_rate": processed_rate, "skip_rate": skip_rate}` to the result.
3. Return the list (sorted by feature name for determinism, or by skip_rate
   desc then feature — the test only checks membership, not order, so either
   is fine; sorting by feature name is the most deterministic).

## Invariants (must hold)
- The existing `fit`, `score_item`, `drift`, `learn`, `drift_report` functions
  are unchanged (additive only — don't refactor them).
- Don't edit the test file.

## Done-when
- `K:\Projects\content-hoarder\.venv\Scripts\python.exe -m pytest
   K:/Projects/content-hoarder/tests/test_bakeoff_ch_b7_high_skip_buckets.py -q` exits 0
  (all 6 oracle tests pass).
- The full pre-existing suite still passes.
- The oracle test file's hash is unchanged.
- `git status -s` shows ONLY `src/content_hoarder/triage_score.py` modified.
