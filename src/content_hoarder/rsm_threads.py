"""One-time migration: copy cached thread JSON from a reddit-saved-manager (RSM) DB
into content-hoarder's ``reddit_threads`` cache.

RSM stores each post+comment tree in ``items.thread_json`` keyed by the bare Reddit
fullname (e.g. ``t3_abc123``). content-hoarder namespaces items as ``reddit:t3_abc123``,
so we re-key on copy. The RSM DB is opened strictly read-only and never written.

This is not a connector (connectors stay DB-free); it is a migration helper that writes
via the public ``db`` helpers, like ``firefox_youtube.migrate``.
"""

from __future__ import annotations

import os
import sqlite3
from pathlib import Path

from content_hoarder import db


def migrate_threads(
    conn: sqlite3.Connection, rsm_db_path, *, only_existing: bool = True
) -> dict:
    """Copy non-empty RSM ``thread_json`` rows into ``reddit_threads``.

    With ``only_existing`` (default), threads whose item isn't present locally are
    skipped so we don't accumulate orphans. Returns ``{migrated, skipped}``.
    """
    src = Path(rsm_db_path)
    if not os.path.isfile(str(src)):
        raise ValueError(f"RSM database not found: {src}")
    # Normalise away Windows \\?\ extended-length prefix (pytest tmp_path).
    s = str(src)
    if s.startswith("\\\\?\\"):
        s = s[4:]
    ro = sqlite3.connect(f"file:{s.replace(chr(92), '/')}?mode=ro", uri=True)
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
            db.set_reddit_thread(
                conn, fn, row["thread_json"], row["hydrated_at"], commit=False
            )
            migrated += 1
    finally:
        ro.close()
    conn.commit()
    return {"migrated": migrated, "skipped": skipped}
