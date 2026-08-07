"""Issue #25: assist-auto-archive — high-skip bucket plan + reversible apply."""
import json

from content_hoarder import db, models, triage_score


def _seed(conn, sid, *, sub=None, status="inbox", source="reddit", **md_extra):
    md = dict(md_extra)
    if sub is not None:
        md["subreddit"] = sub
    db.merge_upsert(conn, models.new_item(source=source, source_id=sid, kind="post",
                                          title=f"t{sid}", metadata=md))
    fn = f"{source}:{sid}"
    if status != "inbox":
        conn.execute("UPDATE items SET status=? WHERE fullname=?", (status, fn))
    conn.commit()
    return fn


def _fit_with_high_skip(conn):
    """Corpus: dullsub 10 items all skipped -> high-skip bucket; goodsub
    8/10 processed -> not a candidate. Persist the model like learn --apply."""
    for i in range(10):
        _seed(conn, f"g{i}", sub="goodsub", status="done" if i < 8 else "inbox")
    for i in range(10):
        _seed(conn, f"d{i}", sub="dullsub")
    model = triage_score.fit(conn, min_support=5, alpha=2.0)
    db.set_setting(conn, triage_score.MODEL_SETTING_KEY,
                   json.dumps(model, ensure_ascii=False))
    conn.commit()
    return model


def test_auto_archive_plan_no_model(conn):
    res = triage_score.auto_archive_plan(conn)
    assert res["model_present"] is False
    assert res["actionable"] == [] and res["total_actionable"] == 0


def test_auto_archive_plan_finds_high_skip_subreddit(conn):
    _fit_with_high_skip(conn)
    res = triage_score.auto_archive_plan(conn, min_support=5)
    assert res["model_present"] is True
    # dullsub: 10 items, 0 processed -> skip_rate 1.0 >= 0.9
    subs = {b["subreddit"]: b for b in res["actionable"]}
    assert "dullsub" in subs
    assert subs["dullsub"]["skip_rate"] >= 0.9
    assert subs["dullsub"]["inbox_count"] == 10
    # goodsub (0.2 processed-rate) must not appear
    assert "goodsub" not in subs
    assert res["total_actionable"] == 10


def test_auto_archive_plan_informational_non_sub_buckets(conn):
    model = _fit_with_high_skip(conn)
    # inject a high-skip non-sub feature (e.g. a media type) directly
    model["features"]["media:video"] = [10, 0, 0.02]
    db.set_setting(conn, triage_score.MODEL_SETTING_KEY,
                   json.dumps(model, ensure_ascii=False))
    conn.commit()
    res = triage_score.auto_archive_plan(conn, min_support=5)
    feats = [b["feature"] for b in res["informational"]]
    assert "media:video" in feats  # reported but not actionable (no decay selector)
    assert all(b["feature"].startswith("sub:") for b in res["actionable"])


def test_auto_archive_plan_no_persist_on_dry_run(conn):
    _fit_with_high_skip(conn)
    before = db.get_item(conn, "reddit:d0")["status"]
    triage_score.auto_archive_plan(conn, min_support=5)
    assert db.get_item(conn, "reddit:d0")["status"] == before  # never mutates
    assert db.get_item(conn, "reddit:d0")["status"] == "inbox"


def test_auto_archive_apply_via_decay_is_reversible(conn):
    _fit_with_high_skip(conn)
    res = triage_score.auto_archive_plan(conn, min_support=5)
    for b in res["actionable"]:
        r = db.decay(conn, subreddits=[b["subreddit"]], source="reddit",
                     label="auto-archive", apply=True)
        assert r["total"] == b["inbox_count"]
    # all dullsub rows now archived + stamped
    for i in range(10):
        it = db.get_item(conn, f"reddit:d{i}")
        assert it["status"] == "archived"
        md = json.loads(it["metadata"] or "{}")
        assert md["decay_label"] == "auto-archive"
        assert md.get("decayed_at")  # wave-stamped -> undoable
    # reverse one wave: decayed_at is a monotonic wave id, undo by selecting it
    md0 = json.loads(db.get_item(conn, "reddit:d0")["metadata"] or "{}")
    wave = md0["decayed_at"]
    r = db.undecay(conn, decayed_after=wave, decayed_before=wave + 1, apply=True)
    assert r["total"] >= 1
    assert db.get_item(conn, "reddit:d0")["status"] == "inbox"
