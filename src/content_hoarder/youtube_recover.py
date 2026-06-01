"""Best-effort title recovery for unavailable YouTube videos via the Wayback Machine.

``[Private video]`` / ``[Deleted video]`` items carry no real title. If the watch page
was archived while still public, the Wayback Machine has it. Non-destructive (only fills
a real title), resumable (a ``metadata.wayback_tried`` marker, kept separate from the
enrich ``hydrated_at`` so the two passes don't fight), throttled, network-only.

filmot.com is a stronger source for *deleted* videos but needs a registered API key, so
it's a future provider; the HTTP fetcher is injectable to make that (and tests) easy.
"""
from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request

from content_hoarder import db

DEFAULT_USER_AGENT = "content-hoarder/0.1 (youtube title recovery)"
_WAYBACK_AVAILABLE = "https://archive.org/wayback/available?url="
_PLACEHOLDER_TITLES = {"", "[private video]", "[deleted video]", "[unavailable video]"}

_OG_TITLE = re.compile(
    r'<meta[^>]+(?:property|name)=["\']og:title["\'][^>]+content=["\']([^"\']+)["\']', re.I)
_TITLE_TAG = re.compile(r"<title>(.*?)</title>", re.I | re.S)
_YT_SUFFIX = re.compile(r"\s*-\s*YouTube\s*$", re.I)
# WHERE for items still needing a title.
_NEEDS_TITLE = (
    "(title IS NULL OR title='' OR "
    "lower(title) IN ('[private video]','[deleted video]','[unavailable video]'))"
)


def _http_get(url: str, ua: str = DEFAULT_USER_AGENT, timeout: float = 20.0) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": ua}, method="GET")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", errors="replace")


def _extract_title(html: str) -> str:
    m = _OG_TITLE.search(html or "")
    title = m.group(1) if m else ((_TITLE_TAG.search(html or "") or [None, ""])[1])
    return _YT_SUFFIX.sub("", (title or "").strip()).strip()


def recover_title(vid: str, *, get=_http_get) -> str:
    """Return a recovered title for a YouTube video id via Wayback, or '' if none."""
    if not vid:
        return ""
    watch = f"https://www.youtube.com/watch?v={vid}"
    api = _WAYBACK_AVAILABLE + urllib.parse.quote(watch, safe="")
    try:
        data = json.loads(get(api))
    except (urllib.error.URLError, OSError, ValueError):
        return ""
    snap = ((data or {}).get("archived_snapshots") or {}).get("closest") or {}
    if not snap.get("available") or not snap.get("url"):
        return ""
    try:
        html = get(snap["url"])
    except (urllib.error.URLError, OSError):
        return ""
    title = _extract_title(html)
    return "" if title.lower() in _PLACEHOLDER_TITLES else title


def recover_titles(conn, *, limit=None, retry: bool = False, get=_http_get,
                   sleep=time.sleep, throttle: float = 1.0, progress=None) -> dict:
    """Recover titles for unavailable YouTube items. Resumable + throttled."""
    where = ["source = 'youtube'", _NEEDS_TITLE]
    if not retry:
        where.append("json_extract(metadata, '$.wayback_tried') IS NULL")
    sql = "SELECT * FROM items WHERE " + " AND ".join(where) + " ORDER BY last_seen_utc DESC"
    params: list = []
    if limit:
        sql += " LIMIT ?"
        params.append(int(limit))
    rows = [db._row_to_public(r) for r in conn.execute(sql, params).fetchall()]
    recovered = 0
    for i, it in enumerate(rows):
        if i and throttle:
            sleep(throttle)
        title = recover_title(it.get("source_id") or "", get=get)
        md = {"wayback_tried": 1}
        upd = {"fullname": it["fullname"], "metadata": md}
        if title:
            md["title_source"] = "wayback"
            upd["title"] = title
            recovered += 1
        db.merge_upsert(conn, upd)
        if progress and (i + 1) % 10 == 0:
            progress(f"  {recovered}/{i + 1} titles recovered")
    conn.commit()
    return {"selected": len(rows), "recovered": recovered}
