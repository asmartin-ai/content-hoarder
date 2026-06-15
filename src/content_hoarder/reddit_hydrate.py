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
    RedditNotFoundError,
    _http_get,
    get_auth,
)
from content_hoarder.archival.providers import _bare_id, _PLACEHOLDERS, default_providers

_SUB_FROM_PERMALINK = re.compile(r"^/r/([^/]+)/")
# The submission base36 id sits between ``/comments/`` and the next ``/`` in a comment
# permalink (``/r/<sub>/comments/<sid>/<slug-or-_>/<cid>/``), absolute or relative.
_SID_FROM_PERMALINK = re.compile(r"/comments/([A-Za-z0-9]+)/")


def backfill_titles_local(conn, *, dry_run: bool = False) -> dict:
    """Spec 08 P1: restore real titles for title-less saved reddit items (mostly COMMENTS,
    which carry no title of their own) from ``raw_json.submission_title`` — the title of the
    post the comment is on. Fully local/offline; idempotent + additive: only rows with an
    EMPTY title AND a non-empty ``submission_title`` are touched, never overwriting a real
    title. ``search_text`` is recomputed so the restored title is searchable. Returns a summary
    dict; ``dry_run=True`` previews without writing. Back up the DB before a real run.
    """
    # raw_json defaults to '' (invalid JSON), so parse it in Python rather than via
    # json_extract (which raises "malformed JSON" on the empty string).
    rows = conn.execute(
        "SELECT fullname, body, author, metadata, raw_json "
        "FROM items WHERE source='reddit' AND trim(title) = '' AND raw_json != ''"
    ).fetchall()
    updated, samples = 0, []
    for r in rows:
        try:
            raw = json.loads(r["raw_json"])
        except (ValueError, TypeError):
            continue
        title = str((raw.get("submission_title") if isinstance(raw, dict) else "") or "").strip()
        if not title:
            continue
        if not dry_run:
            md = models.parse_metadata(r["metadata"])
            search_text = models.build_search_text(
                {"title": title, "body": r["body"], "author": r["author"]}, md)
            conn.execute(
                "UPDATE items SET title = ?, search_text = ? WHERE fullname = ?",
                (title, search_text, r["fullname"]),
            )
        updated += 1
        if len(samples) < 5:
            samples.append({"fullname": r["fullname"], "title": title[:80]})
    if updated and not dry_run:
        conn.commit()
    return {"candidates": len(rows), "updated": updated, "dry_run": dry_run, "samples": samples}


def backfill_titles_network(conn, *, providers=None, user_agent=None,
                            dry_run: bool = False, limit: int | None = None,
                            progress=None) -> dict:
    """Spec 08 P2: fill titles for the title-less saved reddit items that ``backfill_titles_local``
    can't (comments whose ``submission_title`` was never captured — they have no ``raw_json``) by
    fetching the SUBMISSION each comment is on from web archives (PullPush -> Arctic-Shift) and using
    its ``title``. The submission base36 id is read from ``metadata.permalink``
    (``/r/<sub>/comments/<sid>/...``), so no per-comment id mapping is needed and comments sharing a
    submission cost a single fetch. Idempotent + additive: only rows with an EMPTY title and a
    resolvable submission id are touched, never overwriting a real title; ``search_text`` is
    recomputed. ``dry_run=True`` reports the scope (incl. resolved submission ids) with NO network.
    Back up the DB before a real run. All network is injectable via ``providers`` for offline tests.
    """
    rows = conn.execute(
        "SELECT fullname, body, author, metadata FROM items "
        "WHERE source='reddit' AND trim(title) = '' "
        "ORDER BY last_seen_utc DESC"
    ).fetchall()

    targets, skipped_no_sid = [], 0
    for r in rows:
        md = models.parse_metadata(r["metadata"])
        m = _SID_FROM_PERMALINK.search(md.get("permalink") or "")
        if not m:
            skipped_no_sid += 1
            continue
        targets.append((r["fullname"], m.group(1), r["body"], md, r["author"]))
    if limit is not None:
        targets = targets[:limit]

    unique_sids = sorted({sid for _, sid, _, _, _ in targets})
    res = {
        "candidates": len(rows), "resolvable": len(targets),
        "submissions": len(unique_sids), "skipped_no_submission_id": skipped_no_sid,
        "updated": 0, "missed": 0, "dry_run": dry_run, "by_provider": {},
    }
    if dry_run:
        res["sample_targets"] = [{"fullname": fn, "submission_id": sid}
                                 for fn, sid, *_ in targets[:20]]
        return res
    if not targets:
        return res

    providers = providers or default_providers(user_agent or config.get("USER_AGENT"))
    titles: dict = {}            # submission bare id -> recovered title
    remaining = set(unique_sids)
    errors: dict = {}
    for prov in providers:
        if not remaining:
            break
        try:
            found = prov.fetch_posts(sorted(remaining))
        except Exception as e:   # a single provider being down must not abort the chain
            errors[prov.name] = str(e)
            continue
        got = 0
        for sid, fields in found.items():
            title = str(fields.get("title") or "").strip()
            if title and title not in _PLACEHOLDERS:
                titles[sid] = title
                got += 1
        remaining -= set(titles)
        if got:
            res["by_provider"][prov.name] = res["by_provider"].get(prov.name, 0) + got
        if progress:
            progress(f"  {prov.name}: {len(titles)}/{len(unique_sids)} submissions resolved")

    samples = []
    for fn, sid, body, md, author in targets:
        title = titles.get(sid)
        if not title:
            res["missed"] += 1
            continue
        search_text = models.build_search_text(
            {"title": title, "body": body, "author": author}, md)
        conn.execute("UPDATE items SET title = ?, search_text = ? WHERE fullname = ?",
                     (title, search_text, fn))
        res["updated"] += 1
        if len(samples) < 8:
            samples.append({"fullname": fn, "submission_id": sid, "title": title[:80]})
    if res["updated"]:
        conn.commit()
    res["samples"] = samples
    if errors:
        res["errors"] = errors
    return res


def hydrate_one(conn, fullname: str, *, getf=None, user_agent=None, providers=None) -> dict:
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

    # permalink may be relative ("/r/sub/comments/id/slug/") from cookie syncs OR an
    # absolute URL ("https://www.reddit.com/r/sub/...") from the legacy bulk import.
    # Handle both — otherwise the absolute case double-prefixes the domain
    # ("https://www.reddit.com/https://www.reddit.com/...") and 404s.
    permalink = metadata["permalink"]
    if permalink.startswith(("http://", "https://")):
        base = permalink
    else:
        base = "https://www.reddit.com/" + permalink.lstrip("/")
    url = base.rstrip("/") + "/.json?raw_json=1"

    try:
        data = getf(url, session_cookie=auth["session_cookie"], user_agent=user_agent)
    except RedditNotFoundError:
        return hydrate_one_from_archive(conn, fullname, providers=providers, user_agent=user_agent)
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


def hydrate_if_missing(conn, fullname, *, getf=None, user_agent=None, providers=None) -> dict:
    """Lazy hydration: if this item has no cached comment thread yet, fetch + store it
    (cookie via :func:`hydrate_one`, with the PullPush/Arctic-Shift archive fallback), then
    report the outcome. Makes NO network call when a thread is already cached — returns
    ``{"status": "cached"}``. Meant to run on the first open of a Reddit item's thread so the
    tree is fetched on demand and served from cache forever after.
    """
    existing = db.get_reddit_thread(conn, fullname)
    if existing and existing.get("thread_json"):
        return {"status": "cached", "fullname": fullname}
    return hydrate_one(conn, fullname, getf=getf, user_agent=user_agent, providers=providers)


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


def _build_comment_tree(comments: list, post_subreddit: str, bare_id: str) -> list:
    """Rebuild a nested comment tree from flat archive records with parent_id adjacency.

    Orphans (parent_id references a comment not in the fetched set) attach at root.
    Each node is converted to the ``t1`` listing shape that ``parse_thread`` consumes.
    """
    children_of: dict = {}
    by_id: dict = {}
    for c in comments:
        cid = (c.get("id") or "").strip()
        pid = (c.get("parent_id") or "").strip()
        if cid:
            by_id[cid] = c
        children_of.setdefault(pid, []).append(c)

    post_parent = "t3_" + bare_id
    roots: list = []
    for c in comments:
        pid = (c.get("parent_id") or "").strip()
        if pid == post_parent:
            roots.append(c)
        else:
            parent_bare = pid[3:] if pid.startswith(("t1_", "t3_")) else pid
            if parent_bare not in by_id:
                roots.append(c)

    def _to_t1(c: dict) -> dict:
        cid = (c.get("id") or "").strip()
        sub = post_subreddit or ""
        permalink = c.get("permalink") or ""
        if not permalink and sub and cid and bare_id:
            permalink = f"/r/{sub}/comments/{bare_id}/_/{cid}/"

        child_parent = "t1_" + cid
        child_comments = children_of.get(child_parent, [])

        if child_comments:
            reply_listing: object = {
                "kind": "Listing",
                "data": {"children": [_to_t1(ch) for ch in child_comments]},
            }
        else:
            reply_listing = ""

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

    return [_to_t1(c) for c in roots]


def hydrate_one_from_archive(conn, fullname: str, *, providers=None, user_agent=None) -> dict:
    """Assemble a best-effort [post, comments] listing from archival providers.

    Called when the live Reddit fetch returns HTTP 404. Caches the result like a
    normal hydrated thread and marks it ``_archive_sourced`` in the post data.
    """
    existing = db.get_reddit_thread(conn, fullname)
    if existing:
        return {"status": "archived", "fullname": fullname, "cached": True}

    ua = user_agent or config.get("USER_AGENT")
    providers = providers or default_providers(
        ua, throttle=False, order=("arctic", "pullpush")
    )

    item = db.get_item(conn, fullname)
    if not item:
        return {"status": "archived", "fullname": fullname, "comments": 0}
    sid = item.get("source_id") or ""
    bare = _bare_id(sid)
    if not bare:
        return {"status": "archived", "fullname": fullname, "comments": 0}

    post_data = None
    chosen_provider = None
    for prov in providers:
        try:
            found = prov.fetch_posts([bare])
        except Exception:
            continue
        if bare in found:
            post_data = found[bare]
            chosen_provider = prov
            break

    if post_data is None:
        return {"status": "archived", "fullname": fullname, "comments": 0}

    try:
        comments = chosen_provider.search_comments_tree(sid, limit=500)
    except Exception:
        comments = []

    tree_comments = _build_comment_tree(
        comments, post_data.get("subreddit") or "", bare
    )

    post = {
        "title": post_data.get("title") or "",
        "author": post_data.get("author") or "",
        "selftext": post_data.get("selftext") or post_data.get("body") or "",
        "subreddit": post_data.get("subreddit") or "",
        "permalink": post_data.get("permalink") or "",
        "score": post_data.get("score") or 0,
        "url": post_data.get("url") or "",
        "created_utc": post_data.get("created_utc") or 0,
        "_archive_sourced": True,
    }

    blob = [
        {"kind": "Listing", "data": {"children": [{"kind": "t3", "data": post}]}},
        {"kind": "Listing", "data": {"children": tree_comments}},
    ]

    db.set_reddit_thread(conn, fullname, json.dumps(blob))

    return {"status": "archived", "fullname": fullname, "comments": len(tree_comments)}


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
