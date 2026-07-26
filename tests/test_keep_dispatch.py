import json
from pathlib import Path

import pytest

from content_hoarder import connectors


def test_keep_export_dir_dispatches_to_keep(tmp_path: Path) -> None:
    d = tmp_path / "keep_export"
    d.mkdir()
    (d / "note1.json").write_text(
        json.dumps(
            {"title": "x", "textContent": "hello", "createdTimestampMs": 1700000000000}
        ),
        encoding="utf-8",
    )
    (d / "note2.json").write_text(
        json.dumps({"foo": 1}),
        encoding="utf-8",
    )
    assert connectors.dispatch(d).id == "keep"


def test_reddit_dir_outranks_keep_and_keep_sniff_false(tmp_path: Path) -> None:
    d = tmp_path / "reddit_export"
    d.mkdir()
    (d / "post.json").write_text(
        json.dumps(
            {
                "title": "t",
                "name": "t3_abc",
                "id": "abc",
                "subreddit": "pics",
                "permalink": "/r/pics/comments/abc/t/",
            }
        ),
        encoding="utf-8",
    )
    assert connectors.dispatch(d).id == "reddit"
    assert connectors.get("keep").can_import(d) is False


def test_generic_json_dir_no_match(tmp_path: Path) -> None:
    d = tmp_path / "generic"
    d.mkdir()
    (d / "data.json").write_text(
        json.dumps({"foo": "bar"}),
        encoding="utf-8",
    )
    assert connectors.get("keep").can_import(d) is False
    assert connectors.get("reddit").can_import(d) is False


def test_keep_single_file_imports(tmp_path: Path) -> None:
    f = tmp_path / "note.json"
    f.write_text(
        json.dumps({"title": "RoundTripTitle", "textContent": "body"}),
        encoding="utf-8",
    )
    keep = connectors.get("keep")
    assert keep.can_import(f) is True
    items = list(keep.import_file(f))
    assert len(items) == 1
    title = items[0].title if hasattr(items[0], "title") else items[0]["title"]
    assert title == "RoundTripTitle"


def test_empty_dir_keep_false(tmp_path: Path) -> None:
    d = tmp_path / "empty"
    d.mkdir()
    assert connectors.get("keep").can_import(d) is False


def test_keep_modern_takeout_format_with_timestamps(tmp_path: Path) -> None:
    """Modern Takeout uses microsecond-epoch under `timestamps.createdTime`
    instead of `createdTimestampMs` (millisecond-epoch). The connector
    should fall back so a single import works against any export shape.
    See PKMS keep_takeout.py for the matching parser."""
    f = tmp_path / "modern.json"
    f.write_text(
        json.dumps(
            {
                "title": "modern note",
                "textContent": "body",
                "timestamps": {
                    "createTime": 1_700_000_000_000_000,  # microseconds
                    "updateTime": 1_700_000_100_000_000,
                },
                "labels": [{"name": "shopping"}],
                "isPinned": True,
            }
        ),
        encoding="utf-8",
    )
    keep = connectors.get("keep")
    assert keep.can_import(f) is True
    items = list(keep.import_file(f))
    assert len(items) == 1
    item = items[0]
    title = item.title if hasattr(item, "title") else item["title"]
    created = item.created_utc if hasattr(item, "created_utc") else item["created_utc"]
    assert title == "modern note"
    # microsecond epoch / 1_000_000 = Unix second
    assert created == 1_700_000_000


def test_keep_sync_raises_with_clear_message() -> None:
    """Live sync lives in PKMS, not CH. The connector raises a clear
    NotImplementedError that points the user at the right project."""
    keep = connectors.get("keep")
    with pytest.raises(NotImplementedError) as exc:
        list(keep.sync())
    assert "PKMS" in str(exc.value)
    assert "ADR 0028" in str(exc.value)
