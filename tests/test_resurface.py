from content_hoarder import db, models, resurface


def test_pick_candidate_returns_highest_dormant_cluster(conn):
    now = 1_000_000_000
    cutoff = now - 90 * 86400

    # coding: 5 dormant items — highest count, should be the pick
    for i in range(5):
        db.merge_upsert(
            conn,
            models.new_item(
                source="test",
                source_id=f"coding_{i}",
                title=f"Coding item {i}",
                status="inbox",
                created_utc=cutoff - 1000 - i * 100,
                metadata={"tags": ["coding"]},
            ),
        )
    conn.commit()

    # japan: 4 dormant items — second pick
    for i in range(4):
        db.merge_upsert(
            conn,
            models.new_item(
                source="test",
                source_id=f"japan_{i}",
                title=f"Japan item {i}",
                status="inbox",
                created_utc=cutoff - 2000 - i * 100,
                metadata={"tags": ["japan"]},
            ),
        )
    conn.commit()

    # science: only 2 items — below min_items=3
    for i in range(2):
        db.merge_upsert(
            conn,
            models.new_item(
                source="test",
                source_id=f"science_{i}",
                title=f"Science item {i}",
                status="inbox",
                created_utc=cutoff - 3000 - i * 100,
                metadata={"tags": ["science"]},
            ),
        )
    conn.commit()

    # tips: 4 recent items — not dormant
    for i in range(4):
        db.merge_upsert(
            conn,
            models.new_item(
                source="test",
                source_id=f"tips_{i}",
                title=f"Tips item {i}",
                status="inbox",
                created_utc=now - 1000 + i * 100,
                metadata={"tags": ["tips"]},
            ),
        )
    conn.commit()

    # memes: 10 dormant items — identity tag, must be ignored
    for i in range(10):
        db.merge_upsert(
            conn,
            models.new_item(
                source="test",
                source_id=f"memes_{i}",
                title=f"Memes item {i}",
                status="inbox",
                created_utc=cutoff - 5000 - i * 100,
                metadata={"tags": ["memes"]},
            ),
        )
    conn.commit()

    result = resurface.pick_candidate(conn, now=now)
    assert result is not None
    assert result["cluster"] == "coding"
    assert result["count"] == 5
    assert len(result["sample"]) == 3
    # 3 newest coding items, newest first
    assert result["sample"] == ["Coding item 0", "Coding item 1", "Coding item 2"]


def test_dismiss_and_reappearance(conn):
    now = 1_000_000_000
    cutoff = now - 90 * 86400

    # coding: 5 dormant items
    for i in range(5):
        db.merge_upsert(
            conn,
            models.new_item(
                source="test",
                source_id=f"coding_{i}",
                title=f"Coding item {i}",
                status="inbox",
                created_utc=cutoff - 1000 - i * 100,
                metadata={"tags": ["coding"]},
            ),
        )
    conn.commit()

    # japan: 4 dormant items
    for i in range(4):
        db.merge_upsert(
            conn,
            models.new_item(
                source="test",
                source_id=f"japan_{i}",
                title=f"Japan item {i}",
                status="inbox",
                created_utc=cutoff - 2000 - i * 100,
                metadata={"tags": ["japan"]},
            ),
        )
    conn.commit()

    # Initially coding wins
    result = resurface.pick_candidate(conn, now=now)
    assert result is not None
    assert result["cluster"] == "coding"

    # Dismiss coding for 30 days
    resurface.dismiss(conn, "coding", now=now, days=30)

    # Now japan wins instead
    result = resurface.pick_candidate(conn, now=now)
    assert result is not None
    assert result["cluster"] == "japan"

    # After the dismiss window expires, coding is eligible again
    later = now + 30 * 86400
    result = resurface.pick_candidate(conn, now=later)
    assert result is not None
    assert result["cluster"] == "coding"
