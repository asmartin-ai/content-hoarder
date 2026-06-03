import json

from content_hoarder.connectors.reddit import RedditConnector

_SAVEDDIT = """<html><body><ul>
<li><a href='https://www.reddit.com/gallery/145vdi9'> A gallery post </a>  - [<a href='https://www.reddit.com/r/Hololive/comments/145vdi9/slug/'> THREAD </a>]</li>
<li><a href='https://example.com/article'> External &amp; link </a>  - [<a href='https://www.reddit.com/r/news/comments/abc123/title/'> THREAD </a>]</li>
</ul></body></html>"""


def test_reddit_saveddit_html(tmp_path):
    p = tmp_path / "reddit_export.html"
    p.write_text(_SAVEDDIT, encoding="utf-8")
    rc = RedditConnector()
    assert rc.can_import(p) is True
    items = {i["source_id"]: i for i in rc.import_file(p)}
    assert set(items) == {"t3_145vdi9", "t3_abc123"}

    g = items["t3_145vdi9"]
    assert g["title"] == "A gallery post"
    gm = json.loads(g["metadata"])
    assert gm["subreddit"] == "Hololive" and gm["permalink"].endswith("/145vdi9/slug/")
    assert gm.get("media_type") == "reddit_media"  # gallery routed through the classifier

    ext = items["t3_abc123"]
    assert ext["url"] == "https://example.com/article"
    assert ext["title"] == "External & link"  # HTML entity unescaped
