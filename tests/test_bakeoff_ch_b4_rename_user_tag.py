"""Bakeoff oracle — CH-B4: user-tag rename-in-vocabulary.

Contract: ``db.rename_user_tag(conn, old, new)`` renames a user-entered tag
across every item that carries it in ``metadata.tags_manual``.

* Items whose ``metadata.tags_manual`` contains ``old`` MUST end up with ``new``
  in their ``tags_manual`` (and in the displayed ``metadata.tags``).
* Items whose ``metadata.tags_auto`` (the heuristic stamp) contains ``old`` MUST
  be left untouched — ``rename_user_tag`` rewrites the HUMAN stamp only, not the
  programmatic one. The auto-stamped ``old`` survives the rename.
* After the rename, ``items_trgm`` (the trigram FTS index over ``search_text``)
  MUST reflect the new tag (searching the new tag finds the renamed item).
* The return value MUST be the count of items whose ``tags_manual`` actually
  contained ``old``.
* Calling ``rename_user_tag`` with an ``old`` tag that no item carries MUST
  return 0 and MUST NOT mutate any item.
"""

from content_hoarder import db, models


def _mk_item(source_id, *, manual=None, auto=None, title=""):
    md = {}
    if manual:
        md["tags_manual"] = list(manual)
        md["tags"] = list(manual)
    if auto:
        md["tags_auto"] = list(auto)
        # ``tags`` is the displayed union; mirror auto in it too.
        tags = list(md.get("tags", []))
        for t in auto:
            if t not in tags:
                tags.append(t)
        md["tags"] = tags
    return models.new_item(
        source="reddit", source_id=source_id, title=title, body="", metadata=md, now=100
    )


def test_rename_user_tag_exists():
    assert hasattr(db, "rename_user_tag"), "db.rename_user_tag must exist (CH-B4)"


def test_rename_user_tag_rewrites_manual_stamp(conn):
    db.init_db(conn)
    db.merge_upsert(conn, _mk_item("1", manual=["oldtag"], title="item one"))
    conn.commit()

    n = db.rename_user_tag(conn, "oldtag", "newtag")
    conn.commit()

    assert n == 1
    row = db.get_item(conn, "reddit:1")
    md = db.parse_metadata(row["metadata"])
    assert "newtag" in md.get("tags_manual", [])
    assert "oldtag" not in md.get("tags_manual", [])
    assert "newtag" in md.get("tags", [])


def test_rename_user_tag_preserves_auto_stamp(conn):
    db.init_db(conn)
    # Item carries ``oldtag`` ONLY as an auto tag, not in tags_manual.
    db.merge_upsert(conn, _mk_item("2", auto=["oldtag"], title="auto only"))
    conn.commit()

    n = db.rename_user_tag(conn, "oldtag", "newtag")
    conn.commit()

    # No item had it in tags_manual -> 0 items renamed.
    assert n == 0
    row = db.get_item(conn, "reddit:2")
    md = db.parse_metadata(row["metadata"])
    # The auto stamp survives untouched.
    assert "oldtag" in md.get("tags_auto", [])
    assert "newtag" not in md.get("tags_auto", [])


def test_rename_user_tag_rebuilds_trigram_fts(conn):
    db.init_db(conn)
    db.merge_upsert(conn, _mk_item("3", manual=["oldtag"], title="renamed item"))
    conn.commit()

    db.rename_user_tag(conn, "oldtag", "newtag")
    conn.commit()

    # The trigram FTS over search_text must surface the new tag.
    hits = db.search_items(conn, "newtag")
    fullnames = {r["fullname"] for r in hits}
    assert "reddit:3" in fullnames


def test_rename_user_tag_nonexistent_returns_zero(conn):
    db.init_db(conn)
    db.merge_upsert(conn, _mk_item("4", manual=["unrelated"], title="other item"))
    conn.commit()

    n = db.rename_user_tag(conn, "ghost", "anything")
    conn.commit()

    assert n == 0
    # No mutation to the unrelated item.
    row = db.get_item(conn, "reddit:4")
    md = db.parse_metadata(row["metadata"])
    assert "unrelated" in md.get("tags_manual", [])
