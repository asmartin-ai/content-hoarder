"""Offline tests for the reddit unsave-on-done queue + drain. No real network: post/getf/sleep
are injected. Mirrors the archival/youtube_recover injectable-callable test style."""

from content_hoarder import db, models, reddit_unsave as ru


# --- helpers ---------------------------------------------------------------

def _seed(conn, *items):
    """items: (source, source_id) tuples -> seeded as inbox items."""
    for source, sid in items:
        db.merge_upsert(conn, models.new_item(source=source, source_id=sid, kind="post",
                                              title=sid, url=f"http://x/{sid}"))
    conn.commit()


def _enable(conn):
    db.set_setting(conn, "reddit_unsave_on_done", "1")


def _queue(conn):
    return {r["fullname"]: r["state"]
            for r in conn.execute("SELECT fullname, state FROM reddit_unsave").fetchall()}


def _ok_me(url, **kw):
    return {"data": {"name": "asmartin-ai", "modhash": "MH"}}


def _logged_out(url, **kw):
    return {}


class _Post:
    """Records POST calls; status decided by `decide(fields)` (default 200)."""
    def __init__(self, decide=None):
        self.calls = []
        self._decide = decide or (lambda fields: (200, {}))

    def __call__(self, url, fields, **kw):
        self.calls.append((url, fields["id"]))
        return self._decide(fields)


# --- enqueue / dequeue (db layer) ------------------------------------------

def test_enqueue_on_done_when_enabled(conn):
    _seed(conn, ("reddit", "t3_a"), ("youtube", "v1"))
    _enable(conn)
    db.set_status(conn, "reddit:t3_a", "done")
    db.set_status(conn, "youtube:v1", "done")   # non-reddit -> not queued
    q = _queue(conn)
    assert q == {"reddit:t3_a": "pending"}
    assert conn.execute("SELECT reddit_id FROM reddit_unsave WHERE fullname='reddit:t3_a'"
                        ).fetchone()["reddit_id"] == "t3_a"


def test_no_enqueue_when_disabled(conn):
    _seed(conn, ("reddit", "t3_a"))
    db.set_status(conn, "reddit:t3_a", "done")   # feature off by default
    assert _queue(conn) == {}


def test_no_enqueue_for_non_done_status(conn):
    _seed(conn, ("reddit", "t3_a"))
    _enable(conn)
    db.set_status(conn, "reddit:t3_a", "keep")
    db.set_status(conn, "reddit:t3_a", "archived")
    assert _queue(conn) == {}


def test_bulk_enqueue_only_reddit(conn):
    _seed(conn, ("reddit", "t3_a"), ("reddit", "t1_b"), ("youtube", "v1"))
    _enable(conn)
    n = db.bulk_set_status(conn, ["reddit:t3_a", "reddit:t1_b", "youtube:v1"], "done")
    assert n == 3
    assert _queue(conn) == {"reddit:t3_a": "pending", "reddit:t1_b": "pending"}


def test_dequeue_on_undo_before_drain(conn):
    _seed(conn, ("reddit", "t3_a"))
    _enable(conn)
    db.set_status(conn, "reddit:t3_a", "done")
    assert _queue(conn) == {"reddit:t3_a": "pending"}
    db.undo_status(conn, "reddit:t3_a")          # Done undone before drain -> never sent
    assert _queue(conn) == {}


# --- drain -----------------------------------------------------------------

def _seed_pending(conn, *sids):
    _seed(conn, *[("reddit", s) for s in sids])
    _enable(conn)
    for s in sids:
        db.set_status(conn, f"reddit:{s}", "done")


def test_drain_success(conn):
    _seed_pending(conn, "t3_a", "t3_b", "t3_c")
    ru.set_auth(conn, session_cookie="ck", username="asmartin-ai")
    post, sleeps = _Post(), []
    res = ru.drain(conn, post=post, getf=_ok_me, sleep=lambda s: sleeps.append(s))
    assert res["unsaved"] == 3 and res["failed"] == 0 and res["remaining"] == 0
    assert not res["auth_error"]
    assert all(st == "done" for st in _queue(conn).values())
    saved = conn.execute("SELECT COUNT(*) FROM items WHERE is_saved=0").fetchone()[0]
    assert saved == 3
    assert post.calls == [(ru.UNSAVE_URL, "t3_a"), (ru.UNSAVE_URL, "t3_b"), (ru.UNSAVE_URL, "t3_c")]
    assert sleeps == [1.0, 1.0]  # throttle between the 3 items, not before the first


def test_drain_respects_limit(conn):
    _seed_pending(conn, "t3_a", "t3_b", "t3_c")
    ru.set_auth(conn, session_cookie="ck")
    res = ru.drain(conn, limit=1, post=_Post(), getf=_ok_me, sleep=lambda s: None)
    assert res["unsaved"] == 1 and res["remaining"] == 2


def test_drain_no_auth_configured(conn):
    _seed_pending(conn, "t3_a")
    post = _Post()
    res = ru.drain(conn, post=post, getf=_ok_me, sleep=lambda s: None)
    assert res["auth_error"] is True
    assert post.calls == []                        # nothing sent
    assert _queue(conn) == {"reddit:t3_a": "pending"}


def test_drain_auth_failure_logged_out(conn):
    _seed_pending(conn, "t3_a")
    ru.set_auth(conn, session_cookie="dead")
    post = _Post()
    res = ru.drain(conn, post=post, getf=_logged_out, sleep=lambda s: None)
    assert res["auth_error"] is True
    assert post.calls == []                        # fail fast before any unsave POST
    assert _queue(conn) == {"reddit:t3_a": "pending"}


def test_drain_429_backoff_then_success(conn):
    _seed_pending(conn, "t3_a")
    ru.set_auth(conn, session_cookie="ck")
    seq = iter([(429, {"Retry-After": "5"}), (200, {})])
    sleeps = []
    res = ru.drain(conn, post=lambda *a, **k: next(seq), getf=_ok_me,
                   sleep=lambda s: sleeps.append(s))
    assert res["unsaved"] == 1
    assert 5.0 in sleeps                            # honored Retry-After


def test_drain_per_item_failure_isolated(conn):
    _seed_pending(conn, "t3_a", "t3_bad", "t3_c")
    ru.set_auth(conn, session_cookie="ck")
    post = _Post(decide=lambda f: (404, {}) if f["id"] == "t3_bad" else (200, {}))
    res = ru.drain(conn, post=post, getf=_ok_me, sleep=lambda s: None)
    assert res["unsaved"] == 2 and res["failed"] == 1
    q = _queue(conn)
    assert q["reddit:t3_bad"] == "pending"          # failure stays re-drainable
    row = conn.execute("SELECT attempts, last_error FROM reddit_unsave WHERE fullname='reddit:t3_bad'"
                       ).fetchone()
    assert row["attempts"] == 1 and "404" in row["last_error"]


def test_drain_403_halts(conn):
    _seed_pending(conn, "t3_a", "t3_b")
    ru.set_auth(conn, session_cookie="ck")
    post = _Post(decide=lambda f: (403, {}))
    res = ru.drain(conn, post=post, getf=_ok_me, sleep=lambda s: None)
    assert res["auth_error"] is True
    assert res["unsaved"] == 0
    assert all(st == "pending" for st in _queue(conn).values())


# --- resave (undo after drain) --------------------------------------------

def test_resave_reverts_is_saved(conn):
    _seed_pending(conn, "t3_a")
    ru.set_auth(conn, session_cookie="ck")
    ru.drain(conn, post=_Post(), getf=_ok_me, sleep=lambda s: None)   # now done + is_saved=0
    assert conn.execute("SELECT is_saved FROM items WHERE fullname='reddit:t3_a'").fetchone()[0] == 0
    ok = ru.resave(conn, "reddit:t3_a", post=_Post(), getf=_ok_me)
    assert ok is True
    assert conn.execute("SELECT is_saved FROM items WHERE fullname='reddit:t3_a'").fetchone()[0] == 1
    assert _queue(conn) == {}                        # row removed


def test_resave_auth_dead_returns_false(conn):
    _seed_pending(conn, "t3_a")
    ru.set_auth(conn, session_cookie="dead")
    ru.drain(conn, post=_Post(), getf=_ok_me, sleep=lambda s: None)
    ok = ru.resave(conn, "reddit:t3_a", post=_Post(), getf=_logged_out)
    assert ok is False


# --- schema idempotency ----------------------------------------------------

def test_enqueue_existing_done_backfill(conn):
    _seed(conn, ("reddit", "t3_a"), ("reddit", "t1_b"), ("reddit", "t3_c"), ("youtube", "v1"))
    # mark some done directly (feature disabled, so nothing auto-queues)
    for fn in ("reddit:t3_a", "reddit:t1_b", "youtube:v1"):
        db.set_status(conn, fn, "done")
    assert _queue(conn) == {}
    added = db.enqueue_existing_done(conn)
    assert added == 2                                # only the two reddit done items
    assert _queue(conn) == {"reddit:t3_a": "pending", "reddit:t1_b": "pending"}
    assert db.enqueue_existing_done(conn) == 0       # idempotent (already queued)


def test_schema_idempotent(tmp_db):
    db.connect(tmp_db).close()
    c = db.connect(tmp_db)                            # reopen -> reddit_unsave still there
    _seed(c, ("reddit", "t3_a"))
    db.set_setting(c, "reddit_unsave_on_done", "1")
    db.set_status(c, "reddit:t3_a", "done")
    assert ru.count_pending(c) == 1
    c.close()


# --- Retry-After parsing (delegation/01) ------------------------------------

def _send_once_429(headers):
    """post stub: 429 with `headers` on the first call, 200 after."""
    state = {"n": 0}

    def post(url, fields, **kw):
        state["n"] += 1
        return (429, headers) if state["n"] == 1 else (200, {})

    return post


def test_retry_after_lowercase_header_honored():
    slept = []
    ok, err = ru._send_with_retry(_send_once_429({"retry-after": "7"}), ru.UNSAVE_URL, "t3_x",
                                  session_cookie="ck", modhash="mh", user_agent="ua",
                                  sleep=slept.append)
    assert (ok, err) == (True, None) and slept == [7.0]


def test_retry_after_http_date_falls_back_to_delay():
    slept = []
    ok, err = ru._send_with_retry(_send_once_429({"Retry-After": "Fri, 31 Dec 1999 23:59:59 GMT"}),
                                  ru.UNSAVE_URL, "t3_x", session_cookie="ck", modhash="mh",
                                  user_agent="ua", sleep=slept.append)
    assert (ok, err) == (True, None) and slept == [2.0]


def test_retry_after_negative_falls_back_to_delay():
    slept = []
    ok, err = ru._send_with_retry(_send_once_429({"Retry-After": "-5"}), ru.UNSAVE_URL, "t3_x",
                                  session_cookie="ck", modhash="mh", user_agent="ua",
                                  sleep=slept.append)
    assert (ok, err) == (True, None) and slept == [2.0]


# --- attempts cap -> state='failed' (delegation/02) --------------------------

def test_drain_caps_attempts_then_parks_as_failed(conn):
    _seed(conn, ("reddit", "t3_a"))
    _enable(conn)
    db.set_status(conn, "reddit:t3_a", "done")
    ru.set_auth(conn, session_cookie="ck")
    always_500 = _Post(lambda fields: (500, {}))
    for _ in range(ru.MAX_ATTEMPTS):
        ru.drain(conn, post=always_500, getf=_ok_me, sleep=lambda s: None)
    row = conn.execute(
        "SELECT state, attempts FROM reddit_unsave WHERE fullname='reddit:t3_a'"
    ).fetchone()
    assert (row["state"], row["attempts"]) == ("failed", ru.MAX_ATTEMPTS)
    res = ru.drain(conn, post=always_500, getf=_ok_me, sleep=lambda s: None)
    assert res["selected"] == 0  # retired rows stop consuming the throttle


def test_re_enqueue_resets_failed_row(conn):
    _seed(conn, ("reddit", "t3_a"))
    _enable(conn)
    db.set_status(conn, "reddit:t3_a", "done")
    ru.set_auth(conn, session_cookie="ck")
    always_500 = _Post(lambda fields: (500, {}))
    for _ in range(ru.MAX_ATTEMPTS):
        ru.drain(conn, post=always_500, getf=_ok_me, sleep=lambda s: None)
    db.enqueue_unsave(conn, "reddit:t3_a")  # fresh chance
    conn.commit()
    row = conn.execute(
        "SELECT state, attempts, last_error FROM reddit_unsave WHERE fullname='reddit:t3_a'"
    ).fetchone()
    assert (row["state"], row["attempts"], row["last_error"]) == ("pending", 0, None)
    res = ru.drain(conn, post=_Post(), getf=_ok_me, sleep=lambda s: None)
    assert res["unsaved"] == 1


# --- network error vs auth error (delegation/03) -----------------------------

def _raise_network(url, **kw):
    raise ru.RedditNetworkError("boom")


def test_drain_network_error_not_auth_error(conn):
    _seed(conn, ("reddit", "t3_a"))
    _enable(conn)
    db.set_status(conn, "reddit:t3_a", "done")
    ru.set_auth(conn, session_cookie="ck")
    post = _Post()
    res = ru.drain(conn, post=post, getf=_raise_network, sleep=lambda s: None)
    assert res["network_error"] is True and res["auth_error"] is False
    assert post.calls == []                            # nothing sent
    assert _queue(conn) == {"reddit:t3_a": "pending"}  # queue intact for retry


def test_resave_network_error_returns_false(conn):
    _seed(conn, ("reddit", "t3_a"))
    _enable(conn)
    db.set_status(conn, "reddit:t3_a", "done")
    ru.set_auth(conn, session_cookie="ck")
    ru.drain(conn, post=_Post(), getf=_ok_me, sleep=lambda s: None)
    assert ru.resave(conn, "reddit:t3_a", post=_Post(), getf=_raise_network) is False
