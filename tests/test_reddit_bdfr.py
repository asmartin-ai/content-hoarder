from content_hoarder.models import parse_metadata
import json
from pathlib import Path

from content_hoarder.connectors import dispatch, RedditConnector


def test_bdfr_submission(tmp_path: Path):
    data = {
        "title": "A self-soldering circuit",
        "name": "t3_abc123",
        "id": "abc123",
        "subreddit": "electronics",
        "selftext": "",
        "permalink": "/r/electronics/comments/abc123/a_selfsoldering_circuit/",
        "url": "https://i.redd.it/xyz.jpg",
        "author": "someuser",
        "score": 1234,
        "created_utc": 1700000000.0,
        "over_18": False,
    }
    fp = tmp_path / "submission.json"
    fp.write_text(json.dumps(data))

    connector = RedditConnector()
    items = list(connector.import_file(fp))
    assert len(items) == 1
    item = items[0]
    assert item["source"] == "reddit"
    assert item["source_id"] == "t3_abc123"
    assert item["kind"] == "post"
    assert parse_metadata(item["metadata"])["subreddit"] == "electronics"
    assert parse_metadata(item["metadata"])["score"] == 1234
    assert parse_metadata(item["metadata"])["over_18"] == 0
    assert parse_metadata(item["metadata"])["media_type"] == "image"
    assert item["url"] == "https://i.redd.it/xyz.jpg"
    assert item["created_utc"] == 1700000000
    assert item["author"] == "someuser"


def test_bdfr_comment(tmp_path: Path):
    data = {
        "body": "Nice soldering!",
        "name": "t1_def456",
        "id": "def456",
        "subreddit": "electronics",
        "permalink": "/r/electronics/comments/abc123/a_selfsoldering_circuit/t1_def456",
        "created_utc": 1700000001.0,
    }
    fp = tmp_path / "comment.json"
    fp.write_text(json.dumps(data))

    connector = RedditConnector()
    items = list(connector.import_file(fp))
    assert len(items) == 1
    item = items[0]
    assert item["kind"] == "comment"
    assert item["source_id"] == "t1_def456"
    assert item["body"] == "Nice soldering!"


def test_bdfr_no_name_uses_id(tmp_path: Path):
    data = {
        "id": "ghi789",
        "permalink": "/r/learnpython/comments/ghi789/some_post/",
        "title": "Some Post",
        "selftext": "text",
        "created_utc": 1700000002.0,
    }
    fp = tmp_path / "noname.json"
    fp.write_text(json.dumps(data))

    connector = RedditConnector()
    items = list(connector.import_file(fp))
    assert len(items) == 1
    assert items[0]["source_id"] == "t3_ghi789"


def test_bdfr_directory_tree(tmp_path: Path):
    sub1 = tmp_path / "sub1"
    sub1.mkdir()
    sub2 = tmp_path / "nested" / "sub2"
    sub2.mkdir(parents=True)

    # valid submission
    (sub1 / "post.json").write_text(json.dumps({
        "title": "Post",
        "name": "t3_111",
        "permalink": "/r/sub/111",
        "created_utc": 1,
    }))
    # valid comment
    (sub2 / "comment.json").write_text(json.dumps({
        "body": "comment",
        "name": "t1_222",
        "permalink": "/r/sub/111/222",
        "created_utc": 2,
    }))
    # malformed file
    (tmp_path / "bad.json").write_text("{invalid")
    # non-reddit json (should yield nothing)
    (tmp_path / "keep.json").write_text(json.dumps({"textContent": "hello"}))

    connector = RedditConnector()
    items = list(connector.import_file(tmp_path))
    ids = {i["source_id"] for i in items}
    assert ids == {"t3_111", "t1_222"}


def test_directory_keep_sniff_false(tmp_path: Path):
    (tmp_path / "note.json").write_text(json.dumps({"textContent": "hello"}))
    (tmp_path / "note2.json").write_text(json.dumps({"textContent": "world"}))
    connector = RedditConnector()
    assert not connector.can_import(tmp_path)
    dispatched = dispatch(tmp_path)
    assert not isinstance(dispatched, RedditConnector)


def test_directory_reddit_sniff_true(tmp_path: Path):
    (tmp_path / "post.json").write_text(json.dumps({"permalink": "/r/test/1", "title": "test", "created_utc": 1}))
    connector = RedditConnector()
    assert connector.can_import(tmp_path)
    dispatched = dispatch(tmp_path)
    assert isinstance(dispatched, RedditConnector)
