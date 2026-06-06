"""Incremental sync of the user's Reddit *saved* list via reddit_session-cookie auth.

No OAuth: GET ``https://www.reddit.com/user/<username>/saved.json`` with the same cookie the
unsave queue uses. Reddit returns the saved listing **newest-saved-first**, so we fetch
newest-first and **stop as soon as a page yields no new items** (or after ``max_pages``). A
routine sync therefore touches only the handful of new saves — not the multi-thousand-item
history — which sidesteps the rate-limit bottleneck.

All network is injectable (``getf=``) so this is fully unit-testable offline. Normalization is
shared with the importer via ``connectors.reddit.child_to_item`` so synced and imported items
are shaped identically.
"""

from __future__ import annotations

import urllib.parse

from content_hoarder import config, db
from content_hoarder.reddit_unsave import (
    RedditAuthError,
    _http_get,
    _refresh_modhash,
    get_auth,
)

SAVED_URL = "https://www.reddit.com/user/{user}/saved.json"


def sync_saved_cookie(
    conn,
    *,
    max_pages: int = 3,
    stop_on_known: bool = True,
    per_page: int = 100,
    getf=None,
    user_agent: str | None = None,
    progress=None,
) -> dict:
    """Pull newest saved items into the local DB. Returns a summary dict:
    ``{fetched, new, updated, pages, stopped, auth_error, username}``.

    ``stopped`` is one of: ``all_known`` (a page had 0 new — caught up), ``max_pages``,
    ``exhausted`` (no more pages), ``empty`` (nothing saved / blocked), ``auth_error``.
    """
    getf = getf or _http_get
    user_agent = user_agent or config.get("USER_AGENT")
    result = {"fetched": 0, "new": 0, "updated": 0, "pages": 0,
              "stopped": None, "auth_error": False, "username": None}

    auth = get_auth(conn)
    if not auth:
        result["auth_error"] = True
        result["stopped"] = "auth_error"
        return result

    username = auth.get("username")
    if not username:  # learn it from /api/me.json if the stored row predates it
        try:
            _modhash, username = _refresh_modhash(
                auth["session_cookie"], user_agent=user_agent, getf=getf
            )
        except RedditAuthError:
            result["auth_error"] = True
            result["stopped"] = "auth_error"
            return result
    result["username"] = username

    from content_hoarder.connectors.reddit import child_to_item

    base = SAVED_URL.format(user=urllib.parse.quote(username))
    after = ""
    for page in range(max_pages):
        params = {"limit": per_page, "raw_json": 1}
        if after:
            params["after"] = after
        body = getf(base + "?" + urllib.parse.urlencode(params),
                    session_cookie=auth["session_cookie"], user_agent=user_agent) or {}
        data = body.get("data") or {}
        children = data.get("children") or []
        if not children:
            result["stopped"] = "empty" if page == 0 else "exhausted"
            break

        result["pages"] += 1
        page_new = 0
        for ch in children:
            item = child_to_item(ch)
            if not item:
                continue
            result["fetched"] += 1
            if db.get_item(conn, item["fullname"]) is not None:
                result["updated"] += 1
            else:
                result["new"] += 1
                page_new += 1
            db.merge_upsert(conn, item)
        conn.commit()
        if progress:
            progress(f"page {page + 1}: +{page_new} new ({len(children)} items)")

        after = data.get("after") or ""
        if not after:
            result["stopped"] = "exhausted"
            break
        if stop_on_known and page_new == 0:
            result["stopped"] = "all_known"
            break
    else:
        result["stopped"] = "max_pages"

    return result
