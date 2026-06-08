"""Consolidate non-YouTube items that point at YouTube videos into canonical youtube:<id> rows.

This is a re-runnable, non-destructive, reversible migration:

- For each item whose source != 'youtube' and whose URL resolves to a YouTube video ID
  (via ``connectors.firefox.youtube_id``), if a corresponding ``youtube:<id>`` row
  exists, we:

  1) append a "companion" record to the YouTube row's ``metadata.companions`` list
     (de-duped by companion fullname), and
  2) stamp ``metadata.consolidated_into = 'youtube:<id>'`` on the companion row.

- If no ``youtube:<id>`` exists we SKIP (saved-only; never fetch; never create a
  youtube row from a link alone).

Undo clears both markers (``metadata.companions`` + ``metadata.consolidated_into``)
so the DB fully round-trips.

Modeled on ``firefox_youtube.py``: ``plan()`` is read-only classification and
``migrate(conn, apply=False)`` is dry-run by default.

Out of scope: UI changes, any network fetching.
"""

from __future__ import annotations

from content_hoarder import db
from content_hoarder.connectors.firefox import youtube_id
from content_hoarder.models import parse_metadata


def _companion_record(row: dict, md: dict) -> dict:
    """Build the per-companion record that is appended to the youtube row."""
    rec = {
        "source": row.get("source") or "",
        "kind": row.get("kind") or "item",
        "fullname": row.get("fullname") or "",
    }
    # Prefer a reddit permalink when present; else fall back to the row URL.
    permalink = (md.get("permalink") or "").strip() if isinstance(md, dict) else ""
    if permalink:
        rec["permalink"] = permalink
    else:
        rec["url"] = row.get("url") or ""
    return rec


def _append_companion(yt_md: dict, comp: dict) -> bool:
    """Append companion to metadata.companions if not already present.

    Returns True if metadata was modified.
    """
    lst = yt_md.get("companions")
    if not isinstance(lst, list):
        lst = []
    fn = comp.get("fullname")
    if fn and any(isinstance(x, dict) and x.get("fullname") == fn for x in lst):
        yt_md["companions"] = lst
        return False
    lst.append(comp)
    yt_md["companions"] = lst
    return True


def plan(conn) -> dict:
    """Classify non-youtube rows that link to YouTube videos (read-only, no writes)."""
    yt_ids = {r[0] for r in conn.execute("SELECT source_id FROM items WHERE source='youtube'")}

    foldable: list[dict] = []
    skipped_no_youtube: list[dict] = []

    for fullname, source, kind, url, metadata in conn.execute(
        "SELECT fullname, source, kind, url, metadata FROM items "
        "WHERE source <> 'youtube' AND url <> '' ORDER BY fullname"
    ):
        vid = youtube_id(url or "")
        if not vid:
            continue
        md = parse_metadata(metadata)
        yt_fullname = f"youtube:{vid}"
        # Already folded into this exact target on a prior run — don't re-count.
        if md.get("consolidated_into") == yt_fullname:
            continue
        rec = {
            "fullname": fullname,
            "source": source,
            "kind": kind,
            "url": url,
            "vid": vid,
            "youtube_fullname": yt_fullname,
            "metadata": md,
        }
        (foldable if vid in yt_ids else skipped_no_youtube).append(rec)

    return {"foldable": foldable, "skipped_no_youtube": skipped_no_youtube}


def migrate(conn, *, apply: bool = False) -> dict:
    """Consolidate non-YouTube items into existing youtube rows.

    Dry-run unless ``apply=True``.
    """
    p = plan(conn)
    foldable = p["foldable"]
    skipped = p["skipped_no_youtube"]

    out = {
        "foldable": len(foldable),
        "skipped_no_youtube": len(skipped),
        "companions_added": 0,
        "companions_marked": 0,
        "applied": bool(apply),
        "sample_foldable": [r["fullname"] for r in foldable[:5]],
    }
    if not apply:
        return out

    companions_added = 0
    companions_marked = 0

    for rec in foldable:
        yt_fn = rec["youtube_fullname"]
        yt_row = db.get_item(conn, yt_fn)
        comp_row = db.get_item(conn, rec["fullname"])
        if not yt_row or not comp_row:
            continue  # concurrently deleted; ignore

        yt_md = parse_metadata(yt_row.get("metadata"))
        comp_md = parse_metadata(comp_row.get("metadata"))

        # 1) Add companion reference to the youtube row.
        comp = _companion_record(comp_row, comp_md)
        if _append_companion(yt_md, comp):
            db._update_metadata(conn, yt_row, yt_md)  # keep search_text in sync
            companions_added += 1

        # 2) Mark the companion row as consolidated.
        if comp_md.get("consolidated_into") != yt_fn:
            comp_md["consolidated_into"] = yt_fn
            db._update_metadata(conn, comp_row, comp_md)
            companions_marked += 1

    conn.commit()
    out["companions_added"] = companions_added
    out["companions_marked"] = companions_marked
    return out


def unconsolidate(conn, *, apply: bool = False) -> dict:
    """Undo consolidation by clearing metadata.companions and metadata.consolidated_into.

    Dry-run unless ``apply=True``.
    """
    # Narrow scan via LIKE to keep it cheap on large DBs; false positives are OK.
    rows = conn.execute(
        "SELECT fullname FROM items "
        "WHERE metadata LIKE '%consolidated_into%' OR metadata LIKE '%companions%'"
    ).fetchall()

    out = {
        "candidates": len(rows),
        "youtube_companions_cleared": 0,
        "companions_unmarked": 0,
        "applied": bool(apply),
        "sample": [r[0] for r in rows[:5]],
    }
    if not apply:
        return out

    yt_cleared = 0
    unmarked = 0

    for (fullname,) in rows:
        row = db.get_item(conn, fullname)
        if not row:
            continue
        md = parse_metadata(row.get("metadata"))
        changed = False
        if "companions" in md:
            md.pop("companions", None)
            if row.get("source") == "youtube":
                yt_cleared += 1
            changed = True
        if "consolidated_into" in md:
            md.pop("consolidated_into", None)
            unmarked += 1
            changed = True
        if changed:
            db._update_metadata(conn, row, md)

    conn.commit()
    out["youtube_companions_cleared"] = yt_cleared
    out["companions_unmarked"] = unmarked
    return out
