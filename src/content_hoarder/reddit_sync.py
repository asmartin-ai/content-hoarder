"""Incremental sync of the user's Reddit *saved* list via reddit_session-cookie auth.

No OAuth: GET ``https://www.reddit.com/user/<username>/saved.json`` with the same cookie the
unsave queue uses. Reddit returns the saved listing **newest-saved-first**, so we walk from the
top and stop the moment we re-reach an item from the previous sync's **high-water mark** — the
newest ``_MARK_DEPTH`` fullnames, stored as a JSON list in ``settings['reddit_sync_newest']``.
The mark is a *list*, not a single name, because the unsave drain (and the user, on reddit.com)
removes items from the saved listing: a single-name mark that gets unsaved would never be
re-found, silently degrading every future sync to a full ``max_pages`` walk. Any one of the K
names re-appearing counts as "caught up". A routine sync therefore does O(new-items) work — not
O(whole-history) — which sidesteps the rate-limit bottleneck.

The very first sync (no mark yet) has no precise boundary, so it pulls ``max_pages`` deep; use the
``--full`` CLI flag (``stop_on_known=False``) for a thorough first catch-up. All network is
injectable (``getf=``/``sleep=``) so this is fully unit-testable offline. Normalization is shared
with the importer via ``connectors.reddit.child_to_item``.
"""

from __future__ import annotations

import json
import time
import urllib.parse

from content_hoarder import config, db
from content_hoarder.reddit_unsave import (
    RedditAuthError,
    RedditNetworkError,
    _http_get,
    _refresh_modhash,
    get_auth,
)

SAVED_URL = "https://www.reddit.com/user/{user}/saved.json"
_MARK_KEY = "reddit_sync_newest"   # JSON list of the newest fullnames seen last sync
_MARK_DEPTH = 25                   # how many top-of-listing names the mark keeps (see module doc)


def _load_mark(value) -> list[str]:
    """Parse the stored mark. Accepts the current JSON-list form and the legacy single
    bare-fullname string (pre-list DBs) — the next successful sync rewrites it as a list."""
    if not value:
        return []
    s = str(value).strip()
    if s.startswith("["):
        try:
            return [str(x) for x in json.loads(s) if x]
        except (ValueError, TypeError):
            return []
    return [s]


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
    ``auth_error``}. The high-water mark only advances when the run reached a real boundary
    (``caught_up``/``all_known``/``exhausted``) or it's the first sync (no mark yet) — never on
    a ``max_pages`` truncation, which could otherwise skip the items below the cutoff forever.
    """
    getf = getf or _http_get
    sleep = sleep or time.sleep
    user_agent = user_agent or config.get("USER_AGENT")
    result = {"fetched": 0, "new": 0, "updated": 0, "pages": 0,
              "stopped": None, "auth_error": False, "network_error": False,
              "username": None}

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
        except RedditNetworkError:
            result["network_error"] = True
            result["stopped"] = "network_error"
            return result
    result["username"] = username

    from content_hoarder.connectors.reddit import child_to_item
    snapshot_utc = int(time.time())  # provenance marker for this saved-list snapshot

    marks = _load_mark(db.get_setting(conn, _MARK_KEY))
    mark_set = set(marks)
    top_names: list[str] = []  # current top of the listing, in order — becomes the next mark
    base = SAVED_URL.format(user=urllib.parse.quote(username))
    after = ""
    hit_mark = False

    for page in range(max_pages):
        if page:
            sleep(throttle)  # be polite between pages (skipped before the first)
        params = {"limit": per_page, "raw_json": 1}
        if after:
            params["after"] = after
        try:
            body = getf(base + "?" + urllib.parse.urlencode(params),
                        session_cookie=auth["session_cookie"], user_agent=user_agent) or {}
        except RedditNetworkError:
            # Not a real boundary — never advances the mark (unlike empty/exhausted).
            result["network_error"] = True
            result["stopped"] = "network_error"
            break
        data = body.get("data") or {}
        children = data.get("children") or []
        if not children:
            result["stopped"] = "empty" if page == 0 else "exhausted"
            break

        result["pages"] += 1
        page_new = 0
        for ch in children:
            name = (ch.get("data") or {}).get("name")
            if name and len(top_names) < _MARK_DEPTH and name not in top_names:
                top_names.append(name)  # incl. a matched mark item — it's still listed
            if mark_set and name in mark_set:  # reached where the last sync left off
                hit_mark = True
                break
            item = child_to_item(ch, saved_seen_utc=snapshot_utc)
            if not item:
                continue
            result["fetched"] += 1
            # merge_upsert already does one existence lookup internally and reports the
            # outcome, so trust its return rather than a second get_item round-trip.
            if db.merge_upsert(conn, item) == "inserted":
                result["new"] += 1
                page_new += 1
            else:
                result["updated"] += 1
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
        if stop_on_known and not marks and page_new == 0:
            result["stopped"] = "all_known"
            break
    else:
        result["stopped"] = "max_pages"

    # Advance the high-water mark ONLY when we contiguously covered the top of the saved
    # list down to a real boundary: the previous mark (caught_up), a fully-known page
    # (all_known), or the end of the list (exhausted). On a `max_pages` truncation there can
    # be new items BELOW what we fetched but ABOVE the old mark; advancing past them here
    # would skip them on every future sync (silent data gap). The very first sync (no mark
    # yet) sets the initial baseline — run `reddit-sync --full` for a thorough first catch-up.
    if top_names and (not marks or result["stopped"] in ("caught_up", "exhausted", "all_known")):
        db.set_setting(conn, _MARK_KEY, json.dumps(top_names))
    return result
