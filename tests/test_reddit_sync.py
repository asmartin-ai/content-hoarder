import json

from content_hoarder import db, reddit_sync, reddit_unsave


def child(name, sub="x"):
    return {"kind": "t3" if name.startswith("t3") else "t1",
            "data": {"name": name, "title": name, "subreddit": sub,
                     "permalink": "/r/" + sub + "/comments/" + name[3:] + "/",
                     "score": 1, "author": "u", "created_utc": 1}}


def make_getf(pages, me=None):
    """Injectable getf: serves `pages` (list of (children, after)) sequentially; /api/me.json
    returns `me`. Ignores the URL's after-cursor (sequence is enough for tests)."""
    state = {"i": 0}

    def getf(url, *, session_cookie, user_agent):
        if "me.json" in url:
            return me or {}
        i = state["i"]
        state["i"] += 1
        if i >= len(pages):
            return {"data": {"children": [], "after": None}}
        kids, after = pages[i]
        return {"data": {"children": kids, "after": after}}

    return getf


def _auth(conn, username="alice"):
    reddit_unsave.set_auth(conn, session_cookie="ck", modhash="mh", username=username)


NOSLEEP = (lambda _s: None)  # keep multi-page tests instant


def test_sync_inserts_new(conn):
    _auth(conn)
    res = reddit_sync.sync_saved_cookie(
        conn, getf=make_getf([([child("t3_a"), child("t3_b")], None)]), user_agent="ua")
    assert res["new"] == 2 and res["fetched"] == 2 and res["stopped"] == "exhausted"
    assert db.get_item(conn, "reddit:t3_a") is not None
    assert db.get_item(conn, "reddit:t3_b") is not None


def test_sync_stops_on_known(conn):
    _auth(conn)
    getf = make_getf([
        ([child("t3_a"), child("t3_b")], "p2"),
        ([child("t3_a"), child("t3_b")], "p3"),  # whole page already known -> stop
    ])
    res = reddit_sync.sync_saved_cookie(conn, getf=getf, user_agent="ua", max_pages=5, sleep=NOSLEEP)
    assert res["pages"] == 2 and res["new"] == 2 and res["updated"] == 2
    assert res["stopped"] == "all_known"


def test_sync_respects_max_pages(conn):
    _auth(conn)
    getf = make_getf([
        ([child("t3_a")], "p2"),
        ([child("t3_b")], "p3"),
        ([child("t3_c")], "p4"),  # never reached
    ])
    res = reddit_sync.sync_saved_cookie(conn, getf=getf, user_agent="ua", max_pages=2, sleep=NOSLEEP)
    assert res["pages"] == 2 and res["new"] == 2 and res["stopped"] == "max_pages"
    assert db.get_item(conn, "reddit:t3_c") is None


def test_sync_stops_at_high_water_mark(conn):
    _auth(conn)
    # Legacy single-string mark from a pre-list DB — must still be honored, and the next
    # successful sync upgrades it to the JSON-list form.
    db.set_setting(conn, "reddit_sync_newest", "t3_b")
    getf = make_getf([([child("t3_a"), child("t3_b"), child("t3_c")], "p2")])
    res = reddit_sync.sync_saved_cookie(conn, getf=getf, user_agent="ua", sleep=NOSLEEP)
    # t3_a is new; t3_b is the mark -> stop before processing t3_b / t3_c
    assert res["new"] == 1 and res["stopped"] == "caught_up"
    assert db.get_item(conn, "reddit:t3_a") is not None
    assert db.get_item(conn, "reddit:t3_c") is None
    # Advanced to the new top-of-listing (incl. the still-listed old mark item), JSON form.
    assert json.loads(db.get_setting(conn, "reddit_sync_newest")) == ["t3_a", "t3_b"]


def test_sync_mark_survives_drained_newest(conn):
    """Regression: the unsave drain removes items from the saved listing. If the single
    newest-marked item is unsaved, a one-name mark would never be re-found and every sync
    would degrade to a max_pages walk forever. The K-deep mark matches any survivor."""
    _auth(conn)
    # Prior sync recorded these as the top of the listing; t3_gone has since been unsaved.
    db.set_setting(conn, "reddit_sync_newest", json.dumps(["t3_gone", "t3_b"]))
    getf = make_getf([([child("t3_new"), child("t3_b"), child("t3_c")], "p2")])
    res = reddit_sync.sync_saved_cookie(conn, getf=getf, user_agent="ua", sleep=NOSLEEP)
    assert res["stopped"] == "caught_up" and res["new"] == 1  # t3_b still matches
    assert db.get_item(conn, "reddit:t3_new") is not None
    assert db.get_item(conn, "reddit:t3_c") is None  # below the boundary — untouched
    assert json.loads(db.get_setting(conn, "reddit_sync_newest")) == ["t3_new", "t3_b"]


def test_sync_keeps_mark_on_max_pages_truncation(conn):
    """An established mark must NOT advance when a sync truncates at max_pages: the items
    between the cutoff and the old mark are unfetched, so moving the mark to the new top
    would skip them on every future sync (silent data gap)."""
    _auth(conn)
    db.set_setting(conn, "reddit_sync_newest", "t3_old")  # mark from a prior full sync
    getf = make_getf([
        ([child("t3_a")], "p2"),
        ([child("t3_b")], "p3"),  # truncated by max_pages=2; t3_old never reached
    ])
    res = reddit_sync.sync_saved_cookie(conn, getf=getf, user_agent="ua", max_pages=2, sleep=NOSLEEP)
    assert res["stopped"] == "max_pages" and res["new"] == 2
    assert db.get_setting(conn, "reddit_sync_newest") == "t3_old"  # unchanged — no gap


def test_sync_stamps_saved_seen_utc_marker(conn):
    """Cookie sync is an authoritative saved-list snapshot, so its rows carry the
    metadata.saved_seen_utc provenance marker reconcile_reddit_saves requires."""
    _auth(conn)
    reddit_sync.sync_saved_cookie(
        conn, getf=make_getf([([child("t3_a")], None)]), user_agent="ua")
    seen = conn.execute(
        "SELECT json_extract(metadata, '$.saved_seen_utc') FROM items "
        "WHERE fullname='reddit:t3_a'").fetchone()[0]
    assert seen is not None and seen > 0


def test_sync_assigns_monotonic_saved_utc_newest_first(conn):
    """Cookie sync (child_to_item leaves saved_utc=0) must assign a monotonic saved_utc so fresh
    saves sort NEWEST, not oldest — sharing the same counter as file imports."""
    _auth(conn)
    # listing is newest-first: t3_a is the most recently saved
    reddit_sync.sync_saved_cookie(
        conn, getf=make_getf([([child("t3_a"), child("t3_b"), child("t3_c")], None)]),
        user_agent="ua")

    def s(sid):
        return conn.execute("SELECT saved_utc FROM items WHERE fullname=?",
                            (f"reddit:{sid}",)).fetchone()[0]

    assert s("t3_a") > s("t3_b") > s("t3_c") > 0   # newest-first, none stuck at 0

    # a later sync's items sit ABOVE the first batch (monotonic across syncs)
    db.set_setting(conn, "reddit_sync_newest", "")  # clear mark so the next batch is all-new
    reddit_sync.sync_saved_cookie(
        conn, getf=make_getf([([child("t3_z")], None)]), user_agent="ua")
    assert s("t3_z") > s("t3_a")


def test_sync_auth_error_without_cookie(conn):
    res = reddit_sync.sync_saved_cookie(conn, getf=make_getf([]), user_agent="ua")
    assert res["auth_error"] is True and res["stopped"] == "auth_error"


def test_sync_learns_username_from_me(conn):
    reddit_unsave.set_auth(conn, session_cookie="ck", modhash="mh", username=None)
    getf = make_getf([([child("t3_z")], None)], me={"data": {"name": "bob", "modhash": "mh"}})
    res = reddit_sync.sync_saved_cookie(conn, getf=getf, user_agent="ua")
    assert res["username"] == "bob" and res["new"] == 1


def test_sync_prefers_oauth_when_configured(conn, monkeypatch):
    """With OAuth configured and no injected cookie getf, the sync hits oauth.reddit.com with a
    bearer token + compliant UA and addresses /user/<me>/saved — mirroring hydrate_one's selection."""
    from content_hoarder import reddit_oauth
    reddit_oauth._store(conn, refresh_token="RT", access_token="AT", username="alice")
    captured = {}

    def fake_oauth_get(url, *, bearer, user_agent):
        captured.update(url=url, bearer=bearer, ua=user_agent)
        return {"data": {"children": [child("t3_a"), child("t3_b")], "after": None}}

    monkeypatch.setattr(reddit_oauth, "oauth_get", fake_oauth_get)
    res = reddit_sync.sync_saved(conn)                 # getf=None -> OAuth path
    assert res["transport"] == "oauth" and res["new"] == 2 and res["username"] == "alice"
    assert captured["url"].startswith("https://oauth.reddit.com/user/alice/saved")
    assert captured["bearer"] == "AT"
    assert captured["ua"].startswith("windows:content-hoarder:")     # compliant OAuth UA


def test_sync_cookie_transport_labeled(conn):
    """An injected getf keeps the cookie path (transport='cookie') — the OAuth selector is bypassed."""
    _auth(conn)
    res = reddit_sync.sync_saved(
        conn, getf=make_getf([([child("t3_a")], None)]), user_agent="ua")
    assert res["transport"] == "cookie" and res["new"] == 1


def test_sync_network_error_keeps_mark(conn):
    """A transport failure must not read as 'cookie expired' and must not move the mark."""
    _auth(conn)
    db.set_setting(conn, "reddit_sync_newest", json.dumps(["t3_b"]))

    def getf(url, *, session_cookie, user_agent):
        raise reddit_unsave.RedditNetworkError("connection refused")

    res = reddit_sync.sync_saved_cookie(conn, getf=getf, user_agent="ua", sleep=NOSLEEP)
    assert res["stopped"] == "network_error" and res["network_error"] is True
    assert res["auth_error"] is False
    assert json.loads(db.get_setting(conn, "reddit_sync_newest")) == ["t3_b"]
