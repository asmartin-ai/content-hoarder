"""Reddit video thumbnails: sync-time capture, offline backfill, metadata patch.

The submission poster (preview.images[0].source.url) the initial sync dropped is
captured at sync (child_to_item), lazily on hydrate, and via a zero-network offline
pass over already-cached thread blobs (reddit_hydrate.backfill_thumbnails).
"""

import json

from content_hoarder import db, reddit_hydrate
from content_hoarder.connectors.reddit import child_to_item, preview_thumb


def _md(item):
    m = item["metadata"]
    return m if isinstance(m, dict) else json.loads(m or "{}")


def _video_child(sid, *, preview=None):
    data = {"name": sid, "title": "V", "subreddit": "x", "url": "https://v.redd.it/" + sid[3:],
            "permalink": "/r/x/comments/" + sid[3:] + "/t/"}
    if preview is not None:
        data["preview"] = {"images": [{"source": {"url": preview}}]}
    return {"kind": "t3", "data": data}


# ---- preview_thumb (pure) ----

def test_preview_thumb_prefers_preview_image_and_unescapes():
    rec = {"preview": {"images": [{"source": {"url": "https://preview.redd.it/x.png?w=1&amp;s=ab"}}]},
           "thumbnail": "https://b.thumbs.redditmedia.com/y.jpg"}
    assert preview_thumb(rec) == "https://preview.redd.it/x.png?w=1&s=ab"


def test_preview_thumb_falls_back_to_thumbnail_field():
    assert preview_thumb({"thumbnail": "https://b.thumbs.redditmedia.com/y.jpg"}) == \
        "https://b.thumbs.redditmedia.com/y.jpg"


def test_preview_thumb_skips_sentinels_and_empty():
    assert preview_thumb({"thumbnail": "default"}) == ""
    assert preview_thumb({"thumbnail": "self"}) == ""
    assert preview_thumb({}) == ""
    assert preview_thumb(None) == ""


# ---- sync-time capture ----

def test_child_to_item_captures_video_poster():
    it = child_to_item(_video_child("t3_abc", preview="https://preview.redd.it/p.jpg"))
    md = _md(it)
    assert md["thumbnail"] == "https://preview.redd.it/p.jpg"
    assert md["media_type"] == "reddit_video"


def test_child_to_item_no_preview_no_thumbnail():
    assert "thumbnail" not in _md(child_to_item(_video_child("t3_abc")))


# ---- patch_item_metadata (no last_seen bump, only_if_missing) ----

def test_patch_item_metadata_only_if_missing(conn):
    db.merge_upsert(conn, child_to_item(_video_child("t3_v")))
    fn = "reddit:t3_v"
    before = db.get_item(conn, fn)["last_seen_utc"]
    assert db.patch_item_metadata(conn, fn, {"thumbnail": "https://preview.redd.it/a.jpg"},
                                  only_if_missing=True) is True
    after = db.get_item(conn, fn)
    assert _md(after)["thumbnail"] == "https://preview.redd.it/a.jpg"
    assert after["last_seen_utc"] == before  # feed order untouched
    # second call must not overwrite an existing thumbnail
    assert db.patch_item_metadata(conn, fn, {"thumbnail": "https://other.jpg"},
                                  only_if_missing=True) is False


# ---- offline backfill from cached thread blobs ----

def test_backfill_thumbnails_from_cached_thread(conn):
    db.merge_upsert(conn, child_to_item(_video_child("t3_v2")))  # no thumbnail at sync
    fn = "reddit:t3_v2"
    blob = [
        {"data": {"children": [{"data": {"preview": {"images": [
            {"source": {"url": "https://preview.redd.it/poster.jpg"}}]}}}]}},
        {"data": {"children": []}},
    ]
    db.set_reddit_thread(conn, fn, json.dumps(blob))

    dry = reddit_hydrate.backfill_thumbnails(conn, apply=False)
    assert dry["eligible"] == 1 and dry["patched"] == 0
    assert not _md(db.get_item(conn, fn)).get("thumbnail")

    live = reddit_hydrate.backfill_thumbnails(conn, apply=True)
    assert live["patched"] == 1
    assert _md(db.get_item(conn, fn))["thumbnail"] == "https://preview.redd.it/poster.jpg"


def test_backfill_skips_item_that_already_has_thumbnail(conn):
    db.merge_upsert(conn, child_to_item(_video_child("t3_v3", preview="https://preview.redd.it/have.jpg")))
    fn = "reddit:t3_v3"
    blob = [{"data": {"children": [{"data": {"preview": {"images": [
        {"source": {"url": "https://preview.redd.it/other.jpg"}}]}}}]}}, {"data": {"children": []}}]
    db.set_reddit_thread(conn, fn, json.dumps(blob))
    res = reddit_hydrate.backfill_thumbnails(conn, apply=True)
    assert res["patched"] == 0  # already had one (from sync) → not overwritten
    assert _md(db.get_item(conn, fn))["thumbnail"] == "https://preview.redd.it/have.jpg"
