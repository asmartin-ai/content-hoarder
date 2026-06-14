import gzip
import json

from content_hoarder import db


def test_round_trip(conn):
    """Compressed write and read returns the original plain JSON string."""
    payload = json.dumps({"hello": "world", "data": list(range(100))})
    db.set_reddit_thread(conn, "reddit:t3_x", payload)
    got = db.get_reddit_thread(conn, "reddit:t3_x")
    assert got["thread_json"] == payload


def test_actually_compressed(conn):
    """The raw stored cell is bytes and shorter than the original payload."""
    payload = json.dumps({"x": "a" * 5000})
    db.set_reddit_thread(conn, "reddit:t3_x", payload)
    row = conn.execute(
        "SELECT thread_json FROM reddit_threads WHERE fullname=?", ("reddit:t3_x",)
    ).fetchone()
    raw = row["thread_json"]
    assert isinstance(raw, bytes)
    assert len(raw) < len(payload)


def test_backward_compat(conn):
    """Legacy uncompressed (str) rows are still readable."""
    conn.execute(
        "INSERT INTO reddit_threads(fullname, thread_json, hydrated_at) "
        "VALUES('reddit:t3_legacy', '{\"a\":1}', 1)"
    )
    got = db.get_reddit_thread(conn, "reddit:t3_legacy")
    assert got["thread_json"] == '{"a":1}'
