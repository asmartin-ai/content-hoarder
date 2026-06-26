import json

from content_hoarder import db, hn_sync


NOSLEEP = lambda _s: None


def _url(user="alice", p=None):
    base = hn_sync.FAVORITES_URL + f"?id={user}"
    return base if p is None else base + f"&p={p}"


def _page(ids, more=None):
    rows = []
    for sid in ids:
        rows.append(
            f'<tr class="athing" id="{sid}"><td class="title">'
            f'<a href="item?id={sid}">Story {sid}</a></td></tr>'
        )
    if more:
        rows.append(f'<a href="{more}" class="morelink" rel="next">More</a>')
    return "\n".join(rows)


def _getf(pages, calls=None):
    def getf(url):
        if calls is not None:
            calls.append(url)
        return 200, pages[url].encode("utf-8")

    return getf


def test_extract_ids_distinct_ordered():
    html = (
        '<tr class="athing" id="100"></tr><a href="item?id=100">A</a>'
        '<a href="item?id=99">B</a><a href="item?id=100">A again</a>'
    )
    assert hn_sync._extract_ids(html) == ["100", "99"]


def test_extract_next_more_link():
    html = '<a href="/favorites?id=alice&amp;p=2" class="morelink" rel="next">More</a>'
    assert hn_sync._extract_next(html) == "/favorites?id=alice&p=2"
    assert hn_sync._extract_next("<a href='/x'>Other</a>") is None


def test_sync_first_run_walks_pages_and_sets_mark(conn):
    pages = {
        _url(): _page(["100", "99"], more="/favorites?id=alice&p=2"),
        _url(p=2): _page(["98"]),
    }
    res = hn_sync.sync_saved(conn, user="alice", getf=_getf(pages), sleep=NOSLEEP)
    assert res["stopped"] == "exhausted"
    assert res["pages"] == 2
    assert res["new"] == 3
    md = json.loads(db.get_item(conn, "hackernews:100")["metadata"])
    assert md["hn_list"] == "saved"
    assert md["hn_url"] == "https://news.ycombinator.com/item?id=100"
    assert json.loads(db.get_setting(conn, "hn_sync_newest")) == [
        "hackernews:100", "hackernews:99", "hackernews:98"
    ]


def test_sync_stops_at_high_water_mark(conn):
    db.set_setting(conn, "hn_sync_newest", json.dumps(["hackernews:99"]))
    calls = []
    pages = {
        _url(): _page(["101", "99", "98"], more="/favorites?id=alice&p=2"),
        _url(p=2): _page(["97"]),
    }
    res = hn_sync.sync_saved(conn, user="alice", getf=_getf(pages, calls), sleep=NOSLEEP)
    assert res["stopped"] == "caught_up"
    assert res["new"] == 1
    assert db.get_item(conn, "hackernews:101") is not None
    assert db.get_item(conn, "hackernews:98") is None
    assert calls == [_url()]
    assert json.loads(db.get_setting(conn, "hn_sync_newest")) == [
        "hackernews:101", "hackernews:99"
    ]


def test_sync_keeps_mark_on_max_pages_truncation(conn):
    db.set_setting(conn, "hn_sync_newest", json.dumps(["hackernews:old"]))
    pages = {
        _url(): _page(["101"], more="/favorites?id=alice&p=2"),
        _url(p=2): _page(["100"]),
    }
    res = hn_sync.sync_saved(
        conn, user="alice", max_pages=1, getf=_getf(pages), sleep=NOSLEEP
    )
    assert res["stopped"] == "max_pages"
    assert res["new"] == 1
    assert json.loads(db.get_setting(conn, "hn_sync_newest")) == ["hackernews:old"]


def test_sync_idempotent_rerun(conn):
    pages = {_url(): _page(["100", "99"])}
    hn_sync.sync_saved(conn, user="alice", getf=_getf(pages), sleep=NOSLEEP)
    res = hn_sync.sync_saved(conn, user="alice", getf=_getf(pages), sleep=NOSLEEP)
    assert res["stopped"] == "caught_up"
    assert res["new"] == 0
    assert res["updated"] == 0


def test_sync_network_error_soft_and_keeps_mark(conn):
    db.set_setting(conn, "hn_sync_newest", json.dumps(["hackernews:99"]))

    def getf(_url):
        return 500, b"server error"

    res = hn_sync.sync_saved(conn, user="alice", getf=getf, sleep=NOSLEEP)
    assert res["stopped"] == "network_error"
    assert res["network_error"] is True
    assert json.loads(db.get_setting(conn, "hn_sync_newest")) == ["hackernews:99"]


def test_sync_network_error_after_partial_first_run_does_not_set_mark(conn):
    calls = []

    def getf(url):
        calls.append(url)
        if len(calls) == 1:
            return 200, _page(["101"], more="/favorites?id=alice&p=2").encode("utf-8")
        return 500, b"server error"

    res = hn_sync.sync_saved(conn, user="alice", getf=getf, sleep=NOSLEEP)
    assert res["stopped"] == "network_error"
    assert db.get_item(conn, "hackernews:101") is not None
    assert db.get_setting(conn, "hn_sync_newest") is None
