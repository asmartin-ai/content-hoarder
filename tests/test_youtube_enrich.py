import json

from content_hoarder import db, enrich as enrich_mod, models
from content_hoarder.connectors import youtube as yt
from content_hoarder.connectors.youtube import YouTubeConnector


class _Proc:
    def __init__(self, stdout="", returncode=0):
        self.stdout = stdout
        self.returncode = returncode
        self.stderr = ""


def test_youtube_enrich_fills_metadata(tmp_db, monkeypatch):
    monkeypatch.setattr(yt.shutil, "which", lambda n: "yt-dlp")
    info = {"title": "Real Title", "duration": 3601, "view_count": 1234, "categories": ["Education"],
            "tags": ["a", "b"], "description": "d", "channel": "Chan", "channel_id": "UC1",
            "availability": "public", "timestamp": 1600000000}
    monkeypatch.setattr(yt.subprocess, "run", lambda *a, **k: _Proc(json.dumps(info)))
    conn = db.connect(tmp_db)
    db.merge_upsert(conn, models.new_item(source="youtube", source_id="vid1", kind="video",
                    title="old", url="https://youtu.be/vid1", metadata={"playlist": "WL"}))
    conn.commit()
    res = enrich_mod.enrich_source(conn, "youtube")
    assert res["selected"] == 1 and res["updated"] == 1
    item = db.get_item(conn, "youtube:vid1")
    md = json.loads(item["metadata"])
    assert md["duration"] == 3601 and md["view_count"] == 1234 and md["yt_categories"] == ["Education"]
    assert item["title"] == "Real Title" and item["hydrated_at"]
    assert md["playlist"] == "WL"


def test_youtube_enrich_unavailable(tmp_db, monkeypatch):
    monkeypatch.setattr(yt.shutil, "which", lambda n: "yt-dlp")
    monkeypatch.setattr(yt.subprocess, "run", lambda *a, **k: _Proc("", returncode=1))
    conn = db.connect(tmp_db)
    db.merge_upsert(conn, models.new_item(source="youtube", source_id="gone", kind="video",
                    title="[Private video]"))
    conn.commit()
    enrich_mod.enrich_source(conn, "youtube")
    item = db.get_item(conn, "youtube:gone")
    assert json.loads(item["metadata"])["availability"] == "unavailable" and item["hydrated_at"]


def test_youtube_enrich_no_ytdlp_noop(monkeypatch):
    monkeypatch.setattr(yt.shutil, "which", lambda n: None)
    items = [{"fullname": "youtube:x", "source_id": "x"}]
    assert YouTubeConnector().enrich(items) == items
