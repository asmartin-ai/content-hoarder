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
    db.set_setting(conn, "reddit_sync_newest", "t3_b")  # newest from a prior sync
    getf = make_getf([([child("t3_a"), child("t3_b"), child("t3_c")], "p2")])
    res = reddit_sync.sync_saved_cookie(conn, getf=getf, user_agent="ua", sleep=NOSLEEP)
    # t3_a is new; t3_b is the mark -> stop before processing t3_b / t3_c
    assert res["new"] == 1 and res["stopped"] == "caught_up"
    assert db.get_item(conn, "reddit:t3_a") is not None
    assert db.get_item(conn, "reddit:t3_c") is None
    assert db.get_setting(conn, "reddit_sync_newest") == "t3_a"  # advanced to new top


def test_sync_auth_error_without_cookie(conn):
    res = reddit_sync.sync_saved_cookie(conn, getf=make_getf([]), user_agent="ua")
    assert res["auth_error"] is True and res["stopped"] == "auth_error"


def test_sync_learns_username_from_me(conn):
    reddit_unsave.set_auth(conn, session_cookie="ck", modhash="mh", username=None)
    getf = make_getf([([child("t3_z")], None)], me={"data": {"name": "bob", "modhash": "mh"}})
    res = reddit_sync.sync_saved_cookie(conn, getf=getf, user_agent="ua")
    assert res["username"] == "bob" and res["new"] == 1
