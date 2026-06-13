import time

from content_hoarder import db, models, resurface


def test_surprise_returns_dormant_knowledge_item(conn):
    now = int(time.time())
    dormant_utc = now - 200 * 86400
    recent_utc = now - 10 * 86400

    dormant_item = models.new_item(
        source="reddit",
        source_id="d1",
        title="Old science item",
        created_utc=dormant_utc,
        status="inbox",
        metadata={"tags": ["science"]},
    )
    db.merge_upsert(conn, dormant_item)

    recent_item = models.new_item(
        source="reddit",
        source_id="r1",
        title="Recent science item",
        created_utc=recent_utc,
        status="inbox",
        metadata={"tags": ["science"]},
    )
    db.merge_upsert(conn, recent_item)

    meme_item = models.new_item(
        source="reddit",
        source_id="m1",
        title="Old meme item",
        created_utc=dormant_utc,
        status="inbox",
        metadata={"tags": ["memes"]},
    )
    db.merge_upsert(conn, meme_item)

    result = resurface.surprise(conn, now=now)
    assert result is not None
    assert result["kind"] == "surprise"
    assert result["fullname"] == dormant_item["fullname"]
    assert result["tag"] == "science"


def test_surprise_returns_none_when_no_qualifiers(conn):
    now = int(time.time())
    recent_utc = now - 10 * 86400

    recent_item = models.new_item(
        source="reddit",
        source_id="r2",
        title="Recent science item",
        created_utc=recent_utc,
        status="inbox",
        metadata={"tags": ["science"]},
    )
    db.merge_upsert(conn, recent_item)

    meme_item = models.new_item(
        source="reddit",
        source_id="m2",
        title="Old meme item",
        created_utc=now - 200 * 86400,
        status="inbox",
        metadata={"tags": ["memes"]},
    )
    db.merge_upsert(conn, meme_item)

    result = resurface.surprise(conn, now=now)
    assert result is None
