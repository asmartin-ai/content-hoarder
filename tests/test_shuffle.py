"""Shuffle sort = source round-robin interleave (Epic 10 mixed-content mode).

Deterministic interleave so a browse page is a varied MIX of sources (not grouped),
and infinite-scroll pages don't dup/skip (unlike ORDER BY RANDOM()).
"""

from content_hoarder import db, models


def _seed(conn, source, sid):
    db.merge_upsert(conn, models.new_item(
        source=source, source_id=sid, kind="post", title=f"{source}-{sid}"))


def test_shuffle_interleaves_sources_not_grouped(conn):
    for i in range(3):
        _seed(conn, "reddit", f"r{i}")
        _seed(conn, "youtube", f"y{i}")
        _seed(conn, "hackernews", f"h{i}")
    rows = db.search_items(conn, "", status="", sort="shuffle", limit=9)
    sources = [r["source"] for r in rows]
    # each round-robin window holds one of every source — a MIX, not grouped runs
    assert set(sources[0:3]) == {"reddit", "youtube", "hackernews"}
    assert set(sources[3:6]) == {"reddit", "youtube", "hackernews"}
    assert sources[0:3] != ["reddit", "reddit", "reddit"]  # explicitly not grouped


def test_shuffle_pagination_is_stable(conn):
    for i in range(10):
        _seed(conn, "reddit", f"r{i}")
        _seed(conn, "youtube", f"y{i}")
    page = lambda off: {r["fullname"] for r in
                        db.search_items(conn, "", status="", sort="shuffle", limit=8, offset=off)}
    p1, p2 = page(0), page(8)
    assert len(p1) == 8 and len(p2) == 8
    assert not (p1 & p2)  # no duplicates / skips across pages


def test_shuffle_handles_uneven_source_sizes(conn):
    # reddit has many, firefox has one — interleave must not crash or drop the rare source
    for i in range(5):
        _seed(conn, "reddit", f"r{i}")
    _seed(conn, "firefox", "f0")
    rows = db.search_items(conn, "", status="", sort="shuffle", limit=50)
    assert len(rows) == 6
    assert "firefox" in {r["source"] for r in rows}
    # the lone firefox item lands early (first round-robin position), not last
    assert rows[0]["source"] == "firefox" or rows[1]["source"] == "firefox"
