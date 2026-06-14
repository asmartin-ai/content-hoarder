"""Tests for offline local-archive Reddit hydration (BDFR JSON -> reddit_threads).

No network: builds a tiny synthetic BDFR archive and verifies the converter produces
the exact ``[post-listing, comments-listing]`` shape ``reddit_thread.parse_thread``
consumes, and that ``hydrate_from_archive`` caches it for existing items only.
"""

import json

from content_hoarder import db, models, reddit_hydrate
from content_hoarder.reddit_thread import get_thread, parse_thread


# ---------- helpers ----------

def _bdfr_submission(sid="13lityl", *, title="rule", selftext="", subreddit=None,
                     comments=None):
    return {
        "title": title, "name": f"t3_{sid}", "id": sid,
        "url": "https://i.redd.it/x.jpg", "selftext": selftext, "score": 5369,
        "permalink": f"/r/19684/comments/{sid}/rule/", "author": "alice",
        "subreddit": subreddit, "created_utc": 1684464320.0,
        "comments": comments if comments is not None else [],
    }


def _bdfr_comment(cid, body, *, author="bob", score=1, replies=None):
    return {
        "author": author, "id": cid, "score": score, "body": body,
        "subreddit": "19684", "submission": "13lityl",
        "parent_id": "t3_13lityl", "created_utc": 1684464321.0,
        "replies": replies if replies is not None else [],
    }


def _seed_item(conn, sid="13lityl"):
    item = models.new_item(source="reddit", source_id=f"t3_{sid}", kind="post",
                           metadata={"permalink": f"/r/19684/comments/{sid}/rule/"})
    db.merge_upsert(conn, item)
    return item


def _write_archive(tmp_path, submissions):
    root = tmp_path / "bdfr"
    for sub in submissions:
        d = root / (sub.get("subreddit") or "19684")
        d.mkdir(parents=True, exist_ok=True)
        (d / f"{sub['id']}.json").write_text(json.dumps(sub), encoding="utf-8")
    return str(root)


# ---------- converter shape ----------

def test_bdfr_to_listing_shape_round_trips_through_parse_thread():
    sub = _bdfr_submission(selftext="hello body", comments=[
        _bdfr_comment("c1", "top comment", replies=[
            _bdfr_comment("c1a", "a reply"),
        ]),
        _bdfr_comment("c2", "second comment"),
    ])
    listing = reddit_hydrate.bdfr_to_listing(sub)

    # exact Reddit-listing skeleton
    assert listing[0]["data"]["children"][0]["kind"] == "t3"
    post = listing[0]["data"]["children"][0]["data"]
    assert post["title"] == "rule"
    assert post["selftext"] == "hello body"
    assert post["subreddit"] == "19684"  # derived from permalink (BDFR top-level was None)

    parsed = parse_thread(json.dumps(listing), {"fullname": "reddit:t3_13lityl"})
    assert parsed["post"]["title"] == "rule"
    assert parsed["post"]["selftext"] == "hello body"
    bodies = [(c["body"], c["depth"]) for c in parsed["comments"]]
    assert ("top comment", 0) in bodies
    assert ("a reply", 1) in bodies      # nested reply flattened with depth
    assert ("second comment", 0) in bodies


def test_bdfr_comment_without_permalink_is_empty_not_crashing():
    sub = _bdfr_submission(comments=[_bdfr_comment("c1", "x")])
    parsed = parse_thread(json.dumps(reddit_hydrate.bdfr_to_listing(sub)),
                          {"fullname": "reddit:t3_13lityl"})
    assert parsed["comments"][0]["permalink"] == ""  # BDFR omits it; no exception


# ---------- hydrate_from_archive ----------

def test_hydrate_from_archive_caches_existing_and_is_readable(conn, tmp_path):
    _seed_item(conn, "13lityl")
    archive = _write_archive(tmp_path, [
        _bdfr_submission("13lityl", comments=[_bdfr_comment("c1", "hi")]),
    ])
    res = reddit_hydrate.hydrate_from_archive(conn, archive)
    assert res == {"files": 1, "hydrated": 1, "skipped_no_item": 0,
                   "skipped_bad": 0, "errors": 0}
    thread = get_thread(conn, "reddit:t3_13lityl")
    assert thread["cached"] is True
    assert thread["comments"][0]["body"] == "hi"


def test_hydrate_from_archive_skips_orphan_posts_by_default(conn, tmp_path):
    # item NOT seeded -> orphan; default only_existing skips it
    archive = _write_archive(tmp_path, [_bdfr_submission("orphan1")])
    res = reddit_hydrate.hydrate_from_archive(conn, archive)
    assert res["hydrated"] == 0 and res["skipped_no_item"] == 1
    # include_orphans path caches it anyway
    res2 = reddit_hydrate.hydrate_from_archive(conn, archive, only_existing=False)
    assert res2["hydrated"] == 1


def test_hydrate_from_archive_limit_caps_writes(conn, tmp_path):
    for sid in ("a1", "a2", "a3"):
        _seed_item(conn, sid)
    subs = [_bdfr_submission(sid) for sid in ("a1", "a2", "a3")]
    archive = _write_archive(tmp_path, subs)
    res = reddit_hydrate.hydrate_from_archive(conn, archive, limit=2)
    assert res["hydrated"] == 2


def test_hydrate_from_archive_is_idempotent(conn, tmp_path):
    _seed_item(conn, "13lityl")
    archive = _write_archive(tmp_path, [_bdfr_submission("13lityl")])
    reddit_hydrate.hydrate_from_archive(conn, archive)
    reddit_hydrate.hydrate_from_archive(conn, archive)  # second run must not error/dup
    rows = conn.execute(
        "SELECT COUNT(*) FROM reddit_threads WHERE fullname=?", ("reddit:t3_13lityl",)
    ).fetchone()[0]
    assert rows == 1


def test_hydrate_from_archive_tolerates_bad_json(conn, tmp_path):
    _seed_item(conn, "good1")
    root = tmp_path / "bdfr"
    (root / "19684").mkdir(parents=True)
    (root / "19684" / "good1.json").write_text(
        json.dumps(_bdfr_submission("good1")), encoding="utf-8")
    (root / "19684" / "broken.json").write_text("{not json", encoding="utf-8")
    res = reddit_hydrate.hydrate_from_archive(conn, str(root))
    assert res["hydrated"] == 1 and res["errors"] == 1
