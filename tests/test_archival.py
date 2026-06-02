import json

from content_hoarder import db, models
from content_hoarder.archival import service as archival
from content_hoarder.archival.providers import ArcticShiftProvider, PullPushProvider


def _seed_removed(conn):
    db.merge_upsert(conn, models.new_item(
        source="reddit", source_id="t3_aaa", kind="post",
        title="[removed]", body="[removed]", metadata={"permalink": "/r/x/comments/aaa/t/"}))
    db.merge_upsert(conn, models.new_item(
        source="reddit", source_id="t1_bbb", kind="comment",
        body="", author="orig_author", metadata={"subreddit": "x"}))
    db.merge_upsert(conn, models.new_item(   # a normal item that should NOT be targeted
        source="reddit", source_id="t3_ccc", kind="post", title="Fine", body="has text"))
    conn.commit()


def _fake_json(post_recs=None, comment_recs=None):
    def gj(url, ua, timeout=20.0):
        if "submission" in url or "/posts/" in url:
            return 200, {}, {"data": post_recs or []}
        return 200, {}, {"data": comment_recs or []}
    return gj


def test_recover_overlays_and_preserves_triage(tmp_db):
    conn = db.connect(tmp_db)
    _seed_removed(conn)
    db.set_status(conn, "reddit:t1_bbb", "keep")  # prove triage survives recovery

    prov = PullPushProvider("ua", min_interval=0.0, get_json=_fake_json(
        post_recs=[{"id": "aaa", "title": "Real Title", "selftext": "Real body",
                    "author": "alice", "subreddit": "x", "created_utc": 1600000000, "score": 5}],
        comment_recs=[{"id": "bbb", "body": "Recovered comment", "author": "bob",
                       "subreddit": "x", "created_utc": 1600000001}]))
    res = archival.recover(conn, providers=[prov])
    assert res["selected"] == 2 and res["recovered"] == 2 and res["missed"] == 0

    post = db.get_item(conn, "reddit:t3_aaa")
    assert post["title"] == "Real Title" and post["body"] == "Real body"
    assert post["author"] == "alice" and post["hydrated_at"]
    assert json.loads(post["metadata"]).get("score") == 5

    comment = db.get_item(conn, "reddit:t1_bbb")
    assert comment["body"] == "Recovered comment"
    assert comment["status"] == "keep"      # triage state preserved
    assert comment["hydrated_at"]


def test_placeholder_falls_through_to_next_provider(tmp_db):
    conn = db.connect(tmp_db)
    _seed_removed(conn)
    pp = PullPushProvider("ua", min_interval=0.0, get_json=_fake_json(
        post_recs=[{"id": "aaa", "title": "[removed]", "selftext": "[removed]"}]))
    ar = ArcticShiftProvider("ua", min_interval=0.0, get_json=_fake_json(
        post_recs=[{"id": "aaa", "title": "Arctic Title", "selftext": "Arctic body"}]))
    res = archival.recover(conn, providers=[pp, ar])
    assert db.get_item(conn, "reddit:t3_aaa")["title"] == "Arctic Title"
    assert res["by_provider"].get("arctic", 0) >= 1


def test_targets_include_admin_removed(tmp_db):
    conn = db.connect(tmp_db)
    db.merge_upsert(conn, models.new_item(source="reddit", source_id="t3_adm", kind="post",
                    title="Some title", body="[ Removed by reddit on account of violating the content policy ]"))
    db.merge_upsert(conn, models.new_item(source="reddit", source_id="t3_du", kind="post",
                    title="Deleted by user", body=""))
    conn.commit()
    assert archival.count_targets(conn) == 2


def test_recover_no_targets(tmp_db):
    conn = db.connect(tmp_db)
    db.merge_upsert(conn, models.new_item(source="reddit", source_id="t3_ok", kind="post",
                    title="Fine", body="text"))
    conn.commit()
    assert archival.recover(conn, providers=[])["selected"] == 0


def test_recover_marks_attempted_so_rerun_skips(tmp_db):
    conn = db.connect(tmp_db)
    _seed_removed(conn)
    none_prov = PullPushProvider("ua", min_interval=0.0, get_json=_fake_json([], []))
    r1 = archival.recover(conn, providers=[none_prov])
    assert r1["selected"] == 2 and r1["recovered"] == 0
    assert archival.recover(conn, providers=[none_prov])["selected"] == 0  # all hydrated now


def test_recover_one(tmp_db):
    conn = db.connect(tmp_db)
    db.merge_upsert(conn, models.new_item(source="reddit", source_id="t3_zz", kind="post",
                    title="[removed]", body="[removed]", metadata={"permalink": "/r/x/comments/zz/t/"}))
    conn.commit()
    prov = PullPushProvider("ua", min_interval=0.0, get_json=_fake_json(
        post_recs=[{"id": "zz", "title": "Got it back", "selftext": "Recovered body"}]))
    res = archival.recover_one(conn, "reddit:t3_zz", providers=[prov])
    assert res["recovered"] is True and res["title"] == "Got it back"
    assert db.get_item(conn, "reddit:t3_zz")["body"] == "Recovered body"
    assert archival.recover_one(conn, "reddit:t3_missing") is None  # not in DB


def test_provider_url_construction():
    pp = PullPushProvider("ua")
    assert pp._ids_url("posts", ["abc"]) == "https://api.pullpush.io/reddit/search/submission/?ids=abc"
    assert pp._ids_url("comments", ["xy"]) == "https://api.pullpush.io/reddit/search/comment/?ids=xy"
    ar = ArcticShiftProvider("ua")
    assert ar._ids_url("posts", ["abc"]) == "https://arctic-shift.photon-reddit.com/api/posts/ids?ids=abc"
