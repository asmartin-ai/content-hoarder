"""Tests for single-fullname Reddit thread hydration (core + endpoint)."""

import json

import pytest

from content_hoarder import db, models, web
from content_hoarder.reddit_hydrate import hydrate_one
from content_hoarder.reddit_unsave import RedditNetworkError, set_auth


# ---------- helpers ----------

def _seed(conn, source="reddit", source_id="t3_h1", permalink=None):
    md = None if permalink is None else {"permalink": permalink}
    item = models.new_item(
        source=source,
        source_id=source_id,
        kind="post" if source == "reddit" else "video",
        metadata=md,
    )
    db.merge_upsert(conn, item)
    return item


def _auth(conn, cookie="c", modhash="m"):
    set_auth(conn, session_cookie=cookie, modhash=modhash)


# ---------- (a) success ----------

def test_hydrate_success(conn):
    _seed(conn, permalink="/r/test/comments/h1/x/")
    _auth(conn)

    blob = [
        {"kind": "Listing", "data": {"children": [{"data": {"id": "h1"}}]}},
        {"kind": "Listing", "data": {"children": [
            {"data": {"id": "c1"}},
            {"data": {"id": "c2"}},
            {"data": {"id": "c3"}},
        ]}},
    ]
    captured = {}

    def fake_getf(url, *, session_cookie, user_agent):
        captured["url"] = url
        captured["session_cookie"] = session_cookie
        captured["user_agent"] = user_agent
        return blob

    res = hydrate_one(conn, "reddit:t3_h1", getf=fake_getf)
    assert res["status"] == "hydrated"
    assert res["fullname"] == "reddit:t3_h1"
    assert res["comments"] == 3
    assert captured["url"].endswith("/r/test/comments/h1/x/.json?raw_json=1")

    row = db.get_reddit_thread(conn, "reddit:t3_h1")
    assert row is not None
    assert json.loads(row["thread_json"]) == blob


# ---------- (b) not_found ----------

def test_hydrate_not_found(conn):
    _auth(conn)
    res = hydrate_one(conn, "reddit:t3_nope", getf=lambda *a, **kw: {})
    assert res["status"] == "not_found"
    assert res["fullname"] == "reddit:t3_nope"


# ---------- (c) no_permalink ----------

def test_hydrate_no_permalink(conn):
    _seed(conn, permalink=None)  # metadata={} → no permalink key
    _auth(conn)
    res = hydrate_one(conn, "reddit:t3_h1", getf=lambda *a, **kw: {})
    assert res["status"] == "no_permalink"
    assert res["fullname"] == "reddit:t3_h1"


def test_hydrate_no_permalink_non_reddit_source(conn):
    _seed(conn, source="youtube", source_id="yt1",
          permalink="/r/test/comments/h1/x/")
    _auth(conn)
    res = hydrate_one(conn, "youtube:yt1", getf=lambda *a, **kw: {})
    assert res["status"] == "no_permalink"
    assert res["fullname"] == "youtube:yt1"


# ---------- (d) auth_missing ----------

def test_hydrate_auth_missing(conn):
    _seed(conn, permalink="/r/test/comments/h1/x/")
    # no _auth(conn) here
    res = hydrate_one(conn, "reddit:t3_h1", getf=lambda *a, **kw: {})
    assert res["status"] == "auth_missing"
    assert res["fullname"] == "reddit:t3_h1"


# ---------- (e) auth_expired ----------

def test_hydrate_auth_expired(conn):
    _seed(conn, permalink="/r/test/comments/h1/x/")
    _auth(conn)
    res = hydrate_one(conn, "reddit:t3_h1", getf=lambda *a, **kw: {})
    assert res["status"] == "auth_expired"
    assert res["fullname"] == "reddit:t3_h1"


# ---------- (f) network_error ----------

def test_hydrate_network_error(conn):
    _seed(conn, permalink="/r/test/comments/h1/x/")
    _auth(conn)

    def boom(url, *, session_cookie, user_agent):
        raise RedditNetworkError("boom")

    res = hydrate_one(conn, "reddit:t3_h1", getf=boom)
    assert res["status"] == "network_error"
    assert res["fullname"] == "reddit:t3_h1"
    assert res["detail"] == "boom"


# ---------- (g) bad_shape ----------

def test_hydrate_bad_shape(conn):
    _seed(conn, permalink="/r/test/comments/h1/x/")
    _auth(conn)
    res = hydrate_one(
        conn, "reddit:t3_h1",
        getf=lambda *a, **kw: {"kind": "Listing"},
    )
    assert res["status"] == "bad_shape"
    assert res["fullname"] == "reddit:t3_h1"


# ---------- (h) endpoint ----------

@pytest.fixture
def tmp_db(tmp_path):
    path = str(tmp_path / "t.db")
    c = db.connect(path)
    try:
        yield path, c
    finally:
        c.close()


def test_endpoint_hydrate_success(tmp_db):
    import content_hoarder.reddit_hydrate as rh
    path, c = tmp_db
    _seed(c, permalink="/r/test/comments/h1/x/")
    _auth(c)
    c.commit()

    blob = [
        {"kind": "Listing", "data": {"children": [{"data": {"id": "h1"}}]}},
        {"kind": "Listing", "data": {"children": [{"data": {"id": "c1"}}]}},
    ]
    orig = rh._http_get
    rh._http_get = lambda url, *, session_cookie, user_agent: blob
    try:
        app = web.create_app(path)
        rv = app.test_client().post("/reddit/items/reddit:t3_h1/hydrate")
        assert rv.status_code == 200
        body = rv.get_json()
        assert body["status"] == "hydrated"
        assert body["fullname"] == "reddit:t3_h1"
        assert body["comments"] == 1
    finally:
        rh._http_get = orig


def test_endpoint_hydrate_not_found(tmp_db):
    path, _c = tmp_db
    app = web.create_app(path)
    rv = app.test_client().post("/reddit/items/reddit:nope/hydrate")
    assert rv.status_code == 404
    body = rv.get_json()
    assert body["status"] == "not_found"
    assert body["fullname"] == "reddit:nope"
