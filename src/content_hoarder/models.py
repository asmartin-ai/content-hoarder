"""Item normalization — the single place an item dict is shaped.

Every connector yields dicts produced by :func:`new_item`. The DB layer and the
pipeline rely on this exact shape (see :data:`ITEM_FIELDS`).
"""

from __future__ import annotations

import json
import time
from typing import Any

# Full, ordered list of columns in the ``items`` table. Keep in sync with db.py.
ITEM_FIELDS: tuple[str, ...] = (
    "fullname", "source", "source_id", "kind",
    "title", "body", "url", "author",
    "created_utc", "saved_utc",
    "is_saved", "first_seen_utc", "last_seen_utc", "hydrated_at",
    "status", "processed_utc", "status_prev",
    "search_text", "metadata", "raw_json",
)

VALID_STATUSES = ("inbox", "keep", "archived", "done")

# The NSFW tag buckets (subreddit-driven; see categorize.py). Canonical here so the
# query layer (db.search_items) and the search-bar parser share one source of truth.
NSFW_TAGS = ("nsfw_erotic", "nsfw_other", "nsfw_talk")

# Metadata keys that are worth folding into the full-text search blob.
_META_SEARCH_KEYS = ("subreddit", "channel", "tags", "labels", "playlist", "domain")


def _now() -> int:
    return int(time.time())


def parse_metadata(value: Any) -> dict:
    """Coerce a metadata value (dict or JSON string) into a dict."""
    if isinstance(value, dict):
        return dict(value)
    if isinstance(value, str) and value.strip():
        try:
            obj = json.loads(value)
            return obj if isinstance(obj, dict) else {}
        except (ValueError, TypeError):
            return {}
    return {}


def build_search_text(item: dict, metadata: dict | None = None) -> str:
    """Compose the denormalized search blob from item fields + key metadata."""
    md = metadata if metadata is not None else parse_metadata(item.get("metadata"))
    parts = [item.get("title") or "", item.get("body") or "", item.get("author") or ""]
    for key in _META_SEARCH_KEYS:
        val = md.get(key)
        if not val:
            continue
        if isinstance(val, (list, tuple)):
            parts.append(" ".join(str(x) for x in val))
        else:
            parts.append(str(val))
    return " ".join(p for p in parts if p).strip()


def new_item(
    *,
    source: str,
    source_id: Any,
    kind: str = "item",
    title: str = "",
    body: str = "",
    url: str = "",
    author: str = "",
    created_utc: int = 0,
    saved_utc: int = 0,
    is_saved: Any = 1,
    hydrated_at: int | None = None,
    status: str = "inbox",
    metadata: dict | None = None,
    raw: Any = None,
    now: int | None = None,
) -> dict:
    """Build a fully-formed, DB-ready item dict.

    ``fullname`` is the global dedup key ``"<source>:<source_id>"``. ``metadata``
    is JSON-encoded; ``search_text`` is computed. ``now`` allows deterministic tests.
    """
    ts = now if now is not None else _now()
    md = dict(metadata) if metadata else {}
    item = {
        "fullname": f"{source}:{source_id}",
        "source": source,
        "source_id": str(source_id),
        "kind": kind or "item",
        "title": (title or "").strip(),
        "body": body or "",
        "url": (url or "").strip(),
        "author": (author or "").strip(),
        "created_utc": int(created_utc or 0),
        "saved_utc": int(saved_utc or 0),
        "is_saved": 1 if is_saved else 0,
        "first_seen_utc": ts,
        "last_seen_utc": ts,
        "hydrated_at": hydrated_at,
        "status": status if status in VALID_STATUSES else "inbox",
        "processed_utc": None,
        "status_prev": None,
        "metadata": json.dumps(md, ensure_ascii=False),
        "raw_json": json.dumps(raw, ensure_ascii=False) if raw is not None else "",
        "search_text": "",
    }
    item["search_text"] = build_search_text(item, md)
    return item
