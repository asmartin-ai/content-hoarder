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


def test_import_upload(tmp_db, fixtures):
    cl = _client(tmp_db)
    with open(fixtures / "keep" / "Keep" / "note1.json", "rb") as fh:
        r = cl.post("/import", data={"file": (fh, "note1.json")},
                    content_type="multipart/form-data").get_json()
    assert r["imported"] >= 1
