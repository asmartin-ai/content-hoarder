"""Parse cached Reddit thread JSON (post + comment tree) for the Reddit view.

Ported from reddit-saved-manager's ``thread_view``. Reads the local ``reddit_threads``
cache (populated by ``migrate-rsm-threads``; later also by cookie/OAuth live fetch).
Pure parsing + a cache reader — no network here.
"""

from __future__ import annotations

import html
import json

from content_hoarder import db


def _abs_permalink(p: str) -> str:
    p = p or ""
    return ("https://www.reddit.com" + p) if p.startswith("/") else p


def _resolve_media(mm: dict) -> dict:
    """Slim a post/comment ``media_metadata`` dict to ``{id: {u, kind, w, h}}`` for inline rendering.

    Reddit stores native comment images (and emotes/giphy) here; the keys match the ``![..](id)``
    refs in the markdown body. URLs are ``html.unescape``d (Reddit HTML-encodes the ``&`` in the
    query string). Only ``valid`` Image/AnimatedImage entries with an http(s) source survive — the
    client re-escapes the URL before it ever reaches the DOM. ``kind`` ∈ {image, gif, video}."""
    out: dict = {}
    if not isinstance(mm, dict):
        return out
    for mid, meta in mm.items():
        if not isinstance(meta, dict) or meta.get("status") not in (None, "valid"):
            continue
        s = meta.get("s") or {}
        if meta.get("e") == "AnimatedImage":
            u = s.get("gif") or s.get("mp4") or s.get("u")
            kind = "gif" if s.get("gif") else ("video" if s.get("mp4") else "image")
        else:
            u = s.get("u") or s.get("gif") or s.get("mp4")
            kind = "image"
        if not isinstance(u, str) or not u.startswith(("http://", "https://")):
            continue
        out[str(mid)] = {"u": html.unescape(u), "kind": kind,
                         "w": s.get("x") or 0, "h": s.get("y") or 0}
    return out


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
        entry = {
            "author": d.get("author", ""),
            "body": d.get("body", ""),
            "score": d.get("score", 0),
            "depth": depth,
            "permalink": _abs_permalink(d.get("permalink", "")),
            "created_utc": int(d.get("created_utc") or 0),
        }
        media = _resolve_media(d.get("media_metadata"))
        if media:                       # only when present — keeps the common (no-media) comment lean
            entry["media"] = media
        out.append(entry)
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
                "media": _resolve_media(pd.get("media_metadata")),   # selftext ![](id) images
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

    For saved **comments** (``reddit:t1_…``), falls back to the parent submission's
    cache key (``reddit:t3_<sid>`` from ``metadata.permalink``) so a once-hydrated
    post is reusable (#74).

    NOTE: the dual-key fallback path issues a commit-on-mirror so the next
    open is a direct hit. This violates the historical "pure cache reader"
    contract documented above; no current API route mixes open DML with a
    ``get_thread`` call, so it is latent, not live. TODO(#74-followup):
    factor the mirror into a caller-side helper once the dual-key logic
    consolidates with ``reddit_hydrate.hydrate_if_missing`` (also duplicated).
    """
    item = db.get_item(conn, fullname)
    if item is None:
        return None
    cached = db.get_reddit_thread(conn, fullname)
    via = None
    if not (cached and cached.get("thread_json")):
        # Dual-key fallback: comment → submission cache
        from content_hoarder.reddit_hydrate import submission_fullname

        md = item.get("metadata") or {}
        if isinstance(md, str):
            try:
                md = json.loads(md) if md else {}
            except (ValueError, TypeError):
                md = {}
        post_fn = submission_fullname(md.get("permalink") if isinstance(md, dict) else None)
        if post_fn and post_fn != fullname:
            alt = db.get_reddit_thread(conn, post_fn)
            if alt and alt.get("thread_json"):
                cached = alt
                via = "submission"
                # Mirror so the next open is a direct hit.
                db.set_reddit_thread(conn, fullname, alt["thread_json"], commit=True)
    if cached and cached.get("thread_json"):
        out = parse_thread(cached["thread_json"], item, sort)
        if via:
            out["cache_via"] = via
        return out
    return {
        "post": {},
        "comments": [],
        "cached": False,
        "item_fullname": fullname,
        "item_kind": item.get("kind"),
        "sort": sort,
    }
