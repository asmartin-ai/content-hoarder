"""Policy: which reddit ingestion paths stamp the ``metadata.saved_seen_utc`` reconcile marker.

Authoritative saved-list snapshots (saveddit table/CSV, GDPR ``saved_*.csv``, cookie sync) MARK
their rows so ``db.reconcile_reddit_saves`` can delta-reconcile them; bulk dumps (BDFR/JSON) do
NOT — their ``is_saved=1`` is only the import default, not proof of a current save.
"""
import json
import zipfile

from content_hoarder.connectors.reddit import RedditConnector, child_to_item
from content_hoarder.models import parse_metadata

_PERMA = "https://www.reddit.com/r/AskReddit/comments/abc/slug/"


def _marked(item):
    return parse_metadata(item["metadata"]).get("saved_seen_utc")


def test_csv_import_marks(tmp_path):
    p = tmp_path / "saved.csv"
    p.write_text(f"id,permalink\r\nabc,{_PERMA}\r\n")
    items = list(RedditConnector().import_file(p))
    assert items and all(_marked(i) for i in items)


def test_gdpr_import_marks(tmp_path):
    z = tmp_path / "gdpr.zip"
    with zipfile.ZipFile(z, "w") as zf:
        zf.writestr("saved_posts.csv", f"id,permalink\r\nabc,{_PERMA}\r\n")
    items = list(RedditConnector().import_file(z))
    assert items and all(_marked(i) for i in items)


def test_bulk_json_does_not_mark(tmp_path):
    p = tmp_path / "dump.json"
    p.write_text(json.dumps({"name": "t3_abc", "title": "x", "subreddit": "s",
                             "permalink": "/r/s/comments/abc/slug/"}))
    items = list(RedditConnector().import_file(p))
    assert items and all(_marked(i) is None for i in items)


def test_child_to_item_marks_only_when_asked():
    ch = {"kind": "t3", "data": {"name": "t3_abc", "title": "x", "subreddit": "s",
                                 "permalink": "/r/s/comments/abc/slug/"}}
    assert _marked(child_to_item(ch)) is None
    assert _marked(child_to_item(ch, saved_seen_utc=1700000000)) == 1700000000
