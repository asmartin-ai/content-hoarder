# Test: consolidate undo → re-migrate round-trip (test-only)

## Model: qwen-3.6 (thinking on) — TEST-ONLY; if it fails, STOP and report

`consolidate.py` supports `migrate(apply=True)` (fold posts-linking-to-YouTube into canonical
`youtube:<id>` rows, **promoting** a new keyless youtube row when none exists) and
`unconsolidate(apply=True)` (clear markers, delete promoted rows). The existing suite covers
migrate→undo (`test_undo_round_trip`, `test_undo_deletes_promoted_row` in
`tests/test_consolidate.py`) but **not undo→migrate-again** — the suspected hole is duplicate
companions or double-promotion on the second migrate.

**Write the tests only. Do not change `consolidate.py`.** If a test fails, leave it failing
and report exactly what was asserted vs observed — the fix is owned elsewhere.

## Context — existing test helpers (tests/test_consolidate.py)

```python
import json

from content_hoarder import consolidate, db, models


def _seed(conn, items):
    for kw in items:
        db.merge_upsert(conn, models.new_item(**kw))
    conn.commit()


def _youtube(vid: str, **md):
    return dict(source="youtube", source_id=vid, kind="video",
                title=f"YT {vid}", url=f"https://youtu.be/{vid}", metadata=md)


def _reddit(fullname_id: str, url: str, *, permalink: str = "", **md):
    meta = dict(md)
    if permalink:
        meta["permalink"] = permalink
    return dict(source="reddit", source_id=fullname_id, kind="post",
                title="Reddit post", url=url, metadata=meta)
```

Conventions: video ids must be 11 chars (e.g. `"Remig00001x"`); `tmp_db` fixture gives a DB
path for `db.connect(tmp_db)`; result dict of `migrate` has keys
`foldable, promoted, youtube_created, companions_added, companions_marked`;
`unconsolidate` has `promoted_rows_deleted, companions_unmarked, youtube_companions_cleared`.

## Requirements — add to tests/test_consolidate.py

1. `test_undo_then_remigrate_promoted_round_trip(tmp_db)`:
   - Seed only `_reddit("t3_rm", f"https://youtu.be/{vid}", permalink="https://www.reddit.com/r/x/comments/rm/y/")`.
   - `migrate(apply=True)` → assert `youtube_created == 1`.
   - `unconsolidate(apply=True)` → assert `promoted_rows_deleted == 1` and
     `db.get_item(conn, f"youtube:{vid}") is None`.
   - `migrate(apply=True)` **again** → assert `youtube_created == 1` (re-promoted cleanly),
     the youtube row exists exactly once
     (`SELECT COUNT(*) FROM items WHERE fullname = ?` == 1), its
     `metadata.companions` has exactly **one** entry (`reddit:t3_rm`), and the reddit row's
     `consolidated_into` points at it.
2. `test_undo_then_remigrate_fold_round_trip(tmp_db)`:
   - Seed `_youtube(vid)` **and** the reddit post.
   - migrate → undo → migrate again.
   - Assert after the second migrate: companions list length is exactly 1 (no duplicate
     companion records), `youtube_created == 0` both times, and the youtube row count for
     that fullname is 1.
3. `test_remigrate_without_undo_after_partial_state(tmp_db)` (defensive):
   - Promoted case; after the first migrate, run `migrate(apply=True)` a second time
     **without** undoing. Assert companions length stays 1 and no second youtube row appears.
     (There is an existing `test_idempotency_running_twice_does_not_double_companions` for
     the fold case — this covers the **promoted** case.)

## Constraints

- Test-only diff. No production-code edits, even if red.
- Follow the existing file's helper/use style exactly (json.loads of `metadata`, etc.).

## Acceptance

`python -m pytest tests/test_consolidate.py --basetemp .pytest-tmp -q`
Green = done. Red = stop, paste the failure output verbatim into your report.

## Output

Unified diff only (tests/test_consolidate.py), plus — if red — the verbatim pytest failure.
