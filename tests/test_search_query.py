from content_hoarder import search_query


def test_parse_free_text_only():
    p = search_query.parse("minecraft speedrun")
    assert p.text == "minecraft speedrun"
    assert p.source is None


def test_parse_basic_operators_and_leftover_text():
    p = search_query.parse("minecraft source:reddit status:inbox")
    assert p.text == "minecraft"
    assert p.source == "reddit"
    assert p.status == "inbox"


def test_parse_normalizes_source_kind_status_value_case():
    # Stored values are canonical-lowercase; a capitalized operator must still match.
    p = search_query.parse("source:YouTube kind:Video status:Inbox subreddit:HoloLive")
    assert p.source == "youtube"
    assert p.kind == "video"
    assert p.status == "inbox"
    assert p.subreddit == "HoloLive"  # left as-typed (matched COLLATE NOCASE downstream)


def test_parse_unknown_key_value_falls_through_to_text():
    p = search_query.parse("foo wat:bar")
    assert p.text == "foo wat:bar"


def test_parse_malformed_known_operator_falls_through_to_text():
    p = search_query.parse("before:not-a-date")
    assert p.before is None
    assert p.text == "before:not-a-date"


def test_parse_quoted_phrase_goes_to_exact_list():
    p = search_query.parse('"exact phrase" tag:coding')
    assert p.text == ""
    assert p.exact == ["exact phrase"]
    assert p.tags == ["coding"]


def test_parse_negation_minus_term():
    p = search_query.parse("cats -removed")
    assert p.text == "cats"
    assert p.exclude == ["removed"]


def test_parse_tags_or_and_and():
    p = search_query.parse("tag:a,b")
    assert p.tags == ["a", "b"]
    assert p.tags_all is False

    p2 = search_query.parse("tag:a tag:b")
    assert p2.tags == ["a", "b"]
    assert p2.tags_all is True


def test_parse_is_saved_and_nsfw():
    p = search_query.parse("is:saved is:nsfw")
    assert p.is_saved == 1
    assert p.nsfw is True


def test_parse_is_decayed_and_swept():
    p = search_query.parse("is:decayed tag:ephemeral")
    assert p.decayed is True and p.swept is False and p.tags == ["ephemeral"]
    p = search_query.parse("is:swept status:archived")
    assert p.swept is True and p.decayed is False and p.status == "archived"
    # unknown is:-value still degrades to free text
    assert search_query.parse("is:sweeped").text == "is:sweeped"


def test_parse_is_firefox_tab():
    p = search_query.parse("is:firefox-tab")
    assert p.open_in_firefox is True and p.text == ""
    # alias without the hyphen
    assert search_query.parse("is:firefoxtab").open_in_firefox is True
    # default false; composes with another operator
    p = search_query.parse("is:firefox-tab source:youtube")
    assert p.open_in_firefox is True and p.source == "youtube"
    assert search_query.parse("cats").open_in_firefox is False


def test_parse_has_media():
    p = search_query.parse("has:video cats")
    assert p.has == "video" and p.text == "cats"
    assert search_query.parse("has:GALLERY").has == "gallery"
    # unknown has:-value degrades to free text
    assert search_query.parse("has:podcast").text == "has:podcast"


def test_parse_before_after_score_bounds():
    p = search_query.parse("before:2023-01-01 after:2022-12-31 score:>100")
    assert p.before == 1672531200
    assert p.after == 1672444800
    assert p.score_min == 101 and p.score_max is None

    p2 = search_query.parse("score:<5")
    assert p2.score_min is None and p2.score_max == 4

    p3 = search_query.parse("score:100")
    assert p3.score_min == 100 and p3.score_max == 100
