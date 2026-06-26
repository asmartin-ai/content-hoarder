"""media_archive: download + store media bytes per item, resumable (Epic 4 P1). Offline —
the HTTP fetch is injected."""
import json

from content_hoarder import config, db, media_archive, media_store, models


def _seed(conn, sid, **md):
    db.merge_upsert(conn, models.new_item(source="reddit", source_id=sid, kind="post",
                                          title=sid, metadata=md))


def _seed_source(conn, source, sid, **md):
    db.merge_upsert(conn, models.new_item(source=source, source_id=sid, kind="post",
                                          title=sid, metadata=md))


def test_urls_for_scopes():
    assert media_archive._urls_for({"media_salvage_url": "u"}, "salvageable") == ["u"]
    assert media_archive._urls_for({"gallery_preview": ["a", "b"]}, "galleries") == ["a", "b"]
    assert media_archive._urls_for(
        {"media_url": "https://i.redd.it/x.jpg"}, "images") == ["https://i.redd.it/x.jpg"]
    # a known-gone image is not re-fetched
    assert media_archive._urls_for(
        {"media_url": "https://i.redd.it/x.jpg", "media_status": "gone"}, "images") == []
    assert media_archive._urls_for(
        {"media_urls": [
            "https://pbs.twimg.com/media/a.jpg?name=orig",
            "https://video.twimg.com/ext_tw_video/1/pu/vid/720x720/v.mp4",
            "https://pbs.twimg.com/media/a.jpg?name=orig",
        ]},
        "twitter",
    ) == ["https://pbs.twimg.com/media/a.jpg?name=orig"]


def test_archive_salvageable_and_galleries(conn, tmp_path, monkeypatch):
    monkeypatch.setattr(config, "db_path", lambda: str(tmp_path / "app.db"))  # media dir -> tmp/media
    _seed(conn, "salv", media_salvage_url="https://preview.redd.it/s.jpg")
    _seed(conn, "gal", gallery_preview=["https://preview.redd.it/g1.jpg",
                                        "https://preview.redd.it/g2.jpg"])
    _seed(conn, "plain", media_url="https://i.redd.it/p.jpg")  # not in these scopes
    conn.commit()
    calls = []

    def fake(u, *, max_bytes):
        calls.append(u)
        return (b"BYTES-" + u.encode(), "image/jpeg")

    # dry run: counts the 3 URLs, fetches/writes nothing
    plan = media_archive.archive(conn, scopes=["salvageable", "galleries"], apply=False,
                                 fetch=fake, throttle=0)
    assert plan["urls"] == 3 and plan["archived"] == 0 and calls == []

    # apply: fetches + stores all 3, stamps archived_media
    res = media_archive.archive(conn, scopes=["salvageable", "galleries"], apply=True,
                                fetch=fake, throttle=0)
    assert res["archived"] == 3 and res["failed"] == 0 and len(calls) == 3
    sm = json.loads(db.get_item(conn, "reddit:salv")["metadata"])
    blob = sm["archived_media"]["https://preview.redd.it/s.jpg"]
    assert blob.endswith(".jpg")
    assert media_store.path_for(blob).read_bytes() == b"BYTES-https://preview.redd.it/s.jpg"
    assert "archived_media" not in json.loads(db.get_item(conn, "reddit:plain")["metadata"])

    # resumable: a second run finds nothing left to do
    again = media_archive.archive(conn, scopes=["salvageable", "galleries"], apply=True,
                                  fetch=fake, throttle=0)
    assert again["urls"] == 0 and again["archived"] == 0


def test_archive_failed_fetch_is_counted_not_stamped(conn, tmp_path, monkeypatch):
    monkeypatch.setattr(config, "db_path", lambda: str(tmp_path / "app.db"))
    _seed(conn, "x", media_salvage_url="https://preview.redd.it/dead.jpg")
    conn.commit()
    res = media_archive.archive(conn, scopes=["salvageable"], apply=True, throttle=0,
                                fetch=lambda u, *, max_bytes: (None, "http_404"))
    assert res["failed"] == 1 and res["archived"] == 0
    assert "archived_media" not in json.loads(db.get_item(conn, "reddit:x")["metadata"])


def test_archive_item_limit(conn, tmp_path, monkeypatch):
    monkeypatch.setattr(config, "db_path", lambda: str(tmp_path / "app.db"))
    for i in range(5):
        _seed(conn, f"s{i}", media_salvage_url=f"https://preview.redd.it/{i}.jpg")
    conn.commit()
    res = media_archive.archive(conn, scopes=["salvageable"], apply=True, limit=2, throttle=0,
                                fetch=lambda u, *, max_bytes: (b"x", "image/jpeg"))
    assert res["items"] == 2 and res["archived"] == 2


def test_archive_twitter_images(conn, tmp_path, monkeypatch):
    monkeypatch.setattr(config, "db_path", lambda: str(tmp_path / "app.db"))
    img = "https://pbs.twimg.com/media/abc123.jpg?name=orig"
    _seed_source(conn, "twitter", "tw1", media_urls=[
        img,
        "https://video.twimg.com/ext_tw_video/1/pu/vid/720x720/v.mp4",
    ])
    _seed(conn, "reddit", media_url="https://i.redd.it/x.jpg")
    conn.commit()
    calls = []

    def fake(u, *, max_bytes):
        calls.append(u)
        return (b"TW-" + u.encode(), "image/jpeg")

    plan = media_archive.archive(conn, scopes=["twitter"], apply=False, fetch=fake, throttle=0)
    assert plan["items"] == 1 and plan["urls"] == 1 and plan["archived"] == 0
    assert calls == []

    res = media_archive.archive(conn, scopes=["twitter"], apply=True, fetch=fake, throttle=0)
    assert res["items"] == 1 and res["archived"] == 1 and res["failed"] == 0
    assert calls == [img]
    md = json.loads(db.get_item(conn, "twitter:tw1")["metadata"])
    blob = md["archived_media"][img]
    assert blob.endswith(".jpg")
    assert media_store.path_for(blob).read_bytes() == b"TW-" + img.encode()

    again = media_archive.archive(conn, scopes=["twitter"], apply=True, fetch=fake, throttle=0)
    assert again["urls"] == 0 and again["archived"] == 0
