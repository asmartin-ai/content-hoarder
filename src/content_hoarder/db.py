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
    NSFW_TAGS,
    VALID_STATUSES,
    build_search_text,
    parse_metadata,
)

PROCESSING_TAGS = ("listenable", "watch", "wotagei")

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

CREATE TABLE IF NOT EXISTS reddit_threads (
    fullname    TEXT PRIMARY KEY,   -- items.fullname, e.g. "reddit:t3_abc123"
    thread_json TEXT NOT NULL,      -- raw Reddit <permalink>.json (post + comment tree)
    hydrated_at INTEGER             -- when the thread was fetched/cached
);
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
    "score": "CAST(json_extract(metadata, '$.score') AS INTEGER)",        # Reddit upvotes
    "subreddit": "json_extract(metadata, '$.subreddit')",                 # Reddit subreddit (A–Z)
    "kind": "kind",
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
    # NOTE: normalize_processing_tags() is a one-time legacy backfill — it scans every
    # category-tagged item (~120ms on the live DB). init_db() runs on EVERY connection
    # (see connect()), so the backfill must NOT live here. It runs once from the `init-db`
    # CLI command; going forward set_category()/merge_upsert() keep the tag mirror in sync.


# Bump when an FTS table is added/changed so upgraded DBs rebuild once — a boolean
# marker could never re-trigger (items_trgm arrived after some DBs set it, silently
# leaving their fuzzy index empty).
_FTS_VERSION = 2


def _ensure_fts_built(conn: sqlite3.Connection) -> None:
    """One-time rebuild of the external-content FTS indexes, gated by a version marker.

    The marker stores the version last built; legacy boolean-'1' DBs rebuild exactly
    once after upgrade (populating any FTS table added since), then store _FTS_VERSION.
    """
    try:  # missing row -> fetchone() is None -> TypeError -> treat as version 0
        marker = int(conn.execute(
            "SELECT value FROM settings WHERE key='fts_built'").fetchone()[0])
    except (TypeError, ValueError):
        marker = 0
    if marker >= _FTS_VERSION:
        return
    has_rows = conn.execute("SELECT EXISTS(SELECT 1 FROM items)").fetchone()[0]
    if has_rows:
        conn.execute("INSERT INTO items_fts(items_fts) VALUES('rebuild')")
        conn.execute("INSERT INTO items_trgm(items_trgm) VALUES('rebuild')")
    conn.execute("INSERT OR REPLACE INTO settings(key, value) VALUES('fts_built', ?)",
                 (str(_FTS_VERSION),))


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


def _tag_list(value) -> list[str]:
    """Coerce metadata.tags to a stable, de-duplicated string list."""
    raw = value if isinstance(value, list) else [value] if value else []
    out: list[str] = []
    for t in raw:
        s = str(t).strip()
        if s and s not in out:
            out.append(s)
    return out


def metadata_with_category_tag(metadata, category: str) -> dict:
    """Mirror a legacy category into metadata.tags, preserving unrelated tags."""
    md = parse_metadata(metadata)
    cat = (category or "").strip().lower()
    tags = [t for t in _tag_list(md.get("tags")) if t not in PROCESSING_TAGS]
    if cat in PROCESSING_TAGS:
        tags.append(cat)
    md["tags"] = tags
    if cat:
        md["category"] = cat
    return md


def _update_metadata(conn: sqlite3.Connection, row: dict, metadata: dict) -> None:
    item = dict(row)
    item["metadata"] = json.dumps(metadata, ensure_ascii=False)
    item["search_text"] = build_search_text(item, metadata)
    conn.execute(
        "UPDATE items SET metadata=?, search_text=?, last_seen_utc=? WHERE fullname=?",
        (
            item["metadata"],
            item["search_text"],
            int(item.get("last_seen_utc") or time.time()),
            item["fullname"],
        ),
    )


def set_category(conn: sqlite3.Connection, fullname: str, category: str) -> bool:
    """Set metadata.category and keep the processing-area tag mirror in sync."""
    row = get_item(conn, fullname)
    if row is None:
        return False
    md = metadata_with_category_tag(row.get("metadata"), category)
    _update_metadata(conn, row, md)
    return True


def normalize_processing_tags(conn: sqlite3.Connection) -> int:
    """Backfill category-derived processing tags for existing rows, idempotently."""
    rows = conn.execute(
        "SELECT * FROM items WHERE json_extract(metadata, '$.category') IS NOT NULL"
    ).fetchall()
    changed = 0
    for r in rows:
        row = dict(r)
        before = parse_metadata(row.get("metadata"))
        after = metadata_with_category_tag(before, str(before.get("category") or ""))
        if after != before:
            _update_metadata(conn, row, after)
            changed += 1
    return changed


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
    incoming_md = parse_metadata(item.get("metadata"))
    incoming_category = str(incoming_md.get("category") or "")

    existing = get_item(conn, item["fullname"])
    if existing is None:
        if incoming_category:
            item = dict(item)
            incoming_md = metadata_with_category_tag(incoming_md, incoming_category)
            item["metadata"] = json.dumps(incoming_md, ensure_ascii=False)
            item["search_text"] = build_search_text(item, incoming_md)
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
    # tags are UNION-merged only when the incoming item carries a category (the category
    # mirror needs prior tags kept); otherwise incoming tags REPLACE existing ones
    # wholesale — re-tag passes recompute from scratch and rely on this. A future
    # partial-tags caller would clobber e.g. NSFW tags: change deliberately (with tests)
    # or send category alongside. Pinned by test_merge_upsert_tags_semantics.
    emd = parse_metadata(existing.get("metadata"))
    for k, v in incoming_md.items():
        if k == "tags" and incoming_category:
            tags = _tag_list(emd.get("tags"))
            for t in _tag_list(v):
                if t not in tags:
                    tags.append(t)
            emd["tags"] = tags
            continue
        if v not in (None, "", [], {}):
            emd[k] = v
    if incoming_category:
        emd = metadata_with_category_tag(emd, incoming_category)
    elif emd.get("category"):
        emd = metadata_with_category_tag(emd, str(emd.get("category") or ""))
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

def _fts_query(
    q: str,
    *,
    exact: list[str] | None = None,
    exclude: list[str] | None = None,
) -> str:
    """Build a safe FTS5 MATCH expression.

    - Each bare token is quoted so FTS5 operator keywords (OR/AND/NOT/NEAR) are
      treated as literals, not syntax.
    - ``exact`` phrases are added as FTS5 phrase terms (also quoted).
    - ``exclude`` terms are appended as ``NOT "term"`` clauses.

    IMPORTANT: the caller must ensure there is at least one *positive* term
    (either ``q`` tokens or ``exact``). FTS5 rejects queries that contain only NOTs.
    """
    exact = exact or []
    exclude = exclude or []

    toks = [t for t in re.split(r"\W+", q or "", flags=re.UNICODE) if t]
    parts: list[str] = ['"' + t + '"' for t in toks]

    for phrase in exact:
        p = (phrase or "").strip()
        if not p:
            continue
        parts.append('"' + p.replace('"', '""') + '"')

    if not parts:
        return ""

    out = " ".join(parts)

    for term in exclude:
        for t in [x for x in re.split(r"\W+", term or "", flags=re.UNICODE) if x]:
            out += ' NOT "' + t.replace('"', '""') + '"'

    return out


def _trigram_exprs(q: str) -> tuple[str, str]:
    """(AND, OR) expressions over the query's overlapping 3-grams; ('', '') if < 3 chars.

    AND ≈ "contains the typed string" — the tight default for fuzzy search (partial
    words and trailing typos still match via substring). OR matches ANY single gram and
    is junk unless rank-ordered — it exists only as the typo-rescue fallback when the
    tight pass finds nothing (became user-visible when fuzzy went default-on: an OR-only
    match made every bare search return one-gram noise in recency order)."""
    s = (q or "").strip().lower()
    if len(s) < 3:
        return "", ""
    grams = sorted({s[i : i + 3] for i in range(len(s) - 2)})
    quoted = ['"' + g.replace('"', '""') + '"' for g in grams]
    return " AND ".join(quoted), " OR ".join(quoted)


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
    tags: list[str] | None = None,
    tags_all: bool = False,
    subreddit: str | None = None,
    is_saved: int | None = None,
    nsfw: bool = False,
    decayed: bool = False,
    swept: bool = False,
    has_media: str | None = None,
    before: int | None = None,
    after: int | None = None,
    score_min: int | None = None,
    score_max: int | None = None,
    exact: list[str] | None = None,
    exclude: list[str] | None = None,
    open_in_firefox: bool = False,
    include_consolidated: bool = False,
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
            if category in PROCESSING_TAGS:
                filters.append(
                    "("
                    f"json_extract({a}metadata, '$.category') = ? OR "
                    f"EXISTS (SELECT 1 FROM json_each({a}metadata, '$.tags') WHERE value = ?)"
                    ")"
                )
                params.extend([category, category])
            else:
                filters.append(f"json_extract({a}metadata, '$.category') = ?")
                params.append(category)
        if tags:
            if tags_all:
                # AND: require membership for every tag.
                for t in tags:
                    filters.append(
                        f"EXISTS (SELECT 1 FROM json_each({a}metadata, '$.tags') WHERE value = ?)"
                    )
                    params.append(t)
            else:
                # OR: match any selected tag.
                ph = ",".join("?" for _ in tags)
                filters.append(
                    f"EXISTS (SELECT 1 FROM json_each({a}metadata, '$.tags') WHERE value IN ({ph}))"
                )
                params.extend(tags)
        if nsfw:
            ph = ",".join("?" for _ in NSFW_TAGS)
            filters.append(
                f"EXISTS (SELECT 1 FROM json_each({a}metadata, '$.tags') WHERE value IN ({ph}))"
            )
            params.extend(NSFW_TAGS)
        if has_media:
            # has:video|image|gallery — facet over metadata.media_type. "video" means
            # reddit-hosted video ('reddit_video'); external embeds keep media_type='link'.
            mt = {"video": "reddit_video"}.get(has_media, has_media)
            filters.append(f"json_extract({a}metadata, '$.media_type') = ?")
            params.append(mt)
        if decayed:
            # decayed (is:decayed): the item carries a decay-wave stamp (see db.decay).
            filters.append(f"json_extract({a}metadata, '$.decayed_at') IS NOT NULL")
        if swept:
            # swept (is:swept): decayed in the labeled initial backfill pass specifically.
            filters.append(f"json_extract({a}metadata, '$.decay_label') = 'swept'")
        if subreddit:
            filters.append(f"json_extract({a}metadata, '$.subreddit') = ? COLLATE NOCASE")
            params.append(subreddit)
        if before is not None or after is not None:
            # created_utc=0 means "unknown" for many sparse imports; avoid treating 0 as
            # "ancient" when date filters are active.
            filters.append(f"{a}created_utc > 0")
        if before is not None:
            filters.append(f"{a}created_utc < ?")
            params.append(int(before))
        if after is not None:
            filters.append(f"{a}created_utc >= ?")
            params.append(int(after))
        if score_min is not None or score_max is not None:
            # Exclude NULL scores when a score filter is active.
            filters.append(f"json_extract({a}metadata, '$.score') IS NOT NULL")
            score_expr = f"CAST(json_extract({a}metadata, '$.score') AS INTEGER)"
            if score_min is not None:
                filters.append(f"{score_expr} >= ?")
                params.append(int(score_min))
            if score_max is not None:
                filters.append(f"{score_expr} <= ?")
                params.append(int(score_max))
        if is_saved is not None:
            filters.append(f"{a}is_saved = ?")
            params.append(int(is_saved))
        if open_in_firefox:  # the "📑 Firefox tabs" batch (json true -> json_extract returns 1)
            filters.append(f"json_extract({a}metadata, '$.open_in_firefox') = 1")
        if not include_consolidated:
            filters.append(
                f"json_extract({a}metadata, '$.consolidated_into') IS NULL")

    q = (q or "").strip()
    exact = exact or []
    exclude = exclude or []

    match_expr = ""
    fts_table = ""
    fuzzy_rescue = ""  # OR-of-trigrams typo fallback; only ever run rank-ordered

    # FTS5 requires at least one positive term; if the query is only operators/negations,
    # fall back to the plain filtered SELECT path.
    has_positive = bool(q) or bool(exact)

    if has_positive:
        if fuzzy and q and not exact and not exclude:
            and_expr, or_expr = _trigram_exprs(q)
            if and_expr:
                match_expr = and_expr
                fts_table = "items_trgm"
                if or_expr != and_expr:  # >1 gram, a rescue pass is meaningful
                    fuzzy_rescue = or_expr
        if not match_expr:  # exact (or fuzzy fell back for short queries)
            match_expr = _fts_query(q, exact=exact, exclude=exclude)
            fts_table = "items_fts"

    if match_expr and fts_table:
        add_filters("i")
        where = " AND ".join([f"{fts_table} MATCH ?"] + filters)
        sql_base = (
            f"SELECT i.* FROM items i JOIN {fts_table} ON {fts_table}.rowid = i.rowid "
            f"WHERE {where} {{order}} LIMIT ? OFFSET ?"
        )
        bind = [match_expr] + params + [int(limit), int(offset)]
        rows = conn.execute(
            sql_base.format(order=_order_clause(sort, order, "i")), bind
        ).fetchall()
        if not rows and fuzzy_rescue and not offset:
            # Tight pass empty ON PAGE ONE -> genuine typo territory: match any gram,
            # best trigram overlap first (bm25 rank), so near-misses surface and junk
            # sinks. Gated to offset 0: on deeper pages an empty tight result means the
            # real matches are simply exhausted — rescuing there would append unrelated
            # one-gram noise after the genuine results (pagination/infinite-scroll bug).
            bind[0] = fuzzy_rescue
            rows = conn.execute(
                sql_base.format(order="ORDER BY rank, i.last_seen_utc DESC"), bind
            ).fetchall()
        return [_row_to_public(r) for r in rows]
    else:
        add_filters("")
        # No positive FTS term to hang a NOT off of (e.g. a `-term`-only query), so apply
        # the negations as plain search_text exclusions instead — otherwise they'd be
        # silently dropped. (`\W+` tokens are word-chars only, so escape just LIKE's `_`.)
        for term in exclude:
            for tk in (t for t in re.split(r"\W+", term or "") if t):
                esc = tk.lower().replace("\\", r"\\").replace("_", r"\_").replace("%", r"\%")
                filters.append(r"LOWER(search_text) NOT LIKE ? ESCAPE '\'")
                params.append("%" + esc + "%")
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
        # attempts/last_error reset: a re-Done item gets a fresh chance even if a prior
        # run exhausted its MAX_ATTEMPTS and parked it as 'failed'.
        "ON CONFLICT(fullname) DO UPDATE SET state='pending', attempts=0, last_error=NULL, "
        "updated_utc=excluded.enqueued_utc",
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


# Any MANUAL status transition exits the decayed state (see decay/undecay): strip the
# wave marks so "stamped == currently decayed" holds and is:swept never matches a rescued
# item. One definition for every status writer — a future writer that forgets this breaks
# the invariant silently. No json_valid guard needed: the functional duration index makes
# SQLite validate metadata JSON on every write, so a malformed row can never exist here
# (pinned by test_malformed_metadata_cannot_enter_the_db).
_STRIP_DECAY_SQL = "json_remove(metadata, '$.decayed_at', '$.decay_label')"


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
        f"UPDATE items SET status=?, status_prev=?, processed_utc=?, "
        f"metadata={_STRIP_DECAY_SQL} WHERE fullname=?",
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
        f"UPDATE items SET status=?, status_prev=NULL, processed_utc=?, "
        f"metadata={_STRIP_DECAY_SQL} WHERE fullname=?",
        (prev, processed, fullname),
    )
    if row[1] == "done":  # a Done undone before the drain ran is never sent to Reddit
        dequeue_unsave(conn, fullname)
        # NOTE: if the unsave already drained (queue state 'done'), the item is genuinely
        # gone from Reddit Saved — this layer stays offline; the web /undo route attempts
        # the live re-save (reddit_unsave.resave) and surfaces a warning when it fails.
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
            f"UPDATE items SET status_prev=status, status=?, processed_utc=?, "
            f"metadata={_STRIP_DECAY_SQL} WHERE fullname=? AND status<>?",
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


# Item age: content creation time when known, else when we first synced it. (Reddit/YouTube
# expose no save timestamps, so this is a content-age proxy — see the decay docstring.)
_AGE_EXPR = "(CASE WHEN created_utc > 0 THEN created_utc ELSE first_seen_utc END)"


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
    where = f"status='inbox' AND {_AGE_EXPR} < ?"
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


def _decay_where(tags, subreddits, before_utc, source) -> tuple[str, list]:
    """WHERE clause + params for a decay selection: tag/subreddit selectors UNION,
    age cutoff and source AND. Tag SQL mirrors search_items' json_each filter."""
    clauses = ["status='inbox'", "source=?"]
    params: list = [source]
    sel = []
    if tags:
        ph = ",".join("?" for _ in tags)
        sel.append(f"EXISTS (SELECT 1 FROM json_each(metadata, '$.tags') WHERE value IN ({ph}))")
        params.extend(tags)
    if subreddits:
        ph = ",".join("?" for _ in subreddits)
        sel.append(f"lower(json_extract(metadata, '$.subreddit')) IN ({ph})")
        params.extend(s.lower() for s in subreddits)
    if sel:
        clauses.append("(" + " OR ".join(sel) + ")")
    if before_utc is not None:
        clauses.append(f"{_AGE_EXPR} < ?")
        params.append(int(before_utc))
    return " AND ".join(clauses), params


def decay(
    conn: sqlite3.Connection,
    *,
    tags: list[str] | None = None,
    subreddits: list[str] | None = None,
    before_utc: int | None = None,
    source: str = "reddit",
    label: str | None = None,
    apply: bool = False,
    samples: int = 5,
    top_subs: int = 50,
) -> dict:
    """Guilt-free bulk decay: archive inbox items by tag/subreddit/age, stamped for reversal.

    The tag-aware successor to ``bankruptcy`` (PKMS-research adoption, Epic 21): selects
    ``status='inbox'`` items of ``source`` matching ANY of ``tags``/``subreddits`` (union),
    optionally older than ``before_utc`` (content age — Reddit exposes no save timestamps),
    and archives them stamping ``metadata.decayed_at``. One stamp value per call = one
    independently reversible "wave" (see ``undecay``). Refuses an unselected decay.
    ``label`` additionally writes ``metadata.decay_label`` — e.g. the supervised initial
    backfill uses ``label='swept'`` so its items stay distinguishable from any future
    rolling decay (queryable via the ``is:swept`` search operator; ``is:decayed`` matches
    any wave). A label is a marker, NOT a tag: tags get wholesale-replaced by categorize
    retags, while metadata keys survive both retags and syncs.

    Deliberately a direct UPDATE like ``bankruptcy`` — never routed through
    ``bulk_set_status`` — so a mass decay can never enqueue live Reddit unsaves.
    Dry-run (default) and apply return the same shape; breakdowns are computed before
    the UPDATE. ``by_tag`` counts membership per selected tag and overlaps by design
    (an anime+memes item counts under both) — ``total`` is the authoritative
    distinct-row count, never ``sum(by_tag)``.
    """
    if not (tags or subreddits or before_utc):
        raise ValueError("decay needs at least one selector (tags/subreddits/before_utc)")
    where, params = _decay_where(tags, subreddits, before_utc, source)
    total = conn.execute(f"SELECT COUNT(*) FROM items WHERE {where}", params).fetchone()[0]

    by_tag: dict = {}
    for t in tags or []:
        n = conn.execute(
            f"SELECT COUNT(*) FROM items WHERE {where} AND EXISTS "
            "(SELECT 1 FROM json_each(metadata, '$.tags') WHERE value = ?)",
            params + [t],
        ).fetchone()[0]
        if n:
            by_tag[t] = n

    by_subreddit = {
        r[0]: r[1]
        for r in conn.execute(
            f"SELECT COALESCE(lower(json_extract(metadata, '$.subreddit')), '(none)') s, "
            f"COUNT(*) n FROM items WHERE {where} GROUP BY s ORDER BY n DESC LIMIT ?",
            params + [int(top_subs)],
        ).fetchall()
    }

    now = int(time.time())
    yr = 365 * 24 * 3600
    b = conn.execute(
        f"SELECT SUM(CASE WHEN {_AGE_EXPR} >= ? THEN 1 ELSE 0 END), "
        f"SUM(CASE WHEN {_AGE_EXPR} < ? AND {_AGE_EXPR} >= ? THEN 1 ELSE 0 END), "
        f"SUM(CASE WHEN {_AGE_EXPR} < ? AND {_AGE_EXPR} >= ? THEN 1 ELSE 0 END), "
        f"SUM(CASE WHEN {_AGE_EXPR} < ? THEN 1 ELSE 0 END) FROM items WHERE {where}",
        [now - yr, now - yr, now - 2 * yr, now - 2 * yr, now - 4 * yr, now - 4 * yr] + params,
    ).fetchone()
    age_bands = {"<1y": b[0] or 0, "1-2y": b[1] or 0, "2-4y": b[2] or 0, ">=4y": b[3] or 0}

    sample = [
        f"r/{r[0] or '?'}: {(r[1] or '')[:60]}"
        for r in conn.execute(
            f"SELECT json_extract(metadata, '$.subreddit'), title FROM items "
            f"WHERE {where} ORDER BY RANDOM() LIMIT ?",
            params + [int(samples)],
        ).fetchall()
    ]

    res = {"total": total, "applied": False, "decayed_at": None, "label": label,
           "by_tag": by_tag, "by_subreddit": by_subreddit, "age_bands": age_bands,
           "sample": sample}
    if apply:
        res["applied"] = True
        if total:
            set_md = "json_set(metadata, '$.decayed_at', ?)"
            md_params = [now]
            if label:
                set_md = "json_set(metadata, '$.decayed_at', ?, '$.decay_label', ?)"
                md_params = [now, label]
            cur = conn.execute(
                f"UPDATE items SET status='archived', status_prev='inbox', processed_utc=?, "
                f"metadata={set_md} WHERE {where}",
                [now] + md_params + params,
            )
            conn.commit()
            res.update(total=cur.rowcount, decayed_at=now)
    return res


def undecay(
    conn: sqlite3.Connection,
    *,
    decayed_after: int | None = None,
    decayed_before: int | None = None,
    apply: bool = False,
    samples: int = 5,
) -> dict:
    """Reverse ``decay``: return stamped-archived items to the inbox.

    Selects by the ``metadata.decayed_at`` stamp (the wave id) — NOT ``status_prev``,
    which is single-step and may have been clobbered since. Items manually re-statused
    after a decay (e.g. to keep) are skipped by the ``status='archived'`` guard; their
    stale stamp is harmless (undecay never touches non-archived rows, and a later decay
    re-stamps). The stamp AND the decay label are REMOVED on restore so the invariant
    "stamped == currently decayed" holds; ``processed_utc`` returns to NULL (inbox
    semantics, as set_status).
    """
    clauses = ["status='archived'", "json_extract(metadata, '$.decayed_at') IS NOT NULL"]
    params: list = []
    if decayed_after is not None:
        clauses.append("json_extract(metadata, '$.decayed_at') >= ?")
        params.append(int(decayed_after))
    if decayed_before is not None:
        clauses.append("json_extract(metadata, '$.decayed_at') < ?")
        params.append(int(decayed_before))
    where = " AND ".join(clauses)
    total = conn.execute(f"SELECT COUNT(*) FROM items WHERE {where}", params).fetchone()[0]
    sample = [
        f"r/{r[0] or '?'}: {(r[1] or '')[:60]}"
        for r in conn.execute(
            f"SELECT json_extract(metadata, '$.subreddit'), title FROM items "
            f"WHERE {where} ORDER BY RANDOM() LIMIT ?",
            params + [int(samples)],
        ).fetchall()
    ]
    res = {"total": total, "applied": False, "sample": sample}
    if apply:
        res["applied"] = True
        if total:
            cur = conn.execute(
                f"UPDATE items SET status='inbox', status_prev='archived', processed_utc=NULL, "
                f"metadata=json_remove(metadata, '$.decayed_at', '$.decay_label') WHERE {where}",
                params,
            )
            conn.commit()
            res["total"] = cur.rowcount
    return res


def delete_items(
    conn: sqlite3.Connection,
    *,
    tags: list[str] | None = None,
    subreddits: list[str] | None = None,
    before_utc: int | None = None,
    source: str = "reddit",
    status: str | None = None,
    swept: bool = False,
    decayed: bool = False,
    fullnames: list[str] | None = None,
    also_unsave: bool = False,
    apply: bool = False,
    samples: int = 8,
    max_rows: int = 5000,
) -> dict:
    """PERMANENTLY delete matching items (and their cached reddit_threads rows).

    The destructive endpoint of the triage-then-delete flow (Epic 21): e.g. after the
    swept/ephemeral pass is triaged, ``swept=True, tags=['ephemeral']`` removes the
    rest for good. Unlike decay this is IRREVERSIBLE at the DB layer — the CLI wraps it
    in a dry-run-default + double-confirmation + auto-backup + audit-log gate; this
    function additionally refuses to apply above ``max_rows`` (blast-radius cap).

    Selector semantics: ``tags``/``subreddits`` union with each other and AND with
    every other selector (status/swept/decayed/age/fullnames). At least one selector
    is required — a bare source-wide delete is refused.

    ``also_unsave=True`` enqueues each deleted reddit item into the existing
    ``reddit_unsave`` queue BEFORE the row vanishes (the queue stores reddit_id, so
    draining works without the item). Without it, PENDING queue rows for deleted items
    are removed so a later drain can't unsave something the user only deleted locally;
    drained history rows are kept as audit.
    """
    if not (tags or subreddits or before_utc or fullnames or swept or decayed or status):
        raise ValueError("delete_items needs at least one selector")
    clauses = ["source=?"]
    params: list = [source]
    if fullnames:
        ph = ",".join("?" for _ in fullnames)
        clauses.append(f"fullname IN ({ph})")
        params.extend(fullnames)
    if status:
        clauses.append("status=?")
        params.append(status)
    if swept:
        clauses.append("json_extract(metadata, '$.decay_label') = 'swept'")
    if decayed:
        clauses.append("json_extract(metadata, '$.decayed_at') IS NOT NULL")
    sel = []
    if tags:
        ph = ",".join("?" for _ in tags)
        sel.append(f"EXISTS (SELECT 1 FROM json_each(metadata, '$.tags') WHERE value IN ({ph}))")
        params.extend(tags)
    if subreddits:
        ph = ",".join("?" for _ in subreddits)
        sel.append(f"lower(json_extract(metadata, '$.subreddit')) IN ({ph})")
        params.extend(s.lower() for s in subreddits)
    if sel:
        clauses.append("(" + " OR ".join(sel) + ")")
    if before_utc is not None:
        clauses.append(f"{_AGE_EXPR} < ?")
        params.append(int(before_utc))
    where = " AND ".join(clauses)

    victims = [r[0] for r in conn.execute(
        f"SELECT fullname FROM items WHERE {where}", params).fetchall()]
    total = len(victims)
    sample = [
        f"r/{r[0] or '?'}: {(r[1] or '')[:60]}"
        for r in conn.execute(
            f"SELECT json_extract(metadata, '$.subreddit'), title FROM items "
            f"WHERE {where} ORDER BY RANDOM() LIMIT ?", params + [int(samples)],
        ).fetchall()
    ]
    res = {"total": total, "applied": False, "threads_deleted": 0,
           "unsave_enqueued": 0, "sample": sample}
    if not apply:
        return res
    if total > max_rows:
        raise ValueError(
            f"refusing to delete {total} rows (> max_rows={max_rows}); "
            f"raise max_rows deliberately if this is intended")
    res["applied"] = True
    if not total:
        return res

    enqueued = 0
    if also_unsave:
        before_q = conn.execute("SELECT COUNT(*) FROM reddit_unsave").fetchone()[0]
        for fn in victims:  # must happen while the item rows still exist
            enqueue_unsave(conn, fn)
        enqueued = conn.execute("SELECT COUNT(*) FROM reddit_unsave").fetchone()[0] - before_q

    threads = 0
    for i in range(0, total, 500):  # chunk IN lists well under SQLite's variable cap
        chunk = victims[i:i + 500]
        ph = ",".join("?" for _ in chunk)
        cur = conn.execute(f"DELETE FROM reddit_threads WHERE fullname IN ({ph})", chunk)
        threads += cur.rowcount
        if not also_unsave:
            conn.execute(
                f"DELETE FROM reddit_unsave WHERE fullname IN ({ph}) AND state='pending'",
                chunk)
        conn.execute(f"DELETE FROM items WHERE fullname IN ({ph})", chunk)
    conn.commit()
    res.update(threads_deleted=threads, unsave_enqueued=enqueued)
    return res


def _public_by_fullname(conn: sqlite3.Connection, fullname: str) -> dict | None:
    row = conn.execute("SELECT * FROM items WHERE fullname=?", (fullname,)).fetchone()
    return _row_to_public(row) if row else None


# ---------------------------------------------------------------------------
# Reddit thread cache (post + comment tree; kept out of items.metadata so search
# stays cheap — the JSON blobs are large). See AGENTS.md "Reddit management view".
# ---------------------------------------------------------------------------

def get_reddit_thread(conn: sqlite3.Connection, fullname: str) -> dict | None:
    """Return the cached thread for an item, or None. Keys: thread_json, hydrated_at."""
    row = conn.execute(
        "SELECT thread_json, hydrated_at FROM reddit_threads WHERE fullname=?", (fullname,)
    ).fetchone()
    return dict(row) if row else None


def set_reddit_thread(
    conn: sqlite3.Connection,
    fullname: str,
    thread_json: str,
    hydrated_at: int | None = None,
    *,
    commit: bool = True,
) -> None:
    """Cache (or replace) a thread JSON blob for an item. Idempotent."""
    conn.execute(
        "INSERT INTO reddit_threads(fullname, thread_json, hydrated_at) VALUES(?, ?, ?) "
        "ON CONFLICT(fullname) DO UPDATE SET "
        "thread_json=excluded.thread_json, hydrated_at=excluded.hydrated_at",
        (fullname, thread_json, hydrated_at if hydrated_at is not None else int(time.time())),
    )
    if commit:
        conn.commit()


def reddit_subreddit_counts(conn: sqlite3.Connection, status: str | None = None) -> list[dict]:
    """Per-subreddit item counts for reddit items (descending), for the sidebar."""
    sub = "json_extract(metadata, '$.subreddit')"
    where = f"source='reddit' AND {sub} IS NOT NULL AND {sub} <> ''"
    params: list = []
    if status:
        where += " AND status = ?"
        params.append(status)
    rows = conn.execute(
        f"SELECT {sub} AS subreddit, COUNT(*) AS c FROM items WHERE {where} "
        f"GROUP BY {sub} COLLATE NOCASE ORDER BY c DESC, subreddit COLLATE NOCASE ASC",
        params,
    ).fetchall()
    return [{"subreddit": r["subreddit"], "count": r["c"]} for r in rows]


def pulse(conn: sqlite3.Connection, *, now: int | None = None) -> dict:
    """Tiny ambient counts for the v3 console (Epic 20: win pebbles, the "· N new"
    tab slice, the quiet decay line). Deliberately guilt-free: arrivals and clears
    today, never backlog totals. ``cleared_today`` counts manual triage only —
    decay-stamped rows are excluded so a bulk decay can never masquerade as a
    day's worth of cleared items."""
    now = int(now or time.time())
    lt = time.localtime(now)
    midnight = int(time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday, 0, 0, 0,
                                lt.tm_wday, lt.tm_yday, -1)))
    new_today = conn.execute(
        "SELECT COUNT(*) FROM items WHERE first_seen_utc >= ?", (midnight,)
    ).fetchone()[0]
    cleared_today = conn.execute(
        "SELECT COUNT(*) FROM items WHERE processed_utc >= ? AND status != 'inbox' "
        "AND json_extract(metadata, '$.decayed_at') IS NULL",
        (midnight,),
    ).fetchone()[0]
    swept_recent = conn.execute(
        "SELECT COUNT(*) FROM items WHERE json_extract(metadata, '$.decayed_at') >= ?",
        (now - 30 * 86400,),
    ).fetchone()[0]
    return {"new_today": new_today, "cleared_today": cleared_today,
            "swept_recent": swept_recent}


def tag_counts(
    conn: sqlite3.Connection,
    *,
    source: str | None = None,
    status: str | None = None,
) -> dict:
    """Counts for the curated filter tags (``categorize.FILTER_TAGS``), descending.

    ``metadata.tags`` also holds non-facet values (e.g. YouTube per-video keywords from the
    enrich pass), so the result is restricted to the curated vocabulary — otherwise the browse
    rail would render tens of thousands of one-off keyword tags. Optionally cross-filtered by
    source/status so the rail composes with the active source tab + status nav.
    """
    from content_hoarder.categorize import FILTER_TAGS

    placeholders = ",".join("?" for _ in FILTER_TAGS)
    where = [f"je.value IN ({placeholders})"]
    params: list = list(FILTER_TAGS)
    if source:
        where.append("items.source = ?")
        params.append(source)
    if status:
        where.append("items.status = ?")
        params.append(status)
    rows = conn.execute(
        "SELECT je.value AS tag, COUNT(*) AS c "
        "FROM items, json_each(items.metadata, '$.tags') je "
        "WHERE " + " AND ".join(where) +
        " GROUP BY je.value ORDER BY c DESC, je.value COLLATE NOCASE ASC",
        params,
    ).fetchall()
    return {r["tag"]: r["c"] for r in rows}


def reddit_stats(conn: sqlite3.Connection) -> dict:
    """Reddit-only stats for the management view's stats modal."""
    sub = "json_extract(metadata, '$.subreddit')"
    by_kind = {
        r["k"]: r["c"] for r in conn.execute(
            "SELECT kind AS k, COUNT(*) AS c FROM items WHERE source='reddit' GROUP BY kind")
    }
    by_status = _group_counts(conn, "status", "reddit")
    top_subs = [
        {"subreddit": r["s"], "count": r["c"]} for r in conn.execute(
            f"SELECT {sub} AS s, COUNT(*) AS c FROM items "
            f"WHERE source='reddit' AND {sub} IS NOT NULL AND {sub} <> '' "
            f"GROUP BY {sub} COLLATE NOCASE ORDER BY c DESC LIMIT 15")
    ]
    distinct_subs = conn.execute(
        f"SELECT COUNT(DISTINCT {sub} COLLATE NOCASE) FROM items "
        f"WHERE source='reddit' AND {sub} IS NOT NULL AND {sub} <> ''"
    ).fetchone()[0]
    nsfw = conn.execute(
        "SELECT COUNT(*) FROM items WHERE source='reddit' "
        "AND json_extract(metadata, '$.over_18') = 1"
    ).fetchone()[0]
    with_media = conn.execute(
        "SELECT COUNT(*) FROM items WHERE source='reddit' AND url <> ''"
    ).fetchone()[0]
    by_year = [
        {"year": r["y"], "count": r["c"]} for r in conn.execute(
            "SELECT CAST(strftime('%Y', created_utc, 'unixepoch') AS INTEGER) AS y, COUNT(*) AS c "
            "FROM items WHERE source='reddit' AND created_utc > 0 GROUP BY y ORDER BY y")
    ]
    return {
        "total": sum(by_status.values()),  # 0 when there are no reddit items
        "by_kind": by_kind,
        "by_status": by_status,
        "by_tag": tag_counts(conn, source="reddit"),
        "top_subreddits": top_subs,
        "distinct_subreddits": distinct_subs,
        "nsfw": nsfw,
        "with_media": with_media,
        "by_year": by_year,
    }


# ---------------------------------------------------------------------------
# Stats
# ---------------------------------------------------------------------------

def _group_counts(
    conn: sqlite3.Connection,
    column: str,
    source: str | None = None,
    status: str | None = None,
) -> dict:
    filters = []
    params: list = []
    if source:
        filters.append("source = ?")
        params.append(source)
    if status:
        filters.append("status = ?")
        params.append(status)
    where = " WHERE " + " AND ".join(filters) if filters else ""
    rows = conn.execute(
        f"SELECT {column} AS k, COUNT(*) AS c FROM items{where} GROUP BY {column} ORDER BY c DESC",
        params,
    ).fetchall()
    return {(r["k"] or ""): r["c"] for r in rows}


def _count_items(
    conn: sqlite3.Connection,
    *,
    source: str | None = None,
    status: str | None = None,
) -> int:
    where = []
    params: list = []
    if source:
        where.append("source = ?")
        params.append(source)
    if status:
        where.append("status = ?")
        params.append(status)
    sql = "SELECT COUNT(*) FROM items"
    if where:
        sql += " WHERE " + " AND ".join(where)
    return conn.execute(sql, params).fetchone()[0]


def category_counts(
    conn: sqlite3.Connection,
    *,
    source: str | None = None,
    status: str | None = None,
) -> list[dict]:
    """Per-category counts with stable ordering from ``categorize.VALID_CATEGORIES``.

    Optional ``source`` / ``status`` cross-filter the counts so the browse category tabs can
    compose with the active source/status filters while still showing 0-count categories.
    """
    from content_hoarder.categorize import VALID_CATEGORIES

    where = []
    params: list = []
    if source:
        where.append("source = ?")
        params.append(source)
    if status:
        where.append("status = ?")
        params.append(status)
    sql = (
        "SELECT json_extract(metadata, '$.category') AS k, COUNT(*) AS c "
        "FROM items"
    )
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " GROUP BY k"
    rows = conn.execute(sql, params).fetchall()
    counts = {r["k"]: r["c"] for r in rows if r["k"]}
    return [{"category": cat, "count": counts.get(cat, 0)} for cat in VALID_CATEGORIES]


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


def get_counts(
    conn: sqlite3.Connection,
    source: str | None = None,
    status: str | None = None,
    *,
    light: bool = False,
) -> dict:
    filters = []
    params: list = []
    if source:
        filters.append("source = ?")
        params.append(source)
    if status:
        filters.append("status = ?")
        params.append(status)
    where = " WHERE " + " AND ".join(filters) if filters else ""
    total = conn.execute(f"SELECT COUNT(*) FROM items{where}", params).fetchone()[0]
    by_status = _group_counts(conn, "status", source)
    if light:
        # Hot path: the browse rail refreshes status counts after every triage action. It only
        # needs by_status (index-backed, ~3ms) — skip the unindexed full-table scans below
        # (by_kind / processed_this_week / with_url, ~170ms total) that only the Stats modal uses.
        return {"total": total, "inbox": by_status.get("inbox", 0), "by_status": by_status}
    by_source = _group_counts(conn, "source")  # global — drives the Stats modal chart
    source_extra = " AND source = ?" if source else ""
    source_params = (source,) if source else ()
    week_ago = int(time.time()) - 7 * 86400
    processed_week = conn.execute(
        f"SELECT COUNT(*) FROM items WHERE processed_utc IS NOT NULL AND processed_utc >= ?{source_extra}",
        (week_ago, *source_params),
    ).fetchone()[0]
    with_url = conn.execute(
        f"SELECT COUNT(*) FROM items WHERE url <> ''{source_extra}", source_params
    ).fetchone()[0]
    return {
        "total": total,
        "inbox": by_status.get("inbox", 0),
        "by_source": by_source,
        "by_kind": _group_counts(conn, "kind", source, status),
        "by_status": by_status,
        "processed_this_week": processed_week,
        "with_url": with_url,
        "distinct_sources": len(by_source),
    }
    # by_tag / by_category are intentionally NOT computed here: each is a full json_each /
    # json_extract scan over the items table (~130ms / ~185ms on the live DB), and /stats is
    # refreshed after every triage action. The browse rail fetches them lazily from the
    # dedicated /tags and /categories endpoints (on navigation only), keeping this path cheap.
