import json

from content_hoarder.connectors.twitter import TwitterConnector, tweet_id_from_url


def md(item):
    return json.loads(item["metadata"])


def test_twitter_json_fixture(fixtures):
    its = list(TwitterConnector().import_file(fixtures / "twitter" / "bookmarks.json"))
    assert [it["fullname"] for it in its] == [
        "twitter:1777777777777777777",
        "twitter:1888888888888888888",
    ]
    first = its[0]
    assert first["kind"] == "tweet"
    assert first["title"] == "Useful thread about SQLite FTS5 trigram indexes"
    assert first["author"] == "db_notes"
    assert first["created_utc"] == 1714566896
    meta = md(first)
    assert meta["author_name"] == "Database Notes"
    assert meta["permalink"] == "https://x.com/db_notes/status/1777777777777777777"
    assert meta["media_urls"] == ["https://pbs.twimg.com/media/abc123.jpg?name=orig"]
    assert meta["media_type"] == "image"


def test_twitter_csv_fixture(fixtures):
    its = list(TwitterConnector().import_file(fixtures / "twitter" / "bookmarks.csv"))
    assert len(its) == 1
    it = its[0]
    assert it["fullname"] == "twitter:1999999999999999999"
    assert it["url"] == "https://x.com/csv_user/status/1999999999999999999"
    assert md(it)["bookmark_index"] == 0


def test_twitter_can_import_is_conservative(tmp_path, fixtures):
    c = TwitterConnector()
    assert c.can_import(fixtures / "twitter" / "bookmarks.json") is True
    generic = tmp_path / "bookmarks.json"
    generic.write_text(json.dumps([{"name": "x", "foo": 1}, {"name": "y"}]), encoding="utf-8")
    assert c.can_import(generic) is False


def test_twitter_graphql_shape_and_dedup(tmp_path):
    p = tmp_path / "x.json"
    p.write_text(json.dumps({
        "data": {"bookmark_timeline": {"timeline": {"instructions": [{
            "entries": [{
                "content": {"itemContent": {"tweet_results": {"result": {
                    "rest_id": "1555555555555555555",
                    "core": {"user_results": {"result": {"legacy": {
                        "screen_name": "graph_user",
                        "name": "Graph User",
                    }}}},
                    "legacy": {
                        "full_text": "Nested GraphQL tweet",
                        "created_at": "Wed Oct 10 20:19:24 +0000 2018",
                        "entities": {"urls": [{
                            "url": "https://t.co/short",
                            "expanded_url": "https://www.youtube.com/watch?v=GraphVid001",
                        }]},
                        "extended_entities": {"media": [{
                            "type": "photo",
                            "media_url_https": "https://pbs.twimg.com/media/nested.jpg?format=jpg&name=small",
                        }]},
                    },
                }}}}
            }, {
                "content": {"itemContent": {"tweet_results": {"result": {
                    "rest_id": "1555555555555555555",
                    "legacy": {"full_text": "duplicate"},
                }}}}
            }]
        }]}}}
    }), encoding="utf-8")

    its = list(TwitterConnector().import_file(p))
    assert len(its) == 1
    it = its[0]
    assert it["fullname"] == "twitter:1555555555555555555"
    assert it["title"] == "Nested GraphQL tweet"
    assert it["author"] == "graph_user"
    assert it["created_utc"] == 1539202764
    assert md(it)["media_urls"] == ["https://pbs.twimg.com/media/nested.jpg?name=orig"]
    assert md(it)["outlinks"] == ["https://www.youtube.com/watch?v=GraphVid001"]


def test_twitter_graphql_quote_reply_and_video_context(tmp_path):
    p = tmp_path / "x-video.json"
    p.write_text(json.dumps({
        "tweet_results": {"result": {
            "rest_id": "1666666666666666666",
            "core": {"user_results": {"result": {"legacy": {
                "screen_name": "clipper",
                "name": "Clipper",
            }}}},
            "legacy": {
                "full_text": "replying with a clip",
                "created_at": "Wed Oct 10 20:19:24 +0000 2018",
                "conversation_id_str": "1111111111111111111",
                "in_reply_to_status_id_str": "1222222222222222222",
                "in_reply_to_screen_name": "parent",
                "extended_entities": {"media": [{
                    "type": "video",
                    "media_url_https": "https://pbs.twimg.com/media/poster.jpg?format=jpg&name=small",
                    "video_info": {"variants": [
                        {"content_type": "application/x-mpegURL",
                         "url": "https://video.twimg.com/ext_tw_video/1/pu/pl/x.m3u8"},
                        {"content_type": "video/mp4", "bitrate": 832000,
                         "url": "https://video.twimg.com/ext_tw_video/1/pu/vid/480x480/lo.mp4"},
                        {"content_type": "video/mp4", "bitrate": 2176000,
                         "url": "https://video.twimg.com/ext_tw_video/1/pu/vid/720x720/hi.mp4"},
                    ]},
                }]},
            },
            "quoted_status_result": {"result": {
                "rest_id": "1555555555555555555",
                "core": {"user_results": {"result": {"legacy": {
                    "screen_name": "quoted",
                    "name": "Quoted User",
                }}}},
                "legacy": {"full_text": "quoted text"},
            }},
        }}
    }), encoding="utf-8")

    its = list(TwitterConnector().import_file(p))
    assert len(its) == 1
    meta = md(its[0])
    assert meta["media_urls"] == ["https://video.twimg.com/ext_tw_video/1/pu/vid/720x720/hi.mp4"]
    assert meta["media_type"] == "video"
    assert meta["thumbnail"] == "https://pbs.twimg.com/media/poster.jpg?name=orig"
    assert meta["conversation_id"] == "1111111111111111111"
    assert meta["in_reply_to_status_id"] == "1222222222222222222"
    assert meta["in_reply_to_screen_name"] == "parent"
    assert meta["quote_tweet"] == {
        "tweet_id": "1555555555555555555",
        "permalink": "https://x.com/quoted/status/1555555555555555555",
        "text": "quoted text",
        "author_handle": "quoted",
        "author_name": "Quoted User",
    }


def test_twitter_outlinks_from_flat_rows_and_text(tmp_path):
    p = tmp_path / "x.csv"
    p.write_text(
        "tweet_id,text,url,expanded_urls\n"
        "1666666666666666666,"
        "\"watch this https://youtu.be/TextVid001x\","
        "https://x.com/me/status/1666666666666666666,"
        "https://www.youtube.com/watch?v=CsvVid0001x\n",
        encoding="utf-8",
    )

    its = list(TwitterConnector().import_file(p))
    links = md(its[0])["outlinks"]
    assert links == [
        "https://www.youtube.com/watch?v=CsvVid0001x",
        "https://youtu.be/TextVid001x",
    ]


def test_tweet_id_from_url():
    assert tweet_id_from_url("https://x.com/me/status/1234567890") == "1234567890"
    assert tweet_id_from_url("https://twitter.com/me/status/1234567890?s=20") == "1234567890"
    assert tweet_id_from_url("https://example.com/status/1234567890") == ""
