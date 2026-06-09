# Version the FTS build marker

## Model: devstral

`src/content_hoarder/db.py` gates the one-time external-content FTS rebuild behind a boolean
`settings` marker. Because it's boolean, **adding a new FTS table later (as already happened
with `items_trgm`) never backfills DBs that set the marker before that table existed** —
fuzzy search silently misses old rows. Make the marker an integer version.

## Context — current code (src/content_hoarder/db.py)

```python
def _ensure_fts_built(conn: sqlite3.Connection) -> None:
    """One-time rebuild of the external-content FTS indexes, gated by a marker."""
    if conn.execute("SELECT 1 FROM settings WHERE key='fts_built'").fetchone():
        return
    has_rows = conn.execute("SELECT EXISTS(SELECT 1 FROM items)").fetchone()[0]
    if has_rows:
        conn.execute("INSERT INTO items_fts(items_fts) VALUES('rebuild')")
        conn.execute("INSERT INTO items_trgm(items_trgm) VALUES('rebuild')")
    conn.execute("INSERT OR REPLACE INTO settings(key, value) VALUES('fts_built', '1')")
```

Notes:
- `init_db()` calls `_ensure_fts_built(conn)` on **every** connection — the early-return path
  must stay a single cheap SELECT.
- Existing DBs in the wild have `fts_built = '1'`.
- The `items_fts` and `items_trgm` virtual tables use `content='items'`; the rebuild command
  is the special `INSERT INTO tbl(tbl) VALUES('rebuild')` form (never `INSERT ... SELECT`).
- Fuzzy search goes through `search_items(conn, "...", fuzzy=True)` which MATCHes
  `items_trgm`.

## Requirements

1. Add a module constant near the schema definitions:
   ```python
   # Bump when an FTS table is added/changed so upgraded DBs rebuild once (the marker
   # stores the version that was last built; a boolean marker can never re-trigger).
   _FTS_VERSION = 2
   ```
2. Rewrite `_ensure_fts_built`:
   - Read the marker value. Parse with `int(...)` under try/except `(TypeError, ValueError)`
     → treat unparseable/missing as `0`.
   - If parsed value `>= _FTS_VERSION` → return (the hot path, unchanged cost).
   - Otherwise rebuild **both** tables when `items` has rows, then store
     `str(_FTS_VERSION)`.
   - Legacy `'1'` DBs therefore rebuild exactly once on first connect after upgrade —
     mention that in the docstring.
3. Test in `tests/test_db.py` (fixtures: `conn` is an in-memory connected DB; `tmp_db` is a
   path string — use `tmp_db` here since the marker must survive a re-`connect`):
   ```python
   def test_fts_marker_version_triggers_rebuild(tmp_db):
       conn = db.connect(tmp_db)
       db.merge_upsert(conn, models.new_item(source="x", source_id="1", title="hello fuzzy world"))
       conn.commit()
       # Simulate a legacy DB: trgm index emptied + old boolean marker.
       conn.execute("DROP TABLE items_trgm")
       conn.execute("UPDATE settings SET value='1' WHERE key='fts_built'")
       conn.commit()
       conn.close()
       conn = db.connect(tmp_db)   # recreates items_trgm empty; version bump must rebuild it
       hits = db.search_items(conn, "helo fuzy", fuzzy=True)
       assert any(r["fullname"] == "x:1" for r in hits)
   ```
   (Adapt imports to the file's existing style; `models` is `content_hoarder.models`.)

## Constraints

- Key name stays `fts_built` (no second settings row).
- No behavior change for a fresh DB beyond the stored value being `'2'`.
- Keep the function's single-SELECT early-return performance.

## Acceptance

`python -m pytest tests/test_db.py --basetemp .pytest-tmp -q`

## Output

Unified diff only (db.py + test_db.py).
