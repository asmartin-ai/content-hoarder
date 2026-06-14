"""Tests for Reddit GDPR data-export ZIP import."""

import zipfile
from pathlib import Path

import pytest

from content_hoarder.connectors import dispatch
from content_hoarder.connectors.reddit import RedditConnector
from content_hoarder.models import parse_metadata


SAVED_POSTS_CSV = (
    "id,permalink\r\n"
    "abc123,https://www.reddit.com/r/AskReddit/comments/abc123/some_title_slug/\r\n"
)

SAVED_COMMENTS_CSV = (
    "id,permalink\r\n"
    "def456,https://www.reddit.com/r/AskReddit/comments/abc123/some_title_slug/def456/\r\n"
)


def _build_zip(tmp_path, files, *, nested=False):
    zip_path = tmp_path / "gdpr.zip"
    prefix = "export_myuser_20260101/" if nested else ""
    with zipfile.ZipFile(zip_path, "w") as zf:
        for name, content in files.items():
            zf.writestr(prefix + name, content)
    return zip_path


class TestGdprCanImport:
    def test_zip_with_saved_posts(self, tmp_path):
        z = _build_zip(tmp_path, {"saved_posts.csv": SAVED_POSTS_CSV})
        assert RedditConnector().can_import(z) is True

    def test_zip_with_saved_comments(self, tmp_path):
        z = _build_zip(tmp_path, {"saved_comments.csv": SAVED_COMMENTS_CSV})
        assert RedditConnector().can_import(z) is True

    def test_zip_with_neither_saved_csv(self, tmp_path):
        z = _build_zip(tmp_path, {"posts.csv": "id\n1\n", "statistics.csv": "x\n"})
        assert RedditConnector().can_import(z) is False

    def test_non_zip_file_named_dotzip(self, tmp_path):
        f = tmp_path / "fake.zip"
        f.write_text("this is not a zip file at all")
        assert RedditConnector().can_import(f) is False


class TestGdprImport:
    def test_root_level_posts_and_comments(self, tmp_path):
        z = _build_zip(tmp_path, {
            "saved_posts.csv": SAVED_POSTS_CSV,
            "saved_comments.csv": SAVED_COMMENTS_CSV,
        })
        items = list(RedditConnector().import_file(z))
        posts = [i for i in items if i["kind"] == "post"]
        comments = [i for i in items if i["kind"] == "comment"]
        assert len(posts) == 1
        assert len(comments) == 1
        post = posts[0]
        assert post["source_id"] == "t3_abc123"
        assert post["fullname"] == "reddit:t3_abc123"
        assert post["kind"] == "post"
        assert parse_metadata(post["metadata"])["subreddit"] == "AskReddit"
        assert "some_title_slug" in parse_metadata(post["metadata"])["permalink"]
        assert post["title"]
        comment = comments[0]
        assert comment["source_id"] == "t1_def456"
        assert comment["fullname"] == "reddit:t1_def456"
        assert comment["kind"] == "comment"
        assert parse_metadata(comment["metadata"])["subreddit"] == "AskReddit"
        assert parse_metadata(comment["metadata"])["permalink"]

    def test_nested_folder_layout(self, tmp_path):
        z = _build_zip(tmp_path, {
            "saved_posts.csv": SAVED_POSTS_CSV,
        }, nested=True)
        items = list(RedditConnector().import_file(z))
        assert len(items) == 1
        assert items[0]["source_id"] == "t3_abc123"
        assert items[0]["kind"] == "post"
        assert parse_metadata(items[0]["metadata"])["subreddit"] == "AskReddit"

    def test_empty_id_and_permalink_row_skipped(self, tmp_path):
        csv_content = (
            "id,permalink\r\n"
            ",\r\n"
            "goodid,https://www.reddit.com/r/AskReddit/comments/goodid/a_slug/\r\n"
        )
        z = _build_zip(tmp_path, {"saved_posts.csv": csv_content})
        items = list(RedditConnector().import_file(z))
        assert len(items) == 1
        assert items[0]["source_id"] == "t3_goodid"

    def test_bom_handled(self, tmp_path):
        bom = b"\xef\xbb\xbf"
        content = bom + (
            "id,permalink\r\n"
            "bomid,https://www.reddit.com/r/test/comments/bomid/bom_slug/\r\n"
        ).encode("utf-8")
        zip_path = tmp_path / "bom.zip"
        with zipfile.ZipFile(zip_path, "w") as zf:
            zf.writestr("saved_posts.csv", content)
        items = list(RedditConnector().import_file(zip_path))
        assert len(items) == 1
        assert items[0]["source_id"] == "t3_bomid"

    def test_dispatch_returns_reddit_connector(self, tmp_path):
        z = _build_zip(tmp_path, {"saved_posts.csv": SAVED_POSTS_CSV})
        result = dispatch(z)
        assert isinstance(result, RedditConnector)
