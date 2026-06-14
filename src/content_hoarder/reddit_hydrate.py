"""Reddit thread hydration.

``hydrate_one`` fetches the [post listing, comments listing] JSON for a single
saved Reddit item (cookie) and caches it in ``reddit_threads``.
``hydrate_from_archive`` does the same fully offline from a local BDFR ``.json``
archive — no network, no cookie (Epic 24 P3) — by converting each BDFR submission
dict into the exact ``[post-listing, comments-listing]`` shape that
``reddit_thread.parse_thread`` consumes.
"""

import glob
import json
import os
import re
import time

from content_hoarder import config, db, models
from content_hoarder.reddit_unsave import (
    RedditNetworkError,
    _http_get,
    get_auth,
)

_SUB_FROM_PERMALINK = re.compile(r"^/r/([^/]+)/")


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


# --- Offline local-archive hydration (BDFR JSON -> reddit_threads) --------------


def _bdfr_comment_to_child(c: dict, subreddit: str, submission_id: str) -> dict:
    """One BDFR comment dict (+ nested ``replies``) -> a Reddit-listing ``t1`` child.

    Mirrors what ``<permalink>.json`` returns so ``reddit_thread._extract_comments``
    reads it identically. BDFR omits the per-comment ``permalink`` field, so we
    synthesize the canonical slugless form (``/r/<sub>/comments/<sid>/_/<cid>/``) from
    subreddit + submission id + comment id — making the conversion lossless rather than
    dropping the link. Empty replies become ``""`` (not a dict), which is exactly how
    ``_extract_comments`` detects "no further nesting".
    """
    replies = c.get("replies")
    if isinstance(replies, list) and replies:
        reply_listing: object = {
            "kind": "Listing",
            "data": {"children": [_bdfr_comment_to_child(r, subreddit, submission_id)
                                  for r in replies if isinstance(r, dict)]},
        }
    else:
        reply_listing = ""
    cid = (c.get("id") or "").strip()
    sid = (c.get("submission") or submission_id or "").strip()
    permalink = (f"/r/{subreddit}/comments/{sid}/_/{cid}/"
                 if (subreddit and sid and cid) else "")
    return {
        "kind": "t1",
        "data": {
            "author": c.get("author") or "",
            "body": c.get("body") or "",
            "score": c.get("score") or 0,
            "permalink": permalink,
            "created_utc": c.get("created_utc") or 0,
            "replies": reply_listing,
        },
    }


def bdfr_to_listing(sub: dict) -> list:
    """Convert a BDFR submission dict into the ``[post-listing, comments-listing]``
    structure stored in ``reddit_threads`` (identical to Reddit's ``<permalink>.json``)."""
    permalink = sub.get("permalink") or ""
    subreddit = sub.get("subreddit")
    if not subreddit:
        m = _SUB_FROM_PERMALINK.match(permalink)
        subreddit = m.group(1) if m else ""
    post = {
        "title": sub.get("title") or "",
        "author": sub.get("author") or "",
        "selftext": sub.get("selftext") or "",
        "subreddit": subreddit,
        "permalink": permalink,
        "score": sub.get("score") or 0,
        "url": sub.get("url") or "",
        "created_utc": sub.get("created_utc") or 0,
    }
    submission_id = (sub.get("id") or "").strip()
    children = [_bdfr_comment_to_child(c, subreddit, submission_id)
                for c in (sub.get("comments") or []) if isinstance(c, dict)]
    return [
        {"kind": "Listing", "data": {"children": [{"kind": "t3", "data": post}]}},
        {"kind": "Listing", "data": {"children": children}},
    ]


def _bdfr_fullname(sub: dict) -> str | None:
    """``reddit:t3_<id>`` for a BDFR submission, or None if it can't be keyed."""
    name = (sub.get("name") or "").strip()
    if name.startswith("t3_"):
        return f"reddit:{name}"
    sid = (sub.get("id") or "").strip()
    return f"reddit:t3_{sid}" if sid else None


def hydrate_from_archive(conn, archive_dir: str, *, limit: int | None = None,
                         only_existing: bool = True, skip_hydrated: bool = True,
                         progress=None) -> dict:
    """Offline-hydrate every BDFR submission ``.json`` under ``archive_dir``.

    Converts each to the ``reddit_threads`` blob shape and caches it — no network, no
    cookie. ``only_existing`` (default) skips files whose ``reddit:t3_<id>`` has no
    matching ``items`` row, so we don't cache orphan threads. ``skip_hydrated``
    (default) skips items that ALREADY have a cached thread — this is the safety guard:
    a live cookie/RSM blob can be richer than the archive (e.g. real comment permalinks
    with slugs), so we never clobber it unless the caller passes ``skip_hydrated=False``
    (CLI ``--overwrite``). ``limit`` caps how many are written.
    """
    files = sorted(glob.glob(os.path.join(archive_dir, "**", "*.json"), recursive=True))
    res = {"files": len(files), "hydrated": 0, "skipped_no_item": 0,
           "skipped_hydrated": 0, "skipped_bad": 0, "errors": 0}
    already = ({r[0] for r in conn.execute("SELECT fullname FROM reddit_threads")}
               if skip_hydrated else set())
    for path in files:
        if limit is not None and res["hydrated"] >= limit:
            break
        try:
            with open(path, encoding="utf-8") as f:
                sub = json.load(f)
        except (OSError, ValueError):
            res["errors"] += 1
            continue
        if not isinstance(sub, dict):
            res["skipped_bad"] += 1
            continue
        fullname = _bdfr_fullname(sub)
        if not fullname:
            res["skipped_bad"] += 1
            continue
        if only_existing and not conn.execute(
            "SELECT 1 FROM items WHERE fullname=?", (fullname,)
        ).fetchone():
            res["skipped_no_item"] += 1
            continue
        if skip_hydrated and fullname in already:
            res["skipped_hydrated"] += 1
            continue
        db.set_reddit_thread(conn, fullname, json.dumps(bdfr_to_listing(sub)),
                             commit=False)
        res["hydrated"] += 1
        if progress and res["hydrated"] % 50 == 0:
            progress(f"hydrated {res['hydrated']}/{res['files']}…")
    conn.commit()
    return res


# --- Cookie batch hydration of the prioritized set (Epic 24 P2) -----------------


def priority_unhydrated(conn, limit: int) -> list[tuple[str, str]]:
    """The promote-priority hydration targets (feasibility doc §3): inbox reddit POSTS
    with a non-empty body (selftext) + a permalink, not yet hydrated, newest-saved
    first. Returns ``[(fullname, permalink), …]`` capped at ``limit``."""
    rows = conn.execute(
        """SELECT i.fullname AS fullname,
                  json_extract(i.metadata, '$.permalink') AS permalink
             FROM items i
            WHERE i.source = 'reddit' AND i.kind = 'post' AND i.status = 'inbox'
              AND i.body IS NOT NULL AND i.body <> ''
              AND json_extract(i.metadata, '$.permalink') IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM reddit_threads t
                               WHERE t.fullname = i.fullname)
            ORDER BY i.saved_utc DESC
            LIMIT ?""",
        (limit,),
    ).fetchall()
    return [(r["fullname"], r["permalink"]) for r in rows]


def hydrate_batch(conn, *, limit: int = 100, throttle: float = 2.0,
                  dry_run: bool = False, getf=None, sleep=None, progress=None) -> dict:
    """Cookie-hydrate the prioritized unhydrated set, rate-limited and resumable.

    Each successful hydration commits immediately (``hydrate_one`` does), and hydrated
    items drop out of ``priority_unhydrated`` — so re-running simply continues where it
    left off (no ledger needed). Courteous by default (``throttle`` s between requests)
    and it STOPS on a dead cookie rather than hammering Reddit. ``dry_run`` lists the
    scope without any network (honors the "approve the scope first" gate). All network
    is injectable (``getf``/``sleep``) so tests are fully offline.
    """
    sleep = sleep or time.sleep
    targets = priority_unhydrated(conn, limit)
    res: dict = {"eligible": len(targets), "hydrated": 0, "failed": 0,
                 "auth_error": False, "network_errors": 0, "dry_run": dry_run,
                 "statuses": {}}
    if dry_run:
        res["sample"] = [fn for fn, _ in targets[:20]]
        return res
    if not get_auth(conn):
        res["auth_error"] = True
        return res
    for idx, (fullname, _permalink) in enumerate(targets):
        r = hydrate_one(conn, fullname, getf=getf)
        st = r.get("status")
        res["statuses"][st] = res["statuses"].get(st, 0) + 1
        if st == "hydrated":
            res["hydrated"] += 1
        elif st in ("auth_expired", "auth_missing"):
            res["auth_error"] = True
            break  # dead cookie — stop, do not keep hitting Reddit
        else:
            res["failed"] += 1
            if st == "network_error":
                res["network_errors"] += 1
        if progress and (idx + 1) % 10 == 0:
            progress(f"hydrated {res['hydrated']}/{res['eligible']}…")
        if idx + 1 < len(targets):
            sleep(throttle)
    return res
