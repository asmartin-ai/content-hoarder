"""Tests for cookie batch hydration of the prioritized set (Epic 24 P2).

Fully offline: the Reddit fetch (``getf``) and the rate-limit ``sleep`` are injected,
so no network or real timing is involved.
"""

import pytest

from content_hoarder import db, models, reddit_hydrate
from content_hoarder.reddit_hydrate import hydrate_batch, priority_unhydrated
from content_hoarder.reddit_unsave import RedditNetworkError, set_auth


# ---------- helpers ----------

def _seed_post(conn, sid, *, body="some selftext", saved_utc=1000, status="inbox",
               kind="post", permalink="auto"):
    if permalink == "auto":
        permalink = f"/r/test/comments/{sid}/x/"
    item = models.new_item(source="reddit", source_id=f"t3_{sid}", kind=kind,
                           body=body, saved_utc=saved_utc, status=status,
                           metadata=({"permalink": permalink} if permalink else {}))
    db.merge_upsert(conn, item)


def _auth(conn):
    set_auth(conn, session_cookie="c", modhash="m")


def _ok_getf(*_a, **_k):
    # minimal valid [post-listing, comments-listing]
    return [{"data": {"children": [{"data": {"id": "p"}}]}},
            {"data": {"children": [{"data": {"id": "c1"}}]}}]


class _Sleeps:
    def __init__(self): self.calls = []
    def __call__(self, secs): self.calls.append(secs)


# ---------- priority_unhydrated ----------

def test_priority_selects_inbox_selftext_unhydrated_newest_first(conn):
    _seed_post(conn, "new", saved_utc=3000)
    _seed_post(conn, "old", saved_utc=1000)
    _seed_post(conn, "nobody", body="")                 # no selftext -> excluded
    _seed_post(conn, "archived", status="archived")     # not inbox -> excluded
    _seed_post(conn, "noperma", permalink="")           # no permalink -> excluded
    _seed_post(conn, "acomment", kind="comment")        # not a post -> excluded
    got = priority_unhydrated(conn, 100)
    assert [fn for fn, _ in got] == ["reddit:t3_new", "reddit:t3_old"]  # newest first


def test_priority_excludes_already_hydrated_and_respects_limit(conn):
    for sid, ts in (("a", 1), ("b", 2), ("c", 3)):
        _seed_post(conn, sid, saved_utc=ts)
    db.set_reddit_thread(conn, "reddit:t3_c", "[{},{}]")  # already cached -> excluded
    got = priority_unhydrated(conn, 1)
    assert got == [("reddit:t3_b", "/r/test/comments/b/x/")]  # newest remaining, capped


# ---------- hydrate_batch ----------

def test_batch_dry_run_lists_scope_without_network(conn):
    _seed_post(conn, "a")
    _seed_post(conn, "b")
    res = hydrate_batch(conn, dry_run=True, getf=_should_not_call)
    assert res["dry_run"] is True
    assert res["eligible"] == 2
    assert set(res["sample"]) == {"reddit:t3_a", "reddit:t3_b"}


def _should_not_call(*_a, **_k):  # getf that fails the test if the network is touched
    raise AssertionError("network must not be called in dry_run / no-auth")


def test_batch_hydrates_and_throttles_between_requests(conn):
    for sid in ("a", "b", "c"):
        _seed_post(conn, sid)
    _auth(conn)
    sleeps = _Sleeps()
    res = hydrate_batch(conn, throttle=2.0, getf=_ok_getf, sleep=sleeps)
    assert res["hydrated"] == 3 and res["failed"] == 0
    assert res["statuses"].get("hydrated") == 3
    assert sleeps.calls == [2.0, 2.0]  # throttle BETWEEN the 3, not after the last
    # the threads are now cached -> a re-run finds nothing (resumable)
    assert priority_unhydrated(conn, 100) == []


def test_batch_no_auth_is_loud_and_silent_on_network(conn):
    _seed_post(conn, "a")
    res = hydrate_batch(conn, getf=_should_not_call)
    assert res["auth_error"] is True and res["hydrated"] == 0


def test_batch_stops_on_dead_cookie(conn):
    for sid in ("a", "b", "c"):
        _seed_post(conn, sid)
    _auth(conn)
    calls = {"n": 0}

    def dead_getf(*_a, **_k):
        calls["n"] += 1
        return {}  # hydrate_one maps {} -> auth_expired

    res = hydrate_batch(conn, getf=dead_getf, sleep=lambda s: None)
    assert res["auth_error"] is True
    assert calls["n"] == 1  # broke after the first dead-cookie response, didn't hammer


def test_batch_counts_network_errors_without_aborting(conn):
    for sid in ("a", "b"):
        _seed_post(conn, sid)
    _auth(conn)

    def flaky_getf(*_a, **_k):
        raise RedditNetworkError("boom")

    res = hydrate_batch(conn, getf=flaky_getf, sleep=lambda s: None)
    assert res["hydrated"] == 0
    assert res["network_errors"] == 2 and res["failed"] == 2
    assert res["auth_error"] is False  # transient != auth failure
