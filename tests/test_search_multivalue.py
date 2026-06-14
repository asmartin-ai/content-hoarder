"""Tests for multi-value search operators (Model B).

Covers comma/pipe multi-value, same-key repetition, and DB-layer IN filtering
for source, kind, status, subreddit, and has.
"""

from content_hoarder import db, models
from content_hoarder.search_query import parse


# ── Parser tests ──────────────────────────────────────────────────────────────


def test_source_comma_multivalue():
    q = parse("source:reddit,youtube")
    assert q.source == ["reddit", "youtube"]
    assert q.text == ""


def test_source_repetition_multivalue():
    q = parse("source:reddit source:youtube")
    assert q.source == ["reddit", "youtube"]


def test_source_single_stays_str():
    q = parse("source:Reddit")
    assert q.source == "reddit"
    assert not isinstance(q.source, list)


def test_kind_pipe_and_status_comma():
    q = parse("kind:post|comment status:inbox,done")
    assert q.kind == ["post", "comment"]
    assert q.status == ["inbox", "done"]


def test_has_multivalue():
    q = parse("has:video|gallery")
    assert q.has == ["video", "gallery"]


def test_has_invalid_part_degrades():
    q = parse("has:video|bogus")
    assert q.has is None
    assert "has:video|bogus" in q.text


def test_has_repetition_valid():
    q = parse("has:video has:image")
    assert q.has == ["video", "image"]


def test_and_remains_free_text():
    q = parse("source:reddit AND source:youtube")
    assert q.source == ["reddit", "youtube"]
    assert "AND" in q.text


# ── DB layer tests ────────────────────────────────────────────────────────────


def test_db_source_list_filter(conn):
    items = [
        models.new_item(source="reddit", source_id="1", metadata={}),
        models.new_item(source="youtube", source_id="2", metadata={}),
        models.new_item(source="hn", source_id="3", metadata={}),
    ]
    for item in items:
        db.merge_upsert(conn, item)

    rows = db.search_items(conn, "", source=["reddit", "youtube"])
    fullnames = {r["fullname"] for r in rows}
    assert fullnames == {"reddit:1", "youtube:2"}


def test_db_source_str_backcompat(conn):
    items = [
        models.new_item(source="reddit", source_id="1", metadata={}),
        models.new_item(source="youtube", source_id="2", metadata={}),
    ]
    for item in items:
        db.merge_upsert(conn, item)

    rows = db.search_items(conn, "", source="reddit")
    fullnames = {r["fullname"] for r in rows}
    assert fullnames == {"reddit:1"}


def test_db_has_media_list_filter(conn):
    items = [
        models.new_item(source="reddit", source_id="1", metadata={"media_type": "reddit_video"}),
        models.new_item(source="reddit", source_id="2", metadata={"media_type": "image"}),
        models.new_item(source="reddit", source_id="3", metadata={"media_type": "link"}),
    ]
    for item in items:
        db.merge_upsert(conn, item)

    rows = db.search_items(conn, "", has_media=["video", "image"])
    fullnames = {r["fullname"] for r in rows}
    assert fullnames == {"reddit:1", "reddit:2"}


def test_db_hide_nsfw_filter(conn):
    items = [
        models.new_item(source="reddit", source_id="1", metadata={"tags": ["nsfw_erotic"]}),
        models.new_item(source="reddit", source_id="2", metadata={"tags": ["coding"]}),
        models.new_item(source="reddit", source_id="3", metadata={"tags": ["nsfw_other", "japan"]}),
        models.new_item(source="reddit", source_id="4", metadata={}),
    ]
    for item in items:
        db.merge_upsert(conn, item)

    # hide_nsfw drops anything carrying an NSFW tag; clean + untagged items stay.
    safe = {r["fullname"] for r in db.search_items(conn, "", hide_nsfw=True)}
    assert safe == {"reddit:2", "reddit:4"}

    # the existing include-filter is the exact inverse (unchanged behavior).
    nsfw = {r["fullname"] for r in db.search_items(conn, "", nsfw=True)}
    assert nsfw == {"reddit:1", "reddit:3"}

    # neither flag → all four (default behavior untouched).
    allrows = {r["fullname"] for r in db.search_items(conn, "")}
    assert allrows == {"reddit:1", "reddit:2", "reddit:3", "reddit:4"}
