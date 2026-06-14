"""Offline tests for the archive fallback on deleted (HTTP 404) Reddit threads (Epic 24 #749).

When a live cookie hydrate returns HTTP 404, ``hydrate_one`` assembles a best-effort thread
from the archival providers (Arctic-Shift preferred for real permalinks), rebuilds the comment
tree from flat ``parent_id`` adjacency, marks it archive-sourced, and caches it like a normal
hydrated thread. All transport is injected (``getf=`` / ``providers=``) — no network.
"""
import json

from content_hoarder import db, models, reddit_thread
from content_hoarder.reddit_hydrate import hydrate_one, hydrate_one_from_archive
from content_hoarder.reddit_unsave import (
    RedditNetworkError,
    RedditNotFoundError,
    set_auth,
)
from content_hoarder.archival.providers import ArcticShiftProvider

POST_RECS = [{"id": "abc", "title": "Deleted Post", "selftext": "the body",
              "author": "op", "subreddit": "sub",
              "permalink": "/r/sub/comments/abc/slug/", "score": 5,
              "created_utc": 1600000000}]
COMMENT_RECS = [
    {"id": "c1", "parent_id": "t3_abc", "author": "a1", "body": "top", "score": 3,
     "created_utc": 1600000100, "permalink": "/r/sub/comments/abc/slug/c1/"},
    {"id": "c2", "parent_id": "t1_c1", "author": "a2", "body": "reply", "score": 1,
     "created_utc": 1600000200},
    {"id": "c3", "parent_id": "t1_zzz", "author": "a3", "body": "orphan", "score": 0,
     "created_utc": 1600000300},
]


def _fake_json(post_recs, comment_recs):
    def gj(url, ua, timeout=20.0):
        if "/comments/search" in url or "/search/comment" in url:
            return 200, {}, {"data": comment_recs}
        return 200, {}, {"data": post_recs}
    return gj


def _seed(conn, source_id="t3_abc", permalink="/r/sub/comments/abc/slug/"):
    db.merge_upsert(conn, models.new_item(
        source="reddit", source_id=source_id, kind="post",
        metadata={"permalink": permalink}))
    conn.commit()


def _arctic():
    return ArcticShiftProvider("ua", min_interval=0.0,
                               get_json=_fake_json(POST_RECS, COMMENT_RECS))


def test_404_archive_core(conn):
    """404 → archive assembled, marked, tree rebuilt, missing permalink synthesized."""
    _seed(conn)
    set_auth(conn, session_cookie="c", modhash="m")

    def boom(url, *, session_cookie, user_agent):
        raise RedditNotFoundError("HTTP 404")

    res = hydrate_one(conn, "reddit:t3_abc", getf=boom, providers=[_arctic()])
    assert res["status"] == "archived"

    row = db.get_reddit_thread(conn, "reddit:t3_abc")
    assert row is not None
    item = db.get_item(conn, "reddit:t3_abc")
    parsed = reddit_thread.parse_thread(row["thread_json"], item)
    assert parsed["archived"] is True
    assert parsed["post"]["title"] == "Deleted Post"

    by_body = {c["body"]: c for c in parsed["comments"]}
    assert by_body["top"]["depth"] == 0
    assert by_body["reply"]["depth"] == 1            # nested under its parent c1
    assert by_body["orphan"]["depth"] == 0           # orphan (parent absent) attaches at root
    # a record with no permalink (c2) gets the synthesized slugless form
    assert by_body["reply"]["permalink"] == "https://www.reddit.com/r/sub/comments/abc/_/c2/"


def test_404_preserves_arctic_permalink(conn):
    """A record that carries a real permalink (Arctic) keeps it — not overwritten by a
    synthesized slugless one. This is why Arctic-Shift is preferred over PullPush."""
    _seed(conn)
    set_auth(conn, session_cookie="c", modhash="m")

    def boom(url, *, session_cookie, user_agent):
        raise RedditNotFoundError("HTTP 404")

    hydrate_one(conn, "reddit:t3_abc", getf=boom, providers=[_arctic()])
    row = db.get_reddit_thread(conn, "reddit:t3_abc")
    item = db.get_item(conn, "reddit:t3_abc")
    parsed = reddit_thread.parse_thread(row["thread_json"], item)
    by_body = {c["body"]: c for c in parsed["comments"]}
    assert by_body["top"]["permalink"] == "https://www.reddit.com/r/sub/comments/abc/slug/c1/"


def test_existing_cache_not_overwritten(conn):
    """The fallback only assembles when there is no cache — a richer live/RSM thread is never
    clobbered by a thinner archive copy."""
    _seed(conn)
    original = json.dumps([
        {"kind": "Listing", "data": {"children": [{"kind": "t3", "data": {"title": "ORIGINAL"}}]}},
        {"kind": "Listing", "data": {"children": []}},
    ])
    db.set_reddit_thread(conn, "reddit:t3_abc", original)

    res = hydrate_one_from_archive(conn, "reddit:t3_abc", providers=[_arctic()])
    assert res["status"] == "archived"
    assert res.get("cached") is True
    row = db.get_reddit_thread(conn, "reddit:t3_abc")
    assert json.loads(row["thread_json"])[0]["data"]["children"][0]["data"]["title"] == "ORIGINAL"


def test_network_error_not_archived(conn):
    """A 5xx/timeout (base RedditNetworkError) must NOT trigger the archive fallback."""
    _seed(conn)
    set_auth(conn, session_cookie="c", modhash="m")

    def boom(url, *, session_cookie, user_agent):
        raise RedditNetworkError("boom")

    res = hydrate_one(conn, "reddit:t3_abc", getf=boom, providers=[_arctic()])
    assert res["status"] == "network_error"
