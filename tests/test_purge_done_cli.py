"""purge-done CLI wrapper (Epic 21 P2): the money-action-safe entrypoint around
db.purge_done — dry-run default, --apply/--yes double gate, auto backup + audit log,
and the --retention-days window override. The db.purge_done primitive is tested
separately; this pins the CLI gate + backup + audit behaviour."""
import argparse
import json
import time

from content_hoarder import cli, config, db, models


def _ns(**kw):
    base = dict(apply=False, yes=False, max=5000, retention_days=None)
    base.update(kw)
    return argparse.Namespace(**base)


def _seed(dbp):
    conn = db.connect(str(dbp))
    db.set_setting(conn, "done_retention_days", "30")
    rows = [("t3_old", "done", 1_000_000),                 # ancient Done -> purgeable
            ("t3_new", "done", int(time.time())),          # recent Done  -> kept
            ("t3_in", "inbox", None)]                      # inbox        -> never touched
    for sid, status, proc in rows:
        db.merge_upsert(conn, models.new_item(source="reddit", source_id=sid,
                                              kind="post", title=sid))
        conn.execute("UPDATE items SET status=?, processed_utc=? WHERE fullname=?",
                     (status, proc, f"reddit:{sid}"))
    conn.commit()
    conn.close()


def test_purge_done_dry_run_gate_then_apply(tmp_path, monkeypatch):
    dbp = tmp_path / "app.db"
    monkeypatch.setattr(config, "db_path", lambda: str(dbp))
    _seed(dbp)

    # dry run (default): reports, writes nothing
    assert cli.cmd_purge_done(_ns()) == 0
    conn = db.connect(str(dbp))
    assert conn.execute("SELECT COUNT(*) FROM items").fetchone()[0] == 3
    conn.close()

    # --apply without --yes: refuses (exit 3), still nothing deleted, no backup
    assert cli.cmd_purge_done(_ns(apply=True)) == 3
    assert not list(tmp_path.glob("app.backup-*"))
    conn = db.connect(str(dbp))
    assert conn.execute("SELECT COUNT(*) FROM items").fetchone()[0] == 3
    conn.close()

    # --apply --yes: purges only the ancient Done; backup + audit written
    assert cli.cmd_purge_done(_ns(apply=True, yes=True)) == 0
    conn = db.connect(str(dbp))
    remaining = {r[0] for r in conn.execute("SELECT fullname FROM items")}
    conn.close()
    assert remaining == {"reddit:t3_new", "reddit:t3_in"}

    assert any(p.name.startswith("app.backup-pre-purge-done-") for p in tmp_path.iterdir())
    audit = tmp_path / "delete-audit.jsonl"
    rec = json.loads(audit.read_text(encoding="utf-8").strip().splitlines()[-1])
    assert rec["op"] == "purge_done" and rec["total"] == 1
    assert rec["victims"][0]["fullname"] == "reddit:t3_old"


def test_purge_done_retention_days_override_persists(tmp_path, monkeypatch):
    dbp = tmp_path / "app.db"
    monkeypatch.setattr(config, "db_path", lambda: str(dbp))
    conn = db.connect(str(dbp))
    db.merge_upsert(conn, models.new_item(source="reddit", source_id="t3_a",
                                          kind="post", title="a"))
    five_days_ago = int(time.time()) - 5 * 86400
    conn.execute("UPDATE items SET status='done', processed_utc=? WHERE fullname='reddit:t3_a'",
                 (five_days_ago,))
    conn.commit()
    conn.close()

    # default 30d window: the 5-day-old Done is NOT yet purgeable
    assert cli.cmd_purge_done(_ns()) == 0
    conn = db.connect(str(dbp))
    assert conn.execute("SELECT COUNT(*) FROM items").fetchone()[0] == 1
    # --retention-days 1 persists the setting; now it qualifies
    assert cli.cmd_purge_done(_ns(retention_days=1)) == 0  # dry run
    assert db.get_setting(conn, "done_retention_days") == "1"
    conn.close()
    assert cli.cmd_purge_done(_ns(retention_days=1, apply=True, yes=True)) == 0
    conn = db.connect(str(dbp))
    assert conn.execute("SELECT COUNT(*) FROM items").fetchone()[0] == 0
    conn.close()
