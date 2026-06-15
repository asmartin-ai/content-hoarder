from content_hoarder import db, models, reddit_hydrate


def _add(conn, sid, *, title="", body="", raw=None):
    db.merge_upsert(conn, models.new_item(
        source="reddit", source_id=sid,
        kind="comment" if sid.startswith("t1_") else "post",
        title=title, body=body, raw=raw, now=1000))


def test_backfill_fills_empty_titles_from_submission_title(conn):
    _add(conn, "t1_a", title="", body="my comment", raw={"submission_title": "Real Post Title"})
    _add(conn, "t1_b", title="Already Has", raw={"submission_title": "Other"})  # real title present
    _add(conn, "t1_c", title="", body="no source")                             # no submission_title

    res = reddit_hydrate.backfill_titles_local(conn)
    assert res["updated"] == 1
    assert db.get_item(conn, "reddit:t1_a")["title"] == "Real Post Title"   # filled
    assert db.get_item(conn, "reddit:t1_b")["title"] == "Already Has"       # never overwritten
    assert db.get_item(conn, "reddit:t1_c")["title"] == ""                  # left as placeholder
    # search_text recomputed so the restored title is searchable
    assert "Real Post Title" in db.get_item(conn, "reddit:t1_a")["search_text"]


def test_backfill_dry_run_does_not_write(conn):
    _add(conn, "t1_a", title="", raw={"submission_title": "Title X"})
    res = reddit_hydrate.backfill_titles_local(conn, dry_run=True)
    assert res["updated"] == 1 and res["dry_run"] is True
    assert db.get_item(conn, "reddit:t1_a")["title"] == ""                  # preview only


def test_backfill_is_idempotent(conn):
    _add(conn, "t1_a", title="", raw={"submission_title": "Title X"})
    assert reddit_hydrate.backfill_titles_local(conn)["updated"] == 1
    assert reddit_hydrate.backfill_titles_local(conn)["updated"] == 0       # nothing left to fill
