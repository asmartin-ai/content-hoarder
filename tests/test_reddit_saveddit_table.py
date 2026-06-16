import json

from content_hoarder.connectors.reddit import RedditConnector

# saveddit.vercel.app export: an HTML <table> saved with a .xls extension. Row 0 is a POST,
# row 1 a saved COMMENT (its permalink carries the trailing comment id; its title is empty).
_TABLE = """<html><head><meta charset="UTF-8" /></head><body>
<table>
<thead><tr><th><b>author</b></th><th><b>archived</b></th><th><b>createdUtc</b></th><th><b>domain</b></th><th><b>id</b></th><th><b>numComments</b></th><th><b>over18</b></th><th><b>permalink</b></th><th><b>score</b></th><th><b>subredditNamePrefixed</b></th><th><b>subreddit</b></th><th><b>title</b></th><th><b>url</b></th></tr></thead>
<tbody>
<tr><td>evesdead</td><td>false</td><td>1781508526</td><td>i.redd.it</td><td>1u69n0s</td><td>88</td><td>false</td><td>/r/196/comments/1u69n0s/rule/</td><td>3410</td><td>r/196</td><td>196</td><td>Rule &amp; order</td><td>https://i.redd.it/9pxkje0ife7h1.jpeg</td></tr>
<tr><td>somebody</td><td>false</td><td>1700000000</td><td></td><td>abc123c</td><td>5</td><td>true</td><td>/r/books/comments/xyz789/is_what_we_owe_to_each_other/abc123c/</td><td>12</td><td>r/books</td><td>books</td><td></td><td></td></tr>
</tbody>
</table></body></html>"""


def test_saveddit_table_xls_import(tmp_path):
    p = tmp_path / "AllSavedPosts(2).xls"
    p.write_text(_TABLE, encoding="utf-8")
    rc = RedditConnector()
    assert rc.can_import(p) is True

    items = list(rc.import_file(p))
    by_id = {i["source_id"]: i for i in items}
    # post -> t3_, comment -> t1_ (from the trailing permalink id)
    assert set(by_id) == {"t3_1u69n0s", "t1_abc123c"}

    post = by_id["t3_1u69n0s"]
    assert post["kind"] == "post"
    assert post["title"] == "Rule & order"          # column value, HTML entity unescaped
    assert post["created_utc"] == 1781508526          # createdUtc -> created_utc (creation time)
    pm = json.loads(post["metadata"])
    assert pm["subreddit"] == "196"
    assert pm["over_18"] == 0
    assert pm["num_comments"] == "88"
    assert pm["score"] == "3410"
    assert pm["domain"] == "i.redd.it"
    assert pm["media_type"] == "image"                # i.redd.it routed through the classifier

    cmt = by_id["t1_abc123c"]
    assert cmt["kind"] == "comment"
    assert cmt["created_utc"] == 1700000000
    assert json.loads(cmt["metadata"])["over_18"] == 1
    # comments get NO synthesized slug title — it would clobber a real submission_title on
    # re-import (merge_upsert overlays). The real title comes from backfill_titles_local (spec 08).
    assert cmt["title"] == ""

    # saved_utc is no longer synthesized in the connector — the pipeline owns the monotonic rank
    # (see test_saved_order_monotonic). The connector leaves it 0 and stamps the saved_seen_utc
    # snapshot marker so reconcile_reddit_saves can consider the row.
    assert post["saved_utc"] == 0 and cmt["saved_utc"] == 0
    assert json.loads(post["metadata"])["saved_seen_utc"] > 0
