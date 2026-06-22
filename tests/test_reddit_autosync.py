"""Reconcile-mode sync + the auto_sync orchestrator + SyncScheduler — all offline.

Reuses the listing/getf fakes from test_reddit_sync (newest-first pages, injectable getf)."""

from contextlib import contextmanager

from content_hoarder import db, reddit_sync, reddit_unsave

from test_reddit_sync import child, make_getf, _auth, NOSLEEP


def _seed_saved(conn, names):
    """Run a normal cookie sync so `names` land as is_saved=1 inbox rows carrying the
    saved_seen_utc provenance marker reconcile requires. Clears the high-water mark after."""
    _auth(conn)
    reddit_sync.sync_saved_cookie(
        conn, getf=make_getf([([child(n) for n in names], None)]), user_agent="ua")
    db.set_setting(conn, "reddit_sync_newest", "")  # so the reconcile walk isn't a no-op caught_up


# --- reconcile-mode sync_saved (the full-walk census) -------------------------------------------

def test_reconcile_flips_absent_and_promotes_only_inbox(conn):
    _seed_saved(conn, ["t3_a", "t3_b", "t3_c", "t1_x"])
    db.set_status(conn, "reddit:t3_b", "keep")          # a decided status -> protected from promotion

    # Live saved set now only has t3_a + t1_x; b and c dropped out (unsaved on reddit.com).
    res = reddit_sync.sync_saved(
        conn, reconcile=True, getf=make_getf([([child("t3_a"), child("t1_x")], None)]),
        user_agent="ua", max_pages=12, sleep=NOSLEEP)

    rec = res["reconcile"]
    assert rec["ran"] is True
    assert rec["unsaved"] == 2 and rec["promoted_done"] == 1
    assert db.get_item(conn, "reddit:t3_a")["is_saved"] == 1      # present -> kept
    assert db.get_item(conn, "reddit:t1_x")["is_saved"] == 1
    c = db.get_item(conn, "reddit:t3_c")
    assert c["is_saved"] == 0 and c["status"] == "done"          # absent + inbox -> done
    b = db.get_item(conn, "reddit:t3_b")
    assert b["is_saved"] == 0 and b["status"] == "keep"          # absent but decided -> status stands


def test_reconcile_promotion_does_not_enqueue_a_redundant_unsave(conn):
    """An item promoted to done *because it's already gone from Reddit* must not enqueue a no-op
    Reddit unsave, even with unsave-on-done opted in (queue_unsave=False)."""
    db.set_setting(conn, "reddit_unsave_on_done", "1")          # the opt-in that would normally enqueue
    _seed_saved(conn, ["t3_a", "t3_gone"])
    reddit_sync.sync_saved(
        conn, reconcile=True, getf=make_getf([([child("t3_a")], None)]),
        user_agent="ua", max_pages=12, sleep=NOSLEEP)
    assert db.get_item(conn, "reddit:t3_gone")["status"] == "done"
    assert reddit_unsave.count_pending(conn) == 0               # NOT re-enqueued


def test_reconcile_skips_incomplete_walk(conn):
    """A max_pages-truncated census is a partial view — it must NOT infer any unsave."""
    _seed_saved(conn, ["t3_a", "t3_b"])
    getf = make_getf([([child("t3_a")], "p2"), ([child("t3_b")], "p3")])  # never exhausts
    res = reddit_sync.sync_saved(conn, reconcile=True, getf=getf, user_agent="ua",
                                 max_pages=1, sleep=NOSLEEP)
    assert res["stopped"] == "max_pages"
    assert res["reconcile"]["ran"] is False
    assert res["reconcile"]["skipped"] == "incomplete_walk"
    assert db.get_item(conn, "reddit:t3_b")["is_saved"] == 1    # absent-from-partial -> protected


def test_reconcile_skips_at_listing_cap(conn, monkeypatch):
    """At/above the ~1000 listing cap the walk may be truncated, so reconcile refuses to act."""
    monkeypatch.setattr(reddit_sync, "RECONCILE_SAFE_CAP", 2)
    _seed_saved(conn, ["t3_a", "t3_gone"])
    # census returns 2 items (>= the patched cap of 2) -> treated as possibly-capped -> skip
    res = reddit_sync.sync_saved(
        conn, reconcile=True, getf=make_getf([([child("t3_a"), child("t3_b")], None)]),
        user_agent="ua", max_pages=12, sleep=NOSLEEP)
    assert res["reconcile"]["skipped"] == "listing_cap"
    assert db.get_item(conn, "reddit:t3_gone")["is_saved"] == 1  # protected


def test_reconcile_dry_run_previews_without_writing(conn):
    _seed_saved(conn, ["t3_a", "t3_gone"])
    res = reddit_sync.sync_saved(
        conn, reconcile=True, reconcile_dry_run=True,
        getf=make_getf([([child("t3_a")], None)]), user_agent="ua", max_pages=12, sleep=NOSLEEP)
    rec = res["reconcile"]
    assert rec["ran"] is True and rec["dry_run"] is True and rec["unsaved"] == 1
    g = db.get_item(conn, "reddit:t3_gone")
    assert g["is_saved"] == 1 and g["status"] == "inbox"        # preview only — nothing written


# --- auto_sync orchestration (debounce + two-speed cadence) -------------------------------------

def test_auto_sync_debounces_rapid_triggers(conn):
    _auth(conn)
    g = lambda: make_getf([([child("t3_a")], None)])
    first = reddit_sync.auto_sync(conn, now=10_000, getf=g(), user_agent="ua", sleep=NOSLEEP)
    assert first.get("skipped") is None and first["mode"] in ("incremental", "reconcile")
    # a second trigger 30s later is inside MIN_RUN_INTERVAL (90s) -> no-op
    second = reddit_sync.auto_sync(conn, now=10_030, getf=g(), user_agent="ua", sleep=NOSLEEP)
    assert second["skipped"] == "debounced" and second["mode"] is None


def test_auto_sync_picks_mode_by_reconcile_cadence(conn):
    _auth(conn)
    g = lambda: make_getf([([child("t3_a")], None)])
    # reconcile just ran -> a fresh trigger does only the cheap incremental import
    db.set_setting(conn, "reddit_autosync_last_reconcile", "100000")
    inc = reddit_sync.auto_sync(conn, now=100_000 + 100, getf=g(), user_agent="ua", sleep=NOSLEEP)
    assert inc["mode"] == "incremental"
    # ...but once the reconcile interval has elapsed, the next trigger reconciles
    rec = reddit_sync.auto_sync(
        conn, now=100_000 + reddit_sync.RECONCILE_INTERVAL + 1,
        getf=g(), user_agent="ua", sleep=NOSLEEP)
    assert rec["mode"] == "reconcile"


def test_auto_sync_force_dry_run_does_not_advance_reconcile_mark(conn):
    _seed_saved(conn, ["t3_a"])
    before = db.get_setting(conn, "reddit_autosync_last_reconcile", "0")
    reddit_sync.auto_sync(conn, now=200_000, force=True, reconcile_dry_run=True,
                          getf=make_getf([([child("t3_a")], None)]), user_agent="ua", sleep=NOSLEEP)
    assert db.get_setting(conn, "reddit_autosync_last_reconcile", "0") == before  # dry-run -> no advance


# --- SyncScheduler (single-flight, enabled-gated) ----------------------------------------------

def _factory(conn):
    @contextmanager
    def f():
        yield conn
    return f


def _inert_scheduler(delay, fn):
    class _H:
        def cancel(self):
            pass
    return _H()


def test_scheduler_noops_while_disabled(conn):
    calls = []
    s = reddit_sync.SyncScheduler(_factory(conn), scheduler=_inert_scheduler,
                                  sync_fn=lambda c: calls.append(1))
    assert s.fire() is None and calls == []                     # default off -> no sync


def test_scheduler_fires_when_enabled(conn):
    reddit_sync.set_autosync_enabled(conn, True)
    calls = []
    s = reddit_sync.SyncScheduler(_factory(conn), scheduler=_inert_scheduler,
                                  sync_fn=lambda c: calls.append(1) or {"mode": "incremental"})
    s.fire()
    assert calls == [1]


def test_scheduler_single_flight(conn):
    reddit_sync.set_autosync_enabled(conn, True)
    calls = []
    s = reddit_sync.SyncScheduler(_factory(conn), scheduler=_inert_scheduler,
                                  sync_fn=lambda c: calls.append(1))
    s._run_lock.acquire()                                       # simulate a sync already in flight
    try:
        assert s.fire() is None and calls == []                # single-flight -> skipped
    finally:
        s._run_lock.release()
