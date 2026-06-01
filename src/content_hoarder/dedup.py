"""Conservative, reversible de-duplication by normalized URL.

Only ever touches ``inbox`` items, and only *archives* duplicates (status change,
recoverable via undo / restore) — never deletes. The "richest" item in each group
(has a title, most metadata, earliest seen) is kept.
"""

from __future__ import annotations

import json
import re

from content_hoarder import db
from content_hoarder.models import parse_metadata


def _norm_url(url: str) -> str:
    u = (url or "").strip().lower()
    if not u:
        return ""
    u = re.sub(r"^https?://", "", u)
    u = re.sub(r"^www\.", "", u)
    u = u.split("#", 1)[0].split("?", 1)[0]
    return u.rstrip("/")


def find_duplicates(conn) -> list[list[dict]]:
    """Return groups (lists) of items that share a normalized non-empty URL."""
    groups: dict[str, list[dict]] = {}
    for r in conn.execute("SELECT * FROM items"):
        it = db._row_to_public(r)
        key = _norm_url(it.get("url"))
        if key:
            groups.setdefault(key, []).append(it)
    return [g for g in groups.values() if len(g) > 1]


def _richness(it: dict) -> tuple:
    md = it["metadata"] if isinstance(it["metadata"], dict) else parse_metadata(it["metadata"])
    return (1 if it.get("title") else 0, len(md), -(it.get("first_seen_utc") or 0))


def dedup(conn, *, dry_run: bool = True) -> dict:
    groups = find_duplicates(conn)
    duplicates = sum(len(g) - 1 for g in groups)
    if dry_run:
        return {"groups": len(groups), "duplicates": duplicates, "applied": 0, "dry_run": True}

    applied = 0
    for group in groups:
        keep = max(group, key=_richness)
        for it in group:
            if it["fullname"] == keep["fullname"] or it["status"] != "inbox":
                continue
            md = it["metadata"] if isinstance(it["metadata"], dict) else parse_metadata(it["metadata"])
            md["dedup_of"] = keep["fullname"]
            conn.execute(
                "UPDATE items SET status='archived', status_prev=status, metadata=? WHERE fullname=?",
                (json.dumps(md, ensure_ascii=False), it["fullname"]),
            )
            applied += 1
    conn.commit()
    return {"groups": len(groups), "duplicates": duplicates, "applied": applied, "dry_run": False}
