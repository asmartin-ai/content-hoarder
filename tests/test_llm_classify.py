"""Offline tests for the local-LLM category auto-classifier. The chat call is injected
(`chat=`) so no network is touched; is_available() is True by default (non-empty default
LLM_BASE_URL), so the unavailable case sets the env to ''."""

from content_hoarder import db, models
from content_hoarder.assist import llm


def _seed(conn, *items):
    """items: (source, source_id, title, metadata) tuples."""
    for source, sid, title, md in items:
        db.merge_upsert(conn, models.new_item(source=source, source_id=sid, kind="video",
                                              title=title, url=f"http://x/{sid}", metadata=md))
    conn.commit()


def _cat(conn, fullname):
    row = conn.execute("SELECT metadata FROM items WHERE fullname=?", (fullname,)).fetchone()
    return models.parse_metadata(row[0])


# --- parsing ---------------------------------------------------------------

def test_parse_category_valid():
    assert llm._parse_category('{"category":"listenable","reason":"music"}') == {
        "category": "listenable", "reason": "music"}


def test_parse_category_invalid_falls_back_to_unknown():
    assert llm._parse_category('{"category":"bogus"}')["category"] == "unknown"


def test_parse_category_no_json():
    assert llm._parse_category("sorry, I cannot help") is None


# --- classify (one item) ---------------------------------------------------

def test_classify_uses_injected_chat():
    res = llm.classify({"title": "Python tutorial", "source": "youtube", "metadata": {}},
                       chat=lambda msgs: '{"category":"watch","reason":"tutorial"}')
    assert res == {"category": "watch", "reason": "tutorial"}


def test_classify_unavailable_returns_none(monkeypatch):
    monkeypatch.setenv("LLM_BASE_URL", "")  # no endpoint -> short-circuit before chat
    called = []
    res = llm.classify({"title": "x", "source": "youtube", "metadata": {}},
                       chat=lambda msgs: called.append(1) or '{"category":"watch"}')
    assert res is None and called == []


# --- classify_source (batch) ----------------------------------------------

def test_classify_source_stores_and_skips_existing(conn):
    _seed(conn,
          ("youtube", "y1", "Lofi mix", {}),
          ("youtube", "y2", "Python tutorial", {}),
          ("youtube", "y3", "already tagged", {"category": "watch"}),
          ("reddit", "t3_a", "a reddit post", {}))
    res = llm.classify_source(conn, "youtube", chat=lambda msgs: '{"category":"listenable"}')
    assert res["available"] is True
    assert res["scanned"] == 2 and res["classified"] == 2   # y3 skipped (has category), reddit excluded
    assert res["by_category"]["listenable"] == 2
    # the processing-area tag is mirrored (like the heuristic path) so the tag rail matches
    assert _cat(conn, "youtube:y1") == {"category": "listenable", "category_source": "llm",
                                        "tags": ["listenable"]}
    assert _cat(conn, "youtube:y3")["category"] == "watch"   # pre-existing category preserved
    assert "category_source" not in _cat(conn, "youtube:y3")


def test_classify_source_retry_includes_categorized(conn):
    _seed(conn,
          ("youtube", "y1", "Lofi mix", {}),
          ("youtube", "y3", "already tagged", {"category": "watch"}))
    res = llm.classify_source(conn, "youtube", retry=True,
                              chat=lambda msgs: '{"category":"listenable"}')
    assert res["scanned"] == 2 and res["classified"] == 2
    assert _cat(conn, "youtube:y3")["category"] == "listenable"   # retry overwrote


def test_classify_source_unavailable(conn, monkeypatch):
    monkeypatch.setenv("LLM_BASE_URL", "")
    _seed(conn, ("youtube", "y1", "x", {}))
    assert llm.classify_source(conn, "youtube", chat=lambda msgs: "{}") == {
        "available": False, "classified": 0}


def test_classify_source_reclassifies_unknown_tail(conn):
    """The heuristic's give-up bucket (category='unknown') is re-classified by default;
    confident heuristic/manual categories are left intact (the backfill's whole point)."""
    _seed(conn,
          ("youtube", "y1", "Lofi mix", {"category": "unknown"}),        # heuristic gave up
          ("youtube", "y2", "Concert film", {"category": "listenable"}),  # confident -> keep
          ("youtube", "y3", "Brand new", {}))                            # never categorized
    res = llm.classify_source(conn, "youtube", chat=lambda msgs: '{"category":"watch"}')
    assert res["scanned"] == 2 and res["classified"] == 2   # y1 (unknown) + y3 (NULL); y2 kept
    assert _cat(conn, "youtube:y1")["category"] == "watch"            # unknown re-resolved
    assert _cat(conn, "youtube:y1")["category_source"] == "llm"
    assert _cat(conn, "youtube:y3")["category"] == "watch"
    assert _cat(conn, "youtube:y2")["category"] == "listenable"       # confident left intact
    assert "category_source" not in _cat(conn, "youtube:y2")


# --- backend selection -----------------------------------------------------

def test_classify_fireworks_backend_requires_key(monkeypatch):
    monkeypatch.delenv("FIREWORKS_API_KEY", raising=False)
    called = []
    res = llm.classify({"title": "x", "source": "youtube", "metadata": {}},
                       chat=lambda msgs: called.append(1) or '{"category":"watch"}',
                       backend="fireworks")
    assert res is None and called == []   # unconfigured backend -> chat never runs


def test_classify_fireworks_backend_uses_chat_when_keyed(monkeypatch):
    monkeypatch.setenv("FIREWORKS_API_KEY", "fw_test")
    res = llm.classify({"title": "Lofi", "source": "youtube", "metadata": {}},
                       chat=lambda msgs: '{"category":"listenable","reason":"music"}',
                       backend="fireworks")
    assert res == {"category": "listenable", "reason": "music"}
