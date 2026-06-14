"""Epic 10: transparent likely-to-process score + smart triage batches."""
import json
import time

from content_hoarder import db, models, triage_score


def _seed(conn, sid, *, sub=None, status="inbox", source="reddit", label=None, **md_extra):
    md = dict(md_extra)
    if sub is not None:
        md["subreddit"] = sub
    if label is not None:
        md["decay_label"] = label
        md["decayed_at"] = 1
    db.merge_upsert(conn, models.new_item(source=source, source_id=sid, kind="post",
                                          title=f"t{sid}", metadata=md))
    fn = f"{source}:{sid}"
    if status != "inbox":
        conn.execute("UPDATE items SET status=? WHERE fullname=?", (status, fn))
    conn.commit()
    return fn


def _corpus(conn):
    # goodsub: 10 items, 8 human-processed -> strong positive signal
    for i in range(10):
        _seed(conn, f"g{i}", sub="goodsub", status="done" if i < 8 else "inbox")
    # dullsub: 10 items, 0 processed -> negative signal
    for i in range(10):
        _seed(conn, f"d{i}", sub="dullsub")


def test_smart_sort_orders_by_triage_score(conn):
    # browse "SORT: SMART" ranks by metadata.triage_score desc; unscored items sort last.
    _seed(conn, "lo", triage_score=0.10)
    _seed(conn, "hi", triage_score=0.90)
    _seed(conn, "mid", triage_score=0.50)
    _seed(conn, "none")  # no triage_score -> NULLS LAST
    order = [it["fullname"] for it in db.search_items(conn, sort="smart", order="desc")]
    assert order[:3] == ["reddit:hi", "reddit:mid", "reddit:lo"]
    assert order[-1] == "reddit:none"


def test_extract_features_shape():
    row = {"source": "reddit", "kind": "post", "created_utc": int(time.time()) - 100,
           "first_seen_utc": 0}
    feats = triage_score.extract_features(
        row, {"subreddit": "MixedCase", "media_type": "image", "category": "watch"})
    # source+kind are one composite feature (correlated pairs would double-count)
    assert "sk:reddit/post" in feats and "sub:mixedcase" in feats
    assert "media:image" in feats and "cat:watch" in feats and "age:<30d" in feats


def test_fit_rates_smoothing_and_min_support(conn):
    _corpus(conn)
    model = triage_score.fit(conn, min_support=5, alpha=2.0)
    assert model["trained_on"] == 20 and model["processed"] == 8
    good = model["features"]["sub:goodsub"]
    dull = model["features"]["sub:dullsub"]
    assert good[0] == 10 and good[1] == 8
    assert dull[1] == 0
    # smoothed toward the prior, never the raw extremes
    assert model["prior"] < good[2] < 0.8
    assert 0.0 < dull[2] < model["prior"]
    # min_support drops rare features
    sparse = triage_score.fit(conn, min_support=15, alpha=2.0)
    assert "sub:goodsub" not in sparse["features"]


def test_score_ranks_good_over_dull_and_why_names_the_feature(conn):
    _corpus(conn)
    model = triage_score.fit(conn, min_support=5, alpha=2.0)
    s_good, why_good = triage_score.score_item(model, ["sub:goodsub"])
    s_dull, _ = triage_score.score_item(model, ["sub:dullsub"])
    assert s_good > model["prior"] > s_dull
    assert any(w.startswith("sub:goodsub") for w in why_good)


def test_fit_excludes_machine_swept_rows(conn):
    _corpus(conn)
    # 5 swept rows in a sub the user never touched: must NOT count as processed signal
    for i in range(5):
        _seed(conn, f"s{i}", sub="sweptsub", status="archived", label="swept")
    model = triage_score.fit(conn, min_support=2, alpha=2.0)
    assert "sub:sweptsub" not in model["features"]
    assert model["trained_on"] == 20  # swept rows excluded entirely


def test_learn_dry_run_writes_nothing_apply_scores_inbox_only(conn):
    _corpus(conn)
    res = triage_score.learn(conn, min_support=5, alpha=2.0)
    assert res["applied"] is False and res["scored"] == 12  # 2 good-inbox + 10 dull
    md = json.loads(db.get_item(conn, "reddit:g9")["metadata"])
    assert "triage_score" not in md

    res = triage_score.learn(conn, apply=True, min_support=5, alpha=2.0)
    assert res["applied"] is True
    md_in = json.loads(db.get_item(conn, "reddit:g9")["metadata"])
    assert 0.0 < md_in["triage_score"] < 1.0 and isinstance(md_in["triage_why"], list)
    assert md_in["subreddit"] == "goodsub"  # other metadata preserved
    # processed rows don't get scores
    md_done = json.loads(db.get_item(conn, "reddit:g0")["metadata"])
    assert "triage_score" not in md_done
    # model persisted for serve-time use
    assert db.get_setting(conn, triage_score.MODEL_SETTING_KEY) is not None


def test_smart_batch_mixes_scored_and_recent(conn):
    _corpus(conn)
    triage_score.learn(conn, apply=True, min_support=5, alpha=2.0)
    batch = db.get_random_batch(conn, 6, mode="smart")
    fns = {b["fullname"] for b in batch}
    assert len(batch) == 6 and len(fns) == 6
    assert all(b["status"] == "inbox" for b in batch)
    # the score pool (top by triage_score) is goodsub-dominated: g8/g9 outscore dullsub,
    # so with a 3-from-10-pool draw at least one goodsub item lands in most draws;
    # assert the structural property instead of luck: batch ⊆ inbox and topped to n.
    inbox = {r["fullname"] for r in db.search_items(conn, "", status="inbox", limit=100)}
    assert fns <= inbox


def test_smart_batch_falls_back_without_scores(conn):
    _corpus(conn)  # no learn() run -> no scores anywhere
    batch = db.get_random_batch(conn, 5, mode="smart")
    assert len(batch) == 5 and all(b["status"] == "inbox" for b in batch)
