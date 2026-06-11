"""Epic 21: hard-delete pathway (irreversible; safety semantics pinned here)."""
import pytest

from content_hoarder import db, models


def _seed(conn, sid, *, sub=None, tags=None, label=None, title="t", source="reddit",
          status="inbox"):
    md = {}
    if sub is not None:
        md["subreddit"] = sub
    if tags is not None:
        md["tags"] = tags
    if label is not None:
        md["decay_label"] = label
        md["decayed_at"] = 12345
    it = models.new_item(source=source, source_id=sid, kind="post", title=title,
                         metadata=md)
    db.merge_upsert(conn, it)
    fn = f"{source}:{sid}"
    if status != "inbox":
        conn.execute("UPDATE items SET status=? WHERE fullname=?", (status, fn))
    conn.commit()
    return fn


def test_delete_requires_selector(conn):
    with pytest.raises(ValueError):
        db.delete_items(conn)


def test_delete_dry_run_reports_without_deleting(conn):
    a = _seed(conn, "t3_a", sub="gamedeals", tags=["ephemeral"])
    res = db.delete_items(conn, tags=["ephemeral"])
    assert res["total"] == 1 and res["applied"] is False and len(res["sample"]) == 1
    assert db.get_item(conn, a) is not None


def test_delete_apply_removes_items_threads_and_fts(conn):
    a = _seed(conn, "t3_a", sub="gamedeals", tags=["ephemeral"], title="zonkified deal")
    conn.execute("INSERT INTO reddit_threads(fullname, thread_json, hydrated_at) "
                 "VALUES(?, '{}', 1)", (a,))
    conn.commit()
    res = db.delete_items(conn, tags=["ephemeral"], apply=True)
    assert res["total"] == 1 and res["applied"] is True and res["threads_deleted"] == 1
    assert db.get_item(conn, a) is None
    assert conn.execute("SELECT COUNT(*) FROM reddit_threads WHERE fullname=?",
                        (a,)).fetchone()[0] == 0
    # FTS row gone too (items_ad trigger)
    assert db.search_items(conn, "zonkified") == []


def test_delete_swept_and_tag_are_anded(conn):
    swept = _seed(conn, "t3_s", sub="gamedeals", tags=["ephemeral"], label="swept",
                  status="archived")
    fresh = _seed(conn, "t3_f", sub="gamedeals", tags=["ephemeral"])  # not swept
    res = db.delete_items(conn, tags=["ephemeral"], swept=True, apply=True)
    assert res["total"] == 1
    assert db.get_item(conn, swept) is None
    assert db.get_item(conn, fresh) is not None


def test_delete_also_unsave_enqueues_before_rows_vanish(conn):
    a = _seed(conn, "t3_a", sub="s", tags=["ephemeral"])
    res = db.delete_items(conn, tags=["ephemeral"], also_unsave=True, apply=True)
    assert res["unsave_enqueued"] == 1 and db.get_item(conn, a) is None
    row = conn.execute("SELECT reddit_id, state FROM reddit_unsave WHERE fullname=?",
                       (a,)).fetchone()
    assert row is not None and row[0] == "t3_a" and row[1] == "pending"


def test_delete_without_unsave_clears_stale_pending_queue_rows(conn):
    a = _seed(conn, "t3_a", sub="s", tags=["ephemeral"])
    db.enqueue_unsave(conn, a)  # pending from an earlier Done, never drained
    conn.commit()
    db.delete_items(conn, tags=["ephemeral"], apply=True)
    # a later drain must not unsave something the user only deleted locally
    assert conn.execute("SELECT COUNT(*) FROM reddit_unsave WHERE fullname=? "
                        "AND state='pending'", (a,)).fetchone()[0] == 0


def test_delete_max_rows_cap_refuses(conn):
    for i in range(3):
        _seed(conn, f"t3_{i}", sub="s", tags=["ephemeral"])
    with pytest.raises(ValueError):
        db.delete_items(conn, tags=["ephemeral"], apply=True, max_rows=2)
    # nothing was deleted by the refused call
    assert db.get_item(conn, "reddit:t3_0") is not None
    # dry run is never blocked by the cap (it IS the confirmation surface)
    assert db.delete_items(conn, tags=["ephemeral"], max_rows=2)["total"] == 3


def test_delete_fullname_selector_and_source_isolation(conn):
    a = _seed(conn, "t3_a", sub="s")
    y = _seed(conn, "v1", source="youtube", tags=["ephemeral"])
    res = db.delete_items(conn, fullnames=[a], apply=True)
    assert res["total"] == 1
    assert db.get_item(conn, a) is None
    assert db.get_item(conn, y) is not None  # source defaults to reddit
