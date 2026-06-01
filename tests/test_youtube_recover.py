import json

from content_hoarder import db, models
from content_hoarder.youtube_recover import _extract_title, recover_title, recover_titles

_AVAIL = json.dumps({"archived_snapshots": {"closest": {
    "available": True, "url": "http://web.archive.org/web/2020/https://www.youtube.com/watch?v=vid1"}}})
_NO_SNAP = json.dumps({"archived_snapshots": {}})
_HTML = ('<html><head><meta property="og:title" content="Recovered Cool Video">'
         '<title>Recovered Cool Video - YouTube</title></head></html>')


def _fake_get(avail=_AVAIL, html=_HTML):
    def get(url, ua=None, timeout=20.0):
        return avail if "archive.org/wayback/available" in url else html
    return get


def test_extract_title():
    assert _extract_title('<meta property="og:title" content="Foo Bar">') == "Foo Bar"
    assert _extract_title("<title>Baz - YouTube</title>") == "Baz"
    # apostrophes inside the double-quoted content must not truncate (code-review)
    assert _extract_title('<meta property="og:title" content="It\'s a Don\'t Test">') == "It's a Don't Test"
    # reversed attribute order (content before property)
    assert _extract_title('<meta content="Reversed Attrs" property="og:title">') == "Reversed Attrs"
    # HTML entities are unescaped
    assert _extract_title('<meta property="og:title" content="Rock &amp; Roll">') == "Rock & Roll"


def test_recover_title_via_wayback():
    assert recover_title("vid1", get=_fake_get()) == "Recovered Cool Video"


def test_recover_title_no_snapshot():
    assert recover_title("vid1", get=_fake_get(avail=_NO_SNAP)) == ""


def test_recover_titles_overlays(tmp_db):
    conn = db.connect(tmp_db)
    db.merge_upsert(conn, models.new_item(source="youtube", source_id="vid1", kind="video",
                    title="[Deleted video]", metadata={"playlist": "WL"}))
    db.merge_upsert(conn, models.new_item(source="youtube", source_id="vid2", kind="video",
                    title="Normal title", metadata={}))  # has a title -> not selected
    conn.commit()
    res = recover_titles(conn, get=_fake_get(), sleep=lambda s: None, throttle=0)
    assert res["selected"] == 1 and res["recovered"] == 1
    item = db.get_item(conn, "youtube:vid1")
    assert item["title"] == "Recovered Cool Video"
    md = json.loads(item["metadata"])
    assert md["wayback_tried"] == 1 and md["title_source"] == "wayback" and md["playlist"] == "WL"


def test_recover_titles_marks_tried_when_none(tmp_db):
    conn = db.connect(tmp_db)
    db.merge_upsert(conn, models.new_item(source="youtube", source_id="vidX", kind="video",
                    title="[Private video]"))
    conn.commit()
    res = recover_titles(conn, get=_fake_get(avail=_NO_SNAP), sleep=lambda s: None, throttle=0)
    assert res["selected"] == 1 and res["recovered"] == 0
    # marked tried, so a re-run skips it
    assert recover_titles(conn, get=_fake_get(), sleep=lambda s: None, throttle=0)["selected"] == 0
