"""Tests for the RedGifs resolver (WP2 T25).

Offline unit tests for URL parsing + id extraction; the network-dependent
resolve functions are tested with a synthetic token + mocked responses.
"""

import json

from content_hoarder import db, models
from content_hoarder import redgifs_resolver as rg


def mk(**kw):
    kw.setdefault("now", 1000)
    return models.new_item(**kw)


# ---------------------------------------------------------------------------
# URL parsing
# ---------------------------------------------------------------------------


def test_extract_gfycat_id_simple():
    assert rg.extract_gfycat_id("https://gfycat.com/lazyfatcat") == "lazyfatcat"


def test_extract_gfycat_id_ifr():
    assert rg.extract_gfycat_id("https://gfycat.com/ifr/Xyz123") == "Xyz123"


def test_extract_gfycat_id_detail():
    assert rg.extract_gfycat_id("https://gfycat.com/gifs/detail/TestId") == "TestId"


def test_extract_gfycat_id_gallery():
    assert rg.extract_gfycat_id("https://gfycat.com/gallery/MyGallery") == "MyGallery"


def test_extract_gfycat_id_no_match():
    assert rg.extract_gfycat_id("https://example.com/video.mp4") is None


def test_extract_gfycat_id_empty():
    assert rg.extract_gfycat_id("") is None
    assert rg.extract_gfycat_id(None) is None


# ---------------------------------------------------------------------------
# ID conversion
# ---------------------------------------------------------------------------


def test_gfycat_to_redgifs_id():
    assert rg.gfycat_to_redgifs_id("lazyfatcat") == "Lazyfatcat"
    assert rg.gfycat_to_redgifs_id("abc") == "Abc"
    assert rg.gfycat_to_redgifs_id("a") == "A"
    assert rg.gfycat_to_redgifs_id("") == ""
    assert rg.gfycat_to_redgifs_id(None) is None


# ---------------------------------------------------------------------------
# rewrite_item
# ---------------------------------------------------------------------------


def test_rewrite_item(conn):
    db.merge_upsert(
        conn,
        mk(
            source="reddit",
            source_id="t3_gfy",
            metadata={
                "media_url": "https://gfycat.com/lazyfatcat",
                "media_type": "gif",
            },
        ),
    )
    info = {
        "redgifs_url": "https://redgifs.com/watch/Lazyfatcat",
        "media_url": "https://media.redgifs.com/Lazyfatcat.mp4",
        "media_type": "redgifs_video",
        "poster_url": "https://media.redgifs.com/Lazyfatcat.jpg",
        "gfycat_id": "lazyfatcat",
    }
    assert rg.rewrite_item(conn, "reddit:t3_gfy", info) is True
    md = json.loads(db.get_item(conn, "reddit:t3_gfy")["metadata"])
    assert md["media_url"] == "https://media.redgifs.com/Lazyfatcat.mp4"
    assert md["media_type"] == "redgifs_video"
    assert md["redgifs_url"] == "https://redgifs.com/watch/Lazyfatcat"
    assert md["media_resolved_from"] == "redgifs"


def test_rewrite_item_missing(conn):
    assert rg.rewrite_item(conn, "reddit:nonexistent", {"redgifs_url": "x"}) is False


def test_rewrite_item_no_info(conn):
    db.merge_upsert(conn, mk(source="reddit", source_id="t3_x"))
    assert rg.rewrite_item(conn, "reddit:t3_x", None) is False


# ---------------------------------------------------------------------------
# resolve_all (no network — uses DB query logic only)
# ---------------------------------------------------------------------------


def test_resolve_all_skips_already_resolved(conn):
    """Items with media_resolved_from set are skipped."""
    db.merge_upsert(
        conn,
        mk(
            source="reddit",
            source_id="t3_a",
            metadata={
                "media_url": "https://gfycat.com/xxx",
                "media_resolved_from": "redgifs",
            },
        ),
    )
    res = rg.resolve_all(conn, dry_run=True)
    assert res["total"] == 0


def test_resolve_all_skips_no_gfycat_url(conn):
    """Items without gfycat URL are not selected."""
    db.merge_upsert(
        conn,
        mk(
            source="reddit",
            source_id="t3_a",
            metadata={"media_url": "https://v.redd.it/abc.mp4"},
        ),
    )
    res = rg.resolve_all(conn, dry_run=True)
    assert res["total"] == 0


# ---------------------------------------------------------------------------
# CLI wiring / explicit RedGifs opt-in gate
# ---------------------------------------------------------------------------


def _add_gfycat_item(conn):
    db.merge_upsert(
        conn,
        mk(
            source="reddit",
            source_id="t3_cli_gfy",
            title="keep me",
            status="keep",
            metadata={
                "media_url": "https://gfycat.com/lazyfatcat",
                "media_type": "gif",
                "unrelated": "preserve",
            },
        ),
    )
    conn.commit()


def _resolved_info():
    return {
        "redgifs_url": "https://redgifs.com/watch/Lazyfatcat",
        "media_url": "https://media.redgifs.com/Lazyfatcat.mp4",
        "media_type": "redgifs_video",
        "poster_url": "https://media.redgifs.com/Lazyfatcat.jpg",
        "gfycat_id": "lazyfatcat",
    }


def test_cli_parser_exposes_resolve_redgifs():
    from content_hoarder import cli

    parser = cli.build_parser()
    args = parser.parse_args(["resolve-redgifs", "--limit", "7", "--redgifs-ok", "--apply"])

    assert args.command == "resolve-redgifs"
    assert args.limit == 7
    assert args.redgifs_ok is True
    assert args.apply is True


def test_resolve_all_without_opt_in_counts_candidates_without_network(conn, monkeypatch):
    _add_gfycat_item(conn)

    def boom(_url):
        raise AssertionError("resolve_gfycat must not be called without explicit RedGifs opt-in")

    monkeypatch.setattr(rg, "resolve_gfycat", boom)
    res = rg.resolve_all(conn, dry_run=True, allow_network=False)

    assert res["total"] == 1
    assert res["resolved"] == 0
    assert res["failed"] == 0
    assert res["dry_run"] is True
    assert res["network"] is False
    assert res["requires_opt_in"] is True
    assert "redgifs-ok" in res["message"]

    md = json.loads(db.get_item(conn, "reddit:t3_cli_gfy")["metadata"])
    assert md["media_url"] == "https://gfycat.com/lazyfatcat"
    assert md["unrelated"] == "preserve"


def test_resolve_all_opt_in_dry_run_does_not_rewrite(conn, monkeypatch):
    _add_gfycat_item(conn)
    monkeypatch.setattr(rg, "resolve_gfycat", lambda url: _resolved_info())

    res = rg.resolve_all(conn, dry_run=True, allow_network=True)

    assert res["total"] == 1
    assert res["resolved"] == 1
    assert res["failed"] == 0
    assert res["dry_run"] is True
    assert res["network"] is True
    assert res["samples"] == [
        {
            "fullname": "reddit:t3_cli_gfy",
            "gfycat_id": "lazyfatcat",
            "redgifs_url": "https://redgifs.com/watch/Lazyfatcat",
        }
    ]

    md = json.loads(db.get_item(conn, "reddit:t3_cli_gfy")["metadata"])
    assert md["media_url"] == "https://gfycat.com/lazyfatcat"
    assert "redgifs_url" not in md
    assert md["unrelated"] == "preserve"


def test_resolve_all_opt_in_apply_rewrites_metadata_only(conn, monkeypatch):
    _add_gfycat_item(conn)
    monkeypatch.setattr(rg, "resolve_gfycat", lambda url: _resolved_info())

    res = rg.resolve_all(conn, dry_run=False, allow_network=True)

    assert res["total"] == 1
    assert res["resolved"] == 1
    assert res["failed"] == 0
    assert res["dry_run"] is False
    assert res["network"] is True

    row = db.get_item(conn, "reddit:t3_cli_gfy")
    assert row["status"] == "keep"
    assert row["title"] == "keep me"
    md = json.loads(row["metadata"])
    assert md["media_url"] == "https://media.redgifs.com/Lazyfatcat.mp4"
    assert md["media_type"] == "redgifs_video"
    assert md["thumbnail"] == "https://media.redgifs.com/Lazyfatcat.jpg"
    assert md["redgifs_url"] == "https://redgifs.com/watch/Lazyfatcat"
    assert md["gfycat_id"] == "lazyfatcat"
    assert md["media_resolved_from"] == "redgifs"
    assert isinstance(md["media_resolved_at"], int)
    assert md["unrelated"] == "preserve"
