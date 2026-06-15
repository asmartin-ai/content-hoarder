"""_backup_db: the shared pre-destructive-op DB backup helper (cli.py).

Previously this logic was duplicated inline in cmd_delete / cmd_reddit_hydrate_titles
and untested; pin its contract here.
"""
import sqlite3

from content_hoarder import cli, config, db, models


def test_backup_db_writes_named_recoverable_copy(tmp_path, monkeypatch):
    dbp = tmp_path / "app.db"
    monkeypatch.setattr(config, "db_path", lambda: str(dbp))
    conn = db.connect(str(dbp))
    db.merge_upsert(conn, models.new_item(source="reddit", source_id="t3_x",
                                          kind="post", title="keep me"))
    conn.commit()

    bak = cli._backup_db(conn, "pre-test")

    # named beside the live DB, with the requested suffix
    assert bak.parent == tmp_path
    assert bak.name.startswith("app.backup-pre-test-") and bak.suffix == ".db"
    assert bak.exists()
    # a real, readable copy that carries the seeded row (not an empty file)
    c2 = sqlite3.connect(str(bak))
    try:
        row = c2.execute("SELECT title FROM items WHERE fullname='reddit:t3_x'").fetchone()
    finally:
        c2.close()
    assert row is not None and row[0] == "keep me"
    conn.close()
