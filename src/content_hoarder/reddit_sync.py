"""Incremental sync of the user's Reddit *saved* list via reddit_session-cookie auth.

No OAuth: GET ``https://www.reddit.com/user/<username>/saved.json`` with the same cookie the
unsave queue uses. Reddit returns the saved listing **newest-saved-first**, so we walk from the
top and stop the moment we re-reach the newest item from the previous sync (a **high-water mark**
stored in ``settings['reddit_sync_newest']``). A routine sync therefore does O(new-items) work —
not O(whole-history) — which sidesteps the rate-limit bottleneck.

The very first sync (no mark yet) has no precise boundary, so it pulls ``max_pages`` deep; use the
``--full`` CLI flag (``stop_on_known=False``) for a thorough first catch-up. All network is
injectable (``getf=``/``sleep=``) so this is fully unit-testable offline. Normalization is shared
with the importer via ``connectors.reddit.child_to_item``.
"""

from __future__ import annotations

import time
import urllib.parse

from content_hoarder import config, db
from content_hoarder.reddit_unsave import (
    RedditAuthError,
    _http_get,
    _refresh_modhash,
    get_auth,
)

SAVED_URL = "https://www.reddit.com/user/{user}/saved.json"
_MARK_KEY = "reddit_sync_newest"   # newest reddit fullname (e.g. "t3_abc") seen last sync


def sync_saved_cookie(
    conn,
    *,
    max_pages: int = 3,
    stop_on_known: bool = True,
    per_page: int = 100,
    throttle: float = 1.0,
    sleep=None,
    getf=None,
    user_agent: str | None = None,
    progress=None,
) -> dict:
    """Pull newest saved items into the local DB. Returns a summary dict:
    ``{fetched, new, updated, pages, stopped, auth_error, username}``.

    ``stopped`` ∈ {``caught_up`` (re-reached the high-water mark), ``all_known`` (a page had 0
    new and there's no mark yet), ``max_pages``, ``exhausted`` (no more pages), ``empty``,
    ``auth_error``}. Advances the high-water mark to the current top on success.
    """
    getf = getf or _http_get
    sleep = sleep or time.sleep
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

    mark = db.get_setting(conn, _MARK_KEY)
    newest = None
    base = SAVED_URL.format(user=urllib.parse.quote(username))
    after = ""
    hit_mark = False

    for page in range(max_pages):
        if page:
            sleep(throttle)  # be polite between pages (skipped before the first)
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
            name = (ch.get("data") or {}).get("name")
            if newest is None and name:
                newest = name
            if mark and name == mark:  # reached where the last sync left off
                hit_mark = True
                break
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

        if hit_mark:
            result["stopped"] = "caught_up"
            break
        after = data.get("after") or ""
        if not after:
            result["stopped"] = "exhausted"
            break
        # Without a mark yet, a fully-known page is the best boundary heuristic. Once a mark
        # exists it's authoritative, so this fallback is disabled (avoids stopping early at a
        # known *prefix* that still has new items behind it).
        if stop_on_known and not mark and page_new == 0:
            result["stopped"] = "all_known"
            break
    else:
        result["stopped"] = "max_pages"

    if newest:
        db.set_setting(conn, _MARK_KEY, newest)
    return result
