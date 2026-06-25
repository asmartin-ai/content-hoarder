"""Tests for HN comment-thread viewer backend (Task A — 09-devstral-batch).

All offline. Uses :memory: SQLite and injectable fetch seams.
"""

import json

import pytest

from content_hoarder import db, hn_thread, models
from content_hoarder.web import create_app


# -- Helpers --

def _seed_hn_item(conn, source_id="42", **kw):
    """Insert a hackernews item via models.new_item + merge_upsert."""
    kw.setdefault("source", "hackernews")
    kw.setdefault("source_id", source_id)
    kw.setdefault("kind", "story")
    kw.setdefault("title", f"HN item {source_id}")
    item = models.new_item(**kw)
    db.merge_upsert(conn, item)
    conn.commit()
    return f"hackernews:{source_id}"


def _algolia_story(story_id=42, title="Test Story", points=100,
                   created_at_i=1609459200, children=None):
    """Build a synthetic Algolia story dict."""
    return {
        "id": story_id,
        "title": title,
        "url": f"https://news.ycombinator.com/item?id={story_id}",
        "author": "pg",
        "points": points,
        "created_at_i": created_at_i,
        "type": "story",
        "children": children or [],
    }


def _algolia_comment(cid, author="user", text="comment text", points=5,
                     created_at_i=1609459300, children=None):
    """Build a synthetic Algolia comment dict."""
    return {
        "id": cid,
        "author": author,
        "text": text,
        "points": points,
        "created_at_i": created_at_i,
        "type": "comment",
        "children": children or [],
    }


# -- 1. parse_thread tests --

class TestParseThread:
    def test_basic_structure(self):
        """Root story + 2 comments (one nested) → correct post + comments shape."""
        tree = _algolia_story(story_id=42, title="Test Story", points=100,
                              created_at_i=1609459200,
                              children=[
                                  _algolia_comment(101, author="u2", text="First",
                                                   points=50, created_at_i=1609459300,
                                                   children=[
                                                       _algolia_comment(102, author="u3",
                                                                        text="Reply",
                                                                        points=25,
                                                                        created_at_i=1609459400),
                                                   ]),
                                  _algolia_comment(103, author="u4", text="Second",
                                                   points=30, created_at_i=1609459250),
                              ])
        item = {"fullname": "hackernews:42", "kind": "story", "title": "Fallback"}
        result = hn_thread.parse_thread(json.dumps(tree), item, sort="top")

        # Top-level keys match reddit_thread.parse_thread contract
        assert set(result.keys()) >= {"post", "comments", "cached",
                                       "item_fullname", "item_kind", "sort"}
        assert result["item_fullname"] == "hackernews:42"
        assert result["item_kind"] == "story"
        assert result["cached"] is True
        assert result["sort"] == "top"

        # Post
        assert result["post"]["title"] == "Test Story"
        assert result["post"]["points"] == 100
        assert result["post"]["created_utc"] == 1609459200

        # Comments sorted by points desc (top sort)
        comments = result["comments"]
        assert len(comments) == 2
        assert comments[0]["author"] == "u2"   # 50 points
        assert comments[1]["author"] == "u4"   # 30 points

        # Nested comment
        assert comments[0]["children"][0]["author"] == "u3"
        assert comments[0]["children"][0]["points"] == 25
        assert comments[0]["children"][0]["depth"] == 2

    def test_sort_new(self):
        """'new' sort orders by created_at_i descending."""
        tree = _algolia_story(children=[
            _algolia_comment(1, author="old", points=999, created_at_i=100),
            _algolia_comment(2, author="new", points=1, created_at_i=200),
        ])
        item = {"fullname": "hackernews:42", "kind": "story"}
        result = hn_thread.parse_thread(json.dumps(tree), item, sort="new")
        comments = result["comments"]
        assert comments[0]["author"] == "new"
        assert comments[1]["author"] == "old"

    def test_sort_default_preserves_order(self):
        """'default' sort preserves Algolia's given order."""
        tree = _algolia_story(children=[
            _algolia_comment(1, author="first", points=50, created_at_i=200),
            _algolia_comment(2, author="second", points=100, created_at_i=100),
        ])
        item = {"fullname": "hackernews:42", "kind": "story"}
        result = hn_thread.parse_thread(json.dumps(tree), item, sort="default")
        assert result["comments"][0]["author"] == "first"
        assert result["comments"][1]["author"] == "second"

    def test_sort_best_maps_to_top(self):
        """'best' maps to 'top' (HN has no native best sort)."""
        tree = _algolia_story(children=[
            _algolia_comment(1, author="low", points=10),
            _algolia_comment(2, author="high", points=100),
        ])
        item = {"fullname": "hackernews:42", "kind": "story"}
        result = hn_thread.parse_thread(json.dumps(tree), item, sort="best")
        assert result["sort"] == "best"  # requested sort preserved in output
        # But ordering is top (by points desc)
        assert result["comments"][0]["author"] == "high"

    def test_title_fallback(self):
        """When Algolia title is empty, falls back to item title."""
        tree = _algolia_story(title="")
        item = {"fullname": "hackernews:42", "kind": "story", "title": "Item Title"}
        result = hn_thread.parse_thread(json.dumps(tree), item)
        assert result["post"]["title"] == "Item Title"

    def test_invalid_json_returns_error_dict(self):
        """Invalid JSON → error dict (not None), matching reddit_thread convention."""
        item = {"fullname": "hackernews:42", "kind": "story"}
        result = hn_thread.parse_thread("not json", item)
        assert "error" in result
        assert result["item_fullname"] == "hackernews:42"

    def test_non_story_type_returns_error_dict(self):
        """Non-story Algolia response → error dict."""
        item = {"fullname": "hackernews:42", "kind": "story"}
        result = hn_thread.parse_thread(json.dumps({"type": "comment"}), item)
        assert "error" in result

    def test_created_at_i_used_not_iso_string(self):
        """created_utc comes from created_at_i (epoch), not the ISO created_at."""
        tree = _algolia_story(created_at_i=1609459200)
        tree["created_at"] = "2021-01-01T00:00:00Z"  # ISO string present but ignored
        item = {"fullname": "hackernews:42", "kind": "story"}
        result = hn_thread.parse_thread(json.dumps(tree), item)
        assert result["post"]["created_utc"] == 1609459200

    def test_nested_depth_tracking(self):
        """Depth increments correctly at each nesting level."""
        tree = _algolia_story(children=[
            _algolia_comment(1, children=[
                _algolia_comment(2, children=[
                    _algolia_comment(3),
                ]),
            ]),
        ])
        item = {"fullname": "hackernews:42", "kind": "story"}
        result = hn_thread.parse_thread(json.dumps(tree), item)
        assert result["comments"][0]["depth"] == 1
        assert result["comments"][0]["children"][0]["depth"] == 2
        assert result["comments"][0]["children"][0]["children"][0]["depth"] == 3


# -- 2. hydrate + cache tests --

class TestHydrateAndCache:
    def test_hydrate_writes_cache_and_returns_hydrated(self, conn):
        """First call hydrates, writes to reddit_threads, returns 'hydrated'."""
        fn = _seed_hn_item(conn, "42")
        fake_json = json.dumps(_algolia_story(story_id=42))
        fetch_calls = []

        def fake_fetch(url):
            fetch_calls.append(url)
            return fake_json

        result = hn_thread.hydrate_if_missing(conn, fn, fetch=fake_fetch)
        assert result["status"] == "hydrated"
        assert len(fetch_calls) == 1
        assert "42" in fetch_calls[0]  # URL contains the source_id

        # Verify the cache was actually written
        cached = db.get_reddit_thread(conn, fn)
        assert cached is not None
        assert cached["thread_json"] is not None

    def test_second_call_returns_cached_no_fetch(self, conn):
        """Second call returns 'cached' and does NOT call fetch."""
        fn = _seed_hn_item(conn, "42")
        fetch_calls = []

        def fake_fetch(url):
            fetch_calls.append(url)
            return json.dumps(_algolia_story(story_id=42))

        r1 = hn_thread.hydrate_if_missing(conn, fn, fetch=fake_fetch)
        assert r1["status"] == "hydrated"
        assert len(fetch_calls) == 1

        r2 = hn_thread.hydrate_if_missing(conn, fn, fetch=fake_fetch)
        assert r2["status"] == "cached"
        assert len(fetch_calls) == 1  # no additional fetch

    def test_hydrate_not_found(self, conn):
        """fetch returning None → status 'not_found'."""
        fn = _seed_hn_item(conn, "99")
        result = hn_thread.hydrate_if_missing(conn, fn, fetch=lambda _url: None)
        assert result["status"] == "not_found"

    def test_hydrate_non_story_response(self, conn):
        """Algolia returns a non-story response → 'not_found'."""
        fn = _seed_hn_item(conn, "42")
        result = hn_thread.hydrate_if_missing(
            conn, fn, fetch=lambda _url: json.dumps({"type": "comment", "id": 42}))
        assert result["status"] == "not_found"

    def test_hydrate_invalid_json(self, conn):
        """Algolia returns garbage → 'error'."""
        fn = _seed_hn_item(conn, "42")
        result = hn_thread.hydrate_if_missing(
            conn, fn, fetch=lambda _url: "not json at all")
        assert result["status"] == "error"
        assert "message" in result

    def test_hydrate_fetch_exception(self, conn):
        """fetch raising → 'error' (soft miss, no crash)."""
        fn = _seed_hn_item(conn, "42")

        def bad_fetch(_url):
            raise RuntimeError("network down")

        result = hn_thread.hydrate_if_missing(conn, fn, fetch=bad_fetch)
        assert result["status"] == "error"

    def test_hydrate_invalid_fullname(self, conn):
        """Malformed fullname → 'error'."""
        result = hn_thread.hydrate_if_missing(conn, "bogus", fetch=lambda _u: "{}")
        assert result["status"] == "error"


# -- 3. get_thread tests --

class TestGetThread:
    def test_cached_thread(self, conn):
        """Cached thread → parsed result with cached=True."""
        fn = _seed_hn_item(conn, "42")
        db.set_reddit_thread(conn, fn, json.dumps(_algolia_story(story_id=42)))
        result = hn_thread.get_thread(conn, fn)
        assert result is not None
        assert result["cached"] is True
        assert result["post"]["title"] == "Test Story"

    def test_item_exists_no_cache(self, conn):
        """Item exists but no cached thread → cached=False (not None)."""
        fn = _seed_hn_item(conn, "42")
        result = hn_thread.get_thread(conn, fn)
        assert result is not None
        assert result["cached"] is False
        assert result["comments"] == []
        assert result["post"] == {}
        assert result["item_fullname"] == fn

    def test_item_not_found(self, conn):
        """Item doesn't exist → None."""
        result = hn_thread.get_thread(conn, "hackernews:nonexistent")
        assert result is None


# -- 4. Route test --

class TestHnThreadRoute:
    def test_route_returns_200_with_thread(self, tmp_db):
        """GET /hackernews/items/<fn>/thread returns parsed thread JSON."""
        c = db.connect(tmp_db)
        fn = f"hackernews:42"
        db.merge_upsert(c, models.new_item(source="hackernews", source_id="42",
                                            kind="story", title="HN Story"))
        c.commit()
        c.close()

        client = create_app(tmp_db).test_client()

        # Pre-cache a thread so the route can serve it
        c2 = db.connect(tmp_db)
        db.set_reddit_thread(c2, fn, json.dumps(_algolia_story(story_id=42)))
        c2.commit()
        c2.close()

        resp = client.get(f"/hackernews/items/{fn}/thread?nofetch=1")
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["post"]["title"] == "Test Story"
        assert data["item_fullname"] == fn

    def test_route_404_for_unknown_item(self, tmp_db):
        """GET /hackernews/items/<fn>/thread → 404 for nonexistent item."""
        client = create_app(tmp_db).test_client()
        resp = client.get("/hackernews/items/hackernews:nope/thread?nofetch=1")
        assert resp.status_code == 404

    def test_route_sort_param(self, tmp_db):
        """?sort=new is accepted and propagated."""
        c = db.connect(tmp_db)
        fn = "hackernews:42"
        db.merge_upsert(c, models.new_item(source="hackernews", source_id="42",
                                            kind="story", title="HN Story"))
        db.set_reddit_thread(c, fn, json.dumps(_algolia_story(story_id=42)))
        c.commit()
        c.close()

        client = create_app(tmp_db).test_client()
        resp = client.get(f"/hackernews/items/{fn}/thread?sort=new&nofetch=1")
        assert resp.status_code == 200
        assert resp.get_json()["sort"] == "new"

    def test_route_invalid_sort_defaults_to_top(self, tmp_db):
        """Invalid sort value → defaults to 'top'."""
        c = db.connect(tmp_db)
        fn = "hackernews:42"
        db.merge_upsert(c, models.new_item(source="hackernews", source_id="42",
                                            kind="story", title="HN Story"))
        db.set_reddit_thread(c, fn, json.dumps(_algolia_story(story_id=42)))
        c.commit()
        c.close()

        client = create_app(tmp_db).test_client()
        resp = client.get(f"/hackernews/items/{fn}/thread?sort=invalid&nofetch=1")
        assert resp.status_code == 200
        assert resp.get_json()["sort"] == "top"

    def test_route_hydrate_status_attached(self, tmp_db):
        """When nofetch is not set, hydrate_if_missing runs and attach hydrate_status."""
        c = db.connect(tmp_db)
        fn = "hackernews:42"
        db.merge_upsert(c, models.new_item(source="hackernews", source_id="42",
                                            kind="story", title="HN Story"))
        c.commit()
        c.close()

        client = create_app(tmp_db).test_client()

        # Monkeypatch hydrate_if_missing to return a controlled result
        import unittest.mock
        with unittest.mock.patch("content_hoarder.hn_thread.hydrate_if_missing",
                                  return_value={"status": "hydrated"}):
            # Pre-cache so get_thread finds something
            c2 = db.connect(tmp_db)
            db.set_reddit_thread(c2, fn, json.dumps(_algolia_story(story_id=42)))
            c2.commit()
            c2.close()

            resp = client.get(f"/hackernews/items/{fn}/thread")
            assert resp.status_code == 200
            assert resp.get_json()["hydrate_status"] == "hydrated"
