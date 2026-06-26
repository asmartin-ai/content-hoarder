"""Incremental sync of a user's public Hacker News favorites page.

HN favorites are public HTML pages, so this needs no cookie. Network is kept
behind ``getf=`` for offline tests.
"""

from __future__ import annotations

import html as _html
import json
import re
import time
import urllib.parse

from content_hoarder import _http, config, db
from content_hoarder.connectors.hackernews import _ATHING, _ITEM_ID
from content_hoarder.models import new_item

FAVORITES_URL = "https://news.ycombinator.com/favorites"
_HN_MARK_KEY = "hn_sync_newest"
_HN_MARK_DEPTH = 25
_ANCHOR_RE = re.compile(r"<a\b([^>]*)>(.*?)</a>", re.IGNORECASE | re.DOTALL)
_HREF_RE = re.compile(r"""\bhref\s*=\s*["']([^"']+)["']""", re.IGNORECASE)
_TAG_RE = re.compile(r"<[^>]+>")


def _hn_url(sid: str) -> str:
    return f"https://news.ycombinator.com/item?id={sid}"


def _load_mark(value) -> list[str]:
    if not value:
        return []
    s = str(value).strip()
    if s.startswith("["):
        try:
            return [str(x) for x in json.loads(s) if x]
        except (TypeError, ValueError):
            return []
    return [s]


def _extract_ids(html: str) -> list[str]:
    """Extract distinct HN item ids in page order."""
    ids = _ITEM_ID.findall(html or "") or _ATHING.findall(html or "")
    out: list[str] = []
    for sid in ids:
        sid = str(sid).strip()
        if sid and sid not in out:
            out.append(sid)
    return out


def _extract_next(html: str) -> str | None:
    """Return the href for the HN "More" pagination link."""
    for attrs, label in _ANCHOR_RE.findall(html or ""):
        text = _html.unescape(_TAG_RE.sub("", label)).strip()
        if text.lower() != "more":
            continue
        m = _HREF_RE.search(attrs)
        if m:
            return _html.unescape(m.group(1))
    return None


def _default_getf(url: str) -> tuple[int, bytes]:
    status, _headers, raw = _http.request(
        url,
        timeout=20.0,
        retries=2,
        backoff=1.0,
        jitter=True,
        user_agent=config.get("USER_AGENT"),
    )
    return status, raw


def _item(sid: str) -> dict:
    url = _hn_url(sid)
    return new_item(
        source="hackernews",
        source_id=sid,
        kind="story",
        title="",
        url=url,
        metadata={"hn_url": url, "hn_list": "saved"},
    )


def sync_saved(
    conn,
    *,
    user: str,
    max_pages: int = 5,
    stop_on_known: bool = True,
    throttle: float = 1.0,
    sleep=None,
    getf=None,
    user_agent: str | None = None,
    progress=None,
) -> dict:
    """Fetch HN favorites, upsert bare items, and stop at the high-water mark."""
    del user_agent  # kept as a call-shape extension point; _default_getf owns headers.
    user = (user or "").strip()
    if not user:
        raise ValueError("user is required")
    sleep = sleep or time.sleep
    getf = getf or _default_getf
    throttle = max(throttle, _http.MIN_THROTTLE)
    max_pages = max(0, int(max_pages or 0))
    result = {
        "fetched": 0,
        "new": 0,
        "updated": 0,
        "pages": 0,
        "stopped": None,
        "network_error": False,
        "user": user,
    }

    marks = _load_mark(db.get_setting(conn, _HN_MARK_KEY))
    mark_set = set(marks)
    top_names: list[str] = []
    seen_run: set[str] = set()
    hit_mark = False
    url = FAVORITES_URL + "?" + urllib.parse.urlencode({"id": user})

    for page in range(max_pages):
        if page:
            sleep(_http.jittered_throttle(throttle))
        try:
            status, raw = getf(url)
        except Exception:  # noqa: BLE001 - soft miss; never crash a sync job
            result["network_error"] = True
            result["stopped"] = "network_error"
            break
        if status < 200 or status >= 300:
            result["network_error"] = True
            result["stopped"] = "network_error"
            break

        text = raw.decode("utf-8", errors="replace")
        ids = _extract_ids(text)
        if not ids:
            result["stopped"] = "empty" if page == 0 else "exhausted"
            break

        result["pages"] += 1
        page_new = 0
        for sid in ids:
            fullname = f"hackernews:{sid}"
            if len(top_names) < _HN_MARK_DEPTH and fullname not in top_names:
                top_names.append(fullname)
            if mark_set and fullname in mark_set and stop_on_known:
                hit_mark = True
                break
            if fullname in seen_run:
                continue
            seen_run.add(fullname)
            res = db.merge_upsert(conn, _item(sid))
            result["fetched"] += 1
            if res == "inserted":
                result["new"] += 1
                page_new += 1
            else:
                result["updated"] += 1
        conn.commit()
        if progress:
            progress(f"page {page + 1}: +{page_new} new ({len(ids)} ids)")

        if hit_mark:
            result["stopped"] = "caught_up"
            break
        next_href = _extract_next(text)
        if not next_href:
            result["stopped"] = "exhausted"
            break
        if stop_on_known and not marks and page_new == 0:
            result["stopped"] = "all_known"
            break
        url = urllib.parse.urljoin(url, next_href)
    else:
        result["stopped"] = "max_pages"

    safe_boundary = result["stopped"] in ("caught_up", "exhausted", "all_known")
    first_sync_baseline = not marks and result["stopped"] == "max_pages"
    if top_names and (safe_boundary or first_sync_baseline):
        db.set_setting(conn, _HN_MARK_KEY, json.dumps(top_names), commit=False)
    conn.commit()
    return result
