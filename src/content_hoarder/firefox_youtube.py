"""Reconcile already-imported Firefox YouTube tabs into ``youtube:<vid>`` items.

The Firefox connector now emits a ``youtube:<vid>`` item for any tab whose URL is a
YouTube video, so *future* imports stay unified. This one-shot pass fixes the rows that
were imported as ``firefox:<hash>`` tabs *before* that change. Each ``source='firefox'``
row whose URL is a YouTube video is either:

  * a **dupe** — a ``youtube:<vid>`` row already exists (you also saved it to Watch
    Later): stamp the open-in-firefox markers onto that row (never touching its
    title / playlist / status), or
  * an **orphan** — no youtube row yet: insert one (cleaned title + thumbnail, with the
    firefox row's *status preserved* so a triaged 'done' tab stays done),

then the now-superseded ``firefox:<hash>`` row is deleted — its content and the open-tab
signal live on the youtube row, and it's re-importable from the .txt export.

Dry-run by default; pass ``apply=True`` to commit. Run against a COPY of the DB first.
"""
from __future__ import annotations

from content_hoarder import db, dedup
from content_hoarder.connectors.firefox import youtube_id, yt_item
from content_hoarder.models import VALID_STATUSES, parse_metadata


def plan(conn) -> dict:
    """Classify firefox youtube-tab rows into dupes vs orphans (read-only, no writes)."""
    yt_ids = {r[0] for r in conn.execute("SELECT source_id FROM items WHERE source='youtube'")}
    dupes: list[dict] = []
    orphans: list[dict] = []
    for fullname, url, title, status, processed_utc, metadata in conn.execute(
        "SELECT fullname, url, title, status, processed_utc, metadata"
        " FROM items WHERE source='firefox' ORDER BY fullname"
    ):
        vid = youtube_id(url or "")
        if not vid:
            continue
        rec = {
            "fullname": fullname, "vid": vid, "title": title or "",
            # validate status so corrupted/legacy values don't slip through
            "status": status if status in VALID_STATUSES else "inbox",
            "processed_utc": processed_utc,  # preserve so 'done' tabs count in weekly stats
            "metadata": parse_metadata(metadata),
        }
        (dupes if vid in yt_ids else orphans).append(rec)
    return {"dupes": dupes, "orphans": orphans}


def _firefox_marker_mutator(ff_meta: dict):
    """Return a mutator that copies the open-in-firefox signal onto a youtube row's metadata."""
    def mut(md: dict) -> None:
        md["open_in_firefox"] = True
        if ff_meta.get("window"):
            md["firefox_window"] = ff_meta["window"]
        if ff_meta.get("pinned"):
            md["firefox_pinned"] = ff_meta["pinned"]
    return mut


def migrate(conn, *, apply: bool = False) -> dict:
    """Promote firefox youtube-tabs into youtube items. Dry-run unless ``apply=True``."""
    p = plan(conn)
    dupes, orphans = p["dupes"], p["orphans"]
    out = {
        "dupes": len(dupes), "orphans": len(orphans),
        "firefox_rows_removed": 0, "applied": bool(apply),
        "sample_orphans": [o["fullname"] for o in orphans[:5]],
    }
    if not apply:
        return out

    removed = 0
    for rec in dupes:  # already saved to WL — just add the open-in-firefox signal
        dedup._set_meta(conn, f"youtube:{rec['vid']}", _firefox_marker_mutator(rec["metadata"]))
        conn.execute("DELETE FROM items WHERE fullname=?", (rec["fullname"],))
        removed += 1
    for rec in orphans:  # open but never saved — becomes a real, enrichable youtube item
        md = rec["metadata"]
        item = yt_item(rec["vid"], rec["title"], md.get("window") or "", bool(md.get("pinned")))
        item["status"] = rec["status"]          # preserve triage state (don't un-do a 'done' tab)
        item["processed_utc"] = rec["processed_utc"]  # preserve so 'done' counts in weekly stats
        db.merge_upsert(conn, item)
        conn.execute("DELETE FROM items WHERE fullname=?", (rec["fullname"],))
        removed += 1
    conn.commit()
    out["firefox_rows_removed"] = removed
    return out
