"""F14 — pipeline wiring for firefox_tags / hackernews_tags.

The bakeoff oracle (test_bakeoff_f14_firefox_hn_tags.py) pins the *pure* tagging
functions; these tests pin that ``tag_browser_source`` actually reads the source's
rows, writes ``metadata.tags`` (real run) / previews (dry run), skips already-tagged
items unless ``retry``, and never touches ``metadata.category``.
"""

import pytest

from content_hoarder import categorize as cat
from content_hoarder import db, models
from content_hoarder.models import parse_metadata


def _add(conn, *, source, sid, title, url="", metadata=None):
    item = models.new_item(
        source=source,
        source_id=sid,
        kind="tab" if source == "firefox" else "story",
        title=title,
        url=url,
        metadata=metadata or {},
    )
    db.merge_upsert(conn, item)
    return f"{source}:{sid}"


def test_firefox_pipeline_writes_tags(conn):
    fn = _add(
        conn,
        source="firefox",
        sid="ff|invest",
        title="Markets wrap: stocks rally",
        url="https://www.bloomberg.com/markets",
        metadata={"domain": "www.bloomberg.com"},
    )
    res = cat.tag_browser_source(conn, "firefox")
    assert res["source"] == "firefox"
    assert res["tagged"] == 1
    assert res["by_tag"] == {"investing": 1}
    md = parse_metadata(db.get_item(conn, fn)["metadata"])
    assert md["tags"] == ["investing"]
    assert md["tags_auto"] == ["investing"]


def test_firefox_pipeline_keyword_path(conn):
    # neutral host -> title keyword drives the bucket
    fn = _add(
        conn,
        source="firefox",
        sid="ff|game",
        title="My Steam library backlog is huge",
        url="https://blog.example.com/post",
        metadata={"domain": "blog.example.com"},
    )
    cat.tag_browser_source(conn, "firefox")
    assert parse_metadata(db.get_item(conn, fn)["metadata"])["tags"] == ["gaming"]


def test_hackernews_pipeline_writes_tags(conn):
    fn = _add(
        conn,
        source="hackernews",
        sid="hn|def",
        title="Inside a modern missile defense radar",
        url="https://www.defensenews.com/x",
    )
    res = cat.tag_browser_source(conn, "hackernews")
    assert res["tagged"] == 1
    assert parse_metadata(db.get_item(conn, fn)["metadata"])["tags"] == ["defense"]


def test_browser_pipeline_dry_run_does_not_write(conn):
    fn = _add(
        conn,
        source="firefox",
        sid="ff|dry",
        title="Q3 earnings beat",
        url="https://x.example.com/",
        metadata={"domain": "x.example.com"},
    )
    res = cat.tag_browser_source(conn, "firefox", dry_run=True)
    assert res["dry_run"] is True
    assert res["tagged"] == 1
    assert parse_metadata(db.get_item(conn, fn)["metadata"]).get("tags") is None


def test_browser_pipeline_skips_already_tagged_unless_retry(conn):
    fn = _add(
        conn,
        source="hackernews",
        sid="hn|skip",
        title="Inside a missile defense radar",
        url="https://www.defensenews.com/x",
        metadata={"tags": ["defense"]},
    )
    # default: already tagged -> not reselected
    res = cat.tag_browser_source(conn, "hackernews")
    assert res["selected"] == 0
    # retry: reselected and re-tagged
    res = cat.tag_browser_source(conn, "hackernews", retry=True)
    assert res["tagged"] == 1


def test_browser_pipeline_no_match_leaves_untagged(conn):
    fn = _add(
        conn,
        source="firefox",
        sid="ff|none",
        title="How to bake sourdough bread",
        url="https://example.com/recipe",
        metadata={"domain": "example.com"},
    )
    res = cat.tag_browser_source(conn, "firefox")
    assert res["tagged"] == 0
    assert res["untagged"] == 1
    assert parse_metadata(db.get_item(conn, fn)["metadata"]).get("tags") is None


def test_browser_pipeline_never_introduces_category(conn):
    # Firefox/HN items carry no processing category (listenable/watch/wotagei are youtube-only);
    # the topic-tag write must add tags WITHOUT ever stamping a metadata.category.
    fn = _add(
        conn,
        source="firefox",
        sid="ff|nocat",
        title="stocks rally",
        url="https://x.example.com/",
        metadata={"domain": "x.example.com"},
    )
    cat.tag_browser_source(conn, "firefox")
    md = parse_metadata(db.get_item(conn, fn)["metadata"])
    assert md["tags"] == ["investing"]
    assert md["tags_auto"] == ["investing"]
    assert md.get("category") is None


def test_browser_retry_clears_stale_auto_tags_but_keeps_manual(conn):
    fn = _add(
        conn,
        source="firefox",
        sid="ff|stale",
        title="How to bake sourdough bread",
        url="https://example.com/recipe",
        metadata={"domain": "example.com"},
    )
    db.set_auto_tags(conn, fn, ["gaming"])
    db.set_tags(conn, fn, add=["Recipes"])
    res = cat.tag_browser_source(conn, "firefox", retry=True)
    assert res["tagged"] == 0
    md = parse_metadata(db.get_item(conn, fn)["metadata"])
    assert md["tags"] == ["recipes"]
    assert md["tags_manual"] == ["recipes"]
    assert "tags_auto" not in md


def test_browser_pipeline_rejects_unsupported_source(conn):
    with pytest.raises(ValueError):
        cat.tag_browser_source(conn, "twitter")
