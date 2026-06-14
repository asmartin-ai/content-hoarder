"""Parse cached Reddit thread JSON (post + comment tree) for the Reddit view.

Ported from reddit-saved-manager's ``thread_view``. Reads the local ``reddit_threads``
cache (populated by ``migrate-rsm-threads``; later also by cookie/OAuth live fetch).
Pure parsing + a cache reader — no network here.
"""

from __future__ import annotations

import json

from content_hoarder import db


def _abs_permalink(p: str) -> str:
    p = p or ""
    return ("https://www.reddit.com" + p) if p.startswith("/") else p


def _extract_comments(children: list, depth: int = 0, sort: str = "best") -> list:
    """Flatten the nested comment tree to a list with a ``depth`` for CSS indentation."""
    filtered = [c for c in children if isinstance(c, dict) and c.get("kind") != "more"]
    if sort == "top":
        filtered.sort(key=lambda c: (c.get("data", {}) or {}).get("score", 0), reverse=True)
    elif sort == "new":
        filtered.sort(key=lambda c: int((c.get("data", {}) or {}).get("created_utc") or 0), reverse=True)
    out: list = []
    for child in filtered:
        d = child.get("data", {}) or {}
        out.append({
            "author": d.get("author", ""),
            "body": d.get("body", ""),
            "score": d.get("score", 0),
            "depth": depth,
            "permalink": _abs_permalink(d.get("permalink", "")),
            "created_utc": int(d.get("created_utc") or 0),
        })
        replies = d.get("replies")
        if isinstance(replies, dict):
            out.extend(_extract_comments(replies.get("data", {}).get("children", []), depth + 1, sort))
    return out


def parse_thread(raw_json: str, item: dict, sort: str = "best") -> dict:
    """Turn a raw ``<permalink>.json`` blob into ``{post, comments, …}``."""
    try:
        data = json.loads(raw_json)
    except (ValueError, TypeError):
        return {"error": "could not parse thread JSON", "item_fullname": item.get("fullname")}

    post: dict = {}
    comments: list = []
    pd: dict = {}
    if isinstance(data, list) and data:
        post_children = data[0].get("data", {}).get("children", [])
        if post_children:
            pd = post_children[0].get("data", {}) or {}
            post = {
                "title": pd.get("title", ""),
                "author": pd.get("author", ""),
                "selftext": pd.get("selftext", ""),
                "subreddit": pd.get("subreddit", ""),
                "permalink": _abs_permalink(pd.get("permalink", "")),
                "score": pd.get("score", 0),
                "url": pd.get("url", ""),
                "created_utc": pd.get("created_utc", 0),
            }
        if len(data) >= 2:
            comments = _extract_comments(data[1].get("data", {}).get("children", []), sort=sort)

    return {
        "post": post,
        "comments": comments,
        "cached": True,
        "archived": pd.get("_archive_sourced", False),
        "item_fullname": item.get("fullname"),
        "item_kind": item.get("kind"),
        "sort": sort,
    }


def get_thread(conn, fullname: str, sort: str = "best") -> dict | None:
    """Return the parsed thread from the local cache.

    Returns ``None`` if the item doesn't exist, or ``{cached: False, …}`` if the item
    exists but has no cached thread yet (the UI then offers Recover / live fetch).
    Live cookie/OAuth fetch is layered on in a later phase.
    """
    item = db.get_item(conn, fullname)
    if item is None:
        return None
    cached = db.get_reddit_thread(conn, fullname)
    if cached and cached.get("thread_json"):
        return parse_thread(cached["thread_json"], item, sort)
    return {
        "post": {},
        "comments": [],
        "cached": False,
        "item_fullname": fullname,
        "item_kind": item.get("kind"),
        "sort": sort,
    }
