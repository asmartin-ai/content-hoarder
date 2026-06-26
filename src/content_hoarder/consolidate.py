"""Consolidate non-YouTube items that point at YouTube videos into canonical youtube:<id> rows.

This is a re-runnable, non-destructive, reversible migration:

- For each item whose source != 'youtube' and whose URL resolves to a YouTube video ID
  (via ``connectors.firefox.youtube_id``), if a corresponding ``youtube:<id>`` row
  exists, we:

  1) append a "companion" record to the YouTube row's ``metadata.companions`` list
     (de-duped by companion fullname), and
  2) stamp ``metadata.consolidated_into = 'youtube:<id>'`` on the companion row.

- If no ``youtube:<id>`` exists we PROMOTE the link into one: a real, enrichable
  ``youtube:<id>`` item is built from the video id alone (derived thumbnail, the
  companion post's title as a provisional title stamped ``title_source='companion'``,
  ``metadata.promoted_by='consolidate'`` for reversibility), inheriting the post's
  triage status/processed time, and the post is then folded into it as above. The point
  of such a post is to watch the video, so the video becomes the canonical item.

Undo clears the companion markers (``metadata.companions`` +
``metadata.consolidated_into``) and DELETES the youtube rows this created
(``promoted_by='consolidate'``), so the DB fully round-trips.

Modeled on ``firefox_youtube.py``: ``plan()`` is read-only classification and
``migrate(conn, apply=False)`` is dry-run by default. Promotion is keyless — the row is
built from the id (mirrors firefox tab promotion) and a later ``enrich --source
youtube`` fills exact metadata.

Out of scope: UI changes, any network fetching.
"""

from __future__ import annotations

import re

from content_hoarder import db
from content_hoarder.connectors.firefox import youtube_id
from content_hoarder.models import VALID_STATUSES, new_item, parse_metadata

PROMOTE_MARKER = "consolidate"
_VIDEO_TAG_RE = re.compile(r"\s*\[video\]", re.IGNORECASE)


def _companion_record(row: dict, md: dict) -> dict:
    """Build the per-companion record that is appended to the youtube row.

    The stored link points at the companion's *discussion*, never back at the
    video it was matched on: a reddit comments permalink, the Hacker News thread
    (derived from the item id — the row URL IS the YouTube link, so it's useless
    here), else the row URL as a last resort.
    """
    source = row.get("source") or ""
    rec = {
        "source": source,
        "kind": row.get("kind") or "item",
        "fullname": row.get("fullname") or "",
    }
    permalink = (md.get("permalink") or "").strip() if isinstance(md, dict) else ""
    if permalink:
        rec["permalink"] = permalink
    elif source == "hackernews":
        sid = str(row.get("source_id") or "").strip()
        rec["url"] = f"https://news.ycombinator.com/item?id={sid}" if sid else (row.get("url") or "")
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


def _candidate_urls(url: str, md: dict) -> list[str]:
    """URLs to inspect for a YouTube video, preserving primary-url precedence."""
    out: list[str] = []
    if url:
        out.append(url)
    links = md.get("outlinks") if isinstance(md, dict) else None
    if isinstance(links, list):
        out += [str(u).strip() for u in links if str(u).strip()]
    elif isinstance(links, str) and links.strip():
        out.append(links.strip())
    seen: set[str] = set()
    return [u for u in out if not (u in seen or seen.add(u))]


def _youtube_match(url: str, md: dict) -> tuple[str, str]:
    """Return ``(video_id, matched_url)`` from the primary URL or metadata.outlinks."""
    for u in _candidate_urls(url, md):
        vid = youtube_id(u)
        if vid:
            return vid, u
    return "", ""


def plan(conn) -> dict:
    """Classify non-youtube rows that link to YouTube videos (read-only, no writes)."""
    yt_ids = {r[0] for r in conn.execute("SELECT source_id FROM items WHERE source='youtube'")}

    foldable: list[dict] = []
    skipped_no_youtube: list[dict] = []

    for fullname, source, kind, url, title, status, processed_utc, metadata in conn.execute(
        "SELECT fullname, source, kind, url, title, status, processed_utc, metadata FROM items "
        "WHERE source <> 'youtube' AND url <> '' ORDER BY fullname"
    ):
        md = parse_metadata(metadata)
        vid, matched_url = _youtube_match(url or "", md)
        if not vid:
            continue
        yt_fullname = f"youtube:{vid}"
        # Already folded into this exact target on a prior run — don't re-count.
        if md.get("consolidated_into") == yt_fullname:
            continue
        rec = {
            "fullname": fullname,
            "source": source,
            "kind": kind,
            "url": url,
            "title": title or "",
            # validate status so corrupted/legacy values don't slip onto a promoted row
            "status": status if status in VALID_STATUSES else "inbox",
            "processed_utc": processed_utc,
            "vid": vid,
            "matched_url": matched_url,
            "youtube_fullname": yt_fullname,
            "metadata": md,
        }
        (foldable if vid in yt_ids else skipped_no_youtube).append(rec)

    return {"foldable": foldable, "skipped_no_youtube": skipped_no_youtube}


def _provisional_title(title: str) -> str:
    """Clean a companion post title for use as the promoted video's provisional title.

    Strips the Hacker News ``[video]`` submission marker (noise on a row that's now
    explicitly a video); keeps the rest, incl. year tags. A later ``enrich --source
    youtube`` overrides this with the real video title."""
    return _VIDEO_TAG_RE.sub("", title or "").strip()


def _promote_item(rec: dict) -> dict:
    """Build the keyless ``youtube:<id>`` item a link-only companion promotes to.

    No network: the thumbnail is derived from the id and the title is provisional
    (``title_source='companion'``), enrichable later. ``promoted_by`` tags the row so
    undo can delete it. The companion's triage status / processed time carry over so a
    promoted-from-archived video doesn't resurface in the inbox."""
    vid = rec["vid"]
    item = new_item(
        source="youtube",
        source_id=vid,
        kind="video",
        title=_provisional_title(rec.get("title") or ""),
        url=f"https://youtu.be/{vid}",
        status=rec.get("status") or "inbox",
        metadata={
            "thumbnail": f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg",
            "title_source": "companion",
            "promoted_by": PROMOTE_MARKER,
        },
    )
    item["processed_utc"] = rec.get("processed_utc")
    return item


def _fold_one(conn, rec: dict, out: dict) -> None:
    """Append a companion ref to its (now-existing) youtube row and mark the post folded."""
    yt_fn = rec["youtube_fullname"]
    yt_row = db.get_item(conn, yt_fn)
    comp_row = db.get_item(conn, rec["fullname"])
    if not yt_row or not comp_row:
        return  # concurrently deleted; ignore

    yt_md = parse_metadata(yt_row.get("metadata"))
    comp_md = parse_metadata(comp_row.get("metadata"))

    # 1) Add companion reference to the youtube row.
    comp = _companion_record(comp_row, comp_md)
    if _append_companion(yt_md, comp):
        db._update_metadata(conn, yt_row, yt_md)  # keep search_text in sync
        out["companions_added"] += 1

    # 2) Mark the companion row as consolidated.
    if comp_md.get("consolidated_into") != yt_fn:
        comp_md["consolidated_into"] = yt_fn
        db._update_metadata(conn, comp_row, comp_md)
        out["companions_marked"] += 1


def migrate(conn, *, apply: bool = False) -> dict:
    """Consolidate non-YouTube items into youtube rows, creating the row when missing.

    Folds links-to-YouTube into a pre-existing ``youtube:<id>`` row, or PROMOTES the
    link into a new keyless youtube item first. Dry-run unless ``apply=True``.
    """
    p = plan(conn)
    foldable = p["foldable"]
    promotable = p["skipped_no_youtube"]

    out = {
        "foldable": len(foldable),
        "promoted": len(promotable),
        # distinct video ids → one row each (two posts on the same video share a row)
        "youtube_created": len({r["vid"] for r in promotable}),
        "companions_added": 0,
        "companions_marked": 0,
        "applied": bool(apply),
        "sample_foldable": [r["fullname"] for r in foldable[:5]],
        "sample_promoted": [r["fullname"] for r in promotable[:5]],
    }
    if not apply:
        return out

    created = 0
    for rec in promotable:  # build the missing youtube row first (keyless, no fetch)
        if db.merge_upsert(conn, _promote_item(rec)) == "inserted":
            created += 1
    for rec in foldable + promotable:  # then fold every post in (row now exists)
        _fold_one(conn, rec, out)

    conn.commit()
    out["youtube_created"] = created
    return out


def unconsolidate(conn, *, apply: bool = False) -> dict:
    """Undo consolidation: clear the companion markers and delete promoted youtube rows.

    Dry-run unless ``apply=True``.
    """
    # Narrow scan via LIKE to keep it cheap on large DBs; false positives are OK (each
    # row is re-checked below). ``promoted_by`` catches rows this migration created.
    rows = conn.execute(
        "SELECT fullname FROM items "
        "WHERE metadata LIKE '%consolidated_into%' OR metadata LIKE '%companions%' "
        "OR metadata LIKE '%promoted_by%'"
    ).fetchall()

    out = {
        "candidates": len(rows),
        "youtube_companions_cleared": 0,
        "companions_unmarked": 0,
        "promoted_rows_deleted": 0,
        "applied": bool(apply),
        "sample": [r[0] for r in rows[:5]],
    }
    if not apply:
        return out

    yt_cleared = 0
    unmarked = 0
    promoted_deleted = 0

    for (fullname,) in rows:
        row = db.get_item(conn, fullname)
        if not row:
            continue
        md = parse_metadata(row.get("metadata"))
        # Rows this migration *created* are removed wholesale (round-trip); the posts
        # that pointed at them get their consolidated_into cleared below.
        if row.get("source") == "youtube" and md.get("promoted_by") == PROMOTE_MARKER:
            conn.execute("DELETE FROM items WHERE fullname=?", (fullname,))
            promoted_deleted += 1
            continue
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
    out["promoted_rows_deleted"] = promoted_deleted
    return out
