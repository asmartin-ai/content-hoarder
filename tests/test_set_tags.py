import json

from content_hoarder import db, models


def mk(**kw):
    kw.setdefault("now", 1000)
    return models.new_item(**kw)


def _md(conn, fullname):
    return json.loads(db.get_item(conn, fullname)["metadata"])


def test_add_stamps_manual_and_tags(conn):
    db.merge_upsert(conn, mk(source="r", source_id="1", title="x"))
    tags = db.set_tags(conn, "r:1", add=["MyProject"])  # normalized to lowercase
    assert "myproject" in tags
    md = _md(conn, "r:1")
    assert "myproject" in md["tags"]          # in the displayed list
    assert "myproject" in md["tags_manual"]   # and stamped as manual


def test_remove_drops_from_both(conn):
    db.merge_upsert(conn, mk(source="r", source_id="1", title="x"))
    db.set_tags(conn, "r:1", add=["keepme", "dropme"])
    db.set_tags(conn, "r:1", remove=["dropme"])
    md = _md(conn, "r:1")
    assert md["tags"] == ["keepme"]
    assert md["tags_manual"] == ["keepme"]


def test_manual_tag_survives_reimport_that_replaces_tags(conn):
    # A no-category re-import REPLACES metadata.tags wholesale (merge_upsert semantics);
    # a manually-applied tag must still survive via the tags_manual stamp.
    db.merge_upsert(conn, mk(source="r", source_id="1", title="x", metadata={"tags": ["gaming"]}))
    db.set_tags(conn, "r:1", add=["myproject"])
    db.merge_upsert(conn, mk(source="r", source_id="1", title="x", metadata={"tags": ["gaming", "memes"]}))
    md = _md(conn, "r:1")
    assert "myproject" in md["tags"]          # manual tag preserved across the replace
    assert "myproject" in md["tags_manual"]
    assert "memes" in md["tags"]              # pipeline tags still applied


def test_added_tag_is_searchable(conn):
    db.merge_upsert(conn, mk(source="r", source_id="1", title="x"))
    db.set_tags(conn, "r:1", add=["zzunique"])
    assert "zzunique" in db.get_item(conn, "r:1")["search_text"]


def test_missing_item_returns_none(conn):
    assert db.set_tags(conn, "r:nope", add=["x"]) is None


def test_no_op_does_not_reorder_feed(conn):
    db.merge_upsert(conn, mk(source="r", source_id="1", title="x", now=1000))
    before = db.get_item(conn, "r:1")["last_seen_utc"]
    db.set_tags(conn, "r:1", add=["tagא"])  # add a tag (non-ASCII tolerated)
    assert db.get_item(conn, "r:1")["last_seen_utc"] == before  # tag edit never bumps recency
