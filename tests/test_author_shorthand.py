"""Epic 12 — ``author:`` operator + bare ``u/<user>`` shorthand.

Mirrors the F9 ``r/<sub>`` oracle (tests/test_bakeoff_f9_subreddit_shorthand.py):
``u/`` is an ALIAS for the new ``author:`` operator — both forms work, neither is
removed. The recognizer is a PURE ADDED branch in ``search_query.parse`` anchored to
a standalone ``^u/<name>$`` token, so a reddit profile URL must NOT be captured. The
filter rides the first-class ``author`` column in ``db.search_items`` (COLLATE NOCASE,
like ``subreddit``).
"""
from content_hoarder import db, models, search_query


def mk(**kw):
    kw.setdefault("now", 1000)
    return models.new_item(**kw)


# ---- parser (pure) --------------------------------------------------------

def test_author_operator_parses():
    assert search_query.parse("author:spez").author == "spez"


def test_bare_u_slash_is_author_shorthand():
    pq = search_query.parse("u/spez")
    assert pq.author == "spez"
    assert pq.text == ""  # consumed as the operator, not left as leftover free text


def test_bare_u_slash_equivalent_to_author_operator():
    assert (
        search_query.parse("u/spez").author
        == search_query.parse("author:spez").author
        == "spez"
    )


def test_bare_u_slash_composes_with_free_text_and_operators():
    pq = search_query.parse("u/spez reddit source:reddit r/announcements")
    assert pq.author == "spez"
    assert pq.subreddit == "announcements"
    assert pq.source == "reddit"
    assert pq.text == "reddit"


def test_bare_u_slash_value_left_as_typed():
    # author is matched COLLATE NOCASE downstream; the value is kept as-typed, like subreddit:.
    assert search_query.parse("u/Spez").author == "Spez"


def test_author_allows_hyphen_and_underscore_usernames():
    assert search_query.parse("u/some_user-name").author == "some_user-name"


def test_u_slash_must_be_standalone_token_not_inside_a_url():
    # GUARD: a reddit profile URL token must not be mistaken for the operator.
    pq = search_query.parse("https://www.reddit.com/u/spez/")
    assert pq.author is None


def test_author_comma_is_or_multivalue():
    assert search_query.parse("author:spez,kn0thing").author == ["spez", "kn0thing"]


# ---- end-to-end filter through db.search_items ----------------------------

def test_search_items_filters_by_author(conn):
    db.merge_upsert(conn, mk(source="reddit", source_id="a", title="one", author="spez"))
    db.merge_upsert(conn, mk(source="reddit", source_id="b", title="two", author="kn0thing"))

    rows = db.search_items(conn, "", author="spez")
    assert [r["source_id"] for r in rows] == ["a"]


def test_search_items_author_is_case_insensitive(conn):
    db.merge_upsert(conn, mk(source="reddit", source_id="a", title="one", author="Spez"))
    rows = db.search_items(conn, "", author="spez")
    assert [r["source_id"] for r in rows] == ["a"]


def test_search_items_author_list_is_or(conn):
    db.merge_upsert(conn, mk(source="reddit", source_id="a", title="one", author="spez"))
    db.merge_upsert(conn, mk(source="reddit", source_id="b", title="two", author="kn0thing"))
    db.merge_upsert(conn, mk(source="reddit", source_id="c", title="three", author="other"))

    rows = db.search_items(conn, "", author=["spez", "kn0thing"])
    assert sorted(r["source_id"] for r in rows) == ["a", "b"]
