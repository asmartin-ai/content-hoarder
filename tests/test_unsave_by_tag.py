"""Offline tests for bulk-enqueue unsave by tag."""

from content_hoarder import db, models


def test_enqueue_unsave_by_tag_preview_apply_and_idempotency(conn):
    tag = "nsfw_erotic"
    # (a) saved reddit item WITH the tag - should be enqueued
    db.merge_upsert(conn, models.new_item(
        source="reddit", source_id="t3_tagged", kind="post",
        title="tagged", url="http://x/t3_tagged",
        metadata={"tags": [tag]},
    ))
    # (b) saved reddit item WITHOUT the tag - should NOT be enqueued
    db.merge_upsert(conn, models.new_item(
        source="reddit", source_id="t3_untagged", kind="post",
        title="untagged", url="http://x/t3_untagged",
    ))
    # (c) NON-reddit item with the tag - should NOT be enqueued
    db.merge_upsert(conn, models.new_item(
        source="youtube", source_id="vid1", kind="post",
        title="yt", url="http://x/vid1",
        metadata={"tags": [tag]},
    ))
    # (d) UNSAVED reddit item with the tag - should NOT be enqueued
    db.merge_upsert(conn, models.new_item(
        source="reddit", source_id="t3_unsaved", kind="post",
        title="unsaved", url="http://x/t3_unsaved",
        is_saved=0,
        metadata={"tags": [tag]},
    ))
    # (e) Invalid reddit thing id with the tag - should NOT be enqueued
    db.merge_upsert(conn, models.new_item(
        source="reddit", source_id="abc_invalid", kind="post",
        title="invalid", url="http://x/invalid",
        metadata={"tags": [tag]},
    ))
    # (f) Already queued reddit item with the tag - should NOT count as newly enqueued
    db.merge_upsert(conn, models.new_item(
        source="reddit", source_id="t1_queued", kind="comment",
        title="queued", url="http://x/t1_queued",
        metadata={"tags": [tag]},
    ))
    conn.commit()
    db.enqueue_unsave(conn, "reddit:t1_queued")
    conn.commit()

    preview = db.enqueue_unsave_by_tag(conn, tag, dry_run=True)
    assert preview["dry_run"] is True
    assert preview["matched"] == 5
    assert preview["eligible"] == 1
    assert preview["enqueued"] == 0
    assert preview["skipped"] == {
        "non_reddit": 1,
        "already_unsaved": 1,
        "invalid_id": 1,
        "already_queued": 1,
    }
    assert len(preview["sample"]) == 1
    sample = preview["sample"][0]
    assert sample["fullname"] == "reddit:t3_tagged"
    assert sample["reddit_id"] == "t3_tagged"
    assert sample["title"] == "tagged"
    assert sample["subreddit"] is None
    assert sample["kind"] == "post"
    assert {"created_utc", "saved_utc", "first_seen_utc"} <= set(sample)
    assert preview["truncated"] is False
    assert conn.execute("SELECT COUNT(*) FROM reddit_unsave").fetchone()[0] == 1

    res = db.enqueue_unsave_by_tag(conn, tag)
    assert res["dry_run"] is False
    assert res["enqueued"] == 1
    assert conn.execute("SELECT is_saved FROM items WHERE fullname='reddit:t3_tagged'").fetchone()[0] == 1

    rows = conn.execute(
        "SELECT fullname, state FROM reddit_unsave ORDER BY fullname"
    ).fetchall()
    assert [(r["fullname"], r["state"]) for r in rows] == [
        ("reddit:t1_queued", "pending"),
        ("reddit:t3_tagged", "pending"),
    ]

    again = db.enqueue_unsave_by_tag(conn, tag)
    assert again["enqueued"] == 0
    assert again["skipped"]["already_queued"] == 2
