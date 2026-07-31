"""user_tags vocabulary registry tests (issue #70 / Epic 26 P3).

Pre-create empty tags, rename-in-vocabulary in one action, delete-from-vocab —
all offline on :memory: fixtures. The schema change is additive
``CREATE TABLE IF NOT EXISTS`` (runs on every connect, idempotent); the live
``data/app.db`` is never touched by tests.
"""

import json

import pytest

from content_hoarder import db, models


def mk(**kw):
    kw.setdefault("now", 1000)
    return models.new_item(**kw)


def _md(conn, fullname) -> dict:
    row = conn.execute(
        "SELECT metadata FROM items WHERE fullname=?", (fullname,)
    ).fetchone()
    assert row is not None
    return json.loads(row[0])


def _seed_tagged(conn, tag="craft"):
    db.merge_upsert(conn, mk(source="r", source_id="1", title="x"))
    db.merge_upsert(conn, mk(source="r", source_id="2", title="y"))
    db.set_tags(conn, "r:1", add=[tag])
    db.set_tags(conn, "r:2", add=[tag])
    return db.create_user_tag(conn, tag)


# ---- table shape ----


def test_user_tags_table_exists(conn):
    cols = {r[1] for r in conn.execute("PRAGMA table_info(user_tags)")}
    assert {"id", "name", "created_utc", "updated_utc"} <= cols
    unique = {r[1] for r in conn.execute("PRAGMA index_list(user_tags)") if r[2]}
    assert unique  # UNIQUE on name


# ---- pre-create an empty tag ----


def test_precreate_empty_tag_has_a_home(conn):
    t = db.create_user_tag(conn, "Deep Dives")
    assert t["id"] >= 1
    assert t["name"] == "deep dives"  # normalized exactly like set_tags stamps
    listed = db.list_user_tags(conn)
    assert len(listed) == 1
    assert listed[0]["id"] == t["id"]
    assert listed[0]["name"] == "deep dives"
    assert listed[0]["item_count"] == 0  # a 0-item tag has somewhere to live
    assert "deep dives" in db.user_tag_vocab(conn)  # in the vocabulary already


def test_create_duplicate_and_empty_rejected(conn):
    db.create_user_tag(conn, "craft")
    with pytest.raises(ValueError, match="already exists"):
        db.create_user_tag(conn, "Craft")  # same normalized name
    with pytest.raises(ValueError, match="empty"):
        db.create_user_tag(conn, "   ")


# ---- vocabulary = table rows UNION tags_manual stamps ----


def test_vocab_unions_table_and_derived(conn):
    db.create_user_tag(conn, "planned")  # 0 items — table row only
    db.merge_upsert(conn, mk(source="r", source_id="1", title="x"))
    db.set_tags(conn, "r:1", add=["applied"])  # applied without registering
    vocab = db.user_tag_vocab(conn)
    assert "planned" in vocab and "applied" in vocab


# ---- rename-in-vocabulary in one action ----


def test_rename_in_vocab_rewrites_items_in_one_action(conn):
    t = _seed_tagged(conn)
    renamed = db.rename_user_tag_in_vocab(conn, t["id"], "renamed")
    assert renamed["name"] == "renamed"
    assert db.get_user_tag(conn, t["id"])["name"] == "renamed"
    for fn in ("r:1", "r:2"):
        md = _md(conn, fn)
        assert md["tags_manual"] == ["renamed"]
        assert "renamed" in md["tags"] and "craft" not in md["tags"]
    # the old name is gone from the vocabulary AND from every item stamp
    assert "craft" not in db.user_tag_vocab(conn)
    # search surfaces the renamed items (trigram FTS rebuilt)
    hits = {i["fullname"] for i in db.search_items(conn, "renamed")}
    assert hits == {"r:1", "r:2"}


def test_rename_keeps_auto_stamp_untouched(conn):
    db.merge_upsert(conn, mk(
        source="r", source_id="1", title="x",
        metadata={"tags": ["craft", "gaming"], "tags_auto": ["gaming"]},
    ))
    db.set_tags(conn, "r:1", add=["craft"])
    t = db.create_user_tag(conn, "craft")
    db.rename_user_tag_in_vocab(conn, t["id"], "handmade")
    md = _md(conn, "r:1")
    assert md["tags_manual"] == ["handmade"]
    assert md["tags_auto"] == ["gaming"]  # heuristic stamp never bleeds into rename
    assert set(md["tags"]) == {"handmade", "gaming"}


def test_rename_collision_rejected_atomically(conn):
    t = _seed_tagged(conn, "craft")
    db.create_user_tag(conn, "other")
    with pytest.raises(ValueError, match="already exists"):
        db.rename_user_tag_in_vocab(conn, t["id"], "Other")
    # nothing moved: row name + item stamps unchanged
    assert db.get_user_tag(conn, t["id"])["name"] == "craft"
    assert _md(conn, "r:1")["tags_manual"] == ["craft"]


def test_rename_same_name_is_noop(conn):
    t = _seed_tagged(conn)
    assert db.rename_user_tag_in_vocab(conn, t["id"], "CRAFT")["name"] == "craft"
    assert _md(conn, "r:1")["tags_manual"] == ["craft"]


def test_rename_missing_id_raises(conn):
    with pytest.raises(ValueError, match="not found"):
        db.rename_user_tag_in_vocab(conn, 999, "x")


# ---- delete-from-vocabulary (unlocked cheaply by the same bulk rewrite) ----


def test_delete_strips_items_and_row(conn):
    t = _seed_tagged(conn)
    assert db.delete_user_tag(conn, t["id"]) is True
    assert db.get_user_tag(conn, t["id"]) is None
    for fn in ("r:1", "r:2"):
        md = _md(conn, fn)
        assert "tags_manual" not in md
        assert "craft" not in md.get("tags", [])
    assert "craft" not in db.user_tag_vocab(conn)


def test_delete_missing_id_false(conn):
    assert db.delete_user_tag(conn, 999) is False


# ---- list counts ----


def test_list_user_tags_counts(conn):
    db.create_user_tag(conn, "craft")
    db.merge_upsert(conn, mk(source="r", source_id="1", title="x"))
    db.set_tags(conn, "r:1", add=["craft"])
    by_name = {t["name"]: t for t in db.list_user_tags(conn)}
    assert by_name["craft"]["item_count"] == 1
    planned = db.create_user_tag(conn, "planned")
    by_name = {t["name"]: t for t in db.list_user_tags(conn)}
    assert by_name["planned"]["item_count"] == 0
    assert by_name["planned"]["id"] == planned["id"]
