import io
import json

from content_hoarder import db, models
from content_hoarder.web import create_app


def _seed(dbp):
    conn = db.connect(dbp)
    db.merge_upsert(conn, models.new_item(source="reddit", source_id="t3_a", kind="post",
                    title="Hedgehog", url="http://r/a", metadata={"subreddit": "hh"}))
    db.merge_upsert(conn, models.new_item(source="youtube", source_id="v1", kind="video",
                    title="Vid", url="https://youtu.be/v1"))
    conn.commit()
    conn.close()


def _client(tmp_db):
    _seed(tmp_db)
    return create_app(tmp_db).test_client()


def test_items_search(tmp_db):
    r = _client(tmp_db).get("/items?q=hedgehog").get_json()
    assert r["items"][0]["fullname"] == "reddit:t3_a"


def test_items_fuzzy(tmp_db):
    r = _client(tmp_db).get("/items?fuzzy=1&q=hedgmog").get_json()
    assert any(i["fullname"] == "reddit:t3_a" for i in r["items"])


def test_sources_and_stats(tmp_db):
    cl = _client(tmp_db)
    ids = {s["id"] for s in cl.get("/sources").get_json()["sources"]}
    assert {"reddit", "youtube"} <= ids
    assert cl.get("/stats").get_json()["total"] == 2


def test_status_undo_bulk(tmp_db):
    cl = _client(tmp_db)
    assert cl.post("/items/reddit:t3_a/status", json={"status": "keep"}).get_json()["status"] == "keep"
    assert cl.post("/items/reddit:t3_a/undo").get_json()["status"] == "inbox"
    assert cl.post("/bulk/status", json={"fullnames": ["youtube:v1"], "status": "archived"}).get_json()["updated"] == 1


def test_random(tmp_db):
    assert len(_client(tmp_db).get("/random?n=10").get_json()["items"]) == 2


def test_invalid_status(tmp_db):
    assert _client(tmp_db).post("/items/reddit:t3_a/status", json={"status": "bogus"}).status_code == 400


def test_malformed_params_dont_500(tmp_db):
    cl = _client(tmp_db)
    assert cl.get("/items?limit=abc&offset=-9&is_saved=x").status_code == 200
    assert cl.get("/random?n=notanumber").status_code == 200


def test_suggest_unconfigured_503(tmp_db, monkeypatch):
    monkeypatch.setenv("LLM_BASE_URL", "")
    assert _client(tmp_db).post("/items/reddit:t3_a/suggest").status_code == 503


def test_import_upload(tmp_db, fixtures):
    cl = _client(tmp_db)
    with open(fixtures / "keep" / "Keep" / "note1.json", "rb") as fh:
        r = cl.post("/import", data={"file": (fh, "note1.json")},
                    content_type="multipart/form-data").get_json()
    assert r["imported"] >= 1


def _yt_playlist(*ids):
    return {"_type": "playlist", "title": "WL", "id": "PL",
            "entries": [{"id": i, "title": i.upper()} for i in ids]}


def test_import_prepare_counts_without_writing_then_commit(tmp_db):
    cl = _client(tmp_db)  # seeds 2 items
    blob = json.dumps(_yt_playlist("abc123", "def456")).encode()
    data = {"file": (io.BytesIO(blob), "wl.json")}
    pr = cl.post("/import/prepare", data=data, content_type="multipart/form-data").get_json()
    assert pr["count"] == 2 and pr["new"] == 2 and pr["source"] == "youtube"
    assert cl.get("/stats").get_json()["total"] == 2  # prepare must NOT write
    res = cl.post("/import/commit", json={"token": pr["token"]}).get_json()
    assert res["imported"] == 2
    assert cl.get("/stats").get_json()["total"] == 4  # commit wrote


def test_import_prepare_url_via_ytdlp(tmp_db, monkeypatch):
    import content_hoarder.web as web

    class FakeProc:
        returncode = 0
        stdout = json.dumps(_yt_playlist("zzz999"))
        stderr = ""

    monkeypatch.setattr(web.shutil, "which", lambda name: "yt-dlp")
    monkeypatch.setattr(web.subprocess, "run", lambda *a, **k: FakeProc())
    cl = _client(tmp_db)
    pr = cl.post("/import/prepare", json={"url": "https://www.youtube.com/playlist?list=PL"}).get_json()
    assert pr["count"] == 1 and pr["source"] == "youtube"


def test_import_prepare_rejects_non_youtube_url(tmp_db):
    assert _client(tmp_db).post("/import/prepare", json={"url": "https://example.com/x"}).status_code == 400


def test_import_commit_expired_token(tmp_db):
    assert _client(tmp_db).post("/import/commit", json={"token": "nope"}).status_code == 400


def test_recover_route(tmp_db, monkeypatch):
    import content_hoarder.archival.service as svc
    monkeypatch.setattr(svc, "recover_one",
                        lambda c, fn, **k: {"recovered": True, "title": "X", "body": "Y", "url": "Z"})
    r = _client(tmp_db).post("/items/reddit:t3_a/recover")
    assert r.status_code == 200 and r.get_json()["recovered"] is True


def test_recover_route_non_reddit_400(tmp_db):
    # real recover_one short-circuits for a non-reddit item (no network)
    assert _client(tmp_db).post("/items/youtube:v1/recover").status_code == 400


def test_set_category(tmp_db):
    cl = _client(tmp_db)
    r = cl.post("/items/youtube:v1/category", json={"category": "listenable"})
    assert r.status_code == 200 and r.get_json()["category"] == "listenable"
    assert cl.get("/items?category=listenable").get_json()["items"][0]["fullname"] == "youtube:v1"
    assert cl.post("/items/youtube:v1/category", json={"category": "bogus"}).status_code == 400
    assert cl.post("/items/youtube:nope/category", json={"category": "watch"}).status_code == 404


def test_cross_filtered_counts(tmp_db):
    cl = _client(tmp_db)  # seeds reddit:t3_a + youtube:v1, both inbox
    cl.post("/items/reddit:t3_a/status", json={"status": "keep"})
    # status counts cross-filtered by source
    s = cl.get("/stats?source=reddit").get_json()
    assert s["total"] == 1
    assert s["by_status"].get("keep") == 1 and s["by_status"].get("inbox", 0) == 0
    # source counts cross-filtered by status; reddit still listed even at 0
    src = {x["id"]: x["count"] for x in cl.get("/sources?status=inbox").get_json()["sources"]}
    assert src.get("youtube") == 1 and src.get("reddit") == 0 and "reddit" in src
