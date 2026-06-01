import json

from content_hoarder import db, dedup, models


def _seed(conn, items):
    for kw in items:
        db.merge_upsert(conn, models.new_item(**kw))
    conn.commit()


def test_find_groups_by_url(tmp_db):
    conn = db.connect(tmp_db)
    _seed(conn, [
        dict(source="reddit", source_id="t3_a", title="A", url="https://ex.com/x"),
        dict(source="youtube", source_id="v1", title="B", url="https://www.ex.com/x/"),  # same norm url
        dict(source="reddit", source_id="t3_c", title="C", url="https://other.com/y"),
        # distinct query strings must NOT collapse (the ?v= is the identifier)
        dict(source="youtube", source_id="ytA", title="X", url="https://www.youtube.com/watch?v=AAA"),
        dict(source="youtube", source_id="ytB", title="Y", url="https://www.youtube.com/watch?v=BBB"),
    ])
    groups = dedup.find_groups(conn, by="url")
    assert len(groups) == 1 and groups[0]["count"] == 2  # only ex.com/x; youtube urls stay distinct


def test_title_grouping_excludes_placeholders(tmp_db):
    conn = db.connect(tmp_db)
    _seed(conn, [
        dict(source="youtube", source_id="p1", title="[Private video]"),
        dict(source="youtube", source_id="p2", title="[Private video]"),
        dict(source="reddit", source_id="t3_r1", title="[removed]"),
        dict(source="reddit", source_id="t3_r2", title="[removed]"),
        dict(source="reddit", source_id="t3_x", title="A genuinely shared headline"),
        dict(source="hackernews", source_id="h1", title="A genuinely shared headline"),
    ])
    groups = dedup.find_groups(conn, by="title")
    assert len(groups) == 1 and groups[0]["count"] == 2  # placeholders excluded
    assert "headline" in groups[0]["key"]


def test_flag_auto_resolve_and_clear(tmp_db):
    conn = db.connect(tmp_db)
    _seed(conn, [
        dict(source="reddit", source_id="t3_a", title="Dup", url="https://ex.com/x", metadata={"score": 5}),
        dict(source="reddit", source_id="t3_b", title="Dup", url="https://ex.com/x"),
    ])
    f = dedup.flag_duplicates(conn, by="url")
    assert f["groups"] == 1 and f["flagged"] == 2
    md = json.loads(db.get_item(conn, "reddit:t3_a")["metadata"])
    assert md["dup_count"] == 2 and "dup_group" in md

    r = dedup.auto_resolve(conn, by="url")
    assert r["archived"] == 1
    statuses = {fn: db.get_item(conn, fn)["status"] for fn in ("reddit:t3_a", "reddit:t3_b")}
    assert sorted(statuses.values()) == ["archived", "inbox"]  # richer kept, other archived

    assert dedup.clear_flags(conn)["cleared"] >= 1
