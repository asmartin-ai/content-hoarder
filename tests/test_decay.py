"""Epic 21: tag/subreddit-aware decay + undecay (guilt-free bulk archive, reversible)."""
import json
import time

import pytest

from content_hoarder import db, models


def _seed(conn, sid, *, sub=None, tags=None, title="t", source="reddit",
          status=None, created=0):
    md = {}
    if sub is not None:
        md["subreddit"] = sub
    if tags is not None:
        md["tags"] = tags
    it = models.new_item(source=source, source_id=sid, kind="post", title=title,
                         metadata=md, created_utc=created)
    db.merge_upsert(conn, it)
    if status:
        conn.execute("UPDATE items SET status=? WHERE fullname=?",
                     (status, f"{source}:{sid}"))
    conn.commit()
    return f"{source}:{sid}"


def _md(conn, fn):
    return json.loads(db.get_item(conn, fn)["metadata"] or "{}")


def test_decay_requires_selector(conn):
    with pytest.raises(ValueError):
        db.decay(conn)


def test_decay_dry_run_counts_and_no_write(conn):
    a = _seed(conn, "1", sub="anime_irl", tags=["anime", "memes"])
    _seed(conn, "2", sub="hololive", tags=["vtubers"])
    _seed(conn, "3", sub="askreddit")  # untagged — not selected
    res = db.decay(conn, tags=["anime", "memes", "vtubers"])
    # the anime+memes item counts ONCE in total but under BOTH tags in by_tag
    assert res["total"] == 2 and res["applied"] is False and res["decayed_at"] is None
    assert res["by_tag"] == {"anime": 1, "memes": 1, "vtubers": 1}
    assert res["by_subreddit"] == {"anime_irl": 1, "hololive": 1}
    assert sum(res["age_bands"].values()) == 2
    assert len(res["sample"]) == 2
    # dry run wrote nothing
    it = db.get_item(conn, a)
    assert it["status"] == "inbox" and "decayed_at" not in _md(conn, a)


def test_decay_apply_sets_stamp_status_processed(conn):
    a = _seed(conn, "1", sub="gamedeals", tags=["ephemeral"])
    b = _seed(conn, "2", sub="askscience", tags=["science"])
    res = db.decay(conn, tags=["ephemeral"], apply=True)
    assert res["total"] == 1 and res["applied"] is True
    assert isinstance(res["decayed_at"], int)
    it = db.get_item(conn, a)
    assert it["status"] == "archived" and it["status_prev"] == "inbox"
    assert it["processed_utc"] == res["decayed_at"]
    assert _md(conn, a)["decayed_at"] == res["decayed_at"]
    # non-matching row untouched
    other = db.get_item(conn, b)
    assert other["status"] == "inbox" and "decayed_at" not in _md(conn, b)


def test_decay_same_second_waves_undo_independently(conn, monkeypatch):
    """B1: two decays in the SAME wall-clock second get distinct (monotonic) wave
    stamps, so undoing one wave's window restores only its rows — not both."""
    a = _seed(conn, "1", sub="gamedeals", tags=["ephemeral"])
    b = _seed(conn, "2", sub="askscience", tags=["science"])
    monkeypatch.setattr(db.time, "time", lambda: 1_700_000_000)  # freeze the clock
    wave_a = db.decay(conn, tags=["ephemeral"], apply=True)["decayed_at"]
    wave_b = db.decay(conn, tags=["science"], apply=True)["decayed_at"]
    assert wave_a != wave_b  # distinct stamps despite the identical second
    assert _md(conn, a)["decayed_at"] == wave_a
    assert _md(conn, b)["decayed_at"] == wave_b
    # undo only wave A's [wave, wave+1) window -> A returns, B stays decayed
    db.undecay(conn, decayed_after=wave_a, decayed_before=wave_a + 1, apply=True)
    assert db.get_item(conn, a)["status"] == "inbox"
    assert db.get_item(conn, b)["status"] == "archived"


def test_decay_subreddit_filter_case_insensitive(conn):
    a = _seed(conn, "1", sub="feedthebeast")
    res = db.decay(conn, subreddits=["FeedTheBeast"], apply=True)
    assert res["total"] == 1
    assert db.get_item(conn, a)["status"] == "archived"


def test_decay_tag_subreddit_union(conn):
    _seed(conn, "1", sub="randomsub", tags=["memes"])      # tag only
    _seed(conn, "2", sub="projectzomboid")                 # subreddit only, untagged
    _seed(conn, "3", sub="askreddit")                      # matches neither
    res = db.decay(conn, tags=["memes"], subreddits=["projectzomboid"], apply=True)
    assert res["total"] == 2
    assert db.get_item(conn, "reddit:3")["status"] == "inbox"


def test_decay_before_cutoff_age_expr(conn):
    now = int(time.time())
    old = _seed(conn, "1", sub="s", tags=["memes"], created=now - 10 * 86400)
    new = _seed(conn, "2", sub="s", tags=["memes"], created=now)
    # created_utc=0 falls back to first_seen_utc (= now at seed time) -> NOT old
    fallback = _seed(conn, "3", sub="s", tags=["memes"], created=0)
    res = db.decay(conn, tags=["memes"], before_utc=now - 86400, apply=True)
    assert res["total"] == 1
    assert db.get_item(conn, old)["status"] == "archived"
    assert db.get_item(conn, new)["status"] == "inbox"
    assert db.get_item(conn, fallback)["status"] == "inbox"


def test_decay_skips_non_inbox(conn):
    for sid, st in (("1", "keep"), ("2", "done"), ("3", "archived")):
        _seed(conn, sid, sub="s", tags=["memes"], status=st)
    inbox = _seed(conn, "4", sub="s", tags=["memes"])
    res = db.decay(conn, tags=["memes"], apply=True)
    assert res["total"] == 1
    assert db.get_item(conn, inbox)["status"] == "archived"
    assert db.get_item(conn, "reddit:1")["status"] == "keep"


def test_decay_never_enqueues_unsave(conn):
    # even with the unsave-on-done setting active, a mass decay must not touch the queue
    db.set_setting(conn, "reddit_unsave_on_done", "1")
    for sid in ("t3_a", "t3_b", "t3_c"):
        _seed(conn, sid, sub="s", tags=["memes"])
    res = db.decay(conn, tags=["memes"], apply=True)
    assert res["total"] == 3
    assert conn.execute("SELECT COUNT(*) FROM reddit_unsave").fetchone()[0] == 0


def test_undecay_round_trip(conn):
    a = _seed(conn, "1", sub="s", tags=["memes"])
    decayed = db.decay(conn, tags=["memes"], apply=True)
    res = db.undecay(conn, apply=True)
    assert res["total"] == decayed["total"] == 1
    it = db.get_item(conn, a)
    assert it["status"] == "inbox" and it["processed_utc"] is None
    assert it["status_prev"] == "archived"
    assert "decayed_at" not in _md(conn, a)


def test_undecay_skips_manually_restatused(conn):
    a = _seed(conn, "1", sub="s", tags=["memes"])
    db.decay(conn, tags=["memes"], label="swept", apply=True)
    db.set_status(conn, a, "keep")  # user rescued it after the decay
    res = db.undecay(conn, apply=True)
    assert res["total"] == 0
    it = db.get_item(conn, a)
    assert it["status"] == "keep"
    # the manual transition stripped the decay marks — a rescued item never shows
    # up in is:swept/is:decayed again
    md = _md(conn, a)
    assert "decayed_at" not in md and "decay_label" not in md


def test_manual_status_changes_clear_decay_marks(conn):
    a = _seed(conn, "1", sub="s", tags=["memes"])
    b = _seed(conn, "2", sub="s", tags=["memes"])
    db.decay(conn, tags=["memes"], label="swept", apply=True)
    # per-item web ↩ undo (archived -> inbox) acts as a mini-undecay
    db.undo_status(conn, a)
    it = db.get_item(conn, a)
    assert it["status"] == "inbox" and "decayed_at" not in _md(conn, a)
    # bulk action on a decayed item strips the marks too
    db.bulk_set_status(conn, [b], "done")
    assert "decay_label" not in _md(conn, b)
    assert db.search_items(conn, swept=True) == []


def test_undecay_stamp_window_selects_one_wave(conn, monkeypatch):
    a = _seed(conn, "1", sub="s", tags=["memes"])
    b = _seed(conn, "2", sub="s", tags=["vtubers"])
    t1, t2 = 1_000_000, 2_000_000
    monkeypatch.setattr(db.time, "time", lambda: t1)
    db.decay(conn, tags=["memes"], apply=True)
    monkeypatch.setattr(db.time, "time", lambda: t2)
    db.decay(conn, tags=["vtubers"], apply=True)
    # window covering only wave 2
    res = db.undecay(conn, decayed_after=t2, apply=True)
    assert res["total"] == 1
    assert db.get_item(conn, b)["status"] == "inbox"
    assert db.get_item(conn, a)["status"] == "archived"


def test_decay_stamp_survives_merge_upsert(conn):
    a = _seed(conn, "1", sub="s", tags=["memes"], title="old title")
    db.decay(conn, tags=["memes"], apply=True)
    # (a) sync-style re-import of the same item with fresh content
    db.merge_upsert(conn, models.new_item(source="reddit", source_id="1", kind="post",
                    title="new title", metadata={"subreddit": "s"}))
    conn.commit()
    it = db.get_item(conn, a)
    assert it["status"] == "archived" and "decayed_at" in _md(conn, a)
    # (b) retag-style partial write (tags w/o category -> REPLACE path) keeps other md keys
    db.merge_upsert(conn, {"fullname": a, "metadata": {"tags": ["memes", "gaming"]},
                           "last_seen_utc": int(time.time())})
    conn.commit()
    md = _md(conn, a)
    assert md["tags"] == ["memes", "gaming"] and "decayed_at" in md
    assert db.get_item(conn, a)["status"] == "archived"


def test_decay_rerun_idempotent(conn):
    _seed(conn, "1", sub="s", tags=["memes"])
    assert db.decay(conn, tags=["memes"], apply=True)["total"] == 1
    assert db.decay(conn, tags=["memes"], apply=True)["total"] == 0


def test_decay_label_written_queryable_and_removed(conn):
    a = _seed(conn, "1", sub="s", tags=["memes"])
    res = db.decay(conn, tags=["memes"], label="swept", apply=True)
    assert res["label"] == "swept"
    md = _md(conn, a)
    assert md["decay_label"] == "swept" and md["decayed_at"] == res["decayed_at"]
    # the search filters behind is:decayed / is:swept both find it
    assert {r["fullname"] for r in db.search_items(conn, decayed=True)} == {a}
    assert {r["fullname"] for r in db.search_items(conn, swept=True)} == {a}
    db.undecay(conn, apply=True)
    md = _md(conn, a)
    assert "decayed_at" not in md and "decay_label" not in md
    assert db.search_items(conn, decayed=True) == []


def test_decay_unlabeled_wave_not_swept(conn):
    a = _seed(conn, "1", sub="s", tags=["memes"])
    db.decay(conn, tags=["memes"], apply=True)  # rolling-style wave, no label
    assert "decay_label" not in _md(conn, a)
    assert {r["fullname"] for r in db.search_items(conn, decayed=True)} == {a}
    assert db.search_items(conn, swept=True) == []


def test_decay_other_source_untouched(conn):
    r = _seed(conn, "1", sub="s", tags=["memes"])
    y = _seed(conn, "vid1", source="youtube", tags=["memes"])
    res = db.decay(conn, tags=["memes"], apply=True)  # source defaults to reddit
    assert res["total"] == 1
    assert db.get_item(conn, r)["status"] == "archived"
    assert db.get_item(conn, y)["status"] == "inbox"
