import pytest

from content_hoarder import categorize as cat
from content_hoarder import db, models
from content_hoarder.models import parse_metadata


def test_youtube_tags_channel_hit():
    item = {
        "title": "Black Holes Explained",
        "metadata": {"channel": "Kurzgesagt – In a Nutshell"},
    }
    assert cat.youtube_tags(item) == ["science"]


def test_youtube_tags_multi_label():
    item = {
        "title": "x",
        "metadata": {"channel": "Kurzgesagt abroad in japan"},
    }
    assert cat.youtube_tags(item) == ["science", "japan"]


def test_youtube_tags_keyword_fallback_only_when_channel_misses():
    item = {
        "title": "Minecraft Speedrun",
        "metadata": {"channel": "Some Channel"},
    }
    assert cat.youtube_tags(item) == ["minecraft"]

    item = {
        "title": "Minecraft Speedrun",
        "metadata": {"channel": "Kurzgesagt"},
    }
    assert cat.youtube_tags(item) == ["science"]


def test_youtube_tags_no_match():
    item = {
        "title": "Random Video",
        "metadata": {"channel": "Unknown Channel"},
    }
    assert cat.youtube_tags(item) == []


def test_youtube_preservation(conn):
    fn = "youtube:test|preservation"
    item = models.new_item(
        source_id=fn.split(":", 1)[1],
        source="youtube",
        title="Science",
        metadata={"channel": "Kurzgesagt"},
    )
    db.merge_upsert(conn, item)
    db.set_category(conn, fn, "listenable")
    res = cat.tag_youtube_source(conn, limit=10)
    assert res["tagged"] == 1
    row = db.get_item(conn, fn)
    md = parse_metadata(row["metadata"])
    assert sorted(md["tags"]) == ["listenable", "science"]
    assert md["tags_auto"] == ["science"]
    assert md["category"] == "listenable"


def test_youtube_keyword_noise_drop(conn):
    fn = "youtube:test|noise"
    item = models.new_item(
        source_id=fn.split(":", 1)[1],
        source="youtube",
        title="Science",
        metadata={"channel": "Kurzgesagt", "tags": ["watch", "arduino", "diy reflow"]},
    )
    db.merge_upsert(conn, item)
    res = cat.tag_youtube_source(conn, limit=10)
    assert res["tagged"] == 1
    row = db.get_item(conn, fn)
    md = parse_metadata(row["metadata"])
    assert md["tags"] == ["watch", "science"]
    assert md["tags_auto"] == ["science"]


def test_youtube_dry_run(conn):
    fn = "youtube:test|dry"
    item = models.new_item(
        source_id=fn.split(":", 1)[1],
        source="youtube",
        title="Science",
        metadata={"channel": "Kurzgesagt"},
    )
    db.merge_upsert(conn, item)
    res = cat.tag_youtube_source(conn, limit=10, dry_run=True)
    assert res["dry_run"] is True
    assert res["tagged"] == 1
    row = db.get_item(conn, fn)
    assert parse_metadata(row["metadata"]).get("tags") is None


def test_youtube_skip_logic(conn):
    fn = "youtube:test|skip"
    item = models.new_item(
        source_id=fn.split(":", 1)[1],
        source="youtube",
        title="Science",
        metadata={"channel": "Kurzgesagt", "tags": ["listenable", "science"]},
    )
    db.merge_upsert(conn, item)
    # retry=False should skip
    res = cat.tag_youtube_source(conn, limit=10, retry=False)
    assert res["tagged"] == 0
    assert res["selected"] == 0
    row = db.get_item(conn, fn)
    assert sorted(parse_metadata(row["metadata"])["tags"]) == ["listenable", "science"]
    # retry=True should re-tag
    res = cat.tag_youtube_source(conn, limit=10, retry=True)
    assert res["tagged"] == 1
    row = db.get_item(conn, fn)
    assert sorted(parse_metadata(row["metadata"])["tags"]) == ["listenable", "science"]
