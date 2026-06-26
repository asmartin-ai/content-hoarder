import json
from pathlib import Path

from content_hoarder import db, models
from content_hoarder.web import create_app


NOW = 1_700_000_000
DAY = 86_400


def _insert(conn, source_id, *, status="inbox", processed_utc=None, title=None):
    item = models.new_item(
        source="reddit",
        source_id=source_id,
        kind="post",
        title=title or source_id,
        url=f"https://example.test/{source_id}",
    )
    db.merge_upsert(conn, item)
    conn.execute(
        "UPDATE items SET status=?, processed_utc=? WHERE fullname=?",
        (status, processed_utc, f"reddit:{source_id}"),
    )


def _seed_retention_rows(db_path):
    with db.connect(db_path) as conn:
        _insert(conn, "old_done", status="done", processed_utc=NOW - 45 * DAY, title="Old Done")
        _insert(conn, "recent_done", status="done", processed_utc=NOW - 5 * DAY, title="Recent Done")
        _insert(conn, "old_archive", status="archived", processed_utc=NOW - 45 * DAY, title="Old Archive")
        conn.commit()


def _client(tmp_db, monkeypatch):
    _seed_retention_rows(tmp_db)
    import content_hoarder.web as web

    monkeypatch.setattr(web.time, "time", lambda: NOW)
    return create_app(tmp_db).test_client()


def test_done_retention_get_preview_and_default(tmp_db, monkeypatch):
    cl = _client(tmp_db, monkeypatch)
    data = cl.get("/settings/done-retention").get_json()

    assert data["retention_days"] == 30
    assert data["preview"]["total"] == 1
    assert data["preview"]["cutoff"] == NOW - 30 * DAY
    assert data["preview"]["sample"] == ["reddit: Old Done"]


def test_done_retention_post_persists_and_validates(tmp_db, monkeypatch):
    cl = _client(tmp_db, monkeypatch)

    data = cl.post("/settings/done-retention", json={"retention_days": 7}).get_json()
    assert data["retention_days"] == 7
    assert data["preview"]["total"] == 1

    with db.connect(tmp_db) as conn:
        assert db.get_setting(conn, "done_retention_days") == "7"

    bad = cl.post("/settings/done-retention", json={"retention_days": 0})
    assert bad.status_code == 400
    assert "retention_days" in bad.get_json()["error"]


def test_done_retention_purge_rejects_stale_preview(tmp_db, monkeypatch):
    cl = _client(tmp_db, monkeypatch)
    preview = cl.get("/settings/done-retention").get_json()["preview"]

    res = cl.post(
        "/settings/done-retention/purge",
        json={"expected_total": preview["total"] + 1, "expected_cutoff": preview["cutoff"]},
    )

    assert res.status_code == 409
    assert res.get_json()["preview"]["total"] == 1


def test_done_retention_purge_applies_backup_audit_and_only_done(tmp_db, monkeypatch, tmp_path):
    cl = _client(tmp_db, monkeypatch)
    preview = cl.get("/settings/done-retention").get_json()["preview"]

    res = cl.post(
        "/settings/done-retention/purge",
        json={"expected_total": preview["total"], "expected_cutoff": preview["cutoff"]},
    )

    assert res.status_code == 200
    data = res.get_json()
    assert data["purged"]["total"] == 1
    assert data["preview"]["total"] == 0

    with db.connect(tmp_db) as conn:
        fullnames = {
            r[0]
            for r in conn.execute("SELECT fullname FROM items ORDER BY fullname").fetchall()
        }
    assert "reddit:old_done" not in fullnames
    assert {"reddit:recent_done", "reddit:old_archive"} <= fullnames

    assert Path(data["purged"]["backup"]).exists()

    audit_path = tmp_path / "delete-audit.jsonl"
    audit = json.loads(audit_path.read_text(encoding="utf-8").splitlines()[-1])
    assert audit["op"] == "purge_done"
    assert audit["total"] == 1
    assert audit["victims"][0]["fullname"] == "reddit:old_done"
