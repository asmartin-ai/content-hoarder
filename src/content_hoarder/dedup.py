"""Possible-duplicate detection — FLAG similar items for review (non-destructive).

Default behavior *flags* groups (annotates ``metadata.dup_group`` / ``dup_count``) WITHOUT
changing status. You then review each group and resolve it (keep one, archive the rest),
or opt into auto-resolve (keep the richest). Everything is reversible (archived items keep
``metadata.dedup_of`` and a recoverable ``status_prev``).

Grouping strategies (``by``):
  - "url"   — identical normalized URL (default; safest).
  - "title" — identical normalized title (looser; catches the same thing saved from
              different sources). Placeholder titles ([removed]/[deleted]/[Private video]/
              [Deleted video]) are EXCLUDED so removed/unavailable items don't falsely group.
"""
from __future__ import annotations

import json
import re

from content_hoarder import db
from content_hoarder.models import parse_metadata

# Normalized titles that are NOT real content — never group items by these.
_PLACEHOLDER_TITLES = {
    "removed", "deleted", "private video", "deleted video",
    "unavailable video", "removed video", "deleted by user",
}


def _norm_url(url: str) -> str:
    u = (url or "").strip().lower()
    if not u:
        return ""
    u = re.sub(r"^https?://", "", u)
    u = re.sub(r"^www\.", "", u)
    # Drop the fragment only — KEEP the query. The query is the identifier for many
    # URLs (e.g. youtube.com/watch?v=<id>); stripping it collapsed every video into one
    # giant false group.
    u = u.split("#", 1)[0]
    return u.rstrip("/")


def _norm_title(title: str) -> str:
    t = (title or "").strip().lower()
    t = re.sub(r"https?://\S+", "", t)
    t = re.sub(r"[^\w\s]", "", t)
    t = re.sub(r"\s+", " ", t).strip()
    return t


def _key(item: dict, by: str) -> str:
    if by == "title":
        t = _norm_title(item.get("title"))
        if len(t) < 8 or t in _PLACEHOLDER_TITLES:  # ignore trivial + placeholder titles
            return ""
        return "t:" + t
    u = _norm_url(item.get("url"))
    return ("u:" + u) if u else ""


def _richness(it: dict) -> tuple:
    md = it["metadata"] if isinstance(it["metadata"], dict) else parse_metadata(it["metadata"])
    return (1 if it.get("title") else 0, len(md), -(it.get("first_seen_utc") or 0))


def find_groups(conn, by: str = "url", *, status: str = "inbox") -> list[dict]:
    """Return possible-duplicate groups (>1 item sharing a key). Each: key, count,
    suggested_keep, items."""
    rows = [db._row_to_public(r) for r in conn.execute(
        "SELECT * FROM items WHERE status=?", (status,))]
    groups: dict[str, list[dict]] = {}
    for it in rows:
        k = _key(it, by)
        if k:
            groups.setdefault(k, []).append(it)
    out = []
    for key, members in groups.items():
        if len(members) > 1:
            keep = max(members, key=_richness)
            out.append({
                "key": key, "count": len(members),
                "suggested_keep": keep["fullname"], "items": members,
            })
    out.sort(key=lambda g: -g["count"])
    return out


def _set_meta(conn, fullname: str, mutate) -> None:
    row = db.get_item(conn, fullname)
    if not row:
        return
    md = parse_metadata(row["metadata"])
    mutate(md)
    conn.execute("UPDATE items SET metadata=? WHERE fullname=?",
                 (json.dumps(md, ensure_ascii=False), fullname))


def flag_duplicates(conn, by: str = "url") -> dict:
    """Tag every member of every possible-duplicate group (metadata only; no status change)."""
    groups = find_groups(conn, by=by)
    flagged = 0
    for grp in groups:
        for it in grp["items"]:
            _set_meta(conn, it["fullname"],
                      lambda md, g=grp: md.update({"dup_group": g["key"], "dup_count": g["count"]}))
            flagged += 1
    conn.commit()
    return {"groups": len(groups), "flagged": flagged, "by": by}


def clear_flags(conn) -> dict:
    cleared = 0
    rows = conn.execute("SELECT fullname, metadata FROM items WHERE metadata LIKE '%dup_group%'").fetchall()
    for fullname, metadata in rows:
        md = parse_metadata(metadata)
        if "dup_group" in md or "dup_count" in md:
            md.pop("dup_group", None)
            md.pop("dup_count", None)
            conn.execute("UPDATE items SET metadata=? WHERE fullname=?",
                         (json.dumps(md, ensure_ascii=False), fullname))
            cleared += 1
    conn.commit()
    return {"cleared": cleared}


def resolve_group(conn, keep_fullname: str, archive_fullnames: list[str]) -> dict:
    """Archive the given items (reversibly), tagging them as dups of keep_fullname."""
    archive_fullnames = [fn for fn in archive_fullnames if fn != keep_fullname]
    archived = db.bulk_set_status(conn, archive_fullnames, "archived")
    for fn in archive_fullnames:
        _set_meta(conn, fn, lambda md: md.update({"dedup_of": keep_fullname}))
    conn.commit()
    return {"kept": keep_fullname, "archived": archived}


def auto_resolve(conn, by: str = "url") -> dict:
    """Keep the richest item per group, archive the rest. Reversible."""
    archived = 0
    groups = find_groups(conn, by=by)
    for grp in groups:
        others = [it["fullname"] for it in grp["items"] if it["fullname"] != grp["suggested_keep"]]
        archived += resolve_group(conn, grp["suggested_keep"], others)["archived"]
    return {"groups": len(groups), "archived": archived}
