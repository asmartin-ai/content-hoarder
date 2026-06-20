"""Bakeoff ORACLE — F9: bare ``r/<sub>`` is subreddit-operator shorthand.

RED until implemented. This file is the objective "done" oracle for the delegation
task formerly tracked as F9 (now SHIPPED; see ``BACKLOG.md`` Epic 12):

    Typing ``r/tankporn`` in the search bar is equivalent to ``subreddit:tankporn``.

Decision (handoff §4 open item, resolved to the safe default here): ``r/`` is an
**ALIAS** for the existing ``subreddit:`` operator — both forms work; ``subreddit:``
is NOT removed/deprecated.

Anti-gaming shape: the fix must be a PURE ADDED recognizer branch in
``search_query.parse`` for a token that today falls through to free text (a bare
``r/<sub>`` has no ``:`` so ``_OP_RE`` never matches it). The existing
``subreddit:`` operator branch must stay byte-identical, and the ``_must_be_standalone``
guard below must remain green (the recognizer has to be anchored ``^r/<name>$`` — a
reddit URL token must NOT be captured).
"""
from content_hoarder import search_query


def test_bare_r_slash_is_subreddit_shorthand():
    # Today: "r/tankporn" has no ':' -> falls through to free text (pq.subreddit is None).
    pq = search_query.parse("r/tankporn")
    assert pq.subreddit == "tankporn"
    assert pq.text == ""  # consumed as the operator, not left as leftover free text


def test_bare_r_slash_equivalent_to_subreddit_operator():
    assert (
        search_query.parse("r/tankporn").subreddit
        == search_query.parse("subreddit:tankporn").subreddit
        == "tankporn"
    )


def test_bare_r_slash_composes_with_free_text_and_operators():
    pq = search_query.parse("r/tankporn abrams source:reddit")
    assert pq.subreddit == "tankporn"
    assert pq.source == "reddit"
    assert pq.text == "abrams"


def test_bare_r_slash_value_left_as_typed_like_subreddit_operator():
    # subreddit values are matched COLLATE NOCASE downstream and kept as-typed
    # (mirrors test_parse_normalizes_..._case for subreddit:HoloLive).
    assert search_query.parse("r/TankPorn").subreddit == "TankPorn"


def test_r_slash_must_be_standalone_token_not_inside_a_url():
    # GUARD (already green today, must STAY green): a reddit URL token must not be
    # mistaken for the operator — a naive substring/contains match would wrongly
    # capture this. Keeps the added recognizer anchored to a standalone ^r/<name>$ token.
    pq = search_query.parse("https://www.reddit.com/r/tankporn/comments/abc/")
    assert pq.subreddit is None
