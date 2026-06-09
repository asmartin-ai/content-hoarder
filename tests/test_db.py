import json

from content_hoarder import db, models


def mk(**kw):
    kw.setdefault("now", 1000)
    return models.new_item(**kw)


def test_schema_has_all_columns(conn):
    cols = {r[1] for r in conn.execute("PRAGMA table_info(items)")}
    for c in models.ITEM_FIELDS:
        assert c in cols


def test_insert_and_get(conn):
    db.merge_upsert(conn, mk(source="reddit", source_id="t3_a", title="Hi"))
    it = db.get_item(conn, "reddit:t3_a")
    assert it["title"] == "Hi" and it["source"] == "reddit"


def test_merge_no_clobber_and_frozen_first_seen(conn):
    db.merge_upsert(conn, mk(source="r", source_id="1", title="Rich", body="b", now=1000))
    db.merge_upsert(conn, mk(source="r", source_id="1", title="", now=2000))  # sparse
    it = db.get_item(conn, "r:1")
    assert it["title"] == "Rich"
    assert it["first_seen_utc"] == 1000
    assert it["last_seen_utc"] >= 1000


def test_metadata_shallow_merge(conn):
    db.merge_upsert(conn, mk(source="r", source_id="1", metadata={"a": 1}))
    db.merge_upsert(conn, mk(source="r", source_id="1", metadata={"b": 2}))
    md = json.loads(db.get_item(conn, "r:1")["metadata"])
    assert md == {"a": 1, "b": 2}


def test_processing_category_is_mirrored_to_tags(conn):
    db.merge_upsert(conn, mk(source="youtube", source_id="v1",
                             metadata={"category": "watch", "tags": ["existing", "listenable"]}))
    md = json.loads(db.get_item(conn, "youtube:v1")["metadata"])
    assert md["category"] == "watch"
    assert md["tags"] == ["existing", "watch"]
    assert db.search_items(conn, "", tags=["watch"])[0]["fullname"] == "youtube:v1"
    assert db.search_items(conn, "", category="watch")[0]["fullname"] == "youtube:v1"

    db.merge_upsert(conn, mk(source="youtube", source_id="v1",
                             metadata={"category": "listenable", "tags": ["fresh", "watch"]}))
    md = json.loads(db.get_item(conn, "youtube:v1")["metadata"])
    assert md["category"] == "listenable"
    assert md["tags"] == ["existing", "fresh", "listenable"]

    assert db.set_category(conn, "youtube:v1", "unknown") is True
    md = json.loads(db.get_item(conn, "youtube:v1")["metadata"])
    assert md["category"] == "unknown"
    assert md["tags"] == ["existing", "fresh"]
    assert db.search_items(conn, "", tags=["watch"]) == []


def test_normalize_processing_tags_backfills_legacy_metadata(conn):
    db.merge_upsert(conn, mk(source="youtube", source_id="v1"))
    conn.execute(
        "UPDATE items SET metadata=? WHERE fullname='youtube:v1'",
        (json.dumps({"category": "listenable"}),),
    )
    assert db.normalize_processing_tags(conn) == 1
    md = json.loads(db.get_item(conn, "youtube:v1")["metadata"])
    assert md["tags"] == ["listenable"]


def test_search_exact_and_metadata_fold(conn):
    db.merge_upsert(conn, mk(source="r", source_id="1", title="Hedgehog care",
                             metadata={"subreddit": "hedgehogs"}))
    assert db.search_items(conn, "hedgehog")
    assert db.search_items(conn, "hedgehogs")  # subreddit folded into search_text


def test_fuzzy_typo(conn):
    db.merge_upsert(conn, mk(source="r", source_id="1", title="Hedgehog"))
    assert db.search_items(conn, "hedgmog", fuzzy=True)


def test_status_and_undo(conn):
    db.merge_upsert(conn, mk(source="r", source_id="1", title="x"))
    db.set_status(conn, "r:1", "keep")
    it = db.get_item(conn, "r:1")
    assert it["status"] == "keep" and it["status_prev"] == "inbox" and it["processed_utc"]
    db.undo_status(conn, "r:1")
    it = db.get_item(conn, "r:1")
    assert it["status"] == "inbox" and it["processed_utc"] is None


def test_triage_state_preserved_on_reimport(conn):
    db.merge_upsert(conn, mk(source="r", source_id="1", title="x"))
    db.set_status(conn, "r:1", "done")
    db.merge_upsert(conn, mk(source="r", source_id="1", title="x2", now=3000))
    assert db.get_item(conn, "r:1")["status"] == "done"


def test_bulk_and_bankruptcy(conn):
    for i in range(3):
        db.merge_upsert(conn, mk(source="r", source_id=str(i), title="t", created_utc=100))
    assert db.bulk_set_status(conn, ["r:0", "r:1"], "keep") == 2
    assert db.bankruptcy(conn, 200, dry_run=True) == 1
    assert db.bankruptcy(conn, 200) == 1
    it = db.get_item(conn, "r:2")
    assert it["status"] == "archived" and it["status_prev"] == "inbox"


def test_random_batch_inbox_only(conn):
    db.merge_upsert(conn, mk(source="r", source_id="1"))
    db.merge_upsert(conn, mk(source="r", source_id="2"))
    db.set_status(conn, "r:1", "keep")
    batch = db.get_random_batch(conn, 10)
    assert len(batch) == 1 and batch[0]["status"] == "inbox"


def test_invalid_status_raises(conn):
    db.merge_upsert(conn, mk(source="r", source_id="1"))
    try:
        db.set_status(conn, "r:1", "bogus")
        assert False, "expected ValueError"
    except ValueError:
        pass


def test_fts_operator_keywords_dont_crash(conn):
    db.merge_upsert(conn, mk(source="r", source_id="1", title="cats and dogs OR birds"))
    for q in ("OR", "AND", "NOT", "cats OR dogs", "cats AND"):
        db.search_items(conn, q)  # bare FTS5 operators must not raise
    assert db.search_items(conn, "cats")


def test_status_prev_preserved_on_double_apply(conn):
    db.merge_upsert(conn, mk(source="r", source_id="1", title="x"))
    db.set_status(conn, "r:1", "keep")
    db.set_status(conn, "r:1", "keep")   # re-apply same status (no-op)
    db.undo_status(conn, "r:1")
    assert db.get_item(conn, "r:1")["status"] == "inbox"  # not stuck at 'keep'


def test_bulk_status_prev_preserved_on_double_apply(conn):
    db.merge_upsert(conn, mk(source="r", source_id="1", title="x"))
    assert db.bulk_set_status(conn, ["r:1"], "archived") == 1
    assert db.bulk_set_status(conn, ["r:1"], "archived") == 0  # no-op skipped
    db.undo_status(conn, "r:1")
    assert db.get_item(conn, "r:1")["status"] == "inbox"


def test_sort_oldest_first_and_by_duration(conn):
    db.merge_upsert(conn, mk(source="y", source_id="1", title="old short",
                             created_utc=100, metadata={"duration": 60}))
    db.merge_upsert(conn, mk(source="y", source_id="2", title="new long",
                             created_utc=200, metadata={"duration": 3600}))
    assert [i["source_id"] for i in db.search_items(conn, "", sort="created_utc", order="asc")] == ["1", "2"]
    assert db.search_items(conn, "", sort="duration", order="asc")[0]["source_id"] == "1"   # 60s first
    assert db.search_items(conn, "", sort="duration", order="desc")[0]["source_id"] == "2"  # 3600s first


def test_category_counts_cross_filter_by_source_and_status(conn):
    db.merge_upsert(conn, mk(source="youtube", source_id="v1", metadata={"category": "watch"}))
    db.merge_upsert(conn, mk(source="youtube", source_id="v2", metadata={"category": "watch"}))
    db.merge_upsert(conn, mk(source="youtube", source_id="v3", metadata={"category": "listenable"}))
    db.merge_upsert(conn, mk(source="reddit", source_id="t3_a", metadata={"category": "watch"}))
    db.set_status(conn, "youtube:v2", "keep")
    db.set_status(conn, "reddit:t3_a", "keep")

    all_youtube = {r["category"]: r["count"] for r in db.category_counts(conn, source="youtube")}
    keep_only = {r["category"]: r["count"] for r in db.category_counts(conn, source="youtube", status="keep")}

    assert all_youtube == {"listenable": 1, "watch": 2, "wotagei": 0, "unknown": 0}
    assert keep_only == {"listenable": 0, "watch": 1, "wotagei": 0, "unknown": 0}

    assert db.tag_counts(conn, source="youtube") == {"watch": 2, "listenable": 1}
    assert db.tag_counts(conn, source="youtube", status="keep") == {"watch": 1}


def test_init_db_idempotent(conn):
    db.init_db(conn)
    db.init_db(conn)


def test_search_tags_all_or_nsfw_and_score_and_dates(conn):
    # Two reddit posts, one NSFW + high score, one SFW + low score.
    db.merge_upsert(conn, mk(
        source="reddit",
        source_id="t3_a",
        title="A",
        created_utc=1672444800,  # 2022-12-31
        metadata={"tags": ["coding", "memes", "nsfw_other"], "score": 150, "subreddit": "hh"},
    ))
    db.merge_upsert(conn, mk(
        source="reddit",
        source_id="t3_b",
        title="B",
        created_utc=1675209600,  # 2023-02-01
        metadata={"tags": ["coding"], "score": 10, "subreddit": "hh"},
    ))

    # OR tags (any matches)
    r = db.search_items(conn, "", tags=["memes", "coding"], tags_all=False, sort="title", order="asc")
    assert [x["source_id"] for x in r] == ["t3_a", "t3_b"]

    # AND tags (all must match)
    r = db.search_items(conn, "", tags=["coding", "memes"], tags_all=True)
    assert [x["source_id"] for x in r] == ["t3_a"]

    # NSFW tag bucket
    r = db.search_items(conn, "", nsfw=True)
    assert [x["source_id"] for x in r] == ["t3_a"]

    # Score bounds (inclusive min/max)
    r = db.search_items(conn, "", score_min=100)
    assert [x["source_id"] for x in r] == ["t3_a"]

    r = db.search_items(conn, "", score_max=10)
    assert [x["source_id"] for x in r] == ["t3_b"]

    # Date filters: before is exclusive, after inclusive, and created_utc=0 rows are excluded.
    assert [x["source_id"] for x in db.search_items(conn, "", before=1672531200)] == ["t3_a"]
    assert [x["source_id"] for x in db.search_items(conn, "", after=1672531200)] == ["t3_b"]


def test_search_exact_and_exclude(conn):
    db.merge_upsert(conn, mk(source="r", source_id="1", title="hedgehog removed"))
    db.merge_upsert(conn, mk(source="r", source_id="2", title="hedgehog ok"))

    r = db.search_items(conn, "hedgehog", exclude=["removed"], sort="title", order="asc")
    assert [x["source_id"] for x in r] == ["2"]

    r = db.search_items(conn, "", exact=["hedgehog ok"])
    assert [x["source_id"] for x in r] == ["2"]

    # Exclude-only (no positive term) still filters via search_text, not just "doesn't crash".
    r = db.search_items(conn, "", exclude=["removed"], sort="title", order="asc")
    assert [x["source_id"] for x in r] == ["2"]


# --- versioned FTS build marker (delegation/04) -------------------------------

def test_fts_marker_version_triggers_rebuild(tmp_db):
    conn = db.connect(tmp_db)
    db.merge_upsert(conn, models.new_item(source="x", source_id="1", title="hello fuzzy world"))
    conn.commit()
    # Simulate a legacy DB: trgm index gone + old boolean marker.
    conn.execute("DROP TABLE items_trgm")
    conn.execute("UPDATE settings SET value='1' WHERE key='fts_built'")
    conn.commit()
    conn.close()
    conn = db.connect(tmp_db)   # recreates items_trgm empty; version bump must rebuild it
    hits = db.search_items(conn, "helo fuzy", fuzzy=True)
    assert any(r["fullname"] == "x:1" for r in hits)
    assert db.get_setting(conn, "fts_built") == "2"  # marker upgraded
    conn.close()
