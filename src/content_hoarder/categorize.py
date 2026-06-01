"""Heuristic content categorizer: tag items listenable / watch / wotagei / unknown.

No LLM (asmartin-ai wants to validate heuristic accuracy first). The category is stored on
``metadata.category`` non-destructively and is re-runnable. YouTube videos are the
default target. An LLM auto-classifier is a separate backlog item.
"""
from __future__ import annotations

import re
import time

from content_hoarder import db

# Title keywords that mark a wotagei (ヲタ芸) idol-event performance.
_WOTAGEI_RE = re.compile(r"ヲタ芸|オタ芸|ﾜｵﾀ|wotagei|\bwota\b", re.IGNORECASE)

# Channels whose content is reliably "listenable" (audio-first: long-form talk, music,
# podcasts). Case-insensitive substring match on the channel name. " - Topic" is the
# YouTube auto-generated music-channel suffix.
_LISTENABLE_CHANNELS = (
    "isaac arthur", "perun", "lemmino", "lofi", "lo-fi", " - topic",
    "podcast", "audiobook", "full album", "soundtrack",
)

LISTENABLE_MIN_SECONDS = 30 * 60   # >= 30 min  => likely listenable
WATCH_MAX_SECONDS = 5 * 60         # <= 5 min   => short, watch

VALID_CATEGORIES = ("listenable", "watch", "wotagei", "unknown")


def categorize(title: str, channel: str, duration) -> str:
    """Return a category from the heuristics. ``duration`` is seconds (int) or None.

    Order matters: wotagei (most specific) → allowlisted channel → duration thresholds.
    """
    if _WOTAGEI_RE.search(title or ""):
        return "wotagei"
    ch = (channel or "").lower()
    if any(name in ch for name in _LISTENABLE_CHANNELS):
        return "listenable"
    try:
        secs = int(duration)
    except (TypeError, ValueError):
        secs = 0
    if secs >= LISTENABLE_MIN_SECONDS:
        return "listenable"
    if 0 < secs <= WATCH_MAX_SECONDS:
        return "watch"
    return "unknown"


def categorize_item(item: dict) -> str:
    md = item.get("metadata") or {}
    return categorize(item.get("title", ""), md.get("channel", ""), md.get("duration"))


def categorize_source(conn, source: str = "youtube", *, limit=None, retry: bool = False) -> dict:
    """Categorize a source's items, storing ``metadata.category``. Returns counts."""
    where = ["source = ?"]
    params: list = [source]
    if not retry:
        where.append("json_extract(metadata, '$.category') IS NULL")
    sql = "SELECT * FROM items WHERE " + " AND ".join(where) + " ORDER BY last_seen_utc DESC"
    if limit:
        sql += " LIMIT ?"
        params.append(int(limit))
    rows = [db._row_to_public(r) for r in conn.execute(sql, params).fetchall()]
    counts = {c: 0 for c in VALID_CATEGORIES}
    now = int(time.time())
    for it in rows:
        cat = categorize_item(it)
        counts[cat] = counts.get(cat, 0) + 1
        db.merge_upsert(conn, {"fullname": it["fullname"],
                               "metadata": {"category": cat}, "last_seen_utc": now})
    conn.commit()
    return {"selected": len(rows), "by_category": counts}
