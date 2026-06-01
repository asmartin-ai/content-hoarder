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


def test_init_db_idempotent(conn):
    db.init_db(conn)
    db.init_db(conn)
