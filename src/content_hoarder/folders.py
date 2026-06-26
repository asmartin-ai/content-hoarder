"""Folder evaluation engine — derive folder assignments from saved queries.

A folder is a named, saved query evaluated against ``items``. On evaluate, matching
items get ``metadata.folder`` set to the folder name; items that no longer match
(but were previously assigned) get cleared.

Guardrails (from B5/D9 research):
- Folders never block saving (no required picker).
- Folders never show "N unfiled" counts (no guilt surface).
- Folder = curator framing ("a slice of your library"), not hoarder filing.
"""

from __future__ import annotations

import json
import time
from typing import Any

from content_hoarder import db
from content_hoarder.models import parse_metadata


def _build_item_query(query_def: dict) -> tuple[str, list]:
    """Build a SQL WHERE clause + params from a folder query definition.

    Maps to ``db.search_items`` params. Supported keys:
      source, kind, status, tag, tags_all, subreddit, author,
      has, q, before, after, nsfw, hide_nsfw, is_saved.

    Returns (where_clause, params). The WHERE clause uses ``i.`` alias.
    """
    filters: list[str] = []
    params: list = []

    src = query_def.get("source")
    if src:
        filters.append("i.source = ?")
        params.append(src)

    kind = query_def.get("kind")
    if kind:
        filters.append("i.kind = ?")
        params.append(kind)

    status = query_def.get("status")
    if status:
        filters.append("i.status = ?")
        params.append(status)

    tag = query_def.get("tag")
    if tag:
        if isinstance(tag, str):
            tag = [tag]
        if query_def.get("tags_all"):
            for t in tag:
                filters.append(
                    "EXISTS (SELECT 1 FROM json_each(i.metadata, '$.tags') WHERE value = ?)"
                )
                params.append(t)
        else:
            ph = ",".join("?" for _ in tag)
            filters.append(
                f"EXISTS (SELECT 1 FROM json_each(i.metadata, '$.tags') WHERE value IN ({ph}))"
            )
            params.extend(tag)

    subreddit = query_def.get("subreddit")
    if subreddit:
        if isinstance(subreddit, str):
            filters.append("json_extract(i.metadata, '$.subreddit') = ? COLLATE NOCASE")
            params.append(subreddit)
        elif isinstance(subreddit, list):
            ph = ",".join("?" for _ in subreddit)
            filters.append(
                f"json_extract(i.metadata, '$.subreddit') IN ({ph}) COLLATE NOCASE"
            )
            params.extend(subreddit)

    author = query_def.get("author")
    if author:
        filters.append("i.author = ? COLLATE NOCASE")
        params.append(author)

    has_val = query_def.get("has")
    if has_val:
        if has_val == "video" or has_val == "media":
            filters.append("i.url != ''")
        elif has_val == "body":
            filters.append("i.body != ''")
        elif has_val == "image":
            filters.append(
                "(i.url LIKE '%.jpg' OR i.url LIKE '%.png' OR i.url LIKE '%.gif' "
                "OR i.url LIKE '%.webp' OR json_extract(i.metadata, '$.gallery') IS NOT NULL)"
            )

    q = query_def.get("q")
    if q:
        filters.append("(i.search_text LIKE ? OR i.title LIKE ?)")
        like = f"%{q}%"
        params.extend([like, like])

    nsfw = query_def.get("nsfw")
    hide_nsfw = query_def.get("hide_nsfw")
    if nsfw or hide_nsfw:
        from content_hoarder.models import NSFW_TAGS

        ph = ",".join("?" for _ in NSFW_TAGS)
        pred = (
            f"(EXISTS (SELECT 1 FROM json_each(i.metadata, '$.tags') WHERE value IN ({ph}))"
            f" OR COALESCE(json_extract(i.metadata, '$.over_18'), 0) = 1)"
        )
        if nsfw:
            filters.append(pred)
        elif hide_nsfw:
            filters.append(f"NOT ({pred})")
        if nsfw or hide_nsfw:
            params.extend(list(NSFW_TAGS))

    is_saved = query_def.get("is_saved")
    if is_saved is not None:
        filters.append("i.is_saved = ?")
        params.append(1 if is_saved else 0)

    before = query_def.get("before")
    if before:
        filters.append("i.created_utc < ?")
        params.append(int(before))

    after = query_def.get("after")
    if after:
        filters.append("i.created_utc > ?")
        params.append(int(after))

    where = " AND ".join(filters) if filters else "1=1"
    return where, params


def evaluate_folder(conn, folder_id: int, *, dry_run: bool = False) -> dict[str, Any]:
    """Evaluate one folder: find matching items and assign ``metadata.folder``.

    If ``dry_run`` is True, only counts matches without writing.

    Returns counts: ``{folder_name, total, matched, cleared, dry_run}``.
    """
    row = conn.execute(
        "SELECT id, name, query_def FROM folders WHERE id=?", (folder_id,)
    ).fetchone()
    if row is None:
        return {"error": f"folder {folder_id} not found"}

    name = row["name"]
    try:
        qd = json.loads(row["query_def"])
    except (ValueError, TypeError):
        qd = {}
    if not isinstance(qd, dict):
        qd = {}

    where, params = _build_item_query(qd)

    # Items matching the rule
    matched = conn.execute(
        f"SELECT fullname FROM items i WHERE {where}", params
    ).fetchall()
    matched_fns = {r["fullname"] for r in matched}

    if dry_run:
        return {
            "folder_name": name,
            "matched": len(matched_fns),
            "dry_run": True,
        }

    # Items currently assigned to this folder
    currently = conn.execute(
        "SELECT fullname FROM items WHERE json_extract(metadata, '$.folder') = ?",
        (name,),
    ).fetchall()
    current_fns = {r["fullname"] for r in currently}

    # Items to add (matched but not currently assigned)
    to_add = matched_fns - current_fns
    # Items to clear (assigned but no longer match)
    to_clear = current_fns - matched_fns

    now = int(time.time())

    for fn in to_add:
        row = conn.execute(
            "SELECT metadata FROM items WHERE fullname=?", (fn,)
        ).fetchone()
        if row is None:
            continue
        md = parse_metadata(row["metadata"])
        md["folder"] = name
        conn.execute(
            "UPDATE items SET metadata=? WHERE fullname=?",
            (json.dumps(md, ensure_ascii=False), fn),
        )

    for fn in to_clear:
        row = conn.execute(
            "SELECT metadata FROM items WHERE fullname=?", (fn,)
        ).fetchone()
        if row is None:
            continue
        md = parse_metadata(row["metadata"])
        md.pop("folder", None)
        conn.execute(
            "UPDATE items SET metadata=? WHERE fullname=?",
            (json.dumps(md, ensure_ascii=False), fn),
        )

    conn.execute("UPDATE folders SET updated_utc=? WHERE id=?", (now, folder_id))
    conn.commit()

    return {
        "folder_name": name,
        "total": len(matched_fns),
        "matched": len(matched_fns),
        "newly_assigned": len(to_add),
        "cleared": len(to_clear),
        "dry_run": False,
    }


def evaluate_all_folders(conn, *, dry_run: bool = False) -> list[dict]:
    """Evaluate all registered folders. Returns list of per-folder results."""
    folders = conn.execute("SELECT id, name FROM folders ORDER BY id").fetchall()
    results = []
    for f in folders:
        res = evaluate_folder(conn, f["id"], dry_run=dry_run)
        results.append(res)
    return results


def items_by_folder(
    conn, folder_name: str, *, limit: int = 50, offset: int = 0
) -> list[dict]:
    """Get items assigned to a folder, newest first."""
    rows = conn.execute(
        "SELECT * FROM items WHERE json_extract(metadata, '$.folder') = ? "
        "ORDER BY last_seen_utc DESC LIMIT ? OFFSET ?",
        (folder_name, limit, offset),
    ).fetchall()
    return [db._row_to_public(r) for r in rows]
