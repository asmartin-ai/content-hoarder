"""Monotonic saved_utc ordering across multiple reddit imports (pipeline).

Reddit gives no real save time; saved_utc is synthesized from export row order. Across imports
made at different times, the blocks must stack (newer import on top) so "sort by saved newest"
stays coherent — instead of landing in disjoint wall-clock bands.
"""
import json

from content_hoarder import db, pipeline


def _csv(tmp_path, name, ids):
    p = tmp_path / name
    rows = "id,permalink\r\n" + "".join(
        f"{i},https://www.reddit.com/r/test/comments/{i}/slug/\r\n" for i in ids)
    p.write_text(rows)
    return p


def _saved(conn, source_id):
    return conn.execute("SELECT saved_utc FROM items WHERE fullname=?",
                        (f"reddit:{source_id}",)).fetchone()[0]


def test_within_import_newest_row_ranks_highest(conn, tmp_path):
    pipeline.import_path(conn, _csv(tmp_path, "a.csv", ["a1", "a2", "a3"]), source="reddit")
    # newest-first within the export: row 0 (a1) > a2 > a3, all positive
    assert _saved(conn, "t3_a1") > _saved(conn, "t3_a2") > _saved(conn, "t3_a3") > 0


def test_second_import_block_sits_above_first(conn, tmp_path):
    pipeline.import_path(conn, _csv(tmp_path, "a.csv", ["a1", "a2", "a3"]), source="reddit")
    first = [_saved(conn, f"t3_{s}") for s in ("a1", "a2", "a3")]
    pipeline.import_path(conn, _csv(tmp_path, "b.csv", ["b1", "b2"]), source="reddit")
    second = [_saved(conn, f"t3_{s}") for s in ("b1", "b2")]
    assert second[0] > second[1]
    assert min(second) > max(first)   # whole 2nd block above the whole 1st block


def test_reseen_item_takes_newest_block_rank(conn, tmp_path):
    pipeline.import_path(conn, _csv(tmp_path, "a.csv", ["x", "y"]), source="reddit")
    x_first = _saved(conn, "t3_x")
    pipeline.import_path(conn, _csv(tmp_path, "b.csv", ["x", "z"]), source="reddit")  # x re-seen
    assert _saved(conn, "t3_x") > x_first   # newest-export-wins


def test_bulk_json_dump_is_not_reranked(conn, tmp_path):
    p = tmp_path / "dump.json"
    p.write_text(json.dumps({"name": "t3_j", "permalink": "/r/s/comments/j/slug/"}))
    pipeline.import_path(conn, p, source="reddit")
    # no saved_seen_utc marker -> left at the import default, never monotonic-stamped
    assert _saved(conn, "t3_j") == 0


def test_explicit_saved_utc_is_preserved_not_reranked(conn, tmp_path):
    # An export carrying a REAL saved time keeps it — the monotonic re-rank only touches rows
    # that lack one (synthetic ordering), never clobbers a genuine timestamp.
    p = tmp_path / "withsaved.csv"
    p.write_text("id,permalink,saved_utc\r\n"
                 "e1,https://www.reddit.com/r/test/comments/e1/slug/,1600000000\r\n")
    pipeline.import_path(conn, p, source="reddit")
    assert _saved(conn, "t3_e1") == 1600000000
