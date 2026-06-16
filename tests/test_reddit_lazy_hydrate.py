"""Lazy comment-thread hydration: fetch + cache a thread on first open."""

import pytest

from content_hoarder import db, models, web
import content_hoarder.reddit_hydrate as rh
from content_hoarder.reddit_unsave import RedditNotFoundError, set_auth

_BLOB = [
    {"kind": "Listing", "data": {"children": [{"data": {"id": "h1", "title": "Post T"}}]}},
    {"kind": "Listing", "data": {"children": [{"data": {"id": "c1", "body": "hi"}}]}},
]


def _seed(conn, sid="t3_h1", permalink="/r/test/comments/h1/x/"):
    db.merge_upsert(conn, models.new_item(
        source="reddit", source_id=sid, kind="post", metadata={"permalink": permalink}))


def test_hydrate_if_missing_fetches_then_serves_from_cache(conn):
    _seed(conn)
    set_auth(conn, session_cookie="c", modhash="m")
    calls = []

    def fake_getf(url, *, session_cookie, user_agent):
        calls.append(url)
        return _BLOB

    r1 = rh.hydrate_if_missing(conn, "reddit:t3_h1", getf=fake_getf)
    assert r1["status"] == "hydrated"
    assert len(calls) == 1                       # fetched once

    r2 = rh.hydrate_if_missing(conn, "reddit:t3_h1", getf=fake_getf)
    assert r2["status"] == "cached"
    assert len(calls) == 1                       # already cached -> no second fetch


def test_hydrate_if_missing_no_permalink_no_network(conn):
    db.merge_upsert(conn, models.new_item(source="reddit", source_id="t3_np", kind="post"))
    set_auth(conn, session_cookie="c", modhash="m")
    calls = []
    res = rh.hydrate_if_missing(conn, "reddit:t3_np",
                                getf=lambda *a, **k: calls.append(1) or {})
    assert res["status"] == "no_permalink"
    assert calls == []                           # never hit the network


@pytest.fixture
def tmp_db(tmp_path):
    path = str(tmp_path / "t.db")
    c = db.connect(path)
    try:
        yield path, c
    finally:
        c.close()


def test_thread_route_lazily_hydrates(tmp_db):
    path, c = tmp_db
    _seed(c)
    set_auth(c, session_cookie="c", modhash="m")
    c.commit()
    orig = rh._http_get
    rh._http_get = lambda url, *, session_cookie, user_agent: _BLOB
    try:
        cl = web.create_app(path).test_client()
        body = cl.get("/reddit/items/reddit:t3_h1/thread").get_json()
        assert body["cached"] is True            # hydrated on the fly, then served from cache
        assert body["hydrate_status"] == "hydrated"
        assert [c0["body"] for c0 in body["comments"]] == ["hi"]
    finally:
        rh._http_get = orig


def test_thread_route_nofetch_skips_hydration(tmp_db):
    path, c = tmp_db
    _seed(c)
    set_auth(c, session_cookie="c", modhash="m")
    c.commit()
    calls = []
    orig = rh._http_get
    rh._http_get = lambda url, **k: (calls.append(url) or _BLOB)
    try:
        cl = web.create_app(path).test_client()
        body = cl.get("/reddit/items/reddit:t3_h1/thread?nofetch=1").get_json()
        assert body["cached"] is False           # not hydrated
        assert "hydrate_status" not in body
        assert calls == []                       # no network call
    finally:
        rh._http_get = orig


# --- Negative cache: a 404 + archive-miss is terminal; don't re-fetch every open ---


class _MissProvider:
    """Archive provider that finds nothing — drives the 404 -> archive-miss terminal failure."""

    name = "miss"

    def fetch_posts(self, ids):
        return {}

    def search_comments_tree(self, sid, limit=500):
        return []


def _getf_404(calls):
    def getf(url, *, session_cookie, user_agent):
        calls.append(url)
        raise RedditNotFoundError("gone")
    return getf


def test_negative_cache_short_circuits_after_terminal_failure(conn):
    _seed(conn)  # reddit:t3_h1 with a permalink
    set_auth(conn, session_cookie="c", modhash="m")
    calls = []
    getf, miss = _getf_404(calls), [_MissProvider()]
    r1 = rh.hydrate_if_missing(conn, "reddit:t3_h1", getf=getf, providers=miss, now=1000)
    assert r1["status"] == "archived" and r1.get("cached_failure") is True
    assert len(calls) == 1                        # one live fetch attempt, then archive miss
    # reopen within the TTL -> short-circuit, no further network
    r2 = rh.hydrate_if_missing(conn, "reddit:t3_h1", getf=getf, providers=miss, now=1100)
    assert r2["status"] == "unavailable" and r2.get("cached_failure") is True
    assert len(calls) == 1                        # getf NOT called again


def test_negative_cache_retries_after_ttl(conn):
    _seed(conn)
    set_auth(conn, session_cookie="c", modhash="m")
    calls = []
    getf, miss = _getf_404(calls), [_MissProvider()]
    rh.hydrate_if_missing(conn, "reddit:t3_h1", getf=getf, providers=miss, now=1000, ttl=100)
    assert len(calls) == 1
    rh.hydrate_if_missing(conn, "reddit:t3_h1", getf=getf, providers=miss, now=1050, ttl=100)
    assert len(calls) == 1                        # within TTL -> no retry
    rh.hydrate_if_missing(conn, "reddit:t3_h1", getf=getf, providers=miss, now=1200, ttl=100)
    assert len(calls) == 2                        # past TTL -> one retry attempt
