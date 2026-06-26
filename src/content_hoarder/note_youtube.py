"""Promote already-imported Keep/Obsidian notes that contain YouTube links.

Some note sources only capture a single URL or only capture URLs from frontmatter, so
YouTube links embedded in note bodies can be "hidden" from the normal YouTube import.
This migration scans existing note rows, extracts YouTube video IDs, and ensures a
canonical ``youtube:<id>`` item exists, attaching the note as a companion.

Reuses the existing ``metadata.companions`` convention (see :mod:`content_hoarder.consolidate`).
"""

from __future__ import annotations

import re

from content_hoarder import db
from content_hoarder.connectors.firefox import youtube_id
from content_hoarder.consolidate import _append_companion, _companion_record
from content_hoarder.models import VALID_STATUSES, new_item, parse_metadata

NOTE_PROMOTE_MARKER = "note_youtube"

_URL_RE = re.compile(r"https?://\S+", re.I)
_STRIP_TRAIL = ")]>}.\"',;:!?"


def _candidate_urls(text: str) -> list[str]:
    """Extract http(s) URLs from text, stripping common trailing punctuation."""
    out: list[str] = []
    for raw in _URL_RE.findall(text or ""):
        u = raw.rstrip(_STRIP_TRAIL)
        if u and u not in out:
            out.append(u)
    return out


def _note_yt_ids(item: dict) -> list[str]:
    """Distinct YouTube ids found in item['body'], item['url'], metadata['urls'].

    Uses :func:`content_hoarder.connectors.firefox.youtube_id` (host-guarded, 11-char)
    per candidate URL.
    """
    vids: list[str] = []

    for u in _candidate_urls(str(item.get("body") or "")):
        vid = youtube_id(u)
        if vid and vid not in vids:
            vids.append(vid)

    u = str(item.get("url") or "")
    if u:
        vid = youtube_id(u)
        if vid and vid not in vids:
            vids.append(vid)

    md = item.get("metadata") if isinstance(item.get("metadata"), dict) else {}
    urls = md.get("urls") if isinstance(md, dict) else None
    if isinstance(urls, list):
        for uu in urls:
            vid = youtube_id(str(uu or ""))
            if vid and vid not in vids:
                vids.append(vid)

    return vids


def _promoted_to_list(note_md: dict) -> list[str]:
    v = note_md.get("promoted_to")
    if isinstance(v, str) and v.strip():
        return [v.strip()]
    if isinstance(v, list):
        out: list[str] = []
        for x in v:
            s = str(x or "").strip()
            if s and s not in out:
                out.append(s)
        return out
    return []


def _set_promoted_to(note_md: dict, yt_fullname: str) -> bool:
    """Add yt_fullname to promoted_to.

    Returns True iff the metadata changed.

    Representation: string for single target, list for multiple.
    """
    cur = _promoted_to_list(note_md)
    if yt_fullname in cur:
        return False
    cur.append(yt_fullname)
    note_md["promoted_to"] = cur[0] if len(cur) == 1 else cur
    note_md["promoted_to_by"] = NOTE_PROMOTE_MARKER
    return True


def plan(conn) -> dict:
    """Read-only classification.

    Scans notes from sources ('keep','obsidian') and returns:

    * orphan: note+vid where no existing youtube:<vid> item exists
    * companion: note+vid where youtube:<vid> already exists

    Notes already stamped with promoted_to for that vid are still classified; the
    migration is idempotent and will count them as already-done.
    """
    yt_ids = {r[0] for r in conn.execute("SELECT source_id FROM items WHERE source='youtube'")}

    orphan: list[dict] = []
    companion: list[dict] = []

    for r in conn.execute(
        "SELECT fullname, source, source_id, kind, title, body, url, status, processed_utc, metadata "
        "FROM items WHERE source IN ('keep','obsidian') ORDER BY fullname"
    ).fetchall():
        row = dict(r)
        md = parse_metadata(row.get("metadata"))
        vids = _note_yt_ids({"body": row.get("body"), "url": row.get("url"), "metadata": md})
        if len(vids) != 1:
            continue
        for vid in vids:
            yt_fn = f"youtube:{vid}"
            rec = {
                "fullname": row["fullname"],
                "vid": vid,
                "youtube_fullname": yt_fn,
                "source": row.get("source") or "",
                "kind": row.get("kind") or "note",
            }
            (companion if vid in yt_ids else orphan).append(rec)

    return {"orphan": orphan, "companion": companion}


def _promote_youtube_from_note(note_row: dict, vid: str) -> dict:
    """Build a keyless youtube:<vid> item derived from a note."""
    status = note_row.get("status")
    status = status if status in VALID_STATUSES else "inbox"
    item = new_item(
        source="youtube",
        source_id=vid,
        kind="video",
        title=str(note_row.get("title") or "").strip(),
        url=f"https://youtu.be/{vid}",
        status=status,
        metadata={
            "thumbnail": f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg",
            "title_source": "note",
            "promoted_by": NOTE_PROMOTE_MARKER,
        },
    )
    # Preserve processed_utc so a triaged note doesn't resurrect a fresh youtube inbox item.
    item["processed_utc"] = note_row.get("processed_utc")
    return item


def migrate(conn, *, apply: bool = False) -> dict:
    """Dry-run default. See module docstring."""
    p = plan(conn)
    candidates = p["orphan"] + p["companion"]

    out = {
        "candidates": len(candidates),
        "orphan": len(p["orphan"]),
        "companion": len(p["companion"]),
        "promoted": 0,
        "attached": 0,
        "already_done": 0,
        "applied": bool(apply),
    }
    if not apply:
        return out

    for rec in candidates:
        note_fn = rec["fullname"]
        vid = rec["vid"]
        yt_fn = rec["youtube_fullname"]

        note_row = db.get_item(conn, note_fn)
        if not note_row:
            continue
        note_md = parse_metadata(note_row.get("metadata"))
        if yt_fn in _promoted_to_list(note_md):
            out["already_done"] += 1
            continue

        yt_row = db.get_item(conn, yt_fn)
        if yt_row is None:
            db.merge_upsert(conn, _promote_youtube_from_note(note_row, vid))
            out["promoted"] += 1
            yt_row = db.get_item(conn, yt_fn)
        if yt_row is None:
            continue

        # Attach note as a companion.
        yt_md = parse_metadata(yt_row.get("metadata"))
        comp = _companion_record(note_row, note_md)
        if _append_companion(yt_md, comp):
            db._update_metadata(conn, yt_row, yt_md)
            out["attached"] += 1

        # Stamp note.
        if _set_promoted_to(note_md, yt_fn):
            db._update_metadata(conn, note_row, note_md)

    conn.commit()
    return out
