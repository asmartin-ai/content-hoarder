"""F15 review tests — db.purge_done behaviours beyond the bakeoff oracle.

The oracle (test_bakeoff_f15_retention.py) pins dry-run/apply/no-unsave/configurable-window.
These add the safety behaviours the chosen arm (glm-5p2) + review fixes guarantee:
the max_rows blast cap, cross-source purging (not reddit-only), and the pending-unsave cleanup.
"""
import pytest

from content_hoarder import db, models

DAY = 86400
NOW = 1_000_000_000


def _seed_done(conn, sid, *, age_days, source="reddit"):
    db.merge_upsert(conn, models.new_item(source=source, source_id=sid, kind="post", title=sid))
    fn = f"{source}:{sid}"
    conn.execute("UPDATE items SET status='done', processed_utc=? WHERE fullname=?",
                 (NOW - age_days * DAY, fn))
    conn.commit()
    return fn


def test_purge_done_blast_cap_refuses_apply(conn):
    for i in range(3):
        _seed_done(conn, f"t3_{i}", age_days=40)
    # dry-run never trips the cap (counts only)
    assert db.purge_done(conn, now=NOW, apply=False, max_rows=2)["total"] == 3
    # apply above the cap must refuse rather than mass-delete
    with pytest.raises(ValueError):
        db.purge_done(conn, now=NOW, apply=True, max_rows=2)
    # nothing was deleted by the refused apply
    assert db.get_item(conn, "reddit:t3_0") is not None


def test_purge_done_is_cross_source(conn):
    # purge is source-agnostic: an old Done youtube/firefox item is purged too, not just reddit.
    yt = _seed_done(conn, "vid1", age_days=40, source="youtube")
    ff = _seed_done(conn, "tab1", age_days=40, source="firefox")
    rd = _seed_done(conn, "t3_x", age_days=40, source="reddit")
    res = db.purge_done(conn, now=NOW, apply=True)
    assert res["total"] == 3
    assert db.get_item(conn, yt) is None
    assert db.get_item(conn, ff) is None
    assert db.get_item(conn, rd) is None


def test_purge_done_removes_pending_unsave_for_purged_item(conn):
    # a pending unsave for a purged Done item must be dropped (a local purge must not let a
    # later drain unsave something only deleted locally) — glm-5p2's invariant, mirrors delete_items.
    fn = _seed_done(conn, "t3_pending", age_days=40)
    db.enqueue_unsave(conn, fn)
    assert conn.execute("SELECT COUNT(*) FROM reddit_unsave WHERE fullname=? AND state='pending'",
                        (fn,)).fetchone()[0] == 1
    db.purge_done(conn, now=NOW, apply=True)
    assert db.get_item(conn, fn) is None
    assert conn.execute("SELECT COUNT(*) FROM reddit_unsave WHERE fullname=?",
                        (fn,)).fetchone()[0] == 0


def test_purge_done_dryrun_reports_window_and_sample(conn):
    _seed_done(conn, "t3_a", age_days=40)
    res = db.purge_done(conn, now=NOW, apply=False)
    assert res["applied"] is False
    assert res["retention_days"] == 30
    assert res["cutoff"] == NOW - 30 * DAY
    assert any("t3_a" in s for s in res["sample"])


def test_purge_done_cutoff_is_strict(conn):
    # pins the strict `<` boundary: an item processed EXACTLY at the cutoff is kept;
    # one a second older is purged. Guards a silent `<` -> `<=` regression.
    at = _seed_done(conn, "t3_at_cutoff", age_days=30)            # processed_utc == cutoff
    over = _seed_done(conn, "t3_over_cutoff", age_days=30)
    conn.execute("UPDATE items SET processed_utc=? WHERE fullname=?",
                 (NOW - 30 * DAY - 1, over))                      # one second past the cutoff
    conn.commit()
    assert db.purge_done(conn, now=NOW, apply=False)["total"] == 1   # only the over-cutoff one
    db.purge_done(conn, now=NOW, apply=True)
    assert db.get_item(conn, at) is not None     # exactly at cutoff -> kept
    assert db.get_item(conn, over) is None       # past cutoff -> purged


def test_purge_done_excludes_null_dated_done(conn):
    # a status='done' row with processed_utc IS NULL must never be purged (undated -> excluded).
    db.merge_upsert(conn, models.new_item(source="reddit", source_id="t3_null", kind="post", title="x"))
    conn.execute("UPDATE items SET status='done', processed_utc=NULL WHERE fullname='reddit:t3_null'")
    conn.commit()
    assert db.purge_done(conn, now=NOW, apply=False)["total"] == 0
    db.purge_done(conn, now=NOW, apply=True)
    assert db.get_item(conn, "reddit:t3_null") is not None


def test_purge_done_never_touches_non_done(conn):
    # the contract names inbox/keep/archived as untouched — pin archived too (oracle covers inbox/keep).
    db.merge_upsert(conn, models.new_item(source="reddit", source_id="t3_arch", kind="post", title="a"))
    conn.execute("UPDATE items SET status='archived', processed_utc=? WHERE fullname='reddit:t3_arch'",
                 (NOW - 40 * DAY,))
    conn.commit()
    db.purge_done(conn, now=NOW, apply=True)
    assert db.get_item(conn, "reddit:t3_arch") is not None


def test_purge_done_deletes_cached_thread(conn):
    # the reddit_threads cascade + threads_deleted count are otherwise unverified.
    fn = _seed_done(conn, "t3_hyd", age_days=40)
    conn.execute("INSERT INTO reddit_threads(fullname, thread_json, hydrated_at) VALUES (?,?,?)",
                 (fn, "{}", NOW))
    conn.commit()
    res = db.purge_done(conn, now=NOW, apply=True)
    assert res["threads_deleted"] == 1
    assert conn.execute("SELECT COUNT(*) FROM reddit_threads WHERE fullname=?", (fn,)).fetchone()[0] == 0
