import json

from content_hoarder import db, dedup, models


def test_dedup_archives_all_but_richest(conn):
    db.merge_upsert(conn, models.new_item(source="reddit", source_id="1", title="",
                    url="https://Example.com/Article/"))
    db.merge_upsert(conn, models.new_item(source="youtube", source_id="2", title="Has Title",
                    url="http://example.com/article?utm=x"))  # same normalized URL
    db.merge_upsert(conn, models.new_item(source="keep", source_id="3", title="Unique",
                    url="https://other.com"))

    dry = dedup.dedup(conn, dry_run=True)
    assert dry["groups"] == 1 and dry["duplicates"] == 1 and dry["applied"] == 0

    res = dedup.dedup(conn, dry_run=False)
    assert res["applied"] == 1
    assert db.get_item(conn, "youtube:2")["status"] == "inbox"      # titled one kept
    assert db.get_item(conn, "reddit:1")["status"] == "archived"    # dup archived
    assert json.loads(db.get_item(conn, "reddit:1")["metadata"])["dedup_of"] == "youtube:2"
    # reversible
    db.undo_status(conn, "reddit:1")
    assert db.get_item(conn, "reddit:1")["status"] == "inbox"


def test_dedup_ignores_empty_urls(conn):
    db.merge_upsert(conn, models.new_item(source="reddit", source_id="1", title="a"))
    db.merge_upsert(conn, models.new_item(source="reddit", source_id="2", title="b"))
    assert dedup.dedup(conn, dry_run=True)["groups"] == 0


def test_dedup_skips_already_triaged(conn):
    db.merge_upsert(conn, models.new_item(source="a", source_id="1", url="https://x.com/y"))
    db.merge_upsert(conn, models.new_item(source="b", source_id="2", url="https://x.com/y"))
    db.set_status(conn, "a:1", "keep")  # already triaged -> must not be archived
    db.set_status(conn, "b:2", "keep")
    res = dedup.dedup(conn, dry_run=False)
    assert res["applied"] == 0
