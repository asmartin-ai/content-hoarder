from content_hoarder import db, models
from content_hoarder.bridge import karakeep


def _seed(conn):
    db.merge_upsert(conn, models.new_item(source="reddit", source_id="t3_a", title="Post",
                    url="http://r/a", metadata={"subreddit": "hh"}))
    db.merge_upsert(conn, models.new_item(source="keep", source_id="n1", title="Note",
                    body="text", metadata={"labels": ["home"]}))
    db.set_status(conn, "reddit:t3_a", "keep")
    db.set_status(conn, "keep:n1", "keep")


def test_payload_link_vs_text():
    link = karakeep._payload({"source": "reddit", "fullname": "reddit:t3_a", "title": "P",
                              "url": "http://x", "body": "", "metadata": {"subreddit": "hh"}})
    assert link["type"] == "link"
    assert "src:reddit" in link["tags"] and "r/hh" in link["tags"]

    text = karakeep._payload({"source": "keep", "fullname": "keep:n1", "title": "N",
                              "url": "", "body": "b", "metadata": {"labels": ["home"]}})
    assert text["type"] == "text" and "home" in text["tags"]


def test_promote_unconfigured(conn, monkeypatch):
    monkeypatch.setenv("KARAKEEP_BASE_URL", "")
    monkeypatch.setenv("KARAKEEP_API_KEY", "")
    _seed(conn)
    res = karakeep.promote(conn)
    assert res["configured"] is False and res["candidates"] == 2 and res["pushed"] == 0


def test_promote_configured_idempotent(conn, monkeypatch):
    monkeypatch.setenv("KARAKEEP_BASE_URL", "http://kk")
    monkeypatch.setenv("KARAKEEP_API_KEY", "key")
    _seed(conn)
    calls = []
    monkeypatch.setattr(karakeep, "_post",
                        lambda payload: calls.append(payload) or {"id": "kk-" + str(len(calls))})
    res = karakeep.promote(conn)
    assert res["pushed"] == 2 and len(calls) == 2
    res2 = karakeep.promote(conn)
    assert res2["pushed"] == 0 and res2["skipped"] == 2  # karakeep_id recorded -> skipped
