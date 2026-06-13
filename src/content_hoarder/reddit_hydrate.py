"""Single-item Reddit thread hydration.

Fetches the [post listing, comments listing] JSON for a single saved Reddit
item and caches it in the ``reddit_threads`` table. Single fullname only —
batch hydration is explicitly out of scope here.
"""

import json

from content_hoarder import config, db, models
from content_hoarder.reddit_unsave import (
    RedditNetworkError,
    _http_get,
    get_auth,
)


def hydrate_one(conn, fullname: str, *, getf=None, user_agent=None) -> dict:
    """Hydrate one saved Reddit item's full comment thread.

    Returns a flat dict with a ``status`` key in every case; never raises for
    the cases documented below (logged-out, transient network, malformed
    payload, etc.).
    """
    user_agent = user_agent or config.get("USER_AGENT")
    if getf is None:
        getf = _http_get

    row = conn.execute(
        "SELECT source, metadata FROM items WHERE fullname=?", (fullname,)
    ).fetchone()
    if not row:
        return {"status": "not_found", "fullname": fullname}

    metadata = models.parse_metadata(row["metadata"])
    if row["source"] != "reddit" or not metadata.get("permalink"):
        return {"status": "no_permalink", "fullname": fullname}

    auth = get_auth(conn)
    if not auth:
        return {"status": "auth_missing", "fullname": fullname}

    permalink = metadata["permalink"]
    if not permalink.startswith("/"):
        permalink = "/" + permalink
    url = f"https://www.reddit.com{permalink}.json?raw_json=1"

    try:
        data = getf(url, session_cookie=auth["session_cookie"], user_agent=user_agent)
    except RedditNetworkError as e:
        return {"status": "network_error", "fullname": fullname, "detail": str(e)}

    if data == {}:
        return {"status": "auth_expired", "fullname": fullname}

    if not isinstance(data, list) or len(data) < 1:
        return {"status": "bad_shape", "fullname": fullname}

    comments = 0
    try:
        comments = len(data[1]["data"]["children"])
    except (KeyError, IndexError, TypeError):
        comments = 0

    db.set_reddit_thread(conn, fullname, json.dumps(data), commit=True)
    return {"status": "hydrated", "fullname": fullname, "comments": comments}
