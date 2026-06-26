import json

from content_hoarder import db, models, resurface, search_query, web


def _seed(conn, sid, *, source="reddit", status=None, metadata=None, title="t"):
    item = models.new_item(
        source=source,
        source_id=sid,
        kind="post",
        title=title,
        metadata=metadata or {},
    )
    db.merge_upsert(conn, item)
    fn = f"{source}:{sid}"
    if status:
        conn.execute("UPDATE items SET status=? WHERE fullname=?", (status, fn))
    conn.commit()
    return fn


def _md(conn, fn):
    return json.loads(db.get_item(conn, fn)["metadata"] or "{}")


def test_snooze_dry_run_writes_nothing(conn):
    fn = _seed(conn, "t3_a")
    res = db.snooze(conn, fullnames=[fn], until_utc=2_000, apply=False)
    assert res["total"] == 1
    assert res["applied"] is False
    assert res["snoozed"] == [fn]
    assert "snoozed_until" not in _md(conn, fn)


def test_snooze_apply_stamps_and_excludes_batch(conn, monkeypatch):
    monkeypatch.setattr(db.time, "time", lambda: 1_000)
    a = _seed(conn, "t3_a")
    b = _seed(conn, "t3_b")
    res = db.snooze(conn, fullnames=[a, b], until_utc=2_000, apply=True)
    assert res["applied"] is True and res["total"] == 2
    assert isinstance(res["snoozed_wave"], int)
    for fn in (a, b):
        item = db.get_item(conn, fn)
        md = _md(conn, fn)
        assert item["status"] == "inbox"
        assert md["snoozed_until"] == 2_000
        assert md["snooze_count"] == 1
        assert md["snoozed_wave"] == res["snoozed_wave"]
    assert db.get_random_batch(conn, 10) == []


def test_snooze_expiry_resurfaces_in_batch(conn, monkeypatch):
    monkeypatch.setattr(db.time, "time", lambda: 1_000)
    fn = _seed(conn, "t3_a")
    db.snooze(conn, fullnames=[fn], until_utc=2_000, apply=True)
    monkeypatch.setattr(db.time, "time", lambda: 2_001)
    assert {r["fullname"] for r in db.get_random_batch(conn, 10)} == {fn}
    assert _md(conn, fn)["snoozed_until"] == 2_000  # lazily retained history


def test_unsnooze_wave_selects_one_wave(conn, monkeypatch):
    monkeypatch.setattr(db.time, "time", lambda: 1_000)
    a = _seed(conn, "t3_a")
    b = _seed(conn, "t3_b")
    wave_a = db.snooze(conn, fullnames=[a], until_utc=2_000, apply=True)["snoozed_wave"]
    wave_b = db.snooze(conn, fullnames=[b], until_utc=3_000, apply=True)["snoozed_wave"]
    assert wave_a != wave_b
    res = db.unsnooze(conn, snoozed_wave=wave_a, apply=True)
    assert res["total"] == 1
    assert "snoozed_until" not in _md(conn, a)
    assert _md(conn, b)["snoozed_wave"] == wave_b


def test_snooze_escalates_to_decay_without_unsave(conn, monkeypatch):
    monkeypatch.setattr(db.time, "time", lambda: 1_000)
    db.set_setting(conn, "reddit_unsave_on_done", "1")
    fn = _seed(conn, "t3_a")
    db.snooze(conn, fullnames=[fn], until_utc=2_000, escalate_after=3, apply=True)
    db.snooze(conn, fullnames=[fn], until_utc=3_000, escalate_after=3, apply=True)
    res = db.snooze(conn, fullnames=[fn], until_utc=4_000, escalate_after=3, apply=True)
    assert res["escalated"] == [fn]
    item = db.get_item(conn, fn)
    md = _md(conn, fn)
    assert item["status"] == "archived"
    assert md["snooze_count"] == 3
    assert md["decayed_at"] == res["decayed_at"]
    assert md["decay_label"] == "snooze-escalated"
    assert "snoozed_until" not in md
    assert conn.execute("SELECT COUNT(*) FROM reddit_unsave").fetchone()[0] == 0
    db.undecay(
        conn,
        decayed_after=res["decayed_at"],
        decayed_before=res["decayed_at"] + 1,
        apply=True,
    )
    assert db.get_item(conn, fn)["status"] == "inbox"


def test_resurface_escalate_snoozed_sweep(conn):
    fn = _seed(conn, "t3_a", metadata={"snooze_count": 3, "snoozed_until": 9_999})
    res = resurface.escalate_snoozed(conn, escalate_after=3, apply=True)
    assert res["total"] == 1 and res["decayed_at"]
    item = db.get_item(conn, fn)
    md = _md(conn, fn)
    assert item["status"] == "archived"
    assert md["decay_label"] == "snooze-escalated"
    assert "snoozed_until" not in md


def test_manual_status_transition_strips_active_snooze(conn):
    fn = _seed(conn, "t3_a")
    db.snooze(conn, fullnames=[fn], until_utc=2_000, apply=True)
    db.set_status(conn, fn, "done")
    md = _md(conn, fn)
    assert "snoozed_until" not in md and "snoozed_wave" not in md
    assert md["snooze_count"] == 1


def test_merge_upsert_preserves_snooze_state(conn):
    fn = _seed(conn, "t3_a", metadata={"subreddit": "old"})
    db.snooze(conn, fullnames=[fn], until_utc=2_000, apply=True)
    db.merge_upsert(
        conn,
        models.new_item(
            source="reddit",
            source_id="t3_a",
            kind="post",
            title="new",
            metadata={"subreddit": "new", "snoozed_until": 1, "snooze_count": 99},
        ),
    )
    conn.commit()
    md = _md(conn, fn)
    assert md["subreddit"] == "new"
    assert md["snoozed_until"] == 2_000
    assert md["snooze_count"] == 1


def test_is_snoozed_matches_only_current_snoozes(conn, monkeypatch):
    monkeypatch.setattr(db.time, "time", lambda: 1_000)
    active = _seed(conn, "t3_active")
    expired = _seed(conn, "t3_expired")
    _seed(conn, "t3_plain")
    db.snooze(conn, fullnames=[active], until_utc=2_000, apply=True)
    db.snooze(conn, fullnames=[expired], until_utc=999, apply=True)
    assert search_query.parse("is:snoozed").snoozed is True
    assert {r["fullname"] for r in db.search_items(conn, "", snoozed=True)} == {active}


def test_snooze_routes_hide_inbox_and_undo(tmp_db, monkeypatch):
    monkeypatch.setattr(db.time, "time", lambda: 1_000)
    monkeypatch.setattr(web.time, "time", lambda: 1_000)
    with db.connect(tmp_db) as conn:
        fn = _seed(conn, "t3_route", title="route snooze")
        visible = _seed(conn, "t3_visible", title="visible")

    cl = web.create_app(tmp_db).test_client()
    detail = cl.get("/items/" + fn).get_json()
    assert detail["fullname"] == fn

    res = cl.post("/items/" + fn + "/snooze", json={"window_days": 7}).get_json()
    assert res["snoozed"] == [fn]
    wave = res["snoozed_wave"]

    inbox = cl.get("/items?status=inbox").get_json()["items"]
    assert {it["fullname"] for it in inbox} == {visible}
    snoozed = cl.get("/items?status=inbox&q=is:snoozed").get_json()["items"]
    assert {it["fullname"] for it in snoozed} == {fn}

    undo = cl.post("/snooze/undo", json={"snoozed_wave": wave}).get_json()
    assert undo["total"] == 1
    inbox2 = cl.get("/items?status=inbox").get_json()["items"]
    assert {it["fullname"] for it in inbox2} == {fn, visible}


def test_snooze_route_escalation_undoes_decay(tmp_db, monkeypatch):
    monkeypatch.setattr(db.time, "time", lambda: 1_000)
    monkeypatch.setattr(web.time, "time", lambda: 1_000)
    with db.connect(tmp_db) as conn:
        fn = _seed(conn, "t3_escalate", metadata={"snooze_count": 2})

    cl = web.create_app(tmp_db).test_client()
    res = cl.post(
        "/items/" + fn + "/snooze",
        json={"window_days": 7, "escalate_after": 3},
    ).get_json()
    assert res["escalated"] == [fn]
    assert res["decayed_at"]

    undo = cl.post("/snooze/undo", json={"decayed_at": res["decayed_at"]}).get_json()
    assert undo["total"] == 1
    assert cl.get("/items/" + fn).get_json()["status"] == "inbox"
