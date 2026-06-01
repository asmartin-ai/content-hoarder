import json

from content_hoarder import db, dedup, models


def _seed_url_dupes(conn):
    db.merge_upsert(conn, models.new_item(source="reddit", source_id="1", title="",
                    url="https://Example.com/Article/"))
    db.merge_upsert(conn, models.new_item(source="youtube", source_id="2", title="Has Title",
                    url="http://example.com/article?utm=x"))  # same normalized URL
    db.merge_upsert(conn, models.new_item(source="keep", source_id="3", title="Unique",
                    url="https://other.com"))


def test_find_groups_by_url(conn):
    _seed_url_dupes(conn)
    groups = dedup.find_groups(conn, by="url")
    assert len(groups) == 1
    g = groups[0]
    assert g["count"] == 2 and g["suggested_keep"] == "youtube:2"  # the titled one


def test_flag_is_nondestructive_and_clearable(conn):
    _seed_url_dupes(conn)
    res = dedup.flag_duplicates(conn)
    assert res["groups"] == 1 and res["flagged"] == 2
    assert db.get_item(conn, "reddit:1")["status"] == "inbox"      # status untouched
    md = json.loads(db.get_item(conn, "reddit:1")["metadata"])
    assert md["dup_count"] == 2 and md["dup_group"].startswith("u:")
    assert dedup.clear_flags(conn)["cleared"] == 2
    assert "dup_group" not in json.loads(db.get_item(conn, "reddit:1")["metadata"])


def test_resolve_group_is_reversible(conn):
    _seed_url_dupes(conn)
    res = dedup.resolve_group(conn, "youtube:2", ["reddit:1"])
    assert res["archived"] == 1
    assert db.get_item(conn, "youtube:2")["status"] == "inbox"
    assert db.get_item(conn, "reddit:1")["status"] == "archived"
    assert json.loads(db.get_item(conn, "reddit:1")["metadata"])["dedup_of"] == "youtube:2"
    db.undo_status(conn, "reddit:1")
    assert db.get_item(conn, "reddit:1")["status"] == "inbox"


def test_title_grouping_and_auto_resolve(conn):
    db.merge_upsert(conn, models.new_item(source="a", source_id="1", title="The Same Headline Here"))
    db.merge_upsert(conn, models.new_item(source="b", source_id="2", title="the same headline here!"))
    assert dedup.find_groups(conn, by="url") == []          # no urls
    g = dedup.find_groups(conn, by="title")
    assert len(g) == 1 and g[0]["count"] == 2
    assert dedup.auto_resolve(conn, by="title")["archived"] == 1


def test_no_false_positives(conn):
    db.merge_upsert(conn, models.new_item(source="r", source_id="1", title="alpha"))
    db.merge_upsert(conn, models.new_item(source="r", source_id="2", title="beta"))
    assert dedup.find_groups(conn, by="url") == []
    assert dedup.find_groups(conn, by="title") == []
