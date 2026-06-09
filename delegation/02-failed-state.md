# Unsave queue: cap retry attempts → state='failed'

## Model: qwen-3.6 (thinking on) — touches 4 files

The `reddit_unsave` table documents `state ∈ pending | done | failed`, but **nothing ever sets
`failed`** — a permanently-erroring item (Reddit answering 400/500 for it forever) is retried
on every drain for eternity, burning the 1 req/sec throttle and inflating failure counts.

## Context

`src/content_hoarder/db.py` — schema + enqueue:

```sql
CREATE TABLE IF NOT EXISTS reddit_unsave (
    fullname     TEXT PRIMARY KEY,                 -- items.fullname, e.g. "reddit:t3_abc123"
    reddit_id    TEXT NOT NULL,                    -- the t3_/t1_ fullname the API wants (== items.source_id)
    state        TEXT NOT NULL DEFAULT 'pending',  -- pending | done | failed
    attempts     INTEGER NOT NULL DEFAULT 0,
    last_error   TEXT,
    enqueued_utc INTEGER NOT NULL,
    updated_utc  INTEGER
);
```

```python
def enqueue_unsave(conn: sqlite3.Connection, fullname: str) -> None:
    ...
    conn.execute(
        "INSERT INTO reddit_unsave(fullname, reddit_id, state, enqueued_utc) "
        "VALUES(?, ?, 'pending', ?) "
        "ON CONFLICT(fullname) DO UPDATE SET state='pending', updated_utc=excluded.enqueued_utc",
        (fullname, sid, now),
    )
```

`src/content_hoarder/reddit_unsave.py` — drain's failure path (inside the per-row loop) and
the pending count:

```python
def count_pending(conn) -> int:
    return conn.execute(
        "SELECT COUNT(*) FROM reddit_unsave WHERE state='pending'"
    ).fetchone()[0]
```
```python
        else:
            conn.execute(
                "UPDATE reddit_unsave SET attempts=attempts+1, last_error=?, updated_utc=? "
                "WHERE fullname=?", (err, now, fullname))
            conn.commit()
            result["failed"] += 1
            if progress:
                progress(f"failed {reddit_id}: {err}")
```

The drain selects rows with:
```python
    sql = "SELECT fullname, reddit_id FROM reddit_unsave WHERE state='pending' ORDER BY enqueued_utc"
```

`src/content_hoarder/cli.py` — the no-args status output of `cmd_reddit_unsave`:
```python
        auth = ru.get_auth(conn)
        print(json.dumps({
            "configured": auth is not None,
            "username": auth.get("username") if auth else None,
            "enabled": db.get_setting(conn, "reddit_unsave_on_done", "0") == "1",
            "pending": ru.count_pending(conn),
        }, indent=2))
```

`src/content_hoarder/web.py` — `/reddit/unsave/status` returns the same shape
(`configured`, `username`, `enabled`, `pending`).

## Requirements

1. `reddit_unsave.py`: add `MAX_ATTEMPTS = 5` (module constant, brief why-comment).
2. Drain failure UPDATE becomes a single statement that flips state when the cap is hit:
   ```sql
   UPDATE reddit_unsave SET attempts=attempts+1, last_error=?, updated_utc=?,
       state=CASE WHEN attempts+1 >= ? THEN 'failed' ELSE state END
   WHERE fullname=?
   ```
   (bind `MAX_ATTEMPTS`).
3. Add `count_failed(conn)` next to `count_pending` (same shape, `state='failed'`).
4. `db.enqueue_unsave` ON CONFLICT clause also resets `attempts=0, last_error=NULL` — a
   re-Done item gets a fresh chance even if it previously exhausted its attempts.
5. CLI status JSON and the web `/reddit/unsave/status` payload both gain `"failed":
   ru.count_failed(conn)`.
6. Tests in `tests/test_reddit_unsave.py` (style: `_Post` class with a `decide` callback
   returning `(status, headers)`; `ru.drain(conn, post=..., getf=..., sleep=lambda s: None)`;
   `_ok_me` getf stub returns `{"data": {"name": "u", "modhash": "MH"}}`):
   - A row whose POST always returns `(500, {})`: after 5 `drain(...)` calls its state is
     `'failed'`, `attempts == 5`, and a 6th drain selects 0 rows (`result["selected"] == 0`).
   - Re-enqueueing a failed row (call `db.enqueue_unsave` again) resets it to
     `pending`/`attempts=0` and the next drain picks it up.

## Constraints

- Drain's row-selection SQL stays `state='pending'` (the CASE flip removes exhausted rows
  from future selection; no `attempts <` filter needed).
- `count_pending` semantics unchanged. `result` dict keys unchanged (`failed` still means
  "failed this run").
- Don't touch `_send_with_retry` or the injectable parameters.

## Acceptance

`python -m pytest tests/test_reddit_unsave.py tests/test_web.py --basetemp .pytest-tmp -q`

## Output

Unified diff only (reddit_unsave.py, db.py, cli.py, web.py, test_reddit_unsave.py).
