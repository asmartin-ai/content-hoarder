"""SQLite data layer: schema, FTS5 search, non-destructive upsert, triage ops.

Design notes / gotchas (see AGENTS.md):
- External-content FTS5 is backfilled with ``INSERT INTO tbl(tbl) VALUES('rebuild')``
  (NEVER ``INSERT ... SELECT``); emptiness can't be detected by row count, so the
  one-time build is gated behind a ``settings`` marker.
- ``merge_upsert`` is non-destructive: it overlays only non-empty incoming fields and
  never clobbers user/triage state or ``first_seen_utc``.
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
import time

from content_hoarder.models import (
    ITEM_FIELDS,
    VALID_STATUSES,
    build_search_text,
    parse_metadata,
)

# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------

_SCHEMA = """
CREATE TABLE IF NOT EXISTS items (
    fullname        TEXT PRIMARY KEY,
    source          TEXT NOT NULL,
    source_id       TEXT NOT NULL,
    kind            TEXT NOT NULL DEFAULT 'item',
    title           TEXT NOT NULL DEFAULT '',
    body            TEXT NOT NULL DEFAULT '',
    url             TEXT NOT NULL DEFAULT '',
    author          TEXT NOT NULL DEFAULT '',
    created_utc     INTEGER NOT NULL DEFAULT 0,
    saved_utc       INTEGER NOT NULL DEFAULT 0,
    is_saved        INTEGER NOT NULL DEFAULT 1,
    first_seen_utc  INTEGER NOT NULL,
    last_seen_utc   INTEGER NOT NULL,
    hydrated_at     INTEGER,
    status          TEXT NOT NULL DEFAULT 'inbox',
    processed_utc   INTEGER,
    status_prev     TEXT,
    search_text     TEXT NOT NULL DEFAULT '',
    metadata        TEXT NOT NULL DEFAULT '{}',
    raw_json        TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_items_source       ON items(source);
CREATE INDEX IF NOT EXISTS idx_items_status       ON items(status);
CREATE INDEX IF NOT EXISTS idx_items_last_seen    ON items(last_seen_utc);
CREATE INDEX IF NOT EXISTS idx_items_created      ON items(created_utc);
CREATE INDEX IF NOT EXISTS idx_items_saved_status ON items(is_saved, status);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS auth_tokens (
    service       TEXT PRIMARY KEY,
    access_token  TEXT,
    refresh_token TEXT,
    token_type    TEXT,
    scope         TEXT,
    expires_at    INTEGER,
    username      TEXT,
    updated_utc   INTEGER
);

CREATE TABLE IF NOT EXISTS reddit_unsave (
    fullname     TEXT PRIMARY KEY,                 -- items.fullname, e.g. "reddit:t3_abc123"
    reddit_id    TEXT NOT NULL,                    -- the t3_/t1_ fullname the API wants (== items.source_id)
    state        TEXT NOT NULL DEFAULT 'pending',  -- pending | done | failed
    attempts     INTEGER NOT NULL DEFAULT 0,
    last_error   TEXT,
    enqueued_utc INTEGER NOT NULL,
    updated_utc  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_reddit_unsave_state ON reddit_unsave(state);
"""

_FTS_SCHEMA = """
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
    fullname, title, body, author, url, search_text,
    content='items', content_rowid='rowid'
);

CREATE VIRTUAL TABLE IF NOT EXISTS items_trgm USING fts5(
    search_text,
    content='items', content_rowid='rowid', tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS items_ai AFTER INSERT ON items BEGIN
    INSERT INTO items_fts(rowid, fullname, title, body, author, url, search_text)
        VALUES (new.rowid, new.fullname, new.title, new.body, new.author, new.url, new.search_text);
    INSERT INTO items_trgm(rowid, search_text) VALUES (new.rowid, new.search_text);
END;

CREATE TRIGGER IF NOT EXISTS items_ad AFTER DELETE ON items BEGIN
    INSERT INTO items_fts(items_fts, rowid, fullname, title, body, author, url, search_text)
        VALUES ('delete', old.rowid, old.fullname, old.title, old.body, old.author, old.url, old.search_text);
    INSERT INTO items_trgm(items_trgm, rowid, search_text) VALUES ('delete', old.rowid, old.search_text);
END;

CREATE TRIGGER IF NOT EXISTS items_au AFTER UPDATE ON items BEGIN
    INSERT INTO items_fts(items_fts, rowid, fullname, title, body, author, url, search_text)
        VALUES ('delete', old.rowid, old.fullname, old.title, old.body, old.author, old.url, old.search_text);
    INSERT INTO items_trgm(items_trgm, rowid, search_text) VALUES ('delete', old.rowid, old.search_text);
    INSERT INTO items_fts(rowid, fullname, title, body, author, url, search_text)
        VALUES (new.rowid, new.fullname, new.title, new.body, new.author, new.url, new.search_text);
    INSERT INTO items_trgm(rowid, search_text) VALUES (new.rowid, new.search_text);
END;
"""

_INSERT_SQL = (
    "INSERT INTO items (" + ", ".join(ITEM_FIELDS) + ") "
    "VALUES (" + ", ".join(":" + f for f in ITEM_FIELDS) + ")"
)
_UPDATE_SQL = (
    "UPDATE items SET "
    + ", ".join(f"{f}=:{f}" for f in ITEM_FIELDS if f != "fullname")
    + " WHERE fullname=:fullname"
)

# Sort keys allowed for search/browse (whitelist; rowid tiebreaker added). Values may
# be a bare column or a SQL expression (e.g. json_extract for a metadata field).
_SORT_COLUMNS = {
    "last_seen_utc": "last_seen_utc",
    "first_seen_utc": "first_seen_utc",
    # NULLIF(...,0): undated items (created_utc/saved_utc == 0, common for sparse Reddit
    # imports) are treated as unknown and sorted LAST in either direction.
    "created_utc": "NULLIF(created_utc, 0)",
    "saved_utc": "NULLIF(saved_utc, 0)",
    "title": "title",
    "status": "status",
    "source": "source",
    "duration": "CAST(json_extract(metadata, '$.duration') AS INTEGER)",
    "position": "CAST(json_extract(metadata, '$.position') AS INTEGER)",  # YouTube playlist order
}


# ---------------------------------------------------------------------------
# Connection / init
# ---------------------------------------------------------------------------

def connect(path: str | None = None) -> sqlite3.Connection:
    """Open (creating dirs as needed), configure, and initialize the database."""
    from content_hoarder import config

    p = path or config.db_path()
    if p != ":memory:":
        parent = os.path.dirname(os.path.abspath(p))
        if parent:
            os.makedirs(parent, exist_ok=True)
    conn = sqlite3.connect(p)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    # A scheduled `reddit-unsave --drain` writes the same DB as a running `serve`; wait out a
    # brief writer lock instead of failing with "database is locked".
    conn.execute("PRAGMA busy_timeout=5000")
    init_db(conn)
    return conn


def init_db(conn: sqlite3.Connection) -> None:
    """Create tables, FTS indexes, and triggers (idempotent)."""
    conn.executescript(_SCHEMA)
    conn.executescript(_FTS_SCHEMA)
    # Functional index so sorting by video length (metadata.duration) stays cheap at scale.
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_items_duration "
        "ON items(CAST(json_extract(metadata, '$.duration') AS INTEGER))"
    )
    _ensure_fts_built(conn)
    conn.commit()


def _ensure_fts_built(conn: sqlite3.Connection) -> None:
    """One-time rebuild of the external-content FTS indexes, gated by a marker."""
    if conn.execute("SELECT 1 FROM settings WHERE key='fts_built'").fetchone():
        return
    has_rows = conn.execute("SELECT EXISTS(SELECT 1 FROM items)").fetchone()[0]
    if has_rows:
        conn.execute("INSERT INTO items_fts(items_fts) VALUES('rebuild')")
        conn.execute("INSERT INTO items_trgm(items_trgm) VALUES('rebuild')")
    conn.execute("INSERT OR REPLACE INTO settings(key, value) VALUES('fts_built', '1')")


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------

def get_setting(conn: sqlite3.Connection, key: str, default=None):
    row = conn.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    return row[0] if row else default


def set_setting(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        "INSERT OR REPLACE INTO settings(key, value) VALUES(?, ?)", (key, str(value))
    )
    conn.commit()


# ---------------------------------------------------------------------------
# Row helpers
# ---------------------------------------------------------------------------

def _row_to_raw(row: sqlite3.Row) -> dict:
    """Row -> dict with metadata left as a JSON string (for internal merge)."""
    return dict(row)


def _row_to_public(row: sqlite3.Row) -> dict:
    """Row -> dict with metadata parsed into a dict (for API/UI consumers)."""
    d = dict(row)
    d["metadata"] = parse_metadata(d.get("metadata"))
    return d


def get_item(conn: sqlite3.Connection, fullname: str) -> dict | None:
    row = conn.execute("SELECT * FROM items WHERE fullname=?", (fullname,)).fetchone()
    return _row_to_raw(row) if row else None


# ---------------------------------------------------------------------------
# Upsert (non-destructive overlay)
# ---------------------------------------------------------------------------

_OVERLAY_FIELDS = ("title", "body", "url", "author")
_TIME_FIELDS = ("created_utc", "saved_utc")


def merge_upsert(conn: sqlite3.Connection, item: dict) -> str:
    """Insert a new item, or non-destructively overlay onto an existing one.

    Returns ``"inserted"`` or ``"updated"``. Never overwrites user/triage state
    (``status``, ``processed_utc``, ``status_prev``, ``is_saved``,
    ``metadata.karakeep_id``) and never moves ``first_seen_utc`` forward.
    """
    existing = get_item(conn, item["fullname"])
    if existing is None:
        conn.execute(_INSERT_SQL, item)
        return "inserted"

    merged = dict(existing)
    for f in _OVERLAY_FIELDS:
        if item.get(f):
            merged[f] = item[f]
    for f in _TIME_FIELDS:
        if item.get(f):
            merged[f] = item[f]
    # Upgrade a placeholder kind to a real one.
    if item.get("kind") and existing.get("kind") in ("", "item", None):
        merged["kind"] = item["kind"]

    # metadata: shallow-merge (incoming non-empty values win; keep prior keys).
    emd = parse_metadata(existing.get("metadata"))
    for k, v in parse_metadata(item.get("metadata")).items():
        if v not in (None, "", [], {}):
            emd[k] = v
    merged["metadata"] = json.dumps(emd, ensure_ascii=False)

    if item.get("hydrated_at"):
        merged["hydrated_at"] = item["hydrated_at"]

    # Preserve provenance + user state.
    merged["first_seen_utc"] = existing["first_seen_utc"]
    merged["last_seen_utc"] = int(item.get("last_seen_utc") or time.time())
    merged["status"] = existing["status"]
    merged["processed_utc"] = existing["processed_utc"]
    merged["status_prev"] = existing["status_prev"]
    merged["is_saved"] = existing["is_saved"]

    merged["search_text"] = build_search_text(merged, emd)
    conn.execute(_UPDATE_SQL, merged)
    return "updated"


# ---------------------------------------------------------------------------
# Search
# ---------------------------------------------------------------------------

def _fts_query(q: str) -> str:
    """Build a safe FTS5 MATCH expression. Each token is quoted so FTS5 operator
    keywords (OR/AND/NOT/NEAR) are treated as string literals, not syntax — an
    unquoted bare 'OR' would raise an fts5 syntax error and 500 the request."""
    toks = [t for t in re.split(r"\W+", q or "", flags=re.UNICODE) if t]
    return " ".join('"' + t + '"' for t in toks)


def _trigram_match(q: str) -> str:
    """OR of the query's overlapping 3-grams (typo-tolerant). '' if < 3 chars."""
    s = (q or "").strip().lower()
    if len(s) < 3:
        return ""
    grams = {s[i : i + 3] for i in range(len(s) - 2)}
    return " OR ".join('"' + g.replace('"', '""') + '"' for g in sorted(grams))


def _order_clause(sort: str, order: str, alias: str = "") -> str:
    col = _SORT_COLUMNS.get(sort or "", "last_seen_utc")
    direction = "ASC" if (order or "desc").lower() == "asc" else "DESC"
    a = (alias + ".") if alias else ""
    # Expression sort keys (json_extract/CAST) must not be table-alias-prefixed, and
    # NULLs (e.g. videos with no duration) should sort last in either direction.
    is_expr = "(" in col
    col_sql = col if is_expr else f"{a}{col}"
    nulls = " NULLS LAST" if is_expr else ""
    return f"ORDER BY {col_sql} {direction}{nulls}, {a}rowid {direction}"


def search_items(
    conn: sqlite3.Connection,
    q: str = "",
    *,
    source: str | None = None,
    kind: str | None = None,
    status: str | None = None,
    category: str | None = None,
    is_saved: int | None = None,
    open_in_firefox: bool = False,
    fuzzy: bool = False,
    sort: str = "last_seen_utc",
    order: str = "desc",
    limit: int = 50,
    offset: int = 0,
) -> list[dict]:
    """Search/browse items. Empty ``q`` => filtered recency list."""
    filters: list[str] = []
    params: list = []

    def add_filters(alias: str) -> None:
        a = (alias + ".") if alias else ""
        if source:
            filters.append(f"{a}source = ?")
            params.append(source)
        if kind:
            filters.append(f"{a}kind = ?")
            params.append(kind)
        if status:
            filters.append(f"{a}status = ?")
            params.append(status)
        if category:
            filters.append(f"json_extract({a}metadata, '$.category') = ?")
            params.append(category)
        if is_saved is not None:
            filters.append(f"{a}is_saved = ?")
            params.append(int(is_saved))
        if open_in_firefox:  # the "📑 Firefox tabs" batch (json true -> json_extract returns 1)
            filters.append(f"json_extract({a}metadata, '$.open_in_firefox') = 1")

    q = (q or "").strip()
    match_expr = ""
    fts_table = ""
    if q:
        if fuzzy:
            match_expr = _trigram_match(q)
            fts_table = "items_trgm"
        if not match_expr:  # exact (or fuzzy fell back for short queries)
            match_expr = _fts_query(q)
            fts_table = "items_fts"

    if match_expr and fts_table:
        add_filters("i")
        where = " AND ".join([f"{fts_table} MATCH ?"] + filters)
        sql = (
            f"SELECT i.* FROM items i JOIN {fts_table} ON {fts_table}.rowid = i.rowid "
            f"WHERE {where} {_order_clause(sort, order, 'i')} LIMIT ? OFFSET ?"
        )
        bind = [match_expr] + params + [int(limit), int(offset)]
    else:
        add_filters("")
        where = (" WHERE " + " AND ".join(filters)) if filters else ""
        sql = (
            f"SELECT * FROM items{where} {_order_clause(sort, order)} LIMIT ? OFFSET ?"
        )
        bind = params + [int(limit), int(offset)]

    rows = conn.execute(sql, bind).fetchall()
    return [_row_to_public(r) for r in rows]


def get_random_batch(
    conn: sqlite3.Connection,
    n: int = 20,
    *,
    source: str | None = None,
    unprocessed: bool = True,
) -> list[dict]:
    """Return up to ``n`` random items — the triage batch (default: inbox only)."""
    filters = []
    params: list = []
    if unprocessed:
        filters.append("status = 'inbox'")
    if source:
        filters.append("source = ?")
        params.append(source)
    where = (" WHERE " + " AND ".join(filters)) if filters else ""
    sql = f"SELECT * FROM items{where} ORDER BY RANDOM() LIMIT ?"
    rows = conn.execute(sql, params + [int(n)]).fetchall()
    return [_row_to_public(r) for r in rows]


# ---------------------------------------------------------------------------
# Triage operations
# ---------------------------------------------------------------------------

def _unsave_enabled(conn: sqlite3.Connection) -> bool:
    """Whether marking a reddit item 'done' should queue it for unsaving on Reddit."""
    return get_setting(conn, "reddit_unsave_on_done", "0") == "1"


def enqueue_unsave(conn: sqlite3.Connection, fullname: str) -> None:
    """Queue a reddit post/comment for unsaving (idempotent). No-op for non-reddit items.

    The reddit_id stored is items.source_id, which already carries the t3_/t1_ prefix
    the Reddit API wants. Does NOT commit — the caller commits with the status change.
    """
    row = conn.execute(
        "SELECT source, source_id FROM items WHERE fullname=?", (fullname,)
    ).fetchone()
    if row is None or row["source"] != "reddit":
        return
    sid = row["source_id"]
    if not sid.startswith(("t1_", "t3_")):
        return
    now = int(time.time())
    conn.execute(
        "INSERT INTO reddit_unsave(fullname, reddit_id, state, enqueued_utc) "
        "VALUES(?, ?, 'pending', ?) "
        "ON CONFLICT(fullname) DO UPDATE SET state='pending', updated_utc=excluded.enqueued_utc",
        (fullname, sid, now),
    )


def dequeue_unsave(conn: sqlite3.Connection, fullname: str) -> None:
    """Drop a still-pending unsave (a 'done' undone before the drain ran). Caller commits."""
    conn.execute(
        "DELETE FROM reddit_unsave WHERE fullname=? AND state='pending'", (fullname,)
    )


def enqueue_existing_done(conn: sqlite3.Connection) -> int:
    """Backfill: queue every reddit post/comment already marked 'done' for unsaving.

    Enabling the feature does not retroactively enqueue past Dones; this is the opt-in
    one-time seed. Items already queued are left untouched. Returns the number added."""
    now = int(time.time())
    before = conn.execute("SELECT COUNT(*) FROM reddit_unsave").fetchone()[0]
    conn.execute(
        "INSERT INTO reddit_unsave(fullname, reddit_id, state, enqueued_utc) "
        "SELECT fullname, source_id, 'pending', ? FROM items "
        "WHERE source='reddit' AND status='done' "
        "AND (source_id LIKE 't3\\_%' ESCAPE '\\' OR source_id LIKE 't1\\_%' ESCAPE '\\') "
        "ON CONFLICT(fullname) DO NOTHING",
        (now,),
    )
    conn.commit()
    after = conn.execute("SELECT COUNT(*) FROM reddit_unsave").fetchone()[0]
    return after - before


def set_status(conn: sqlite3.Connection, fullname: str, status: str) -> dict | None:
    """Set an item's triage status; record the previous one for undo."""
    if status not in VALID_STATUSES:
        raise ValueError(f"invalid status: {status!r}")
    row = conn.execute(
        "SELECT status FROM items WHERE fullname=?", (fullname,)
    ).fetchone()
    if row is None:
        return None
    old = row[0]
    if status == old:
        return _public_by_fullname(conn, fullname)  # idempotent; don't clobber status_prev
    now = int(time.time())
    processed = None if status == "inbox" else now
    conn.execute(
        "UPDATE items SET status=?, status_prev=?, processed_utc=? WHERE fullname=?",
        (status, old, processed, fullname),
    )
    if status == "done" and _unsave_enabled(conn):
        try:  # best-effort, local-only — an enqueue hiccup must never fail the status write
            enqueue_unsave(conn, fullname)
        except Exception:  # noqa: BLE001
            pass
    conn.commit()
    return _public_by_fullname(conn, fullname)


def undo_status(conn: sqlite3.Connection, fullname: str) -> dict | None:
    """Revert the most recent status change (single step)."""
    row = conn.execute(
        "SELECT status_prev, status FROM items WHERE fullname=?", (fullname,)
    ).fetchone()
    if row is None or row[0] is None:
        return _public_by_fullname(conn, fullname)
    prev = row[0]
    now = int(time.time())
    processed = None if prev == "inbox" else now
    conn.execute(
        "UPDATE items SET status=?, status_prev=NULL, processed_utc=? WHERE fullname=?",
        (prev, processed, fullname),
    )
    if row[1] == "done":  # a Done undone before the drain ran is never sent to Reddit
        dequeue_unsave(conn, fullname)
    conn.commit()
    return _public_by_fullname(conn, fullname)


def bulk_set_status(
    conn: sqlite3.Connection, fullnames: list[str], status: str
) -> int:
    """Apply a status to many items; returns the number updated."""
    if status not in VALID_STATUSES:
        raise ValueError(f"invalid status: {status!r}")
    now = int(time.time())
    processed = None if status == "inbox" else now
    enqueue = status == "done" and _unsave_enabled(conn)
    changed: list[str] = []
    count = 0
    for fn in fullnames:
        # `AND status<>?` skips no-op updates so status_prev (single-step undo) is
        # never clobbered by re-applying the same status.
        cur = conn.execute(
            "UPDATE items SET status_prev=status, status=?, processed_utc=? "
            "WHERE fullname=? AND status<>?",
            (status, processed, fn, status),
        )
        count += cur.rowcount
        if enqueue and cur.rowcount:
            changed.append(fn)
    for fn in changed:  # enqueue_unsave no-ops for non-reddit; best-effort, local-only
        try:
            enqueue_unsave(conn, fn)
        except Exception:  # noqa: BLE001
            pass
    conn.commit()
    return count


def bankruptcy(
    conn: sqlite3.Connection,
    before_utc: int,
    *,
    source: str | None = None,
    dry_run: bool = False,
) -> int:
    """Reversibly bulk-archive inbox items older than ``before_utc``.

    Age uses ``created_utc`` when known, else ``first_seen_utc``. Returns the count
    affected (or that *would* be affected when ``dry_run``).
    """
    age_expr = "(CASE WHEN created_utc > 0 THEN created_utc ELSE first_seen_utc END)"
    where = f"status='inbox' AND {age_expr} < ?"
    params: list = [int(before_utc)]
    if source:
        where += " AND source = ?"
        params.append(source)

    n = conn.execute(f"SELECT COUNT(*) FROM items WHERE {where}", params).fetchone()[0]
    if dry_run or n == 0:
        return n
    now = int(time.time())
    conn.execute(
        f"UPDATE items SET status='archived', status_prev='inbox', processed_utc=? "
        f"WHERE {where}",
        [now] + params,
    )
    conn.commit()
    return n


def _public_by_fullname(conn: sqlite3.Connection, fullname: str) -> dict | None:
    row = conn.execute("SELECT * FROM items WHERE fullname=?", (fullname,)).fetchone()
    return _row_to_public(row) if row else None


# ---------------------------------------------------------------------------
# Stats
# ---------------------------------------------------------------------------

def _group_counts(conn: sqlite3.Connection, column: str, source: str | None = None) -> dict:
    where = " WHERE source = ?" if source else ""
    params = (source,) if source else ()
    rows = conn.execute(
        f"SELECT {column} AS k, COUNT(*) AS c FROM items{where} GROUP BY {column} ORDER BY c DESC",
        params,
    ).fetchall()
    return {(r["k"] or ""): r["c"] for r in rows}


def _category_counts(conn: sqlite3.Connection, source: str | None = None) -> dict:
    where = " WHERE source = ?" if source else ""
    params = (source,) if source else ()
    rows = conn.execute(
        f"SELECT json_extract(metadata, '$.category') AS k, COUNT(*) AS c "
        f"FROM items{where} GROUP BY k", params,
    ).fetchall()
    return {r["k"]: r["c"] for r in rows if r["k"]}


def source_counts(conn: sqlite3.Connection, status: str | None = None) -> list[dict]:
    """Per-source counts. With ``status``, ``count`` is that source's items in that
    status (sources present globally still appear, possibly with 0); ordered by global
    size so the tab order stays stable as the status filter changes."""
    if status:
        rows = conn.execute(
            "SELECT source, SUM(CASE WHEN status = ? THEN 1 ELSE 0 END) AS c "
            "FROM items GROUP BY source ORDER BY COUNT(*) DESC",
            (status,),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT source, COUNT(*) AS c FROM items GROUP BY source ORDER BY c DESC"
        ).fetchall()
    return [{"source": r["source"], "count": r["c"]} for r in rows]


def get_counts(conn: sqlite3.Connection, source: str | None = None) -> dict:
    where = " WHERE source = ?" if source else ""
    sp = (source,) if source else ()
    extra = " AND source = ?" if source else ""
    total = conn.execute(f"SELECT COUNT(*) FROM items{where}", sp).fetchone()[0]
    by_status = _group_counts(conn, "status", source)
    by_source = _group_counts(conn, "source")  # global — drives the Stats modal chart
    week_ago = int(time.time()) - 7 * 86400
    processed_week = conn.execute(
        f"SELECT COUNT(*) FROM items WHERE processed_utc IS NOT NULL AND processed_utc >= ?{extra}",
        (week_ago, *sp),
    ).fetchone()[0]
    with_url = conn.execute(
        f"SELECT COUNT(*) FROM items WHERE url <> ''{extra}", sp
    ).fetchone()[0]
    return {
        "total": total,
        "inbox": by_status.get("inbox", 0),
        "by_source": by_source,
        "by_kind": _group_counts(conn, "kind", source),
        "by_category": _category_counts(conn, source),
        "by_status": by_status,
        "processed_this_week": processed_week,
        "with_url": with_url,
        "distinct_sources": len(by_source),
    }
