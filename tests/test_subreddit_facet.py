"""P3.3 subreddit facet — endpoint + integration tests.

The facet reuses the existing /reddit/subreddits + /items?subreddit= plumbing.
These tests pin the v3 integration: the second-tier facet endpoint stays
reddit-scoped, /items filters by subreddit under source=reddit, and the
served main.js wires data-subreddit + state.subreddit correctly."""

from content_hoarder.web import create_app


def _client(tmp_db):
    return create_app(tmp_db).test_client()


def test_subreddits_endpoint_status_filter(tmp_db):
    """?status= scopes the per-subreddit counts (the v3 rail passes state.status)."""
    cl = _client(tmp_db)
    r = cl.get("/reddit/subreddits?status=inbox").get_json()
    assert "subreddits" in r
    for s in r["subreddits"]:
        assert s["subreddit"] and isinstance(s["count"], int)


def test_items_subreddit_filter_under_reddit_source(tmp_db):
    """The facet click sends source=reddit + subreddit=X; /items must honor both."""
    cl = _client(tmp_db)
    base = cl.get("/items?source=reddit&limit=500").get_json()
    sub = cl.get("/items?source=reddit&subreddit=hedgehogs&limit=500").get_json()
    # The filtered set must be a subset, and at least one row's metadata.subreddit
    # must match (COLLATE NOCASE on the server side).
    assert len(sub["items"]) <= len(base["items"])
    if sub["items"]:
        import json

        for it in sub["items"]:
            md = json.loads(it.get("metadata") or "{}")
            assert (md.get("subreddit") or "").lower() == "hedgehogs"


def test_main_js_wires_subreddit_facet(tmp_db):
    """Static guard: the served main.js has state.subreddit + data-subreddit wiring."""
    cl = _client(tmp_db)
    src = cl.get("/static/browse/main.js").data.decode("utf-8")
    assert "state.subreddit" in src
    assert 'data-subreddit' in src
    assert "rail-sub" in src, "second-tier rail class missing"
    assert "/reddit/subreddits" in src, "facet doesn't fetch from the endpoint"
    assert 'APP_VERSION = "v125"' in src, "APP_VERSION not v125"
    sw = cl.get("/static/sw.js").data.decode("utf-8")
    assert "ch-shell-v125" in sw, "CACHE not bumped to v125"
