import json
import pytest

from content_hoarder import db, models, resurface


def test_let_it_go(conn):
    # Seed: three inbox items tagged science
    for i in range(3):
        db.merge_upsert(
            conn,
            models.new_item(
                source="reddit",
                source_id=f"sci_inbox_{i}",
                status="inbox",
                metadata={"tags": ["science"]},
            ),
        )
    # One science item with status="keep" (NOT inbox)
    db.merge_upsert(
        conn,
        models.new_item(
            source="reddit",
            source_id="sci_keep",
            status="keep",
            metadata={"tags": ["science"]},
        ),
    )
    # One inbox item tagged memes
    db.merge_upsert(
        conn,
        models.new_item(
            source="reddit",
            source_id="memes_inbox",
            status="inbox",
            metadata={"tags": ["memes"]},
        ),
    )
    conn.commit()

    # Call let_it_go for science cluster
    result = resurface.let_it_go(conn, "science")
    assert result["total"] == 3
    conn.commit()

    # (b) three science inbox items are now archived with decay_label == "resurface"
    rows = conn.execute(
        "SELECT status, metadata FROM items WHERE source_id LIKE 'sci_inbox_%'"
    ).fetchall()
    assert len(rows) == 3
    for status, meta_str in rows:
        assert status == "archived"
        meta = json.loads(meta_str)
        assert meta.get("decay_label") == "resurface"

    # (c) keep item and memes item are untouched
    keep_row = conn.execute(
        "SELECT status FROM items WHERE source_id = 'sci_keep'"
    ).fetchone()
    assert keep_row[0] == "keep"

    memes_row = conn.execute(
        "SELECT status FROM items WHERE source_id = 'memes_inbox'"
    ).fetchone()
    assert memes_row[0] == "inbox"

    # Reversibility: undecay returns archived items to inbox
    db.undecay(conn, apply=True)
    conn.commit()

    rows = conn.execute(
        "SELECT status FROM items WHERE source_id LIKE 'sci_inbox_%'"
    ).fetchall()
    for (status,) in rows:
        assert status == "inbox"

    # Non-knowledge cluster raises ValueError
    with pytest.raises(ValueError):
        resurface.let_it_go(conn, "memes")
