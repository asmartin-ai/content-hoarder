import json

from content_hoarder import db, models
from content_hoarder.assist import llm

FAKE = '{"verdict":"skip","reason":"low value","tags":["News","Misc"]}'


def test_suggest_unavailable(monkeypatch):
    monkeypatch.setenv("LLM_BASE_URL", "")
    assert llm.suggest({"title": "x"}) is None


def test_suggest_parses_and_normalizes(monkeypatch):
    monkeypatch.setenv("LLM_BASE_URL", "http://x/v1")
    monkeypatch.setattr(llm, "_chat", lambda messages, timeout=60: "Here you go: " + FAKE)
    s = llm.suggest({"source": "reddit", "title": "A", "metadata": {}})
    assert s["verdict"] == "skip"
    assert s["tags"] == ["news", "misc"]  # lowercased
    assert s["reason"]


def test_suggest_and_store_does_not_change_status(conn, monkeypatch):
    monkeypatch.setenv("LLM_BASE_URL", "http://x/v1")
    monkeypatch.setattr(llm, "_chat", lambda messages, timeout=60: FAKE)
    db.merge_upsert(conn, models.new_item(source="reddit", source_id="t3_a", title="A"))
    s = llm.suggest_and_store(conn, "reddit:t3_a")
    assert s["verdict"] == "skip"
    md = json.loads(db.get_item(conn, "reddit:t3_a")["metadata"])
    assert md["llm"]["verdict"] == "skip"
    assert db.get_item(conn, "reddit:t3_a")["status"] == "inbox"  # never auto-acts


def test_suggest_inbox_batch(conn, monkeypatch):
    monkeypatch.setenv("LLM_BASE_URL", "http://x/v1")
    monkeypatch.setattr(llm, "_chat", lambda messages, timeout=60: FAKE)
    for i in range(3):
        db.merge_upsert(conn, models.new_item(source="reddit", source_id=str(i), title="t"))
    res = llm.suggest_inbox(conn, limit=10)
    assert res["available"] and res["annotated"] == 3 and res["scanned"] == 3


def test_suggest_inbox_unavailable(conn, monkeypatch):
    monkeypatch.setenv("LLM_BASE_URL", "")
    db.merge_upsert(conn, models.new_item(source="reddit", source_id="1", title="t"))
    res = llm.suggest_inbox(conn, limit=10)
    assert res["available"] is False and res["annotated"] == 0
