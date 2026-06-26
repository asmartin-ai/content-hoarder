import json

from content_hoarder import cli, db, models, triage_score


def _seed(
    conn,
    sid,
    *,
    sub=None,
    status="inbox",
    processed_utc=None,
    decayed=False,
    **md_extra,
):
    md = dict(md_extra)
    if sub is not None:
        md["subreddit"] = sub
    if decayed:
        md["decayed_at"] = 1
    db.merge_upsert(
        conn,
        models.new_item(
            source="reddit",
            source_id=sid,
            kind="post",
            title=f"t{sid}",
            metadata=md,
        ),
    )
    fn = f"reddit:{sid}"
    if status != "inbox" or processed_utc is not None:
        conn.execute(
            "UPDATE items SET status=?, processed_utc=? WHERE fullname=?",
            (status, processed_utc, fn),
        )
    conn.commit()
    return fn


def _model(prior=0.5, features=None):
    return {
        "version": 1,
        "fitted_utc": 100,
        "trained_on": 10,
        "processed": int(10 * prior),
        "prior": prior,
        "alpha": 2.0,
        "min_support": 2,
        "features": features or {},
    }


def test_drift_identical_models_zero():
    model = _model(features={"sub:a": [10, 5, 0.5], "sub:b": [10, 7, 0.7]})
    report = triage_score.drift(model, json.loads(json.dumps(model)))
    assert report["features_added"] == []
    assert report["features_dropped"] == []
    assert report["rate_drift"]["max_abs_delta"] == 0.0
    assert report["rate_drift"]["mean_abs_delta"] == 0.0
    assert report["prior_drift"]["delta"] == 0.0
    assert report["drift_score"] == 0.0


def test_drift_reports_features_added_and_dropped(conn, monkeypatch):
    monkeypatch.setattr(triage_score.time, "time", lambda: 1000)
    for i in range(3):
        _seed(conn, f"a{i}", sub="alpha", status="done", processed_utc=10 + i)
    for i in range(2):
        _seed(conn, f"b{i}", sub="beta")
    prev = triage_score.fit(conn, min_support=3, alpha=2.0)
    assert "sub:alpha" in prev["features"]
    assert "sub:beta" not in prev["features"]

    _seed(conn, "b2", sub="beta")
    conn.execute(
        "UPDATE items SET metadata=json_set(metadata, '$.decayed_at', 123) "
        "WHERE fullname='reddit:a0'"
    )
    conn.commit()
    curr = triage_score.fit(conn, min_support=3, alpha=2.0)

    report = triage_score.drift(prev, curr)
    assert "sub:beta" in report["features_added"]
    assert "sub:alpha" in report["features_dropped"]


def test_drift_top_mover_and_score():
    prev = _model(prior=0.4, features={"sub:moved": [10, 2, 0.2], "sub:flat": [10, 5, 0.5]})
    curr = _model(prior=0.5, features={"sub:moved": [10, 8, 0.8], "sub:flat": [10, 5, 0.55]})

    report = triage_score.drift(prev, curr)
    mover = report["rate_drift"]["top_movers"][0]
    assert mover["feature"] == "sub:moved"
    assert mover["old_rate"] == 0.2
    assert mover["new_rate"] == 0.8
    assert mover["delta"] == 0.6
    assert report["drift_score"] > 0
    assert report["prior_drift"]["delta"] == 0.1


def test_triage_drift_cli_dry_run_writes_nothing_and_apply_refits(
    conn, monkeypatch, capsys
):
    monkeypatch.setattr(cli, "_connect", lambda: conn)
    monkeypatch.setattr(triage_score.time, "time", lambda: 1000)
    for i in range(2):
        _seed(conn, f"g{i}", sub="good", status="done", processed_utc=100 + i)
    _seed(conn, "g2", sub="good")
    for i in range(3):
        _seed(conn, f"d{i}", sub="dull")

    triage_score.learn(conn, apply=True, min_support=2, alpha=2.0)
    raw_before = db.get_setting(conn, triage_score.MODEL_SETTING_KEY)
    conn.execute(
        "UPDATE items SET status='done', processed_utc=1500 WHERE fullname='reddit:d0'"
    )
    conn.execute(
        "UPDATE items SET metadata=json_set(metadata, '$.triage_score', 0, "
        "'$.triage_why', json('[\"stale\"]')) WHERE fullname='reddit:g2'"
    )
    conn.commit()

    monkeypatch.setattr(triage_score.time, "time", lambda: 2000)
    assert cli.main(["triage-drift", "--min-support", "2", "--alpha", "2.0"]) == 0
    captured = capsys.readouterr()
    assert '"drift_score"' in captured.out
    assert "dry run" in captured.err
    assert db.get_setting(conn, triage_score.MODEL_SETTING_KEY) == raw_before

    monkeypatch.setattr(triage_score.time, "time", lambda: 3000)
    assert cli.main([
        "triage-drift",
        "--min-support",
        "2",
        "--alpha",
        "2.0",
        "--apply",
    ]) == 0
    raw_after = db.get_setting(conn, triage_score.MODEL_SETTING_KEY)
    assert json.loads(raw_after)["fitted_utc"] == 3000
    assert raw_after != raw_before
    md = json.loads(db.get_item(conn, "reddit:g2")["metadata"])
    assert md["triage_score"] != 0
    assert md["triage_why"] != ["stale"]


def test_drift_report_refit_excludes_decayed_rows(conn, monkeypatch):
    monkeypatch.setattr(triage_score.time, "time", lambda: 1000)
    for i in range(2):
        _seed(conn, f"a{i}", sub="alpha", status="done", processed_utc=100 + i)
    triage_score.learn(conn, apply=True, min_support=2, alpha=2.0)

    for i in range(3):
        _seed(
            conn,
            f"s{i}",
            sub="swept",
            status="archived",
            processed_utc=200 + i,
            decayed=True,
        )
    monkeypatch.setattr(triage_score.time, "time", lambda: 2000)
    report = triage_score.drift_report(conn, min_support=2, alpha=2.0)

    assert report["current"]["trained_on"] == 2
    assert "sub:swept" not in report["drift"]["features_added"]
