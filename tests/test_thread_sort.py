"""Tests for comment sort (best/top/new) in Reddit thread view."""
from __future__ import annotations

import json

import pytest

from content_hoarder import db, reddit_thread
from content_hoarder.web import create_app


def _make_thread_blob() -> list:
    """Build a synthetic Reddit thread JSON blob for sort testing.

    Top-level comments (cached order):
      - alice: score=5, created_utc=100, with two replies
        - charlie: score=1, created_utc=300
        - dave:    score=7, created_utc=250
      - bob:   score=10, created_utc=200
    """
    return [
        {
            "kind": "Listing",
            "data": {
                "children": [
                    {
                        "kind": "t3",
                        "data": {
                            "title": "Test post",
                            "author": "op",
                            "selftext": "body",
                            "subreddit": "test",
                            "permalink": "/r/test/comments/abc/test_post/",
                            "score": 42,
                            "url": "https://example.com",
                            "created_utc": 1000,
                        },
                    }
                ]
            },
        },
        {
            "kind": "Listing",
            "data": {
                "children": [
                    {
                        "kind": "t1",
                        "data": {
                            "author": "alice",
                            "body": "score 5, created 100",
                            "score": 5,
                            "created_utc": 100,
                            "permalink": "/r/test/comments/abc/c1/",
                            "replies": {
                                "kind": "Listing",
                                "data": {
                                    "children": [
                                        {
                                            "kind": "t1",
                                            "data": {
                                                "author": "charlie",
                                                "body": "reply score 1, created 300",
                                                "score": 1,
                                                "created_utc": 300,
                                                "permalink": "/r/test/comments/abc/c1r1/",
                                                "replies": "",
                                            },
                                        },
                                        {
                                            "kind": "t1",
                                            "data": {
                                                "author": "dave",
                                                "body": "reply score 7, created 250",
                                                "score": 7,
                                                "created_utc": 250,
                                                "permalink": "/r/test/comments/abc/c1r2/",
                                                "replies": "",
                                            },
                                        },
                                    ]
                                },
                            },
                        },
                    },
                    {
                        "kind": "t1",
                        "data": {
                            "author": "bob",
                            "body": "score 10, created 200",
                            "score": 10,
                            "created_utc": 200,
                            "permalink": "/r/test/comments/abc/c2/",
                            "replies": "",
                        },
                    },
                ]
            },
        },
    ]


# ── parse_thread sort tests ───────────────────────────────────────────────


def test_best_preserves_cached_order():
    blob = json.dumps(_make_thread_blob())
    result = reddit_thread.parse_thread(blob, {"fullname": "t3_abc", "kind": "t3"}, sort="best")
    comments = result["comments"]
    assert [c["author"] for c in comments] == ["alice", "charlie", "dave", "bob"]
    assert result["sort"] == "best"


def test_top_sorts_by_score_desc_stable():
    blob = json.dumps(_make_thread_blob())
    result = reddit_thread.parse_thread(blob, {"fullname": "t3_abc", "kind": "t3"}, sort="top")
    comments = result["comments"]
    # Top-level siblings: bob(10) before alice(5)
    # Alice's replies: dave(7) before charlie(1)
    assert [c["author"] for c in comments] == ["bob", "alice", "dave", "charlie"]
    # Replies stay directly after their parent at depth 1
    assert comments[0]["depth"] == 0 and comments[0]["author"] == "bob"
    assert comments[1]["depth"] == 0 and comments[1]["author"] == "alice"
    assert comments[2]["depth"] == 1 and comments[2]["author"] == "dave"
    assert comments[3]["depth"] == 1 and comments[3]["author"] == "charlie"
    assert result["sort"] == "top"


def test_new_sorts_by_created_utc_desc():
    blob = json.dumps(_make_thread_blob())
    result = reddit_thread.parse_thread(blob, {"fullname": "t3_abc", "kind": "t3"}, sort="new")
    comments = result["comments"]
    # Top-level: bob(200) before alice(100)
    # Alice's replies: charlie(300) before dave(250)
    assert [c["author"] for c in comments] == ["bob", "alice", "charlie", "dave"]
    assert comments[0]["depth"] == 0
    assert comments[1]["depth"] == 0
    assert comments[2]["depth"] == 1
    assert comments[3]["depth"] == 1
    assert result["sort"] == "new"


def test_comments_carry_created_utc():
    blob = json.dumps(_make_thread_blob())
    result = reddit_thread.parse_thread(blob, {"fullname": "t3_abc", "kind": "t3"})
    for c in result["comments"]:
        assert "created_utc" in c
        assert isinstance(c["created_utc"], int)


# ── Route sort tests ──────────────────────────────────────────────────────


def _seed_db(db_path, fullname):
    """Insert an item + cached thread into the DB at *db_path*."""
    connection = db.connect(str(db_path))
    try:
        from content_hoarder import models as _m; db.merge_upsert(connection, _m.new_item(source="reddit", source_id=fullname.split(":", 1)[1], kind="post", metadata={"subreddit": "test"}))
        db.set_reddit_thread(connection, fullname, json.dumps(_make_thread_blob()))
    finally:
        connection.close()


def test_route_sort_top(tmp_path):
    db_path = tmp_path / "t.db"
    fullname = "reddit:t3_sorttop"
    app = create_app(str(db_path))
    client = app.test_client()
    _seed_db(db_path, fullname)

    resp = client.get(f"/reddit/items/{fullname}/thread?sort=top")
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["sort"] == "top"


def test_route_sort_garbage_coerces_to_best(tmp_path):
    db_path = tmp_path / "t.db"
    fullname = "reddit:t3_sortgarbage"
    app = create_app(str(db_path))
    client = app.test_client()
    _seed_db(db_path, fullname)

    resp = client.get(f"/reddit/items/{fullname}/thread?sort=garbage")
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["sort"] == "best"


def test_route_sort_default_is_best(tmp_path):
    db_path = tmp_path / "t.db"
    fullname = "reddit:t3_sortdefault"
    app = create_app(str(db_path))
    client = app.test_client()
    _seed_db(db_path, fullname)

    resp = client.get(f"/reddit/items/{fullname}/thread")
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["sort"] == "best"
