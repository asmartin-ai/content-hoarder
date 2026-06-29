import json

from content_hoarder import db, models
from content_hoarder.web import create_app

# A minimal two-listing thread blob: [post listing, comment listing].
THREAD = json.dumps([
    {"data": {"children": [{"kind": "t3", "data": {
        "title": "Hello", "author": "op", "selftext": "body text",
        "subreddit": "hedgehogs", "permalink": "/r/hedgehogs/comments/a/hello/",
        "score": 42, "url": "http://x", "created_utc": 1000}}]}},
    {"data": {"children": [
        {"kind": "t1", "data": {
            "author": "c1", "body": "top", "score": 5,
            "permalink": "/r/hedgehogs/comments/a/hello/c1/",
            "replies": {"data": {"children": [
                {"kind": "t1", "data": {"author": "c2", "body": "reply",
                                        "score": 2, "permalink": "/x"}},
            ]}}}},
        {"kind": "more", "data": {}},   # must be skipped
    ]}},
])


def _seed(dbp):
    c = db.connect(dbp)
    db.merge_upsert(c, models.new_item(source="reddit", source_id="t3_a", kind="post",
                    title="Hedgehog", author="op", url="http://r/a",
                    metadata={"subreddit": "hedgehogs", "score": 42, "over_18": 1}))
    db.merge_upsert(c, models.new_item(source="reddit", source_id="t3_b", kind="post",
                    title="Other", url="http://r/b", metadata={"subreddit": "aww", "score": 3}))
    db.merge_upsert(c, models.new_item(source="youtube", source_id="v1", kind="video", title="Vid"))
    db.set_reddit_thread(c, "reddit:t3_a", THREAD, 123)
    c.commit()
    c.close()


def _client(tmp_db):
    _seed(tmp_db)
    return create_app(tmp_db).test_client()


def test_subreddit_filter_case_insensitive(conn):
    db.merge_upsert(conn, models.new_item(source="reddit", source_id="t3_a", kind="post",
                    title="A", metadata={"subreddit": "hh"}))
    db.merge_upsert(conn, models.new_item(source="reddit", source_id="t3_b", kind="post",
                    title="B", metadata={"subreddit": "aww"}))
    conn.commit()
    assert [r["fullname"] for r in db.search_items(conn, source="reddit", subreddit="hh")] == ["reddit:t3_a"]
    assert db.search_items(conn, source="reddit", subreddit="HH")  # COLLATE NOCASE


def test_reddit_items_flat_shape(tmp_db):
    r = _client(tmp_db).get("/reddit/items?subreddit=hedgehogs").get_json()
    it = r["items"][0]
    assert it["subreddit"] == "hedgehogs" and it["score"] == 42 and it["over_18"] == 1
    assert it["fullname"] == "reddit:t3_a" and it["reddit_id"] == "t3_a"


def test_subreddit_counts_and_stats(tmp_db):
    cl = _client(tmp_db)
    names = {s["subreddit"] for s in cl.get("/reddit/subreddits").get_json()["subreddits"]}
    assert {"hedgehogs", "aww"} <= names
    st = cl.get("/reddit/stats").get_json()
    assert st["nsfw"] == 1
    assert st["by_kind"].get("post") == 2
    assert any(s["subreddit"] == "hedgehogs" for s in st["top_subreddits"])


def test_thread_parse_and_route(tmp_db):
    cl = _client(tmp_db)
    res = cl.get("/reddit/items/reddit:t3_a/thread").get_json()
    assert res["cached"] is True
    assert res["post"]["title"] == "Hello" and res["post"]["score"] == 42
    assert [c["depth"] for c in res["comments"]] == [0, 1]  # tree flattened, 'more' skipped
    assert cl.get("/reddit/items/reddit:t3_b/thread").get_json()["cached"] is False
    assert cl.get("/reddit/items/reddit:t3_zzz/thread").status_code == 404


def test_reddit_page_renders(tmp_db):
    r = _client(tmp_db).get("/reddit")
    assert r.status_code == 200 and b"/static/reddit.js" in r.data
    assert b"Local queue only; drain contacts Reddit." in r.data


def test_unsave_enqueues(tmp_db):
    cl = _client(tmp_db)
    res = cl.post("/reddit/items/reddit:t3_a/unsave").get_json()
    assert res["queued"] is True and res["is_saved"] == 0
    c = db.connect(tmp_db)
    n = c.execute("SELECT COUNT(*) FROM reddit_unsave WHERE state='pending'").fetchone()[0]
    saved = c.execute("SELECT is_saved FROM items WHERE fullname='reddit:t3_a'").fetchone()[0]
    c.close()
    assert n == 1
    assert saved == 0  # optimistically flipped so the UI toggles to its Undo state


def test_unsave_by_tag_route_previews_then_confirms(tmp_db):
    tag = "nsfw_erotic"
    _seed(tmp_db)
    c = db.connect(tmp_db)
    db.merge_upsert(c, models.new_item(
        source="reddit", source_id="t3_tagged", kind="post",
        title="Tagged", url="http://r/tagged",
        metadata={"tags": [tag]},
    ))
    c.commit()
    c.close()

    cl = create_app(tmp_db).test_client()
    preview = cl.post("/reddit/unsave/enqueue-by-tag", json={"tag": tag}).get_json()
    assert preview["dry_run"] is True
    assert preview["confirmed"] is False
    assert preview["eligible"] == 1
    assert preview["enqueued"] == 0
    assert preview["sample"][0]["fullname"] == "reddit:t3_tagged"
    assert "only queues local unsaves" in preview["message"]

    c = db.connect(tmp_db)
    assert c.execute("SELECT COUNT(*) FROM reddit_unsave").fetchone()[0] == 0
    c.close()

    dry_run_false = cl.post(
        "/reddit/unsave/enqueue-by-tag",
        json={"tag": tag, "dry_run": False},
    ).get_json()
    assert dry_run_false["confirmed"] is False
    assert dry_run_false["enqueued"] == 0

    c = db.connect(tmp_db)
    assert c.execute("SELECT COUNT(*) FROM reddit_unsave").fetchone()[0] == 0
    c.close()

    refused = cl.post(
        "/reddit/unsave/enqueue-by-tag",
        json={"tag": tag, "apply": True},
    )
    assert refused.status_code == 409
    assert refused.get_json()["confirmed"] is False

    applied = cl.post(
        "/reddit/unsave/enqueue-by-tag",
        json={"tag": tag, "apply": True, "yes": True},
    ).get_json()
    assert applied["confirmed"] is True
    assert applied["enqueued"] == 1

    c = db.connect(tmp_db)
    saved = c.execute("SELECT is_saved FROM items WHERE fullname='reddit:t3_tagged'").fetchone()[0]
    c.close()
    assert saved == 1

    again = cl.post(
        "/reddit/unsave/enqueue-by-tag",
        json={"tag": tag, "apply": True, "yes": True},
    ).get_json()
    assert again["enqueued"] == 0
    assert again["skipped"]["already_queued"] == 1


def test_undo_cancels_pending_unsave(tmp_db):
    """Undo of a still-pending (not yet drained) unsave cancels it locally — no Reddit call,
    the queue row is dropped, and is_saved is restored."""
    cl = _client(tmp_db)
    cl.post("/reddit/items/reddit:t3_a/unsave")
    res = cl.post("/reddit/items/reddit:t3_a/undo").get_json()
    assert res["undone"] is True and res["method"] == "dequeued" and res["is_saved"] == 1
    c = db.connect(tmp_db)
    pending = c.execute("SELECT COUNT(*) FROM reddit_unsave WHERE state='pending'").fetchone()[0]
    saved = c.execute("SELECT is_saved FROM items WHERE fullname='reddit:t3_a'").fetchone()[0]
    c.close()
    assert pending == 0 and saved == 1
