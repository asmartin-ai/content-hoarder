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


def test_keep_iso_createTime_parsed_to_utc_epoch(tmp_path: Path) -> None:
    """ISO-8601 createTime strings resolve to the correct UTC epoch."""
    f = tmp_path / "iso_note.json"
    f.write_text(
        json.dumps(
            {
                "title": "ISO note",
                "textContent": "body",
                "timestamps": {
                    "createTime": "2024-01-15T10:30:00Z",
                    "updateTime": "2024-01-16T12:00:00Z",
                },
            }
        ),
        encoding="utf-8",
    )
    keep = connectors.get("keep")
    items = list(keep.import_file(f))
    assert len(items) == 1
    item = items[0]
    created = item.created_utc if hasattr(item, "created_utc") else item["created_utc"]
    saved = item.saved_utc if hasattr(item, "saved_utc") else item["saved_utc"]
    # 2024-01-15T10:30:00Z == 1705314600
    assert created == 1_705_314_600
    # 2024-01-16T12:00:00Z == 1705406400
    assert saved == 1_705_406_400


def test_keep_iso_offset_createTime_parsed_to_utc_epoch(tmp_path: Path) -> None:
    """ISO-8601 offset strings (non-Z) resolve to UTC epoch."""
    f = tmp_path / "offset_note.json"
    f.write_text(
        json.dumps(
            {
                "title": "offset note",
                "textContent": "body",
                "timestamps": {
                    "createTime": "2024-01-15T10:30:00+02:00",
                },
            }
        ),
        encoding="utf-8",
    )
    keep = connectors.get("keep")
    items = list(keep.import_file(f))
    assert len(items) == 1
    item = items[0]
    created = item.created_utc if hasattr(item, "created_utc") else item["created_utc"]
    # 2024-01-15T10:30:00+02:00 == 2024-01-15T08:30:00Z == 1705307400
    assert created == 1_705_307_400


def test_keep_invalid_timestamp_returns_zero(tmp_path: Path) -> None:
    """Invalid timestamp values (non-parseable string, garbage) yield 0."""
    f = tmp_path / "bad_ts.json"
    f.write_text(
        json.dumps(
            {
                "title": "bad ts note",
                "textContent": "body",
                "timestamps": {
                    "createTime": "not-a-timestamp",
                    "updateTime": "also-not",
                },
            }
        ),
        encoding="utf-8",
    )
    keep = connectors.get("keep")
    items = list(keep.import_file(f))
    assert len(items) == 1
    item = items[0]
    created = item.created_utc if hasattr(item, "created_utc") else item["created_utc"]
    saved = item.saved_utc if hasattr(item, "saved_utc") else item["saved_utc"]
    assert created == 0
    assert saved == 0


def test_keep_modern_checked_true_marks_complete(tmp_path: Path) -> None:
    """Modern Takeout uses `checked` (bool) for list item completion."""
    f = tmp_path / "checked_note.json"
    f.write_text(
        json.dumps(
            {
                "title": "checklist note",
                "listContent": [
                    {"text": "done item", "checked": True},
                    {"text": "undone item", "checked": False},
                ],
            }
        ),
        encoding="utf-8",
    )
    keep = connectors.get("keep")
    items = list(keep.import_file(f))
    assert len(items) == 1
    item = items[0]
    body = item.body if hasattr(item, "body") else item["body"]
    assert "[x] done item" in body
    assert "[ ] undone item" in body


def test_keep_legacy_isChecked_takes_precedence_over_modern_checked(
    tmp_path: Path,
) -> None:
    """When both `isChecked` (legacy) and `checked` (modern) exist,
    legacy isChecked takes precedence."""
    f = tmp_path / "precedence_note.json"
    f.write_text(
        json.dumps(
            {
                "title": "precedence note",
                "listContent": [
                    # legacy says unchecked, modern says checked -> legacy wins
                    {"text": "conflict item", "isChecked": False, "checked": True},
                    # only modern checked -> uses it
                    {"text": "modern only", "checked": True},
                    # only legacy isChecked -> uses it
                    {"text": "legacy only", "isChecked": True},
                ],
            }
        ),
        encoding="utf-8",
    )
    keep = connectors.get("keep")
    items = list(keep.import_file(f))
    assert len(items) == 1
    item = items[0]
    body = item.body if hasattr(item, "body") else item["body"]
    assert "[ ] conflict item" in body
    assert "[x] modern only" in body
    assert "[x] legacy only" in body
