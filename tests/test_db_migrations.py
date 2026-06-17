"""One-time data migrations that heal saved-COMMENT id mis-typing (t3_ link vs t1_ comment).

``repair_reddit_comment_prefixes`` renames a t3_ comment that has NO t1_ twin; ``dedupe_reddit_
comment_twins`` collapses a t3_ phantom that DOES have a correct t1_ twin. Both are idempotent."""

from content_hoarder import db, models


def test_repair_reddit_comment_prefixes(conn):
    # A saved COMMENT mis-stored with a t3_ (link) prefix; its permalink reveals it's a comment.
    db.merge_upsert(conn, models.new_item(
        source="reddit", source_id="t3_cmt", kind="comment", title="c", url="",
        metadata={"permalink": "/r/x/comments/post1/_/cmt/"}))
    # A genuine POST (t3_) whose permalink has no comment segment — must be left untouched.
    db.merge_upsert(conn, models.new_item(
        source="reddit", source_id="t3_post", kind="post", title="p", url="",
        metadata={"permalink": "/r/x/comments/post/title/"}))
    conn.commit()
    db.set_setting(conn, "reddit_unsave_on_done", "1")
    db.set_status(conn, "reddit:t3_cmt", "done")        # queue it (reddit_id copied as t3_cmt)
    assert conn.execute("SELECT reddit_id FROM reddit_unsave WHERE fullname='reddit:t3_cmt'"
                        ).fetchone()["reddit_id"] == "t3_cmt"

    assert db.repair_reddit_comment_prefixes(conn) == 1
    # PK + source_id rewritten t3_->t1_; the old fullname is gone (so a re-sync can't dup it).
    assert db.get_item(conn, "reddit:t3_cmt") is None
    assert db.get_item(conn, "reddit:t1_cmt")["source_id"] == "t1_cmt"
    assert db.get_item(conn, "reddit:t3_post")["source_id"] == "t3_post"  # post untouched
    q = conn.execute("SELECT fullname, reddit_id FROM reddit_unsave").fetchone()
    assert q["fullname"] == "reddit:t1_cmt" and q["reddit_id"] == "t1_cmt"  # queue row migrated
    # FTS stayed in sync via the items trigger — the corrected item is searchable, the old isn't.
    assert any(i["fullname"] == "reddit:t1_cmt" for i in db.search_items(conn, "c", source="reddit"))
    assert db.repair_reddit_comment_prefixes(conn) == 0                   # idempotent


def test_dedupe_reddit_comment_twins(conn):
    db.set_setting(conn, "reddit_unsave_on_done", "1")
    # Pair 1: a 'done' (queued) phantom + an inbox twin -> decision + unsave move to the real t1_.
    db.merge_upsert(conn, models.new_item(source="reddit", source_id="t3_c1", kind="comment",
        title="c1", url="", metadata={"permalink": "/r/x/comments/p1/_/c1/"}))
    db.merge_upsert(conn, models.new_item(source="reddit", source_id="t1_c1", kind="comment",
        title="c1", url=""))
    # Pair 2: an inbox phantom + an already-archived twin -> phantom just removed, twin kept.
    db.merge_upsert(conn, models.new_item(source="reddit", source_id="t3_c2", kind="comment",
        title="c2", url="", metadata={"permalink": "/r/x/comments/p2/_/c2/"}))
    db.merge_upsert(conn, models.new_item(source="reddit", source_id="t1_c2", kind="comment",
        title="c2", url=""))
    # A true orphan t3_ comment (no twin) -> left for repair_reddit_comment_prefixes, untouched here.
    db.merge_upsert(conn, models.new_item(source="reddit", source_id="t3_orph", kind="comment",
        title="o", url="", metadata={"permalink": "/r/x/comments/p3/_/orph/"}))
    conn.commit()
    db.set_status(conn, "reddit:t1_c2", "archived")
    db.set_status(conn, "reddit:t3_c1", "done")          # phantom 'done' -> queued (unsave enabled)
    assert conn.execute("SELECT 1 FROM reddit_unsave WHERE fullname='reddit:t3_c1'").fetchone()

    res = db.dedupe_reddit_comment_twins(conn)
    assert res == {"removed": 2, "status_moved": 1, "requeued": 1}
    assert db.get_item(conn, "reddit:t3_c1") is None and db.get_item(conn, "reddit:t3_c2") is None
    assert db.get_item(conn, "reddit:t1_c1")["status"] == "done"          # decision moved to real row
    assert conn.execute("SELECT reddit_id FROM reddit_unsave WHERE fullname='reddit:t1_c1'"
                        ).fetchone()["reddit_id"] == "t1_c1"              # unsave now targets a valid id
    assert conn.execute("SELECT COUNT(*) FROM reddit_unsave WHERE fullname='reddit:t3_c1'"
                        ).fetchone()[0] == 0                              # phantom queue row gone
    assert db.get_item(conn, "reddit:t1_c2")["status"] == "archived"     # twin untouched
    assert db.get_item(conn, "reddit:t3_orph") is not None               # orphan untouched
    assert db.dedupe_reddit_comment_twins(conn)["removed"] == 0          # idempotent
