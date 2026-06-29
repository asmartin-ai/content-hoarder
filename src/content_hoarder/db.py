"""SQLite data layer: schema, FTS5 search, non-destructive upsert, triage ops.

Design notes / gotchas (see AGENTS.md):
- External-content FTS5 is backfilled with ``INSERT INTO tbl(tbl) VALUES('rebuild')``
  (NEVER ``INSERT ... SELECT``); emptiness can't be detected by row count, so the
  one-time build is gated behind a ``settings`` marker.
- ``merge_upsert`` is non-destructive: it overlays only non-empty incoming fields and
  never clobbers user/triage state or ``first_seen_utc``.
"""

from __future__ import annotations

import gzip
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
CREATE INDEX IF NOT EXISTS idx_items_status_seen  ON items(status, first_seen_utc);

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

CREATE TABLE IF NOT EXISTS tag_suggestions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    fullname        TEXT NOT NULL,
    suggested_tag   TEXT NOT NULL,
    source          TEXT NOT NULL DEFAULT 'rule',  -- 'rule' | 'ai' | 'user' | 'discovery'
    reason          TEXT NOT NULL DEFAULT '',
    status          TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'applied' | 'rejected' | 'dismissed'
    created_utc     INTEGER NOT NULL,
    resolved_utc    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_tag_suggestions_status      ON tag_suggestions(status);
CREATE INDEX IF NOT EXISTS idx_tag_suggestions_fullname    ON tag_suggestions(fullname);
CREATE INDEX IF NOT EXISTS idx_tag_suggestions_tag_status  ON tag_suggestions(suggested_tag, status);

CREATE TABLE IF NOT EXISTS folders (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL UNIQUE,
    query_def       TEXT NOT NULL DEFAULT '{}',
    description     TEXT NOT NULL DEFAULT '',
    created_utc     INTEGER NOT NULL,
    updated_utc     INTEGER
);

CREATE INDEX IF NOT EXISTS idx_items_folder ON items(
    json_extract(metadata, '$.folder')
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
    "score": "CAST(json_extract(metadata, '$.score') AS INTEGER)",  # Reddit upvotes
    "smart": "CAST(json_extract(metadata, '$.triage_score') AS REAL)",  # learned likely-to-process (Epic 10)
    "subreddit": "json_extract(metadata, '$.subreddit')",  # Reddit subreddit (A–Z)
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
    # A scheduled `reddit-unsave --drain` writes the same DB as a running `serve`; wait out a
    # brief writer lock instead of failing with "database is locked". Must precede the WAL
    # switch: the one-time rollback->WAL upgrade on a brand-new DB takes a brief exclusive lock,
    # so concurrent first-connects (e.g. a service worker prefetching / + /triage + /pulse) would
    # otherwise 500 here without a busy_timeout to wait it out.
    conn.execute("PRAGMA busy_timeout=5000")
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
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
        marker = int(
            conn.execute("SELECT value FROM settings WHERE key='fts_built'").fetchone()[
                0
            ]
        )
    except (TypeError, ValueError):
        marker = 0
    if marker >= _FTS_VERSION:
        return
    has_rows = conn.execute("SELECT EXISTS(SELECT 1 FROM items)").fetchone()[0]
    if has_rows:
        conn.execute("INSERT INTO items_fts(items_fts) VALUES('rebuild')")
        conn.execute("INSERT INTO items_trgm(items_trgm) VALUES('rebuild')")
    conn.execute(
        "INSERT OR REPLACE INTO settings(key, value) VALUES('fts_built', ?)",
        (str(_FTS_VERSION),),
    )


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------


def get_setting(conn: sqlite3.Connection, key: str, default=None):
    row = conn.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    return row[0] if row else default


def set_setting(
    conn: sqlite3.Connection, key: str, value: str, *, commit: bool = True
) -> None:
    conn.execute(
        "INSERT OR REPLACE INTO settings(key, value) VALUES(?, ?)", (key, str(value))
    )
    if commit:
        conn.commit()


_SAVED_ORDER_KEY = (
    "reddit_saved_order_top"  # highest synthetic saved_utc rank allocated so far
)


def allocate_saved_order(
    conn: sqlite3.Connection, n: int, *, commit: bool = True
) -> int:
    """Reserve a contiguous block of ``n`` synthetic ``saved_utc`` ranks ABOVE every block
    allocated before, and return the block's TOP value; callers assign ``top, top-1, …,
    top-(n-1)`` in newest-saved-first order.

    Reddit exposes no real per-item save time, so saved_utc is synthesized from export/listing
    ROW ORDER. A persistent monotonic anchor — ``max(now, last_top + n)`` — keeps "sort by saved
    newest" coherent across imports AND cookie syncs made at different times (no disjoint bands),
    while staying ~wall-clock (it only rises above ``now`` when ingests cluster), so the
    "saved Xd ago" display stays sane. ``commit=False`` folds the counter advance into the
    caller's transaction so it commits atomically with the rows it ranks."""
    last_top = int(get_setting(conn, _SAVED_ORDER_KEY, 0) or 0)
    top = max(int(time.time()), last_top + max(n, 0))
    set_setting(conn, _SAVED_ORDER_KEY, str(top), commit=commit)
    return top


_DECAY_WAVE_KEY = "decay_wave_seq"  # highest decay-wave id allocated so far (monotonic)
_SNOOZE_WAVE_KEY = (
    "snooze_wave_seq"  # highest snooze-wave id allocated so far (monotonic)
)


def _allocate_decay_wave(
    conn: sqlite3.Connection, *, now: int, commit: bool = False
) -> int:
    """Reserve a UNIQUE monotonic decay-wave id and return it (mirrors
    ``allocate_saved_order``). Each ``decay`` apply gets a distinct id even when two
    calls land in the same wall-clock second — ``max(now, last + 1)`` guarantees a
    strictly increasing value — so a per-wave UNDO selects exactly one wave instead of
    every wave sharing that second (the same-second collision bug). Stays ~wall-clock
    (only rises above ``now`` when waves cluster within a second), so the value is still
    usable as a "~when decayed" stamp for ``is:decayed`` / ``swept_recent``. ``commit=False``
    folds the advance into the caller's transaction so the counter + the stamped rows
    commit atomically."""
    last = int(get_setting(conn, _DECAY_WAVE_KEY, 0) or 0)
    wave = max(int(now), last + 1)
    set_setting(conn, _DECAY_WAVE_KEY, str(wave), commit=commit)
    return wave


def _allocate_snooze_wave(
    conn: sqlite3.Connection, *, now: int, commit: bool = False
) -> int:
    """Reserve a UNIQUE monotonic snooze-wave id.

    Mirrors ``_allocate_decay_wave`` so an undo can target exactly one snooze wave even
    when multiple snoozes happen in the same wall-clock second.
    """
    last = int(get_setting(conn, _SNOOZE_WAVE_KEY, 0) or 0)
    wave = max(int(now), last + 1)
    set_setting(conn, _SNOOZE_WAVE_KEY, str(wave), commit=commit)
    return wave


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
    """Dual-write: mirror ``category`` into ``metadata.tags`` so single-select
    processing areas filter through the multi-label tag rail. This is the
    **intended bridge** (see ``categorize.py`` module docstring), not a legacy shim.
    Preserves unrelated (non-processing) tags."""
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


def patch_item_metadata(
    conn: sqlite3.Connection,
    fullname: str,
    updates: dict,
    *,
    only_if_missing: bool = False,
) -> bool:
    """Shallow-merge ``updates`` into an item's metadata (+ rebuild search_text) WITHOUT
    touching last_seen_utc, so a background backfill (e.g. lazy thumbnail capture) never
    reorders the feed. Skips falsy values; ``only_if_missing`` skips keys already set
    truthy. Returns True iff a write happened. Caller commits."""
    row = conn.execute("SELECT * FROM items WHERE fullname=?", (fullname,)).fetchone()
    if row is None:
        return False
    md = parse_metadata(dict(row).get("metadata"))
    changed = False
    for k, v in updates.items():
        if v in (None, "", [], {}):
            continue
        if only_if_missing and md.get(k):
            continue
        if md.get(k) != v:
            md[k] = v
            changed = True
    if not changed:
        return False
    item = dict(row)
    conn.execute(
        "UPDATE items SET metadata=?, search_text=? WHERE fullname=?",
        (json.dumps(md, ensure_ascii=False), build_search_text(item, md), fullname),
    )
    return True


def set_category(conn: sqlite3.Connection, fullname: str, category: str) -> bool:
    """Set ``metadata.category`` (single-select) and keep the dual-write tag mirror in
    sync. See :func:`metadata_with_category_tag` and the ``categorize.py`` module
    docstring for the three-system taxonomy model."""
    row = get_item(conn, fullname)
    if row is None:
        return False
    md = metadata_with_category_tag(row.get("metadata"), category)
    _update_metadata(conn, row, md)
    return True


def _norm_user_tag(t) -> str:
    """Normalize a user-entered tag: stripped + lowercased (to match the curated
    vocabulary and avoid case-duplicate tags), capped to a sane length."""
    return str(t or "").strip().lower()[:40]


def set_tags(
    conn: sqlite3.Connection, fullname: str, *, add=None, remove=None
) -> list[str] | None:
    """Add/remove **user** tags on an item, non-destructively.

    Manual tags live in ``metadata.tags`` (the displayed list) AND are stamped in
    ``metadata.tags_manual`` so the pipeline (``categorize`` re-tag / ``merge_upsert``
    re-import) can't clobber them — the stamp is re-unioned wherever tags get rewritten.
    Heuristic/programmatic tags are stamped separately in ``metadata.tags_auto`` by
    :func:`set_auto_tags`, so future sorting/filtering can distinguish human vs auto tags.
    Rebuilds ``search_text`` but does NOT move ``last_seen_utc`` (a tag edit shouldn't
    reorder the feed). Returns the resulting tag list, or ``None`` if the item is missing.
    Caller commits."""
    add_tags = [s for s in (_norm_user_tag(t) for t in (add or [])) if s]
    remove_tags = {s for s in (_norm_user_tag(t) for t in (remove or [])) if s}
    row = get_item(conn, fullname)
    if row is None:
        return None
    md = parse_metadata(row.get("metadata"))
    tags = _tag_list(md.get("tags"))
    manual = _tag_list(md.get("tags_manual"))
    changed = False
    for t in add_tags:
        if t not in manual:
            manual.append(t)
            changed = True
        if t not in tags:
            tags.append(t)
            changed = True
    if remove_tags:
        kept = [t for t in tags if t not in remove_tags]
        kept_manual = [t for t in manual if t not in remove_tags]
        if kept != tags or kept_manual != manual:
            tags, manual, changed = kept, kept_manual, True
    if changed:
        md["tags"] = tags
        if manual:
            md["tags_manual"] = manual
        else:
            md.pop("tags_manual", None)
        item = dict(row)
        conn.execute(
            "UPDATE items SET metadata=?, search_text=? WHERE fullname=?",
            (json.dumps(md, ensure_ascii=False), build_search_text(item, md), fullname),
        )
    return tags


def set_auto_tags(
    conn: sqlite3.Connection,
    fullname: str,
    tags,
    *,
    preserve_tags=None,
    last_seen_utc: int | None = None,
) -> list[str] | None:
    """Replace an item's programmatic/heuristic tag stamp.

    ``metadata.tags_auto`` records the auto-generated subset, while ``metadata.tags``
    remains the displayed/searchable union of preserved base tags + auto + manual tags.
    Clearing auto tags (``tags=[]``) removes ``tags_auto`` and leaves any preserved tags
    and ``tags_manual`` entries visible. This is intentionally separate from
    :func:`set_tags`, which is the human edit path.
    Returns the resulting displayed tag list, or ``None`` if the item is missing.
    Caller commits.
    """
    row = get_item(conn, fullname)
    if row is None:
        return None
    md = parse_metadata(row.get("metadata"))
    preserved = _tag_list(preserve_tags)
    auto = _tag_list(tags)
    manual = _tag_list(md.get("tags_manual"))
    final: list[str] = []
    for t in preserved + auto + manual:
        if t not in final:
            final.append(t)

    if final:
        md["tags"] = final
    else:
        md.pop("tags", None)
    if auto:
        md["tags_auto"] = auto
    else:
        md.pop("tags_auto", None)

    item = dict(row)
    metadata_json = json.dumps(md, ensure_ascii=False)
    search_text = build_search_text(item, md)
    if last_seen_utc is None:
        conn.execute(
            "UPDATE items SET metadata=?, search_text=? WHERE fullname=?",
            (metadata_json, search_text, fullname),
        )
    else:
        conn.execute(
            "UPDATE items SET metadata=?, search_text=?, last_seen_utc=? WHERE fullname=?",
            (metadata_json, search_text, int(last_seen_utc), fullname),
        )
    return final


def normalize_processing_tags(conn: sqlite3.Connection) -> int:
    """One-time backfill: ensure the category→tag dual-write is populated for rows
    that have a ``metadata.category`` but may be missing the tag mirror.
    Idempotent — safe to re-run."""
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
_USER_STATE_METADATA_KEYS = {
    "karakeep_id",
    "decayed_at",
    "decay_label",
    "snoozed_until",
    "snoozed_wave",
    "snooze_count",
}
_WIKILINK_RE = re.compile(r"\[\[([^\]]+)\]\]")
_INLINE_TAG_RE = re.compile(r"(?<![:/\w])#([\w\-/]+)")


def _obsidian_body_metadata(body: str) -> dict:
    """Metadata derived from an Obsidian note body."""
    wikilinks = []
    for raw in _WIKILINK_RE.findall(body or ""):
        target = raw.split("#")[0].split("|")[0].strip()
        if target and target not in wikilinks:
            wikilinks.append(target)
    tags = list(dict.fromkeys(_INLINE_TAG_RE.findall(body or "")))
    return {"tags": tags, "wikilinks": wikilinks}


def set_body(conn: sqlite3.Connection, fullname: str, body: str) -> dict | None:
    """Set an item's body, update search text, and mark it as user-edited.

    Direct UPDATE mirrors the user-state helpers: callers commit, and the existing
    items_au trigger keeps FTS in sync.
    """
    row = get_item(conn, fullname)
    if row is None:
        return None
    text = str(body or "")
    item = dict(row)
    item["body"] = text
    md = parse_metadata(row.get("metadata"))
    md["body_edited_at"] = int(time.time())
    if row.get("source") == "obsidian":
        derived = _obsidian_body_metadata(text)
        manual = _tag_list(md.get("tags_manual"))
        tags = _tag_list(derived["tags"])
        for t in manual:
            if t not in tags:
                tags.append(t)
        md["tags"] = tags
        md["wikilinks"] = derived["wikilinks"]
    conn.execute(
        "UPDATE items SET body=?, metadata=?, search_text=? WHERE fullname=?",
        (
            text,
            json.dumps(md, ensure_ascii=False),
            build_search_text(item, md),
            fullname,
        ),
    )
    return _public_by_fullname(conn, fullname)


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
    emd = parse_metadata(existing.get("metadata"))
    for f in _OVERLAY_FIELDS:
        if f == "body" and emd.get("body_edited_at"):
            continue
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
    for k, v in incoming_md.items():
        if k in _USER_STATE_METADATA_KEYS and k in emd:
            continue
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
    # Stamped tag subsets survive any tag rewrite/replace above: re-union the
    # programmatic and human subsets back into tags. Auto tags remain replaceable via
    # set_auto_tags(tags=[]); manual tags remain replaceable via set_tags(remove=...).
    stamped = _tag_list(emd.get("tags_auto")) + _tag_list(emd.get("tags_manual"))
    if stamped:
        tags = _tag_list(emd.get("tags"))
        for t in stamped:
            if t not in tags:
                tags.append(t)
        emd["tags"] = tags
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
    a = (alias + ".") if alias else ""
    if sort == "shuffle":
        # "Mixed-content" browse (Epic 10): interleave sources round-robin so a page is a
        # varied MIX instead of grouped/recency. Deterministic (nth-item-of-each-source,
        # then source) so infinite-scroll pages don't dup/skip — unlike ORDER BY RANDOM().
        return (
            f"ORDER BY row_number() OVER (PARTITION BY {a}source "
            f"ORDER BY {a}first_seen_utc DESC, {a}rowid), {a}source"
        )
    col = _SORT_COLUMNS.get(sort or "", "last_seen_utc")
    direction = "ASC" if (order or "desc").lower() == "asc" else "DESC"
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
    source: str | list[str] | None = None,
    kind: str | list[str] | None = None,
    status: str | list[str] | None = None,
    category: str | None = None,
    tags: list[str] | None = None,
    tags_all: bool = False,
    subreddit: str | list[str] | None = None,
    author: str | list[str] | None = None,
    is_saved: int | None = None,
    nsfw: bool = False,
    hide_nsfw: bool = False,
    decayed: bool = False,
    swept: bool = False,
    snoozed: bool = False,
    hide_snoozed: bool = False,
    deleted: bool = False,
    has_media: str | list[str] | None = None,
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
            if isinstance(source, list):
                ph = ",".join("?" for _ in source)
                filters.append(f"{a}source IN ({ph})")
                params.extend(source)
            else:
                filters.append(f"{a}source = ?")
                params.append(source)
        if kind:
            if isinstance(kind, list):
                ph = ",".join("?" for _ in kind)
                filters.append(f"{a}kind IN ({ph})")
                params.extend(kind)
            else:
                filters.append(f"{a}kind = ?")
                params.append(kind)
        if status:
            if isinstance(status, list):
                ph = ",".join("?" for _ in status)
                filters.append(f"{a}status IN ({ph})")
                params.extend(status)
            else:
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
        # An item is NSFW if it carries an NSFW tag OR Reddit flagged it over_18. The UI blurs/
        # badges on over_18 alone (render.js isNsfw), but the over_18 flag is too sparse for
        # categorize to reliably tag (gitignored subreddit rules), so a tag-only filter left
        # over_18-but-untagged items visible under "Hide NSFW" (Epic 13 P2). COALESCE keeps an
        # absent over_18 from NULL-propagating through `NOT (… OR …)` and hiding SFW rows.
        pred = ""
        if nsfw or hide_nsfw:
            ph = ",".join("?" for _ in NSFW_TAGS)
            pred = (
                f"(EXISTS (SELECT 1 FROM json_each({a}metadata, '$.tags') WHERE value IN ({ph}))"
                f" OR COALESCE(json_extract({a}metadata, '$.over_18'), 0) = 1)"
            )
        if nsfw:
            filters.append(pred)
            params.extend(NSFW_TAGS)
        if hide_nsfw:
            filters.append("NOT " + pred)  # exact inverse of the include filter above
            params.extend(NSFW_TAGS)
        if has_media:
            # has:video|image|gallery — facet over metadata.media_type. "video" means
            # reddit-hosted video ('reddit_video'); external embeds keep media_type='link'.
            if isinstance(has_media, list):
                mapped = [{"video": "reddit_video"}.get(h, h) for h in has_media]
                ph = ",".join("?" for _ in mapped)
                filters.append(f"json_extract({a}metadata, '$.media_type') IN ({ph})")
                params.extend(mapped)
            else:
                mt = {"video": "reddit_video"}.get(has_media, has_media)
                filters.append(f"json_extract({a}metadata, '$.media_type') = ?")
                params.append(mt)
        if decayed:
            # decayed (is:decayed): the item carries a decay-wave stamp (see db.decay).
            filters.append(f"json_extract({a}metadata, '$.decayed_at') IS NOT NULL")
        if swept:
            # swept (is:swept): decayed in the labeled initial backfill pass specifically.
            filters.append(f"json_extract({a}metadata, '$.decay_label') = 'swept'")
        if snoozed:
            # snoozed (is:snoozed): currently hidden from triage until a future UTC.
            filters.append(f"json_extract({a}metadata, '$.snoozed_until') > ?")
            params.append(int(time.time()))
        if hide_snoozed and not snoozed:
            filters.append(
                f"(json_extract({a}metadata, '$.snoozed_until') IS NULL "
                f"OR json_extract({a}metadata, '$.snoozed_until') <= ?)"
            )
            params.append(int(time.time()))
        if deleted:
            # deleted (is:deleted): media probed gone (scan-deleted-media). media_status is the
            # durable SSOT — the mirrored `deleted` tag is wiped by a categorize retag.
            filters.append(f"json_extract({a}metadata, '$.media_status') = 'gone'")
        if subreddit:
            if isinstance(subreddit, list):
                ph = ",".join("?" for _ in subreddit)
                filters.append(
                    f"json_extract({a}metadata, '$.subreddit') IN ({ph}) COLLATE NOCASE"
                )
                params.extend(subreddit)
            else:
                filters.append(
                    f"json_extract({a}metadata, '$.subreddit') = ? COLLATE NOCASE"
                )
                params.append(subreddit)
        if author:
            # author is a first-class column (filled for reddit/HN); matched case-insensitively
            # to mirror subreddit. Drives the `author:` operator + the bare `u/<user>` shorthand.
            if isinstance(author, list):
                ph = ",".join("?" for _ in author)
                filters.append(f"{a}author IN ({ph}) COLLATE NOCASE")
                params.extend(author)
            else:
                filters.append(f"{a}author = ? COLLATE NOCASE")
                params.append(author)
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
        if (
            open_in_firefox
        ):  # the "📑 Firefox tabs" batch (json true -> json_extract returns 1)
            filters.append(f"json_extract({a}metadata, '$.open_in_firefox') = 1")
        if not include_consolidated:
            filters.append(f"json_extract({a}metadata, '$.consolidated_into') IS NULL")

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
                esc = (
                    tk.lower()
                    .replace("\\", r"\\")
                    .replace("_", r"\_")
                    .replace("%", r"\%")
                )
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
    mode: str = "random",
    smart_mix: float = 0.5,
) -> list[dict]:
    """Return up to ``n`` items — the triage batch (default: random inbox).

    ``mode='smart'`` (Epic 10) interleaves likely-to-be-processed items with recent
    ones instead of a flat shuffle: ~``smart_mix`` of the batch is sampled from the
    top of ``metadata.triage_score`` (written by ``triage_score.learn``), the rest
    from the newest-synced, topped up randomly when either pool runs short. Sampling
    from a pool (5x oversample) rather than taking the strict top keeps repeat
    batches varied. Falls back to pure random when no scores exist yet.
    """
    import random as _random

    filters = []
    params: list = []
    if unprocessed:
        filters.append("status = 'inbox'")
        filters.append(
            "(json_extract(metadata, '$.snoozed_until') IS NULL "
            "OR json_extract(metadata, '$.snoozed_until') <= ?)"
        )
        params.append(int(time.time()))
    if source:
        filters.append("source = ?")
        params.append(source)
    where = (" WHERE " + " AND ".join(filters)) if filters else ""

    if mode != "smart":
        sql = f"SELECT * FROM items{where} ORDER BY RANDOM() LIMIT ?"
        rows = conn.execute(sql, params + [int(n)]).fetchall()
        return [_row_to_public(r) for r in rows]

    n = int(n)
    k_score = max(1, round(n * smart_mix))
    k_recent = max(0, n - k_score)
    score_where = (
        where
        + (" AND " if where else " WHERE ")
        + "json_extract(metadata, '$.triage_score') IS NOT NULL"
    )
    score_pool = conn.execute(
        f"SELECT * FROM items{score_where} "
        f"ORDER BY json_extract(metadata, '$.triage_score') DESC LIMIT ?",
        params + [k_score * 5],
    ).fetchall()
    recent_pool = conn.execute(
        f"SELECT * FROM items{where} ORDER BY first_seen_utc DESC LIMIT ?",
        params + [k_recent * 5],
    ).fetchall()

    picked: dict[str, object] = {}
    for pool, k in ((score_pool, k_score), (recent_pool, k_recent)):
        pool = [r for r in pool if r["fullname"] not in picked]
        for r in _random.sample(pool, min(k, len(pool))):
            picked[r["fullname"]] = r
    if len(picked) < n:  # top up randomly (small inboxes, missing scores)
        ph = ",".join("?" for _ in picked) or "''"
        extra = conn.execute(
            f"SELECT * FROM items{where}"
            + (" AND " if where else " WHERE ")
            + f"fullname NOT IN ({ph}) ORDER BY RANDOM() LIMIT ?",
            params + list(picked.keys()) + [n - len(picked)],
        ).fetchall()
        for r in extra:
            picked[r["fullname"]] = r
    rows = list(picked.values())
    _random.shuffle(rows)
    return [_row_to_public(r) for r in rows[:n]]


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


def repair_reddit_comment_prefixes(conn: sqlite3.Connection) -> int:
    """Heal saved COMMENTS that were ingested (pre-fix) with a ``t3_`` (link) prefix instead of
    ``t1_`` (comment). Reddit's write endpoints 400 on the wrong thing-type, so an unsave of such a
    row fails forever and parks as ``state='failed'``.

    The correct id is derived from the item's permalink (a comment permalink carries a second id
    segment: ``/comments/<post>/<slug>/<comment>/``) via the SAME parser the importer uses, so this
    can't disagree with ingest. Rewrites every place the wrong id lives so a later re-sync can't
    re-insert a ``t1_`` duplicate of the same comment: ``items.source_id`` **and** the
    ``fullname`` primary key (``reddit:t3_x`` -> ``reddit:t1_x``), plus the dependent
    ``reddit_unsave`` (fullname + reddit_id) and ``reddit_threads`` (fullname) rows. ``items_fts`` is
    kept in sync by the items AFTER UPDATE trigger. A row whose corrected fullname already exists is
    skipped (no PK collision). Idempotent (fixed rows no longer match ``t3_``). Returns the number of
    items corrected; commits."""
    from content_hoarder.connectors.reddit import _sid_from_permalink

    rows = conn.execute(
        "SELECT fullname, source_id, json_extract(metadata, '$.permalink') AS permalink "
        "FROM items WHERE source='reddit' AND source_id LIKE 't3\\_%' ESCAPE '\\'"
    ).fetchall()
    fixed = 0
    for r in rows:
        correct = _sid_from_permalink(r["permalink"] or "")
        # Only act when the permalink resolves to a COMMENT for this exact id (same bare base36,
        # t1_ prefix). A real link/post (correct[:3]=='t3_') or a mismatch is left untouched.
        if not (correct.startswith("t1_") and correct[3:] == r["source_id"][3:]):
            continue
        old_fullname = r["fullname"]
        new_fullname = "reddit:" + correct
        if conn.execute(
            "SELECT 1 FROM items WHERE fullname=?", (new_fullname,)
        ).fetchone():
            continue  # corrected row already exists — don't collide the PK
        conn.execute(
            "UPDATE items SET source_id=?, fullname=? WHERE fullname=?",
            (correct, new_fullname, old_fullname),
        )
        conn.execute(
            "UPDATE reddit_unsave SET fullname=?, reddit_id=? WHERE fullname=?",
            (new_fullname, correct, old_fullname),
        )
        conn.execute(
            "UPDATE reddit_threads SET fullname=? WHERE fullname=?",
            (new_fullname, old_fullname),
        )
        fixed += 1
    conn.commit()
    return fixed


def dedupe_reddit_comment_twins(conn: sqlite3.Connection) -> dict:
    """Remove phantom ``t3_`` duplicates of saved COMMENTS that ALSO exist (correctly) as ``t1_``.

    A pre-fix ingest recorded some saved comments under BOTH the right id (``reddit:t1_x``) and a
    wrong link-typed id (``reddit:t3_x``). The ``t3_`` twin is bogus: it shows as a duplicate inbox
    item and 400s on unsave (Reddit rejects the wrong thing-type). This collapses each pair onto the
    canonical ``t1_`` row:

    * if the canonical row is still ``inbox`` and the phantom carries a real triage decision, that
      decision is moved to the canonical row (``set_status``) so a done/archived made on the
      duplicate isn't lost;
    * if the phantom was queued for unsave, the REAL comment is queued instead (so the originally
      intended unsave finally targets a valid id);
    * the phantom's ``items`` row (``items_fts`` auto-cleaned by the AFTER DELETE trigger),
      ``reddit_unsave`` row, and ``reddit_threads`` row are deleted.

    Distinct from :func:`repair_reddit_comment_prefixes`, which RENAMES a t3_ comment that has NO
    t1_ twin. Idempotent. Returns ``{"removed", "status_moved", "requeued"}``; commits."""
    from content_hoarder.connectors.reddit import _sid_from_permalink

    rows = conn.execute(
        "SELECT fullname, source_id, status, json_extract(metadata,'$.permalink') AS permalink "
        "FROM items WHERE source='reddit' AND source_id LIKE 't3\\_%' ESCAPE '\\'"
    ).fetchall()
    removed = status_moved = requeued = 0
    for r in rows:
        correct = _sid_from_permalink(r["permalink"] or "")
        if not (correct.startswith("t1_") and correct[3:] == r["source_id"][3:]):
            continue
        twin_fullname = "reddit:" + correct
        twin = conn.execute(
            "SELECT status FROM items WHERE fullname=?", (twin_fullname,)
        ).fetchone()
        if not twin:
            continue  # no twin -> a true orphan; repair_reddit_comment_prefixes
        phantom = r["fullname"]
        if twin["status"] == "inbox" and r["status"] != "inbox":
            set_status(
                conn, twin_fullname, r["status"]
            )  # move the only triage signal onto the real row
            status_moved += 1
        if conn.execute(
            "SELECT 1 FROM reddit_unsave WHERE fullname=?", (phantom,)
        ).fetchone():
            enqueue_unsave(conn, twin_fullname)  # queue the REAL comment (valid id)
            requeued += 1
        conn.execute("DELETE FROM reddit_unsave WHERE fullname=?", (phantom,))
        conn.execute("DELETE FROM reddit_threads WHERE fullname=?", (phantom,))
        conn.execute("DELETE FROM items WHERE fullname=?", (phantom,))
        removed += 1
    conn.commit()
    return {"removed": removed, "status_moved": status_moved, "requeued": requeued}


def preview_unsave_by_tag(conn: sqlite3.Connection, tag: str) -> dict:
    """Preview local unsave queueing for still-saved reddit items carrying *tag*.

    No network calls and no writes. The skip buckets are mutually exclusive and ordered
    so the ``eligible`` count is exactly the number a confirmed enqueue can add.
    """
    tag = str(tag or "").strip()
    summary = {
        "tag": tag,
        "matched": 0,
        "eligible": 0,
        "enqueued": 0,
        "skipped": {
            "non_reddit": 0,
            "already_unsaved": 0,
            "invalid_id": 0,
            "already_queued": 0,
        },
        "sample": [],
        "fullnames": [],
        "truncated": False,
    }
    if not tag:
        return summary

    rows = conn.execute(
        "SELECT i.fullname, i.source, i.source_id, i.kind, i.title, i.is_saved, "
        "i.created_utc, i.saved_utc, i.first_seen_utc, "
        "json_extract(i.metadata, '$.subreddit') AS subreddit, q.fullname AS queued "
        "FROM items i "
        "LEFT JOIN reddit_unsave q ON q.fullname = i.fullname "
        "WHERE EXISTS (SELECT 1 FROM json_each(i.metadata, '$.tags') WHERE value = ?) "
        "ORDER BY COALESCE(i.saved_utc, i.first_seen_utc, i.created_utc, 0) DESC, i.fullname ASC",
        (tag,),
    ).fetchall()
    summary["matched"] = len(rows)

    fullnames: list[str] = []
    sample: list[dict] = []
    skipped = summary["skipped"]
    for row in rows:
        if row["source"] != "reddit":
            skipped["non_reddit"] += 1
            continue
        if int(row["is_saved"] or 0) != 1:
            skipped["already_unsaved"] += 1
            continue
        sid = row["source_id"] or ""
        if not sid.startswith(("t1_", "t3_")):
            skipped["invalid_id"] += 1
            continue
        if row["queued"] is not None:
            skipped["already_queued"] += 1
            continue
        fullnames.append(row["fullname"])
        if len(sample) < 20:
            sample.append(
                {
                    "fullname": row["fullname"],
                    "reddit_id": sid,
                    "title": (row["title"] or "")[:120],
                    "subreddit": row["subreddit"],
                    "kind": row["kind"],
                    "created_utc": row["created_utc"],
                    "saved_utc": row["saved_utc"],
                    "first_seen_utc": row["first_seen_utc"],
                }
            )

    summary["eligible"] = len(fullnames)
    summary["sample"] = sample
    summary["fullnames"] = fullnames[:200]
    summary["truncated"] = len(fullnames) > 200
    return summary


def enqueue_unsave_by_tag(
    conn: sqlite3.Connection, tag: str, *, dry_run: bool = False
) -> dict:
    """Queue every still-saved reddit item carrying *tag* for unsaving.

    Idempotent and local-only: existing ``reddit_unsave`` rows are left untouched, and
    Reddit is contacted only by the separate drain operation. Returns a preview/apply
    summary with ``enqueued`` set to the number newly inserted.
    """
    summary = preview_unsave_by_tag(conn, tag)
    summary["dry_run"] = bool(dry_run)
    if dry_run or not summary["eligible"]:
        conn.commit()
        return summary

    now = int(time.time())
    conn.execute(
        "INSERT INTO reddit_unsave(fullname, reddit_id, state, enqueued_utc) "
        "SELECT i.fullname, i.source_id, 'pending', ? "
        "FROM items i "
        "WHERE i.source = 'reddit' "
        "AND i.is_saved = 1 "
        "AND EXISTS (SELECT 1 FROM json_each(i.metadata, '$.tags') WHERE value = ?) "
        "AND (i.source_id LIKE 't3\\_%' ESCAPE '\\' OR i.source_id LIKE 't1\\_%' ESCAPE '\\') "
        "AND NOT EXISTS (SELECT 1 FROM reddit_unsave q WHERE q.fullname = i.fullname) "
        "ON CONFLICT(fullname) DO NOTHING",
        (now, summary["tag"]),
    )
    summary["enqueued"] = conn.execute("SELECT changes()").fetchone()[0]
    conn.commit()
    return summary


def reconcile_reddit_saves(
    conn: sqlite3.Connection,
    present_by_kind: dict,
    *,
    dry_run: bool = False,
    cap: int = 1000,
    truncated_by_kind: dict | None = None,
) -> dict:
    """Flip ``is_saved`` to 0 for reddit items missing from a fresh saved-list export.

    ``present_by_kind`` maps ``"post"``/``"comment"`` -> the set of ``source_id``s
    (``t3_``/``t1_`` ids) seen in the export. A DB item still marked saved but absent from the
    export was un-saved on reddit.com, so we clear ``is_saved`` locally (we do NOT enqueue an
    unsave — it's already gone server-side).

    DELTA RECONCILE (the only safe design) — this NEVER touches a row that wasn't itself
    previously confirmed in a saved-list snapshot. ``is_saved=1`` in this DB is the
    ``new_item`` default for *every* imported reddit row (bulk Karakeep/GDPR/JSON dumps), not
    "currently saved on reddit", so a single export can't tell un-saved from never-a-real-save.
    We therefore only consider rows carrying the ``metadata.saved_seen_utc`` provenance marker
    (stamped by the saveddit import / a saved-list sync). Consequence: the FIRST snapshot just
    establishes the baseline (marks rows, un-saves nothing); later snapshots detect genuine
    drop-outs among previously-seen items. Bulk-imported rows are never reconciled.

    SAFETY — also Reddit's saved listing caps at ~``cap`` items PER TYPE (links vs comments
    fetched separately). A type whose export count reaches the cap may be *truncated*, so a
    missing item could be merely beyond the cap; that type is SKIPPED. Zero-row types are skipped.

    ``truncated_by_kind`` lets the SYNC/IMPORT layer — which actually knows whether the listing
    was exhausted (walked ``after`` to the end / a complete GDPR export) vs. stopped at a page
    cap — override the row-count inference (B2). When a kind appears in it, its bool governs:
    ``True`` skips that type (``skipped='source_truncated'``) regardless of count; ``False``
    reconciles even AT/above ``cap`` (so a *complete* export of exactly ``cap`` items is no
    longer mistaken for a truncated one). When ``None`` or a kind is absent, the legacy
    ``len(present) >= cap`` inference is used — existing callers are unchanged.

    Returns ``{kind: {present, capped, skipped, unsaved, fullnames}}``. ``dry_run=True`` previews
    (computes the would-unsave set) without writing. This is a non-additive, destructive write —
    back up the DB first.
    """
    summary: dict = {}
    any_write = False
    for kind in ("post", "comment"):
        present = present_by_kind.get(kind) or set()
        cap_reached = len(present) >= cap
        explicit = truncated_by_kind.get(kind) if truncated_by_kind else None
        info = {
            "present": len(present),
            "capped": cap_reached,
            "skipped": None,
            "unsaved": 0,
            "fullnames": [],
        }
        if not present:
            info["capped"] = False
            info["skipped"] = "no_export_rows"
        elif explicit is True:
            info["skipped"] = "source_truncated"  # caller knows the listing was cut off
        elif explicit is None and cap_reached:
            info["skipped"] = "cap_reached"  # legacy row-count inference
        # explicit is False -> reconcile even at/above cap (a known-complete export)
        if not info["skipped"]:
            # Only previously-seen-in-a-snapshot rows are reconcile candidates (delta reconcile).
            rows = conn.execute(
                "SELECT fullname, source_id FROM items "
                "WHERE source='reddit' AND kind=? AND is_saved=1 "
                "AND json_extract(metadata, '$.saved_seen_utc') IS NOT NULL",
                (kind,),
            ).fetchall()
            missing = [r["fullname"] for r in rows if r["source_id"] not in present]
            info["unsaved"] = len(missing)
            info["fullnames"] = missing
            if missing and not dry_run:
                conn.executemany(
                    "UPDATE items SET is_saved=0 WHERE fullname=?",
                    [(fn,) for fn in missing],
                )
                any_write = True
        summary[kind] = info
    if any_write:
        conn.commit()
    return summary


# Any MANUAL status transition exits transient triage states (see decay/undecay and
# snooze/unsnooze): strip wave marks so "stamped == currently decayed/snoozed" holds.
# ``snooze_count`` deliberately survives as cumulative history; a manual decision only
# clears the active deferral. One definition for every status writer — a future writer
# that forgets this breaks the invariant silently. No json_valid guard needed: the
# functional duration index makes SQLite validate metadata JSON on every write, so a
# malformed row can never exist here (pinned by test_malformed_metadata_cannot_enter_the_db).
_STRIP_DECAY_SQL = (
    "json_remove(metadata, '$.decayed_at', '$.decay_label', "
    "'$.snoozed_until', '$.snoozed_wave')"
)


def set_status(
    conn: sqlite3.Connection, fullname: str, status: str, *, queue_unsave: bool = True
) -> dict | None:
    """Set an item's triage status; record the previous one for undo.

    ``queue_unsave`` (default True) controls whether a transition to ``done`` enqueues a Reddit
    unsave when the opt-in is on. The reconcile path passes ``False``: an item promoted to done
    *because it was already unsaved on Reddit* must not trigger a redundant no-op unsave write
    (mirrors ``reconcile_reddit_saves`` — it's already gone server-side)."""
    if status not in VALID_STATUSES:
        raise ValueError(f"invalid status: {status!r}")
    row = conn.execute(
        "SELECT status FROM items WHERE fullname=?", (fullname,)
    ).fetchone()
    if row is None:
        return None
    old = row[0]
    if status == old:
        return _public_by_fullname(
            conn, fullname
        )  # idempotent; don't clobber status_prev
    now = int(time.time())
    processed = None if status == "inbox" else now
    conn.execute(
        f"UPDATE items SET status=?, status_prev=?, processed_utc=?, "
        f"metadata={_STRIP_DECAY_SQL} WHERE fullname=?",
        (status, old, processed, fullname),
    )
    if status == "done" and queue_unsave and _unsave_enabled(conn):
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


def bulk_set_status(conn: sqlite3.Connection, fullnames: list[str], status: str) -> int:
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


def _dedupe_fullnames(fullnames: list[str] | None) -> list[str]:
    out: list[str] = []
    for fn in fullnames or []:
        s = str(fn or "").strip()
        if s and s not in out:
            out.append(s)
    return out


def _sample_items(rows, *, samples: int = 5) -> list[str]:
    return [f"{r['fullname']}: {(r['title'] or '')[:60]}" for r in list(rows)[:samples]]


def _inbox_rows_for_fullnames(conn: sqlite3.Connection, fullnames: list[str]):
    fns = _dedupe_fullnames(fullnames)
    if not fns:
        raise ValueError("fullnames must not be empty")
    ph = ",".join("?" for _ in fns)
    rows = conn.execute(
        f"SELECT fullname, status, title, metadata FROM items WHERE fullname IN ({ph})",
        fns,
    ).fetchall()
    by_fn = {r["fullname"]: r for r in rows}
    missing = [fn for fn in fns if fn not in by_fn]
    if missing:
        raise ValueError(f"unknown item(s): {', '.join(missing[:5])}")
    non_inbox = [fn for fn in fns if by_fn[fn]["status"] != "inbox"]
    if non_inbox:
        raise ValueError(f"can only snooze inbox item(s): {', '.join(non_inbox[:5])}")
    return [by_fn[fn] for fn in fns]


def snooze(
    conn: sqlite3.Connection,
    *,
    fullnames: list[str],
    until_utc: int,
    window_days: int = 7,
    escalate_after: int = 3,
    apply: bool = False,
    samples: int = 5,
) -> dict:
    """Stamp inbox items as snoozed without changing status.

    ``metadata.snoozed_until`` hides the item from triage batches until that UTC, and
    ``metadata.snoozed_wave`` makes one snooze wave reversible via ``unsnooze``.
    ``metadata.snooze_count`` is cumulative: unsnooze and manual decisions do not
    decrement it. When a snooze would make the count reach ``escalate_after``, the
    item silently follows the decay path instead (archived with
    ``decay_label='snooze-escalated'``), still by direct UPDATE and never via
    ``bulk_set_status``.
    """
    if escalate_after < 1:
        raise ValueError("escalate_after must be >= 1")
    rows = _inbox_rows_for_fullnames(conn, fullnames)
    to_snooze: list[str] = []
    escalated: list[str] = []
    for r in rows:
        md = parse_metadata(r["metadata"])
        count = int(md.get("snooze_count") or 0) + 1
        if count >= int(escalate_after):
            escalated.append(r["fullname"])
        else:
            to_snooze.append(r["fullname"])

    res = {
        "total": len(rows),
        "applied": False,
        "until_utc": int(until_utc),
        "window_days": int(window_days),
        "snoozed_wave": None,
        "decayed_at": None,
        "escalated": escalated,
        "snoozed": to_snooze,
        "sample": _sample_items(rows, samples=samples),
    }
    if not apply:
        return res

    res["applied"] = True
    now = int(time.time())
    applied_total = 0
    if to_snooze:
        wave = _allocate_snooze_wave(conn, now=now, commit=False)
        ph = ",".join("?" for _ in to_snooze)
        cur = conn.execute(
            "UPDATE items SET metadata=json_set("
            "metadata, '$.snoozed_until', ?, "
            "'$.snooze_count', CAST(COALESCE(json_extract(metadata, '$.snooze_count'), 0) AS INTEGER) + 1, "
            "'$.snoozed_wave', ?) "
            f"WHERE status='inbox' AND fullname IN ({ph})",
            [int(until_utc), wave] + to_snooze,
        )
        applied_total += cur.rowcount
        res["snoozed_wave"] = wave
    if escalated:
        wave = _allocate_decay_wave(conn, now=now, commit=False)
        ph = ",".join("?" for _ in escalated)
        cur = conn.execute(
            "UPDATE items SET status='archived', status_prev='inbox', processed_utc=?, "
            "metadata=json_set("
            "json_remove(metadata, '$.snoozed_until', '$.snoozed_wave'), "
            "'$.snooze_count', CAST(COALESCE(json_extract(metadata, '$.snooze_count'), 0) AS INTEGER) + 1, "
            "'$.decayed_at', ?, '$.decay_label', ?) "
            f"WHERE status='inbox' AND fullname IN ({ph})",
            [now, wave, "snooze-escalated"] + escalated,
        )
        applied_total += cur.rowcount
        res["decayed_at"] = wave
    conn.commit()
    res["total"] = applied_total
    return res


def unsnooze(
    conn: sqlite3.Connection,
    *,
    snoozed_wave: int | None = None,
    fullnames: list[str] | None = None,
    apply: bool = False,
    samples: int = 5,
) -> dict:
    """Clear active snooze marks for one wave or explicit inbox items.

    ``snooze_count`` is intentionally not decremented; it is a cumulative signal used
    for repeat-snooze escalation. This function never changes status and never touches
    the Reddit unsave queue.
    """
    fns = _dedupe_fullnames(fullnames)
    if (snoozed_wave is None and not fns) or (snoozed_wave is not None and fns):
        raise ValueError("select either snoozed_wave or fullnames")
    clauses = [
        "status='inbox'",
        "json_extract(metadata, '$.snoozed_until') IS NOT NULL",
    ]
    params: list = []
    if snoozed_wave is not None:
        clauses.append("json_extract(metadata, '$.snoozed_wave') = ?")
        params.append(int(snoozed_wave))
    else:
        ph = ",".join("?" for _ in fns)
        clauses.append(f"fullname IN ({ph})")
        params.extend(fns)
    where = " AND ".join(clauses)
    rows = conn.execute(
        f"SELECT fullname, title FROM items WHERE {where} ORDER BY fullname LIMIT ?",
        params + [int(samples)],
    ).fetchall()
    total = conn.execute(
        f"SELECT COUNT(*) FROM items WHERE {where}", params
    ).fetchone()[0]
    res = {
        "total": total,
        "applied": False,
        "snoozed_wave": snoozed_wave,
        "sample": _sample_items(rows, samples=samples),
    }
    if apply:
        res["applied"] = True
        if total:
            cur = conn.execute(
                "UPDATE items SET metadata=json_remove(metadata, '$.snoozed_until', '$.snoozed_wave') "
                f"WHERE {where}",
                params,
            )
            conn.commit()
            res["total"] = cur.rowcount
    return res


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
        sel.append(
            f"EXISTS (SELECT 1 FROM json_each(metadata, '$.tags') WHERE value IN ({ph}))"
        )
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
    and archives them stamping ``metadata.decayed_at``. The stamp is a UNIQUE monotonic
    wave id (``_allocate_decay_wave``), not bare ``now`` — so two decays in the same
    wall-clock second still get distinct stamps and each is one independently reversible
    "wave" (see ``undecay``); it stays ~wall-clock for ``is:decayed``/``swept_recent``.
    Refuses an unselected decay.
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
        raise ValueError(
            "decay needs at least one selector (tags/subreddits/before_utc)"
        )
    where, params = _decay_where(tags, subreddits, before_utc, source)
    total = conn.execute(
        f"SELECT COUNT(*) FROM items WHERE {where}", params
    ).fetchone()[0]

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
        [now - yr, now - yr, now - 2 * yr, now - 2 * yr, now - 4 * yr, now - 4 * yr]
        + params,
    ).fetchone()
    age_bands = {
        "<1y": b[0] or 0,
        "1-2y": b[1] or 0,
        "2-4y": b[2] or 0,
        ">=4y": b[3] or 0,
    }

    sample = [
        f"r/{r[0] or '?'}: {(r[1] or '')[:60]}"
        for r in conn.execute(
            f"SELECT json_extract(metadata, '$.subreddit'), title FROM items "
            f"WHERE {where} ORDER BY RANDOM() LIMIT ?",
            params + [int(samples)],
        ).fetchall()
    ]

    res = {
        "total": total,
        "applied": False,
        "decayed_at": None,
        "label": label,
        "by_tag": by_tag,
        "by_subreddit": by_subreddit,
        "age_bands": age_bands,
        "sample": sample,
    }
    if apply:
        res["applied"] = True
        if total:
            # A unique monotonic wave id (not bare ``now``) so two decays in the same
            # second get distinct stamps and UNDO reverses exactly one wave. For the
            # first wave on a DB it equals ``now`` (counter starts at 0), so the stamp
            # stays ~wall-clock; ``processed_utc`` keeps the real timestamp.
            wave = _allocate_decay_wave(conn, now=now, commit=False)
            set_md = "json_set(metadata, '$.decayed_at', ?)"
            md_params = [wave]
            if label:
                set_md = "json_set(metadata, '$.decayed_at', ?, '$.decay_label', ?)"
                md_params = [wave, label]
            cur = conn.execute(
                f"UPDATE items SET status='archived', status_prev='inbox', processed_utc=?, "
                f"metadata={set_md} WHERE {where}",
                [now] + md_params + params,
            )
            conn.commit()
            res.update(total=cur.rowcount, decayed_at=wave)
    return res


def decay_fullnames(
    conn: sqlite3.Connection,
    *,
    fullnames: list[str],
    label: str | None = None,
    apply: bool = False,
    samples: int = 5,
) -> dict:
    """Decay explicit inbox items by fullname, using the same reversible stamp shape.

    This is the exact-selection hook for repeat-snooze escalation. It deliberately uses
    a direct UPDATE like ``decay`` and never routes through ``bulk_set_status``, so it
    cannot enqueue Reddit unsaves.
    """
    fns = _dedupe_fullnames(fullnames)
    if not fns:
        raise ValueError("fullnames must not be empty")
    ph = ",".join("?" for _ in fns)
    where = f"status='inbox' AND fullname IN ({ph})"
    rows = conn.execute(
        f"SELECT fullname, title FROM items WHERE {where} ORDER BY fullname LIMIT ?",
        fns + [int(samples)],
    ).fetchall()
    total = conn.execute(f"SELECT COUNT(*) FROM items WHERE {where}", fns).fetchone()[0]
    res = {
        "total": total,
        "applied": False,
        "decayed_at": None,
        "label": label,
        "sample": _sample_items(rows, samples=samples),
    }
    if apply:
        res["applied"] = True
        if total:
            now = int(time.time())
            wave = _allocate_decay_wave(conn, now=now, commit=False)
            set_md = (
                "json_set(json_remove(metadata, '$.snoozed_until', '$.snoozed_wave'), "
                "'$.decayed_at', ?)"
            )
            md_params = [wave]
            if label:
                set_md = (
                    "json_set(json_remove(metadata, '$.snoozed_until', '$.snoozed_wave'), "
                    "'$.decayed_at', ?, '$.decay_label', ?)"
                )
                md_params = [wave, label]
            cur = conn.execute(
                f"UPDATE items SET status='archived', status_prev='inbox', processed_utc=?, "
                f"metadata={set_md} WHERE {where}",
                [now] + md_params + fns,
            )
            conn.commit()
            res.update(total=cur.rowcount, decayed_at=wave)
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
    clauses = [
        "status='archived'",
        "json_extract(metadata, '$.decayed_at') IS NOT NULL",
    ]
    params: list = []
    if decayed_after is not None:
        clauses.append("json_extract(metadata, '$.decayed_at') >= ?")
        params.append(int(decayed_after))
    if decayed_before is not None:
        clauses.append("json_extract(metadata, '$.decayed_at') < ?")
        params.append(int(decayed_before))
    where = " AND ".join(clauses)
    total = conn.execute(
        f"SELECT COUNT(*) FROM items WHERE {where}", params
    ).fetchone()[0]
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
    if not (
        tags or subreddits or before_utc or fullnames or swept or decayed or status
    ):
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
        sel.append(
            f"EXISTS (SELECT 1 FROM json_each(metadata, '$.tags') WHERE value IN ({ph}))"
        )
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

    victims = [
        r[0]
        for r in conn.execute(
            f"SELECT fullname FROM items WHERE {where}", params
        ).fetchall()
    ]
    total = len(victims)
    sample = [
        f"r/{r[0] or '?'}: {(r[1] or '')[:60]}"
        for r in conn.execute(
            f"SELECT json_extract(metadata, '$.subreddit'), title FROM items "
            f"WHERE {where} ORDER BY RANDOM() LIMIT ?",
            params + [int(samples)],
        ).fetchall()
    ]
    res = {
        "total": total,
        "applied": False,
        "threads_deleted": 0,
        "unsave_enqueued": 0,
        "sample": sample,
    }
    if not apply:
        return res
    if total > max_rows:
        raise ValueError(
            f"refusing to delete {total} rows (> max_rows={max_rows}); "
            f"raise max_rows deliberately if this is intended"
        )
    res["applied"] = True
    if not total:
        return res

    enqueued = 0
    if also_unsave:
        before_q = conn.execute("SELECT COUNT(*) FROM reddit_unsave").fetchone()[0]
        for fn in victims:  # must happen while the item rows still exist
            enqueue_unsave(conn, fn)
        enqueued = (
            conn.execute("SELECT COUNT(*) FROM reddit_unsave").fetchone()[0] - before_q
        )

    threads = 0
    for i in range(0, total, 500):  # chunk IN lists well under SQLite's variable cap
        chunk = victims[i : i + 500]
        ph = ",".join("?" for _ in chunk)
        cur = conn.execute(
            f"DELETE FROM reddit_threads WHERE fullname IN ({ph})", chunk
        )
        threads += cur.rowcount
        if not also_unsave:
            conn.execute(
                f"DELETE FROM reddit_unsave WHERE fullname IN ({ph}) AND state='pending'",
                chunk,
            )
        conn.execute(f"DELETE FROM items WHERE fullname IN ({ph})", chunk)
    conn.commit()
    res.update(threads_deleted=threads, unsave_enqueued=enqueued)
    return res


def purge_done(
    conn: sqlite3.Connection,
    *,
    now: int | None = None,
    apply: bool = False,
    max_rows: int = 5000,
) -> dict:
    """Permanently purge ``status='done'`` items older than a retention window (Gmail-trash; F15).

    Items left Done longer than ``done_retention_days`` (setting, default 30) are permanently
    deleted. Age is measured from ``processed_utc`` (when the item entered Done — there is no
    separate done_at column): an item qualifies when ``processed_utc < now - retention*86400``.
    ``processed_utc IS NULL`` rows are excluded so an undated Done item is never purged.

    Like ``decay`` and ``delete_items``, this is a DIRECT delete — never routed through
    ``bulk_set_status``/``enqueue_unsave`` — so a retention purge MUST NOT enqueue a Reddit
    unsave. Only ``status='done'`` rows are ever selected; inbox/keep/archived are untouched.
    Pending ``reddit_unsave`` rows for purged items are removed (a local purge should not let a
    later drain unsave something the user only deleted locally); drained history rows are kept
    as audit. ``apply=True`` refuses to delete more than ``max_rows`` (blast-radius cap, mirrors
    ``delete_items`` — guards a misconfigured 0-day retention). Dry-run (default) changes nothing.
    Returns ``{"total", "applied", "retention_days", "cutoff", "threads_deleted", "sample"}``.
    """
    now = int(now if now is not None else time.time())
    retention_days = int(get_setting(conn, "done_retention_days", 30) or 30)
    cutoff = now - retention_days * 86400
    where = "status='done' AND processed_utc IS NOT NULL AND processed_utc < ?"
    params: list = [cutoff]

    total = conn.execute(
        f"SELECT COUNT(*) FROM items WHERE {where}", params
    ).fetchone()[0]
    sample = [
        f"{r[0]}: {(r[1] or '')[:60]}"
        for r in conn.execute(
            f"SELECT source, title FROM items WHERE {where} ORDER BY processed_utc LIMIT 5",
            params,
        ).fetchall()
    ]
    res = {
        "total": total,
        "applied": False,
        "retention_days": retention_days,
        "cutoff": cutoff,
        "threads_deleted": 0,
        "sample": sample,
    }
    if not apply:
        return res
    if total > max_rows:
        raise ValueError(
            f"refusing to purge {total} done rows (> max_rows={max_rows}); "
            f"raise max_rows deliberately if this is intended"
        )
    res["applied"] = True
    if not total:
        return res

    victims = [
        r[0]
        for r in conn.execute(
            f"SELECT fullname FROM items WHERE {where}", params
        ).fetchall()
    ]
    threads = 0
    for i in range(0, len(victims), 500):  # chunk IN lists under SQLite's variable cap
        chunk = victims[i : i + 500]
        ph = ",".join("?" for _ in chunk)
        cur = conn.execute(
            f"DELETE FROM reddit_threads WHERE fullname IN ({ph})", chunk
        )
        threads += cur.rowcount
        conn.execute(
            f"DELETE FROM reddit_unsave WHERE fullname IN ({ph}) AND state='pending'",
            chunk,
        )
        conn.execute(f"DELETE FROM items WHERE fullname IN ({ph})", chunk)
    conn.commit()
    res["threads_deleted"] = threads
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
        "SELECT thread_json, hydrated_at FROM reddit_threads WHERE fullname=?",
        (fullname,),
    ).fetchone()
    if not row:
        return None
    result = dict(row)
    if isinstance(result["thread_json"], bytes):
        result["thread_json"] = gzip.decompress(result["thread_json"]).decode("utf-8")
    return result


def set_reddit_thread(
    conn: sqlite3.Connection,
    fullname: str,
    thread_json: str,
    hydrated_at: int | None = None,
    *,
    commit: bool = True,
) -> None:
    """Cache (or replace) a thread JSON blob for an item. Idempotent."""
    compressed = gzip.compress(thread_json.encode("utf-8"))
    conn.execute(
        "INSERT INTO reddit_threads(fullname, thread_json, hydrated_at) VALUES(?, ?, ?) "
        "ON CONFLICT(fullname) DO UPDATE SET "
        "thread_json=excluded.thread_json, hydrated_at=excluded.hydrated_at",
        (
            fullname,
            compressed,
            hydrated_at if hydrated_at is not None else int(time.time()),
        ),
    )
    if commit:
        conn.commit()


def reddit_subreddit_counts(
    conn: sqlite3.Connection, status: str | None = None
) -> list[dict]:
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
    midnight = int(
        time.mktime(
            (lt.tm_year, lt.tm_mon, lt.tm_mday, 0, 0, 0, lt.tm_wday, lt.tm_yday, -1)
        )
    )
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
    return {
        "new_today": new_today,
        "cleared_today": cleared_today,
        "swept_recent": swept_recent,
    }


# ---------------------------------------------------------------------------
# Folders (Epic 26) — registry + item assignment
# ---------------------------------------------------------------------------


def list_folders(conn: sqlite3.Connection) -> list[dict]:
    """All registered folders, ordered by name."""
    rows = conn.execute(
        "SELECT id, name, query_def, description, created_utc, updated_utc "
        "FROM folders ORDER BY name COLLATE NOCASE ASC"
    ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        try:
            d["query_def"] = json.loads(d["query_def"])
        except (ValueError, TypeError):
            d["query_def"] = {}
        out.append(d)
    return out


def create_folder(
    conn: sqlite3.Connection,
    name: str,
    query_def: dict | None = None,
    description: str = "",
) -> dict:
    """Create a folder from a saved-query definition. Returns the folder dict.
    Raises ValueError on duplicate name. Names are lowercased for consistency."""
    import time as _time

    qd = json.dumps(query_def or {}, ensure_ascii=False)
    now = int(_time.time())
    norm_name = name.strip().lower()[:100]
    if not norm_name:
        raise ValueError("Folder name cannot be empty")
    try:
        conn.execute(
            "INSERT INTO folders (name, query_def, description, created_utc) VALUES (?, ?, ?, ?)",
            (norm_name, qd, (description or "").strip()[:200], now),
        )
        conn.commit()
    except Exception as exc:
        raise ValueError(f"Folder {name!r} already exists") from exc
    return get_folder_by_name(conn, norm_name)


def get_folder_by_name(conn: sqlite3.Connection, name: str) -> dict | None:
    """Look up a folder by exact name."""
    row = conn.execute(
        "SELECT id, name, query_def, description, created_utc, updated_utc "
        "FROM folders WHERE name=?",
        (name.strip().lower()[:100],),
    ).fetchone()
    if row is None:
        return None
    d = dict(row)
    try:
        d["query_def"] = json.loads(d["query_def"])
    except (ValueError, TypeError):
        d["query_def"] = {}
    return d


def delete_folder(conn: sqlite3.Connection, folder_id: int) -> bool:
    """Delete a folder by id. Returns True if deleted, False if not found.
    Does NOT clear the folder field from items — they keep their assignment."""
    cur = conn.execute("DELETE FROM folders WHERE id=?", (folder_id,))
    conn.commit()
    return cur.rowcount > 0


def rename_folder(
    conn: sqlite3.Connection, folder_id: int, new_name: str
) -> dict | None:
    """Rename a folder. Returns updated folder dict, or None if not found."""
    import time as _time

    now = int(_time.time())
    norm_name = new_name.strip().lower()[:100]
    if not norm_name:
        raise ValueError("Folder name cannot be empty")
    try:
        cur = conn.execute(
            "UPDATE folders SET name=?, updated_utc=? WHERE id=?",
            (norm_name, now, folder_id),
        )
        conn.commit()
    except Exception:
        raise ValueError(f"Folder name {new_name!r} already exists")
    if cur.rowcount == 0:
        return None
    return get_folder_by_name(conn, new_name.strip()[:100])


def set_item_folder(
    conn: sqlite3.Connection, fullname: str, folder_name: str | None
) -> bool:
    """Set or clear ``metadata.folder`` on an item. Setting to None clears it.
    Returns True if the item was found and updated."""
    row = conn.execute(
        "SELECT metadata FROM items WHERE fullname=?", (fullname,)
    ).fetchone()
    if row is None:
        return False
    md = parse_metadata(row["metadata"])
    if folder_name:
        md["folder"] = folder_name.strip().lower()[:100]
    else:
        md.pop("folder", None)
    conn.execute(
        "UPDATE items SET metadata=? WHERE fullname=?",
        (json.dumps(md, ensure_ascii=False), fullname),
    )
    return True


def folder_counts(conn: sqlite3.Connection) -> dict[str, int]:
    """Number of items assigned to each folder."""
    rows = conn.execute(
        "SELECT json_extract(metadata, '$.folder') AS folder, COUNT(*) AS c "
        "FROM items WHERE json_extract(metadata, '$.folder') IS NOT NULL "
        "GROUP BY folder ORDER BY c DESC"
    ).fetchall()
    return {r["folder"]: r["c"] for r in rows}


def user_tag_vocab(conn: sqlite3.Connection) -> list[str]:
    """The user-tag registry: distinct tags the user applied by hand, derived from the
    ``metadata.tags_manual`` stamps that :func:`set_tags` writes (Epic 26).

    No separate table — a tag is "in the vocabulary" exactly while it's stamped on at least one
    item, so it survives re-import via the same stamp and drops out when the last item loses it.
    Crucially this reads ``tags_manual`` (only user-applied tags), NOT ``tags`` (which also holds
    the tens-of-thousands of enrich keywords), so surfacing these in the rail stays cheap + clean.
    """
    rows = conn.execute(
        "SELECT DISTINCT je.value AS tag "
        "FROM items, json_each(items.metadata, '$.tags_manual') je"
    ).fetchall()
    return [r["tag"] for r in rows]


def tag_counts(
    conn: sqlite3.Connection,
    *,
    source: str | None = None,
    status: str | None = None,
) -> dict:
    """Counts for the rail's facet tags (curated ``categorize.FILTER_TAGS`` PLUS user-created
    tags from :func:`user_tag_vocab`), descending.

    ``metadata.tags`` also holds non-facet values (e.g. YouTube per-video keywords from the
    enrich pass), so the result is restricted to the facet vocabulary — otherwise the browse
    rail would render tens of thousands of one-off keyword tags. User tags join the vocabulary
    so a manually-applied tag shows up as a rail facet alongside the curated set (Epic 26).
    Optionally cross-filtered by source/status so the rail composes with the active source tab
    + status nav.
    """
    from content_hoarder.categorize import FILTER_TAGS

    facet_tags = list(FILTER_TAGS)
    seen = set(facet_tags)
    for t in user_tag_vocab(
        conn
    ):  # user-created tags join the curated facet vocabulary
        if t not in seen:
            facet_tags.append(t)
            seen.add(t)
    placeholders = ",".join("?" for _ in facet_tags)
    where = [f"je.value IN ({placeholders})"]
    params: list = list(facet_tags)
    if source:
        where.append("items.source = ?")
        params.append(source)
    if status:
        where.append("items.status = ?")
        params.append(status)
    rows = conn.execute(
        "SELECT je.value AS tag, COUNT(*) AS c "
        "FROM items, json_each(items.metadata, '$.tags') je "
        "WHERE "
        + " AND ".join(where)
        + " GROUP BY je.value ORDER BY c DESC, je.value COLLATE NOCASE ASC",
        params,
    ).fetchall()
    return {r["tag"]: r["c"] for r in rows}


def reddit_stats(conn: sqlite3.Connection) -> dict:
    """Reddit-only stats for the management view's stats modal."""
    sub = "json_extract(metadata, '$.subreddit')"
    by_kind = {
        r["k"]: r["c"]
        for r in conn.execute(
            "SELECT kind AS k, COUNT(*) AS c FROM items WHERE source='reddit' GROUP BY kind"
        )
    }
    by_status = _group_counts(conn, "status", "reddit")
    top_subs = [
        {"subreddit": r["s"], "count": r["c"]}
        for r in conn.execute(
            f"SELECT {sub} AS s, COUNT(*) AS c FROM items "
            f"WHERE source='reddit' AND {sub} IS NOT NULL AND {sub} <> '' "
            f"GROUP BY {sub} COLLATE NOCASE ORDER BY c DESC LIMIT 15"
        )
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
        {"year": r["y"], "count": r["c"]}
        for r in conn.execute(
            "SELECT CAST(strftime('%Y', created_utc, 'unixepoch') AS INTEGER) AS y, COUNT(*) AS c "
            "FROM items WHERE source='reddit' AND created_utc > 0 GROUP BY y ORDER BY y"
        )
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
    sql = "SELECT json_extract(metadata, '$.category') AS k, COUNT(*) AS c FROM items"
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
        return {
            "total": total,
            "inbox": by_status.get("inbox", 0),
            "by_status": by_status,
        }
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
