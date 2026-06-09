"""Direct tests for the RSM thread-cache migration (delegation/10). The fake RSM DB
mirrors only the columns migrate_threads reads; it is opened read-only by the migration."""

import sqlite3

import pytest

from content_hoarder import db, models, rsm_threads


def _rsm_db(tmp_path, rows):
    p = tmp_path / "rsm.db"
    c = sqlite3.connect(p)
    c.execute("CREATE TABLE items (fullname TEXT, thread_json TEXT, hydrated_at INTEGER)")
    c.executemany("INSERT INTO items VALUES (?, ?, ?)", rows)
    c.commit()
    c.close()
    return p


def _seed_local(conn, *sids):
    for sid in sids:
        db.merge_upsert(conn, models.new_item(source="reddit", source_id=sid,
                                              kind="post", title=sid))
    conn.commit()


def test_migrates_and_rekeys(conn, tmp_path):
    _seed_local(conn, "t3_x", "t3_y")
    rsm = _rsm_db(tmp_path, [("t3_x", '{"a":1}', 5),          # bare -> re-keyed
                             ("reddit:t3_y", '{"b":2}', 6)])  # already prefixed -> kept
    res = rsm_threads.migrate_threads(conn, rsm)
    assert res == {"migrated": 2, "skipped": 0}
    assert db.get_reddit_thread(conn, "reddit:t3_x")["thread_json"] == '{"a":1}'
    assert db.get_reddit_thread(conn, "reddit:t3_y")["thread_json"] == '{"b":2}'


def test_only_existing_skips_orphans(conn, tmp_path):
    rsm = _rsm_db(tmp_path, [("t3_orphan", '{"o":1}', 10)])
    res = rsm_threads.migrate_threads(conn, rsm, only_existing=True)
    assert res == {"migrated": 0, "skipped": 1}
    assert db.get_reddit_thread(conn, "reddit:t3_orphan") is None
    res = rsm_threads.migrate_threads(conn, rsm, only_existing=False)
    assert res["migrated"] == 1
    assert db.get_reddit_thread(conn, "reddit:t3_orphan") is not None


def test_blank_fullname_skipped(conn, tmp_path):
    rsm = _rsm_db(tmp_path, [("   ", '{"x":1}', 1)])
    assert rsm_threads.migrate_threads(conn, rsm) == {"migrated": 0, "skipped": 1}


def test_missing_rsm_path_raises(conn, tmp_path):
    with pytest.raises(ValueError, match="RSM database not found"):
        rsm_threads.migrate_threads(conn, tmp_path / "nonexistent.db")


def test_empty_thread_json_excluded(conn, tmp_path):
    # The SQL WHERE excludes empty/NULL thread_json entirely -> neither counter moves.
    _seed_local(conn, "t3_e")
    rsm = _rsm_db(tmp_path, [("t3_e", "", 1), ("t3_f", None, 1)])
    assert rsm_threads.migrate_threads(conn, rsm) == {"migrated": 0, "skipped": 0}
    assert db.get_reddit_thread(conn, "reddit:t3_e") is None
