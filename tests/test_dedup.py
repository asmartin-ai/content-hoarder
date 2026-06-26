import json

from content_hoarder import db, dedup, models
from content_hoarder.web import create_app


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


def test_resolve_undo_restores_archived_rows_and_clears_dedup_of(tmp_db):
    conn = db.connect(tmp_db)
    _seed(conn, [
        dict(source="reddit", source_id="t3_keep", title="Dup", url="https://ex.com/x", metadata={"score": 5}),
        dict(source="hackernews", source_id="hn_arch", title="Dup", url="https://ex.com/x"),
    ])
    res = dedup.resolve_group(conn, "reddit:t3_keep", ["hackernews:hn_arch"])
    assert res["archived"] == 1
    md = json.loads(db.get_item(conn, "hackernews:hn_arch")["metadata"])
    assert md["dedup_of"] == "reddit:t3_keep"

    undo = dedup.undo_resolve(conn, ["hackernews:hn_arch"])
    assert undo["restored"] == 1
    assert db.get_item(conn, "hackernews:hn_arch")["status"] == "inbox"
    md2 = json.loads(db.get_item(conn, "hackernews:hn_arch")["metadata"])
    assert "dedup_of" not in md2


def test_duplicate_review_routes(tmp_db):
    conn = db.connect(tmp_db)
    _seed(conn, [
        dict(source="reddit", source_id="t3_keep", title="Dup", url="https://ex.com/x", metadata={"score": 5}),
        dict(source="hackernews", source_id="hn_arch", title="Dup", url="https://ex.com/x"),
    ])
    conn.close()

    cl = create_app(tmp_db).test_client()
    groups = cl.get("/duplicates?by=url&status=inbox").get_json()["groups"]
    assert len(groups) == 1
    keep = groups[0]["suggested_keep"]
    archive = [it["fullname"] for it in groups[0]["items"] if it["fullname"] != keep]

    res = cl.post("/duplicates/resolve", json={"keep": keep, "archive": archive}).get_json()
    assert res["archived"] == 1
    assert cl.get("/items/" + archive[0]).get_json()["status"] == "archived"

    undo = cl.post("/duplicates/undo", json={"fullnames": archive}).get_json()
    assert undo["restored"] == 1
    item = cl.get("/items/" + archive[0]).get_json()
    assert item["status"] == "inbox"
    assert "dedup_of" not in item["metadata"]
