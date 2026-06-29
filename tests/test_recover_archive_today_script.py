import importlib.util
import io
import json
import sys
from pathlib import Path
from typing import Any

from content_hoarder import db, models

ROOT = Path(__file__).resolve().parents[1]
SCRIPT_PATH = ROOT / "scripts" / "recover_archive_today.py"


def _load_script():
    spec = importlib.util.spec_from_file_location(
        "recover_archive_today_script", SCRIPT_PATH
    )
    assert spec is not None
    assert spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


def _seed_gone(dbp: str, *, fullname: str = "reddit:t3_gone", archived: bool = False):
    conn = db.connect(dbp)
    source, source_id = fullname.split(":", 1)
    md: dict[str, Any] = {
        "media_url": "https://i.redd.it/dead.jpg",
        "media_status": "gone",
    }
    if archived:
        md["archived_media"] = {"https://i.redd.it/dead.jpg": "abc.png"}
    db.merge_upsert(
        conn,
        models.new_item(
            source=source,
            source_id=source_id,
            kind="post",
            title="Gone media",
            metadata=md,
        ),
    )
    conn.commit()
    conn.close()


def test_archive_today_smoke_plan_no_network_no_report(tmp_db, monkeypatch):
    _seed_gone(tmp_db)
    monkeypatch.setenv("CONTENT_HOARDER_DB", tmp_db)
    script = _load_script()
    monkeypatch.setattr(
        script,
        "default_media_providers",
        lambda *a, **k: (_ for _ in ()).throw(
            AssertionError("network provider constructed")
        ),
    )

    out = io.StringIO()
    code = script.main(["--fullname", "reddit:t3_gone"], out=out)

    assert code == 0
    text = out.getvalue()
    assert "Mode: plan" in text
    assert "Eligible items: 1" in text
    assert "i.redd.it" in text
    assert not (Path(tmp_db).parent / script.REPORT_NAME).exists()


def test_archive_today_smoke_probe_requires_live_env(tmp_db, monkeypatch):
    _seed_gone(tmp_db)
    monkeypatch.setenv("CONTENT_HOARDER_DB", tmp_db)
    script = _load_script()

    out = io.StringIO()
    code = script.main(["--probe", "--fullname", "reddit:t3_gone"], out=out, env={})

    assert code == 2
    assert "CONTENT_HOARDER_ARCHIVE_TODAY_LIVE=1" in out.getvalue()


def test_archive_today_smoke_apply_requires_yes(tmp_db, monkeypatch):
    _seed_gone(tmp_db)
    monkeypatch.setenv("CONTENT_HOARDER_DB", tmp_db)
    script = _load_script()

    out = io.StringIO()
    code = script.main(
        ["--apply", "--fullname", "reddit:t3_gone"], out=out, env={script.LIVE_ENV: "1"}
    )

    assert code == 2
    assert "--apply requires --yes" in out.getvalue()


def test_archive_today_smoke_apply_refuses_live_db(monkeypatch):
    script = _load_script()
    live = script._canonical_live_db()
    monkeypatch.setenv("CONTENT_HOARDER_DB", str(live))

    out = io.StringIO()
    code = script.main(
        ["--apply", "--yes", "--fullname", "reddit:t3_x"],
        out=out,
        env={script.LIVE_ENV: "1"},
    )

    assert code == 2
    assert "refusing apply against canonical live DB" in out.getvalue()


def test_archive_today_smoke_probe_report_hides_urls_by_default(tmp_db, monkeypatch):
    _seed_gone(tmp_db)
    monkeypatch.setenv("CONTENT_HOARDER_DB", tmp_db)
    script = _load_script()
    monkeypatch.setattr(script, "default_media_providers", lambda *a, **k: [object()])

    def fake_recover(conn, fullname, **kwargs):
        assert kwargs["apply_bytes"] is False
        return {
            "eligible": True,
            "attempted": True,
            "mode": "preview",
            "bytes_archived": 0,
            "snapshot_candidates": 1,
            "result": "hit",
            "errors": [],
        }

    monkeypatch.setattr(script, "archive_today_recover_media", fake_recover)

    out = io.StringIO()
    code = script.main(
        ["--probe", "--fullname", "reddit:t3_gone"], out=out, env={script.LIVE_ENV: "1"}
    )

    assert code == 0
    report = Path(tmp_db).parent / script.REPORT_NAME
    rows = [
        json.loads(line) for line in report.read_text(encoding="utf-8").splitlines()
    ]
    assert len(rows) == 1
    row = rows[0]
    assert row["mode"] == "probe"
    assert row["result"] == "hit"
    assert row["snapshot_candidate_count"] == 1
    assert "original_urls" not in row
    assert row["original_url_summaries"][0]["host"] == "i.redd.it"
    assert "https://i.redd.it/dead.jpg" not in report.read_text(encoding="utf-8")
