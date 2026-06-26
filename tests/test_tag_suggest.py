"""Tests for the tag suggestion queue (tag_suggest.py).

Offline: :memory: SQLite, synthetic fixtures, no network.
"""

import json

from content_hoarder import db, models, tag_suggest


def mk(**kw):
    kw.setdefault("now", 1000)
    return models.new_item(**kw)


def _parse(conn, fullname):
    return json.loads(db.get_item(conn, fullname)["metadata"])


# ---------------------------------------------------------------------------
# Create + de-dupe
# ---------------------------------------------------------------------------


def test_create_suggestion(conn):
    """A pending suggestion is inserted and returns an int id."""
    sid = tag_suggest.create_suggestion(
        conn, "r:1", "minecraft", "rule", "detected by keyword"
    )
    assert isinstance(sid, int) and sid > 0
    rows = tag_suggest.list_suggestions(conn)
    assert len(rows) == 1
    assert rows[0]["suggested_tag"] == "minecraft"
    assert rows[0]["source"] == "rule"
    assert rows[0]["reason"] == "detected by keyword"


def test_create_suggestion_dedupe(conn):
    """Same (fullname, tag) in pending/applied state is not inserted again."""
    tag_suggest.create_suggestion(conn, "r:1", "minecraft")
    tag_suggest.create_suggestion(conn, "r:1", "minecraft")
    rows = tag_suggest.list_suggestions(conn)
    assert len(rows) == 1


def test_create_suggestion_allows_different_tags(conn):
    """Different tags for the same fullname are both inserted."""
    tag_suggest.create_suggestion(conn, "r:1", "minecraft")
    tag_suggest.create_suggestion(conn, "r:1", "memes")
    rows = tag_suggest.list_suggestions(conn)
    assert len(rows) == 2


def test_create_suggestion_rejected_can_reappear(conn):
    """Once rejected, the same (fullname, tag) can be suggested again."""
    tag_suggest.create_suggestion(conn, "r:1", "minecraft")
    tag_suggest.reject_suggestion(conn, 1)
    sid = tag_suggest.create_suggestion(conn, "r:1", "minecraft")
    assert isinstance(sid, int) and sid > 0  # new suggestion created


def test_create_suggestion_normalizes_tag(conn):
    """Tags are lowercased and truncated."""
    tag_suggest.create_suggestion(conn, "r:1", "  Minecraft  ")
    rows = tag_suggest.list_suggestions(conn)
    assert rows[0]["suggested_tag"] == "minecraft"


def test_create_suggestion_empty_tag_is_noop(conn):
    assert tag_suggest.create_suggestion(conn, "r:1", "") is None
    assert tag_suggest.create_suggestion(conn, "r:1", "   ") is None


# ---------------------------------------------------------------------------
# Accept / reject
# ---------------------------------------------------------------------------


def test_accept_applies_tag(conn):
    db.merge_upsert(conn, mk(source="reddit", source_id="t3_a", title="x"))
    tag_suggest.create_suggestion(conn, "reddit:t3_a", "memes", "rule", "keyword hit")
    res = tag_suggest.accept_suggestion(conn, 1)
    assert res is not None
    assert res["status"] == "applied"
    md = _parse(conn, "reddit:t3_a")
    assert "memes" in md["tags"]


def test_accept_with_missing_item(conn):
    tag_suggest.create_suggestion(conn, "reddit:nonexistent", "memes")
    res = tag_suggest.accept_suggestion(conn, 1)
    assert res is None  # item didn't exist -> no-op


def test_accept_with_wrong_status(conn):
    tag_suggest.create_suggestion(conn, "r:1", "memes")
    tag_suggest.accept_suggestion(conn, 1)
    # Already applied -> cannot accept again
    res = tag_suggest.accept_suggestion(conn, 1)
    assert res is None


def test_reject_marks_only(conn):
    db.merge_upsert(conn, mk(source="reddit", source_id="t3_a", title="x"))
    tag_suggest.create_suggestion(conn, "reddit:t3_a", "memes")
    res = tag_suggest.reject_suggestion(conn, 1)
    assert res is not None
    assert res["status"] == "rejected"
    # Tag should NOT be applied
    md = _parse(conn, "reddit:t3_a")
    assert "tags" not in md or "memes" not in md["tags"]


def test_reject_with_wrong_status(conn):
    tag_suggest.create_suggestion(conn, "r:1", "memes")
    tag_suggest.reject_suggestion(conn, 1)
    res = tag_suggest.reject_suggestion(conn, 1)
    assert res is None


# ---------------------------------------------------------------------------
# Bulk accept / reject
# ---------------------------------------------------------------------------


def test_accept_all(conn):
    db.merge_upsert(conn, mk(source="r", source_id="a", title="x"))
    db.merge_upsert(conn, mk(source="r", source_id="b", title="y"))
    tag_suggest.create_suggestion(conn, "r:a", "memes")
    tag_suggest.create_suggestion(conn, "r:b", "coding")
    n = tag_suggest.accept_all_suggestions(conn)
    assert n == 2
    assert "memes" in _parse(conn, "r:a")["tags"]
    assert "coding" in _parse(conn, "r:b")["tags"]


def test_accept_all_filtered_by_tag(conn):
    db.merge_upsert(conn, mk(source="r", source_id="a", title="x"))
    db.merge_upsert(conn, mk(source="r", source_id="b", title="y"))
    tag_suggest.create_suggestion(conn, "r:a", "memes")
    tag_suggest.create_suggestion(conn, "r:b", "coding")
    n = tag_suggest.accept_all_suggestions(conn, tag="memes")
    assert n == 1
    assert "memes" in _parse(conn, "r:a")["tags"]
    md = _parse(conn, "r:b")
    assert "tags" not in md or "coding" not in md["tags"]


def test_reject_all(conn):
    db.merge_upsert(conn, mk(source="r", source_id="a", title="x"))
    db.merge_upsert(conn, mk(source="r", source_id="b", title="y"))
    tag_suggest.create_suggestion(conn, "r:a", "memes")
    tag_suggest.create_suggestion(conn, "r:b", "coding")
    n = tag_suggest.reject_all_suggestions(conn)
    assert n == 2
    assert tag_suggest.list_suggestions(conn) == []


# ---------------------------------------------------------------------------
# Suggestion counts
# ---------------------------------------------------------------------------


def test_suggestion_counts(conn):
    db.merge_upsert(conn, mk(source="r", source_id="a", title="x"))
    db.merge_upsert(conn, mk(source="r", source_id="b", title="y"))
    db.merge_upsert(conn, mk(source="r", source_id="c", title="z"))
    tag_suggest.create_suggestion(conn, "r:a", "memes")
    tag_suggest.create_suggestion(conn, "r:b", "memes")
    tag_suggest.create_suggestion(conn, "r:c", "coding")
    counts = tag_suggest.suggestion_counts(conn)
    assert counts.get("memes") == 2
    assert counts.get("coding") == 1


# ---------------------------------------------------------------------------
# List suggestions with filters
# ---------------------------------------------------------------------------


def test_list_with_filters(conn):
    db.merge_upsert(conn, mk(source="r", source_id="a", title="x"))
    db.merge_upsert(conn, mk(source="r", source_id="b", title="y"))
    tag_suggest.create_suggestion(conn, "r:a", "memes", "rule", "rule hit")
    tag_suggest.create_suggestion(conn, "r:b", "coding", "ai", "llm said so")
    rows = tag_suggest.list_suggestions(conn, source_type="rule")
    assert len(rows) == 1
    assert rows[0]["suggested_tag"] == "memes"

    rows = tag_suggest.list_suggestions(conn, tag="coding")
    assert len(rows) == 1
    assert rows[0]["suggested_tag"] == "coding"


def test_list_returns_item_title(conn):
    db.merge_upsert(conn, mk(source="r", source_id="a", title="My Test Item"))
    tag_suggest.create_suggestion(conn, "r:a", "test")
    rows = tag_suggest.list_suggestions(conn)
    assert rows[0]["item_title"] == "My Test Item"
    assert rows[0]["item_source"] == "r"


# ---------------------------------------------------------------------------
# suggest_from_rule_matches
# ---------------------------------------------------------------------------


def test_suggest_from_rule_matches_reddit(conn):
    """Untagged reddit item with a known subreddit gets a rule suggestion."""
    db.merge_upsert(
        conn,
        mk(
            source="reddit",
            source_id="t3_a",
            title="x",
            metadata={"subreddit": "feedthebeast"},
        ),
    )
    res = tag_suggest.suggest_from_rule_matches(conn, source="reddit")
    assert res["queued"] >= 1
    assert "minecraft" in res["by_tag"]
    rows = tag_suggest.list_suggestions(conn)
    assert any(r["suggested_tag"] == "minecraft" for r in rows)


def test_suggest_from_rule_matches_skips_tagged(conn):
    """Already-tagged items are skipped unless retry."""
    db.merge_upsert(
        conn,
        mk(
            source="reddit",
            source_id="t3_a",
            title="x",
            metadata={"subreddit": "feedthebeast", "tags": ["minecraft"]},
        ),
    )
    res = tag_suggest.suggest_from_rule_matches(conn, source="reddit")
    assert res["queued"] == 0


def test_suggest_from_rule_matches_retry_processes_tagged(conn):
    db.merge_upsert(
        conn,
        mk(
            source="reddit",
            source_id="t3_a",
            title="x",
            metadata={"subreddit": "feedthebeast", "tags": ["minecraft"]},
        ),
    )
    res = tag_suggest.suggest_from_rule_matches(conn, source="reddit", retry=True)
    assert res["queued"] >= 1


# ---------------------------------------------------------------------------
# suggest_from_discovery
# ---------------------------------------------------------------------------


def test_suggest_from_discovery_reddit(conn):
    """Frequent untagged subreddit with a keyword match triggers discovery."""
    for i in range(3):
        db.merge_upsert(
            conn,
            mk(
                source="reddit",
                source_id=f"t3_{i}",
                title="minecraft server",
                metadata={"subreddit": "mysterymc"},
            ),
        )
    res = tag_suggest.suggest_from_discovery(conn, min_count=2)
    assert res["queued"] >= 1
    assert "discovered" in res


def test_suggest_from_discovery_skips_mapped_subs(conn):
    """Already-mapped subreddits don't trigger discovery."""
    for i in range(5):
        db.merge_upsert(
            conn,
            mk(
                source="reddit",
                source_id=f"t3_{i}",
                title="x",
                metadata={"subreddit": "minecraft"},
            ),
        )
    res = tag_suggest.suggest_from_discovery(conn, min_count=2)
    assert res["queued"] == 0  # already in _SUBREDDIT_TAGS


def test_suggest_from_discovery_skips_below_min(conn):
    """Subreddit below min_count doesn't trigger."""
    db.merge_upsert(
        conn,
        mk(
            source="reddit",
            source_id="t3_a",
            title="minecraft mod",
            metadata={"subreddit": "obscuresub"},
        ),
    )
    res = tag_suggest.suggest_from_discovery(conn, min_count=5)
    assert res["queued"] == 0


def test_suggest_from_discovery_browser(conn):
    """Untagged browser domain with a keyword match triggers discovery."""
    for i in range(3):
        db.merge_upsert(
            conn,
            mk(
                source="firefox",
                source_id=f"ff_{i}",
                title="stock market today",
                metadata={"domain": "exampleinvest.com"},
            ),
        )
    res = tag_suggest.suggest_from_discovery(conn, min_count=2)
    assert res["queued"] >= 1


# ---------------------------------------------------------------------------
# suggest_from_llm (no LLM configured = graceful no-op)
# ---------------------------------------------------------------------------


def test_suggest_from_llm_noop_when_unconfigured(conn, monkeypatch):
    """Without LLM config, suggest_from_llm returns graceful no-op."""
    monkeypatch.setenv("LLM_BASE_URL", "")
    res = tag_suggest.suggest_from_llm(conn)
    assert res["available"] is False
    assert res["queued"] == 0


# ---------------------------------------------------------------------------
# Edge cases
# ---------------------------------------------------------------------------


def test_empty_list_when_no_suggestions(conn):
    assert tag_suggest.list_suggestions(conn) == []
    assert tag_suggest.suggestion_counts(conn) == {}


def test_list_with_limit(conn):
    db.merge_upsert(conn, mk(source="r", source_id="a", title="x"))
    db.merge_upsert(conn, mk(source="r", source_id="b", title="y"))
    tag_suggest.create_suggestion(conn, "r:a", "tag1")
    tag_suggest.create_suggestion(conn, "r:b", "tag2")
    rows = tag_suggest.list_suggestions(conn, limit=1)
    assert len(rows) == 1


def test_preserves_manual_tags_on_accept(conn):
    """Accepting a suggestion preserves existing manual tags (via set_tags)."""
    db.merge_upsert(conn, mk(source="r", source_id="a", title="x"))
    db.set_tags(conn, "r:a", add=["existing"])
    tag_suggest.create_suggestion(conn, "r:a", "new_tag", "rule", "discovered")
    tag_suggest.accept_suggestion(conn, 1)
    md = _parse(conn, "r:a")
    assert "existing" in md["tags"]
    assert "new_tag" in md["tags"]
