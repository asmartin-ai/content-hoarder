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
from html import unescape

from content_hoarder import _http, db

DEFAULT_USER_AGENT = "content-hoarder/0.1 (youtube title recovery)"
_WAYBACK_AVAILABLE = "https://archive.org/wayback/available?url="
_PLACEHOLDER_TITLES = {"", "[private video]", "[deleted video]", "[unavailable video]"}

# Find the og:title <meta> tag (attribute order agnostic), then pull its content value
# with a back-referenced quote so apostrophes inside a double-quoted value don't truncate it.
_META_OG = re.compile(r"<meta\b[^>]*og:title[^>]*>", re.I)
_META_CONTENT = re.compile(r"""content\s*=\s*(["'])(.*?)\1""", re.I | re.S)
_TITLE_TAG = re.compile(r"<title[^>]*>(.*?)</title>", re.I | re.S)
_YT_SUFFIX = re.compile(r"\s*-\s*YouTube\s*$", re.I)
# WHERE for items still needing a title.
_NEEDS_TITLE = (
    "(title IS NULL OR title='' OR "
    "lower(title) IN ('[private video]','[deleted video]','[unavailable video]'))"
)


def _http_get(url: str, ua: str = DEFAULT_USER_AGENT, timeout: float = 20.0) -> str:
    # Thin wrapper over the shared transport. Re-raise the underlying urllib error
    # (URLError / timeout / HTTPError) rather than the wrapping HttpError so
    # recover_title's existing ``except (URLError, OSError, ...)`` clauses still
    # swallow a failed fetch into "" — preserving the propagate-raw contract.
    try:
        _status, _headers, raw = _http.request(
            url, method="GET", headers={"User-Agent": ua}, timeout=timeout,
        )
    except _http.HttpError as e:
        raise e.__cause__ from e
    return raw.decode("utf-8", errors="replace")


def _extract_title(html: str) -> str:
    html = html or ""
    title = ""
    tag = _META_OG.search(html)
    if tag:
        content = _META_CONTENT.search(tag.group(0))
        if content:
            title = content.group(2)
    if not title:
        t = _TITLE_TAG.search(html)
        title = t.group(1) if t else ""
    return _YT_SUFFIX.sub("", unescape(title).strip()).strip()


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
