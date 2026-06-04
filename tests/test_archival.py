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


def test_scope_all_targets_every_reddit_item(tmp_db):
    conn = db.connect(tmp_db)
    db.merge_upsert(conn, models.new_item(source="reddit", source_id="t3_norm", kind="post",
                    title="Normal post", body="has content"))
    conn.commit()
    assert archival.count_targets(conn, scope="removed") == 0   # has content, not a target
    assert archival.count_targets(conn, scope="all") == 1       # --scores hydrates it anyway


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


def test_norm_post_extracts_media():
    from content_hoarder.archival.providers import _norm_post
    img = _norm_post({"post_hint": "image", "thumbnail": "https://b.thumbs.redditmedia.com/t.jpg",
                      "preview": {"images": [{"source": {"url": "https://preview.redd.it/x.png?s=1&amp;a=2"}}]},
                      "url_overridden_by_dest": "https://i.redd.it/x.png"})
    assert img["media_type"] == "image"
    assert img["thumbnail"] == "https://preview.redd.it/x.png?s=1&a=2"   # &amp; unescaped
    assert img["media_url"] == "https://i.redd.it/x.png"
    vid = _norm_post({"is_video": True,
                      "media": {"reddit_video": {"fallback_url": "https://v.redd.it/v/DASH.mp4"}},
                      "url_overridden_by_dest": "https://v.redd.it/v"})
    assert vid["media_type"] == "reddit_video" and vid["media_url"] == "https://v.redd.it/v/DASH.mp4"
    gal = _norm_post({"is_gallery": True, "thumbnail": "https://b.thumbs.redditmedia.com/g.jpg",
                      "url_overridden_by_dest": "https://www.reddit.com/gallery/g"})
    assert gal["media_type"] == "gallery" and gal["thumbnail"].endswith("/g.jpg")
    assert gal["media_url"] == "https://www.reddit.com/gallery/g"
    # sentinel thumbnail with no preview → "", and a text post → no media_type (heuristic kept)
    txt = _norm_post({"is_self": True, "thumbnail": "self", "selftext": "hi"})
    assert txt["media_type"] == "" and txt["thumbnail"] == ""
    # an external rich embed (e.g. a YouTube link) is NOT reddit-hosted video → "" so the
    # connector's URL heuristic ("youtube") survives instead of being clobbered.
    ext = _norm_post({"post_hint": "rich:video", "is_video": False,
                      "url_overridden_by_dest": "https://www.youtube.com/watch?v=x"})
    assert ext["media_type"] == ""


def test_media_refinement_overrides_heuristic_and_keeps_video_url(tmp_db):
    conn = db.connect(tmp_db)
    # two media posts as the connector's URL-heuristic imported them: generic reddit_media,
    # permalink standing in as the click URL.
    for sid, perma in (("t3_img", "/r/x/comments/img/p/"), ("t3_vid", "/r/x/comments/vid/p/")):
        db.merge_upsert(conn, models.new_item(
            source="reddit", source_id=sid, kind="post", title="M",
            url="https://www.reddit.com" + perma,
            metadata={"permalink": perma, "media_type": "reddit_media"}))
    conn.commit()
    prov = PullPushProvider("ua", min_interval=0.0, get_json=_fake_json(post_recs=[
        {"id": "img", "title": "M", "post_hint": "image",
         "preview": {"images": [{"source": {"url": "https://preview.redd.it/x.png?s=1&amp;a=2"}}]},
         "url_overridden_by_dest": "https://i.redd.it/x.png", "url": "https://i.redd.it/x.png"},
        {"id": "vid", "title": "M", "is_video": True,
         "media": {"reddit_video": {"fallback_url": "https://v.redd.it/v/DASH.mp4"}},
         "thumbnail": "https://b.thumbs.redditmedia.com/v.jpg",
         "url_overridden_by_dest": "https://v.redd.it/v", "url": "https://v.redd.it/v"}]))
    archival.recover(conn, scope="all", providers=[prov])

    img = db.get_item(conn, "reddit:t3_img")
    imd = json.loads(img["metadata"])
    assert imd["media_type"] == "image"                       # reddit_media heuristic overridden
    assert imd["thumbnail"] == "https://preview.redd.it/x.png?s=1&a=2"
    assert imd["media_url"] == "https://i.redd.it/x.png"
    assert img["url"] == "https://i.redd.it/x.png"            # image URL is navigable → overwritten
    assert img["title"] == "M" and img["status"] == "inbox"  # overlay is non-destructive

    vid = db.get_item(conn, "reddit:t3_vid")
    vmd = json.loads(vid["metadata"])
    assert vmd["media_type"] == "reddit_video"
    assert vmd["media_url"] == "https://v.redd.it/v/DASH.mp4"
    assert vid["url"] == "https://www.reddit.com/r/x/comments/vid/p/"  # NOT clobbered to bare v.redd.it
