"""Bakeoff oracle — CH-B3: OCR text → FTS search wiring (``is:ocr``).

Contract:

* ``models.build_search_text(item, metadata)`` MUST fold ``metadata.ocr_text`` into
  the search blob when present.
* ``search_query.parse("is:ocr")`` MUST produce a structured operator that
  selects items carrying ``metadata.ocr_text`` (truthy) — distinct from the free
  text it parses to today, and distinct from every other ``is:`` flag
  (``deleted``, ``snoozed``, ``nsfw``, ...).
* ``db.search_items`` filtered on the ``is:ocr`` operator MUST return only items
  with a non-empty ``metadata.ocr_text`` and MUST exclude items without one.
* An item WITHOUT ``metadata.ocr_text`` MUST produce a ``search_text`` byte
  identical to the same item built with ``ocr_text`` absent (the ocr fold is
  strictly additive — no whitespace restructuring on items that have no ocr).
"""

from content_hoarder import db, models, search_query


def _md(**kw):
    return kw


def test_build_search_text_includes_ocr_text():
    md = _md(ocr_text="hello world ocr")
    st = models.build_search_text({"title": "T", "body": "B", "author": "A"}, md)
    assert "hello world ocr" in st


def test_build_search_text_no_ocr_is_byte_identical_to_absent():
    item = {"title": "T", "body": "B", "author": "A"}
    without = models.build_search_text(item, _md())
    # An empty/None ocr_text must produce the same blob as no ocr_text key at all.
    assert models.build_search_text(item, _md(ocr_text="")) == without
    assert models.build_search_text(item, _md(ocr_text=None)) == without


def test_is_ocr_operator_parses_to_structured_filter():
    pq = search_query.parse("is:ocr")
    # Must NOT degrade to free text.
    assert pq.text == ""
    # Must expose a distinct boolean for ocr (the field name is the implementer's
    # choice; this oracle only asserts it is truthy and distinct from existing flags).
    assert _ocr_flag(pq) is True
    # Existing flags must remain unaffected.
    assert pq.deleted is False
    assert pq.nsfw is False
    assert pq.snoozed is False
    assert pq.decayed is False


def _ocr_flag(pq):
    # Tolerant accessor: any field whose name suggests ocr counts; the contract is
    # "is:ocr produces a structured flag distinct from free text", not a field name.
    for name in ("ocr", "is_ocr", "has_ocr"):
        v = getattr(pq, name, None)
        if v:
            return v
    return None


def test_search_items_is_ocr_returns_only_items_with_ocr_text(conn):
    db.init_db(conn)
    with_ocr = models.new_item(
        source="reddit",
        source_id="1",
        title="A",
        body="",
        metadata={"ocr_text": "scanned text"},
        now=100,
    )
    without_ocr = models.new_item(
        source="reddit",
        source_id="2",
        title="B",
        body="",
        now=100,
    )
    db.merge_upsert(conn, with_ocr)
    db.merge_upsert(conn, without_ocr)
    conn.commit()

    pq = search_query.parse("is:ocr")
    results = db.search_items(conn, **_is_ocr_kwarg(pq))
    fullnames = {r["fullname"] for r in results}
    assert f"reddit:1" in fullnames
    assert f"reddit:2" not in fullnames


def _is_ocr_kwarg(pq):
    # Pass the parsed flag through to search_items by the same name search_query
    # exposed. Tolerant of the implementer's field-name choice.
    for name in ("ocr", "is_ocr", "has_ocr"):
        v = getattr(pq, name, None)
        if v:
            return {name: True}
    # Fallback: a direct keyword the implementer would plausibly accept.
    return {"is_ocr": True}
