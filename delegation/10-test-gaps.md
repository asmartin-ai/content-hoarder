# Fill three test gaps: rsm_threads, youtube_recover edges, NSFW rules missing

## Model: qwen-3.6 (thinking on) — tests only, three areas

## Gap A — `rsm_threads.migrate_threads` has no direct test

Full source of `src/content_hoarder/rsm_threads.py` (it is short):

```python
import sqlite3
from pathlib import Path

from content_hoarder import db


def migrate_threads(conn: sqlite3.Connection, rsm_db_path, *, only_existing: bool = True) -> dict:
    """Copy non-empty RSM ``thread_json`` rows into ``reddit_threads``.

    With ``only_existing`` (default), threads whose item isn't present locally are
    skipped so we don't accumulate orphans. Returns ``{migrated, skipped}``.
    """
    src = Path(rsm_db_path)
    if not src.is_file():
        raise ValueError(f"RSM database not found: {src}")
    ro = sqlite3.connect(f"file:{src.as_posix()}?mode=ro", uri=True)
    ro.row_factory = sqlite3.Row
    migrated = skipped = 0
    try:
        cur = ro.execute(
            "SELECT fullname, thread_json, hydrated_at FROM items "
            "WHERE thread_json IS NOT NULL AND thread_json <> ''"
        )
        for row in cur:
            rid = (row["fullname"] or "").strip()
            if not rid:
                skipped += 1
                continue
            fn = rid if rid.startswith("reddit:") else f"reddit:{rid}"
            if only_existing and db.get_item(conn, fn) is None:
                skipped += 1
                continue
            db.set_reddit_thread(conn, fn, row["thread_json"], row["hydrated_at"], commit=False)
            migrated += 1
    finally:
        ro.close()
    conn.commit()
    return {"migrated": migrated, "skipped": skipped}
```

Create `tests/test_rsm_threads.py`. Build a fake RSM DB at `tmp_path / "rsm.db"` with
`sqlite3`: `CREATE TABLE items (fullname TEXT, thread_json TEXT, hydrated_at INTEGER)`, then
insert rows. Local items seed via `db.merge_upsert(conn, models.new_item(source="reddit",
source_id="t3_x", ...))` on the `conn` fixture (in-memory, from tests/conftest.py). Read back
with `db.get_reddit_thread(conn, "reddit:t3_x")` → `{"thread_json", "hydrated_at"}` or None.

Tests:
1. Bare `t3_x` fullname is re-keyed to `reddit:t3_x`; an already-prefixed `reddit:t3_y` row
   is kept as-is (seed both locally; both migrate).
2. `only_existing=True` skips a thread with no local item (counted in `skipped`);
   `only_existing=False` migrates it anyway.
3. Blank/whitespace fullname rows are skipped, not crashed on.
4. Missing RSM path raises `ValueError`.
5. Empty `thread_json` rows are excluded by the SQL (insert one; it appears in neither count).

## Gap B — `youtube_recover` only tests the happy path

Relevant source (src/content_hoarder/youtube_recover.py):

```python
def recover_title(vid: str, *, get=_http_get) -> str:
    """Return a recovered title for a YouTube video id via Wayback, or '' if none."""
    if not vid:
        return ""
    watch = f"https://www.youtube.com/watch?v={vid}"
    api = _WAYBACK_AVAILABLE + urllib.parse.quote(watch, safe="")
    try:
        data = json.loads(get(api))
    except (urllib.error.URLError, OSError, ValueError):
        return ""
    snap = ((data or {}).get("archived_snapshots") or {}).get("closest") or {}
    if not snap.get("available") or not snap.get("url"):
        return ""
    try:
        html = get(snap["url"])
    except (urllib.error.URLError, OSError):
        return ""
    title = _extract_title(html)
    return "" if title.lower() in _PLACEHOLDER_TITLES else title
```

`_extract_title` pulls `og:title` content (attribute-order agnostic, back-referenced quotes)
falling back to `<title>`, strips a trailing `" - YouTube"`. `get` is injectable: a callable
`(url) -> str` (it may raise).

Add to `tests/test_youtube_recover.py` (match its existing injectable style):
1. `get` raising `TimeoutError` on the availability call → `recover_title` returns `""`
   (no crash). Note: `TimeoutError` is an `OSError` subclass — that's why it's caught.
2. Availability OK but `get` raises `urllib.error.URLError("x")` on the snapshot fetch → `""`.
3. Snapshot HTML with **no** og:title and **no** `<title>` tag at all → `""`.
4. og:title using single quotes with an apostrophe inside double... use:
   `<meta property='og:title' content='It&#39;s a title'/>` → returns `It's a title`
   (entities unescaped).
5. HTML whose extracted title is `[Deleted video] - YouTube` → `""` (placeholder rejected
   case-insensitively after suffix strip).

## Gap C — categorize: missing nsfw_rules.json must degrade gracefully

Relevant source (src/content_hoarder/categorize.py): `_load_nsfw_rules(path)` is
`@lru_cache`d and returns empty rule sets when the file is missing/unparseable; `_nsfw_tag`
then only ever yields `nsfw_other` for `over_18` items. The path comes from
`config.get("CONTENT_HOARDER_NSFW_RULES")`.

Add to `tests/test_categorize_reddit.py` (it tests `categorize.reddit_tags(item)` where item
is `{"title": ..., "metadata": {"subreddit": ..., ...}}`):
1. With `CONTENT_HOARDER_NSFW_RULES` pointed at a **unique non-existent path**
   (`monkeypatch.setenv("CONTENT_HOARDER_NSFW_RULES", str(tmp_path / "nope.json"))` — unique
   so the `lru_cache` on the old path doesn't serve a stale hit), `reddit_tags` on a mapped
   subreddit still returns its topic tags, no exception, and no `nsfw_*` tag.
2. Same setup but `metadata={"subreddit": "x", "over_18": 1}` → tags include `nsfw_other`
   (the residual still works without rules).

## Constraints

- Tests only; no production-code changes anywhere.
- Offline; no network. Follow each existing test file's conventions.

## Acceptance

`python -m pytest tests/test_rsm_threads.py tests/test_youtube_recover.py tests/test_categorize_reddit.py --basetemp .pytest-tmp -q`

## Output

Unified diff only (new tests/test_rsm_threads.py + additions to the two existing test files).
