"""Offline tests for the async unsave trickle (reddit_trickle.TrickleDrainer). No real threads or
network: the scheduler + drain_fn are injected, and the opt-in is read from a real test conn."""

import contextlib

from content_hoarder import db, reddit_trickle
from content_hoarder.reddit_trickle import TrickleDrainer


class _FakeTimer:
    def __init__(self):
        self.cancelled = False

    def cancel(self):
        self.cancelled = True


def _make_scheduler():
    calls = []

    def sched(delay, fn):
        t = _FakeTimer()
        calls.append((delay, fn, t))
        return t

    sched.calls = calls
    return sched


def _make_drain(result=None):
    calls = []

    def drain(conn, *, limit, audit):
        calls.append({"limit": limit, "audit": audit})
        return result if result is not None else {"unsaved": 1, "transport": "oauth"}

    drain.calls = calls
    return drain


def _factory(conn):
    return lambda: contextlib.nullcontext(conn)   # yield the shared test conn; never close it


def test_note_enqueue_arms_idle_debounce(conn):
    sched = _make_scheduler()
    d = TrickleDrainer(_factory(conn), scheduler=sched, idle_seconds=30, drain_fn=_make_drain())
    d.note_enqueue()
    assert len(sched.calls) == 1
    delay, fn, _t = sched.calls[0]
    assert delay == 30 and fn == d.fire           # fires d.fire after the idle delay


def test_rearm_cancels_the_prior_timer(conn):
    sched = _make_scheduler()
    d = TrickleDrainer(_factory(conn), scheduler=sched, drain_fn=_make_drain())
    d.note_enqueue()
    d.note_enqueue()                               # a second Done before the first fired
    assert len(sched.calls) == 2
    assert sched.calls[0][2].cancelled is True     # debounce: the first timer was cancelled
    assert sched.calls[1][2].cancelled is False


def test_fire_drains_capped_batch_when_opted_in(conn):
    db.set_setting(conn, "reddit_unsave_on_done", "1")
    drain = _make_drain()
    d = TrickleDrainer(_factory(conn), cap=25, drain_fn=drain, audit="AUDIT")
    res = d.fire()
    assert res == {"unsaved": 1, "transport": "oauth"}
    assert drain.calls == [{"limit": 25, "audit": "AUDIT"}]   # small cap + audit threaded through


def test_fire_noop_when_opt_in_withdrawn(conn):
    db.set_setting(conn, "reddit_unsave_on_done", "0")
    drain = _make_drain()
    d = TrickleDrainer(_factory(conn), drain_fn=drain)
    assert d.fire() is None and drain.calls == []  # consent is the toggle — off => nothing sent


def test_fire_rearms_while_progress_and_backlog_remain(conn):
    db.set_setting(conn, "reddit_unsave_on_done", "1")
    sched = _make_scheduler()
    drain = _make_drain(result={"unsaved": 25, "remaining": 10, "transport": "cookie"})
    d = TrickleDrainer(_factory(conn), scheduler=sched, drain_fn=drain)
    d.fire()
    assert len(sched.calls) == 1 and sched.calls[0][1] == d.fire   # re-armed to keep trickling


def test_fire_stops_when_backlog_cleared(conn):
    db.set_setting(conn, "reddit_unsave_on_done", "1")
    sched = _make_scheduler()
    d = TrickleDrainer(_factory(conn), scheduler=sched,
                       drain_fn=_make_drain(result={"unsaved": 5, "remaining": 0}))
    d.fire()
    assert sched.calls == []                       # nothing left -> don't re-arm


def test_fire_does_not_rearm_without_progress(conn):
    # a dead cookie / all-failed drain returns unsaved=0 with remaining>0 — must NOT loop forever
    db.set_setting(conn, "reddit_unsave_on_done", "1")
    sched = _make_scheduler()
    d = TrickleDrainer(_factory(conn), scheduler=sched,
                       drain_fn=_make_drain(result={"unsaved": 0, "remaining": 10, "auth_error": True}))
    d.fire()
    assert sched.calls == []                       # no progress -> no re-arm (loop guard)


def test_fire_single_flight_skips_when_already_running(conn):
    db.set_setting(conn, "reddit_unsave_on_done", "1")
    drain = _make_drain()
    d = TrickleDrainer(_factory(conn), drain_fn=drain)
    assert d._run_lock.acquire(blocking=False)     # simulate a drain already in flight
    try:
        assert d.fire() is None and drain.calls == []   # second fire is skipped, not queued
    finally:
        d._run_lock.release()
