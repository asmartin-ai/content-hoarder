"""Offline tests for bulk-enqueue unsave by tag."""

from content_hoarder import db, models


def test_enqueue_unsave_by_tag(conn):
    tag = "nsfw_erotic"
    # (a) saved reddit item WITH the tag — should be enqueued
    db.merge_upsert(conn, models.new_item(
        source="reddit", source_id="t3_tagged", kind="post",
        title="tagged", url="http://x/t3_tagged",
        metadata={"tags": [tag]},
    ))
    # (b) saved reddit item WITHOUT the tag — should NOT be enqueued
    db.merge_upsert(conn, models.new_item(
        source="reddit", source_id="t3_untagged", kind="post",
        title="untagged", url="http://x/t3_untagged",
    ))
    # (c) NON-reddit item with the tag — should NOT be enqueued
    db.merge_upsert(conn, models.new_item(
        source="youtube", source_id="vid1", kind="post",
        title="yt", url="http://x/vid1",
        metadata={"tags": [tag]},
    ))
    # (d) UNSAVED reddit item with the tag — should NOT be enqueued
    db.merge_upsert(conn, models.new_item(
        source="reddit", source_id="t3_unsaved", kind="post",
        title="unsaved", url="http://x/t3_unsaved",
        is_saved=0,
        metadata={"tags": [tag]},
    ))
    conn.commit()

    n = db.enqueue_unsave_by_tag(conn, tag)
    assert n == 1

    rows = conn.execute(
        "SELECT fullname, state FROM reddit_unsave"
    ).fetchall()
    assert len(rows) == 1
    assert rows[0]["fullname"] == "reddit:t3_tagged"
    assert rows[0]["state"] == "pending"
