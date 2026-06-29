from content_hoarder import db, models


def test_ocr_text_included_in_search_text():
    item = models.new_item(
        source="r",
        source_id="1",
        title="",
        metadata={"ocr_text": "captcha"},
    )
    assert "captcha" in item["search_text"]


def test_search_finds_ocr_only_term(conn):
    db.merge_upsert(
        conn,
        models.new_item(
            source="r",
            source_id="1",
            title="",
            metadata={"ocr_text": "helloocr"},
        ),
    )
    hits = db.search_items(conn, "helloocr")
    assert any(r["fullname"] == "r:1" for r in hits)


def test_ocr_text_recomputes_on_merge_upsert(conn):
    db.merge_upsert(
        conn,
        models.new_item(
            source="r",
            source_id="1",
            title="some title",
            metadata={},
        ),
    )
    hits = db.search_items(conn, "ocrterm")
    assert not hits

    db.merge_upsert(
        conn,
        models.new_item(
            source="r",
            source_id="1",
            title="some title",
            metadata={"ocr_text": "ocrterm"},
        ),
    )
    hits = db.search_items(conn, "ocrterm")
    assert any(r["fullname"] == "r:1" for r in hits)
