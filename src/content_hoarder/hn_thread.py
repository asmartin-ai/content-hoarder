"""HN comment-thread viewer backend.

Fetches the full comment tree from the HN Algolia API, parses it into the same
render shape ``reddit_thread.py`` produces, and caches it in the existing
``reddit_threads`` side table. Served by a new JSON route mirroring
``/reddit/items/<fn>/thread``.

**Cache reuse note:** The ``reddit_threads`` table is source-agnostic (keyed by
fullname PK). A ``hackernews:<id>`` key works unchanged. The name is a wart;
reuse it as-is (renaming = a schema migration, out of scope). No schema change.
"""

from __future__ import annotations

import json
import time
from typing import Callable, Optional

from content_hoarder import db
from content_hoarder._http import HttpError, request as _http_request


def _sort_children(children: list, sort: str) -> list:
    """Sort comment children according to the requested order."""
    if sort == "top":
        return sorted(children, key=lambda c: int(c.get("points", 0)), reverse=True)
    if sort == "new":
        return sorted(children, key=lambda c: int(c.get("created_at_i", 0)), reverse=True)
    # "default" / "best" -> preserve Algolia's given order
    return list(children)


def _extract_comments(children: list, depth: int = 0, sort: str = "top") -> list[dict]:
    """Recursive. Each comment: {id, author, text, points, created_utc, depth, children}."""
    # Map 'best' to 'top' for frontend parity (HN has no native "best" sort).
    if sort == "best":
        sort = "top"

    sorted_children = _sort_children(children, sort)
    out: list[dict] = []
    for child in sorted_children:
        if not isinstance(child, dict):
            continue
        comment = {
            "id": str(child.get("id", "")),
            "author": child.get("author", ""),
            "text": child.get("text", ""),
            "points": int(child.get("points", 0)),
            "created_utc": int(child.get("created_at_i", 0)),  # epoch seconds, NOT the ISO string
            "depth": depth,
        }
        nested = _extract_comments(child.get("children", []), depth + 1, sort)
        if nested:
            comment["children"] = nested
        out.append(comment)
    return out


def parse_thread(raw_json: str, item: dict, sort: str = "top") -> dict:
    """Parse Algolia item JSON into the reddit_thread render shape.

    Returns ``{post, comments, cached, item_fullname, item_kind, sort}``.
    ``item`` is the items-table row (for title fallback / fullname / kind).

    Algolia node structure: ``{id, title, url, text, author, points, created_at,
    created_at_i, type, parent_id, story_id, options, children[]}``.
    Root node has ``type="story"``. ``created_at_i`` is epoch seconds (use it,
    not the ISO ``created_at`` string).
    """
    # Map 'best' -> 'top' for frontend parity.
    effective_sort = "top" if sort == "best" else sort

    try:
        data = json.loads(raw_json)
    except (ValueError, TypeError):
        return {
            "error": "could not parse thread JSON",
            "item_fullname": item.get("fullname"),
            "item_kind": item.get("kind"),
            "sort": sort,
        }

    if not isinstance(data, dict) or data.get("type") != "story":
        return {
            "error": "not a story-type Algolia response",
            "item_fullname": item.get("fullname"),
            "item_kind": item.get("kind"),
            "sort": sort,
        }

    # Build post object (mirrors reddit_thread.py post structure)
    post = {
        "id": str(data.get("id", "")),
        "title": data.get("title", "") or item.get("title", ""),  # fallback to item title
        "url": data.get("url", ""),
        "author": data.get("author", ""),
        "points": int(data.get("points", 0)),
        "created_utc": int(data.get("created_at_i", 0)),  # epoch seconds
    }

    # Extract comments recursively
    comments = _extract_comments(data.get("children", []), depth=1, sort=effective_sort)

    return {
        "post": post,
        "comments": comments,
        "cached": True,
        "item_fullname": item.get("fullname"),
        "item_kind": item.get("kind"),
        "sort": sort,  # return the *requested* sort, not the effective one
    }


def get_thread(conn, fullname: str, sort: str = "top") -> dict | None:
    """Read cached Algolia JSON via db.get_reddit_thread, parse, return shape or None.

    Returns ``None`` if the item doesn't exist. If the item exists but has no
    cached thread yet, returns ``{post: {}, comments: [], cached: False, …}``
    (mirrors ``reddit_thread.get_thread``) so the UI can offer a hydrate action.
    """
    item = db.get_item(conn, fullname)
    if item is None:
        return None
    cached = db.get_reddit_thread(conn, fullname)
    if cached and cached.get("thread_json"):
        return parse_thread(cached["thread_json"], item, sort)
    # Item exists but no thread cached yet.
    return {
        "post": {},
        "comments": [],
        "cached": False,
        "item_fullname": fullname,
        "item_kind": item.get("kind"),
        "sort": sort,
    }


def hydrate_if_missing(conn, fullname: str, *, fetch=None) -> dict:
    """If no cached thread, fetch Algolia (``fetch=`` injectable), cache, return
    ``{status: "hydrated"|"cached"|"not_found"|"error"}``.

    ``fetch`` is an injectable seam: ``fetch(url) -> str | None`` returning the
    raw Algolia JSON string (or ``None`` for not-found). Default wraps
    ``_http.request`` so retries/throttle are shared. Tests pass a fake returning
    canned Algolia JSON.
    """
    # Already cached? Short-circuit.
    cached = db.get_reddit_thread(conn, fullname)
    if cached and cached.get("thread_json"):
        return {"status": "cached"}

    # Build the Algolia URL from the source_id portion of the fullname.
    parts = fullname.split(":", 1)
    if len(parts) != 2 or not parts[1]:
        return {"status": "error", "message": f"invalid fullname: {fullname!r}"}
    source_id = parts[1]
    algolia_url = f"https://hn.algolia.com/api/v1/items/{source_id}"

    if fetch is None:
        def _default_fetch(url: str) -> str | None:
            try:
                status, _headers, body = _http_request(
                    url,
                    method="GET",
                    timeout=10,
                    retries=3,
                    backoff=1.5,
                    user_agent="content-hoarder/hn-thread",
                )
            except HttpError:
                return None
            if status != 200:
                return None
            return body.decode("utf-8")
        fetch = _default_fetch

    try:
        raw_json = fetch(algolia_url)
    except Exception:
        return {"status": "error", "message": "fetch failed"}

    if not raw_json:
        return {"status": "not_found"}

    # Validate before caching.
    try:
        data = json.loads(raw_json)
    except (ValueError, TypeError):
        return {"status": "error", "message": "invalid JSON from Algolia"}
    if not isinstance(data, dict) or data.get("type") != "story":
        return {"status": "not_found"}

    # Cache and commit.
    db.set_reddit_thread(conn, fullname, raw_json, commit=True)
    return {"status": "hydrated"}
