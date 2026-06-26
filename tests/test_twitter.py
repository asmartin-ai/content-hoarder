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


def test_tweet_id_from_url():
    assert tweet_id_from_url("https://x.com/me/status/1234567890") == "1234567890"
    assert tweet_id_from_url("https://twitter.com/me/status/1234567890?s=20") == "1234567890"
    assert tweet_id_from_url("https://example.com/status/1234567890") == ""
