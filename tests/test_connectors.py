import json
from pathlib import Path

import pytest

from content_hoarder import connectors
from content_hoarder.connectors.hackernews import HNConnector
from content_hoarder.connectors.keep import KeepConnector
from content_hoarder.connectors.obsidian import ObsidianConnector
from content_hoarder.connectors.reddit import RedditConnector
from content_hoarder.connectors.youtube import YouTubeConnector


def items(connector, path):
    return list(connector.import_file(Path(path)))


def md(item):
    return json.loads(item["metadata"])


def test_reddit_csv(fixtures):
    its = items(RedditConnector(), fixtures / "reddit" / "saved.csv")
    assert len(its) == 1
    it = its[0]
    assert it["fullname"] == "reddit:t3_abcde"
    assert md(it)["subreddit"] == "python"
    assert "python trick" in it["title"].lower()


def test_reddit_listing(fixtures):
    it = items(RedditConnector(), fixtures / "reddit" / "listing.json")[0]
    assert it["fullname"] == "reddit:t3_zzz"
    assert md(it)["score"] == 99 and md(it)["subreddit"] == "news"


def test_reddit_clean_url():
    from content_hoarder.connectors.reddit import _clean_url
    assert _clean_url("", "/r/x/comments/abc/t/") == "https://www.reddit.com/r/x/comments/abc/t/"
    assert _clean_url("", "https://www.reddit.com/r/x/") == "https://www.reddit.com/r/x/"
    assert _clean_url("", "https//www.reddit.com/r/x/") == "https://www.reddit.com/r/x/"  # broken colon
    assert _clean_url("https://ex.com/a", "/r/x/") == "https://ex.com/a"  # explicit url wins
    assert _clean_url("", "") == ""


def test_reddit_media_classifier():
    from content_hoarder.connectors.reddit import _classify_media
    perma = "https://www.reddit.com/r/x/comments/abc/title/"

    def run(raw_url, body="", kind="post"):
        meta = {}
        url = _classify_media(meta, raw_url, perma, body, kind)
        return url, meta.get("media_type"), meta.get("media_url")

    # bare v.redd.it: click URL becomes the permalink (the bare link renders nothing),
    # original media URL is stashed, and it's flagged as a video.
    url, mt, mu = run("https://v.redd.it/abc123")
    assert url == perma and mt == "reddit_video" and mu == "https://v.redd.it/abc123"
    # media post with no captured URL (e.g. the tonppk example) → previewable
    assert run("")[1] == "reddit_media"
    # direct images stay as the click URL
    assert run("https://i.redd.it/x.jpg")[:2] == ("https://i.redd.it/x.jpg", "image")
    # text posts (have a body) and comments are plain links, no preview affordance
    assert run("", body="some text")[1] == "link"
    assert run("", kind="comment")[1] == "link"
    assert run("https://youtu.be/x")[1] == "youtube"


def test_youtube_playlist(fixtures):
    its = items(YouTubeConnector(), fixtures / "youtube" / "playlist.json")
    assert len(its) == 2
    it = its[0]
    assert it["fullname"] == "youtube:vid000001"
    assert it["url"] == "https://youtu.be/vid000001"
    assert md(it)["playlist"] == "WL2" and "i.ytimg.com" in md(it)["thumbnail"]


def test_youtube_watchlater_fallback(fixtures):
    its = items(YouTubeConnector(), fixtures / "youtube" / "watchlater.json")
    assert len(its) == 2
    assert its[1]["fullname"] == "youtube:wlvid00002"  # id extracted from url
    assert md(its[0])["playlist"] == "WL"


def test_obsidian(fixtures):
    its = items(ObsidianConnector(), fixtures / "obsidian" / "vault")
    assert len(its) == 1
    it = its[0]
    assert it["fullname"] == "obsidian:note.md"
    assert it["title"] == "Test Note"
    assert it["url"] == "https://example.org"
    tags = md(it)["tags"]
    assert "alpha" in tags and "beta" in tags and "inline" in tags
    assert "Other Note" in md(it)["wikilinks"]


def test_keep(fixtures):
    it = items(KeepConnector(), fixtures / "keep" / "Keep")[0]
    assert it["title"] == "Grocery"
    assert "[ ] eggs" in it["body"] and "[x] bread" in it["body"]
    assert "home" in md(it)["labels"]


def test_hackernews_import_and_enrich(fixtures, monkeypatch):
    c = HNConnector()
    its = items(c, fixtures / "hackernews" / "ids.json")
    assert {i["source_id"] for i in its} == {"8863", "121003"}
    assert all(i["title"] == "" for i in its)

    its_html = items(c, fixtures / "hackernews" / "favorites.html")
    assert {i["source_id"] for i in its_html} == {"8863", "121003"}

    monkeypatch.setattr(c, "_fetch", lambda sid: {
        "type": "story", "title": f"Story {sid}", "url": "http://e/" + str(sid),
        "by": "u", "time": 111, "score": 5, "descendants": 3})
    enriched = c.enrich(its)
    assert len(enriched) == 2
    e = enriched[0]
    assert e["title"].startswith("Story") and e["hydrated_at"]
    assert md(e)["score"] == 5


def test_hackernews_favorite_db(tmp_path):
    import sqlite3
    dbp = tmp_path / "Materialistic.db"
    con = sqlite3.connect(dbp)
    con.execute("CREATE TABLE favorite (_id INTEGER PRIMARY KEY, itemid TEXT, url TEXT, title TEXT, time INTEGER)")
    con.executemany(
        "INSERT INTO favorite (itemid,url,title,time) VALUES (?,?,?,?)",
        [("8863", "https://example.com/a", "Story A", 1700000000),
         ("121003", "https://example.com/b", "Story B", 1700000001)])
    con.commit()
    con.close()
    c = HNConnector()
    assert c.can_import(dbp)
    its = items(c, dbp)
    assert {i["source_id"] for i in its} == {"8863", "121003"}
    by_id = {i["source_id"]: i for i in its}
    assert by_id["8863"]["title"] == "Story A"     # title pulled straight from the favorite table
    assert by_id["8863"]["url"] == "https://example.com/a"


def test_youtube_rejects_generic_list(tmp_path):
    p = tmp_path / "bookmarks.json"
    p.write_text(json.dumps([{"name": "x", "foo": 1}, {"name": "y"}]))
    assert YouTubeConnector().can_import(p) is False  # no video ids -> not claimed
    with pytest.raises(ValueError):
        connectors.dispatch(p)  # falls through to a helpful "pass --source" error


def test_dispatch_routes(fixtures):
    cases = {
        fixtures / "reddit" / "saved.csv": "reddit",
        fixtures / "reddit" / "listing.json": "reddit",
        fixtures / "youtube" / "playlist.json": "youtube",
        fixtures / "hackernews" / "ids.json": "hackernews",
        fixtures / "obsidian" / "vault": "obsidian",
        fixtures / "keep" / "Keep": "keep",
    }
    for path, sid in cases.items():
        assert connectors.dispatch(path).id == sid, (path, sid)


def test_registry():
    assert set(connectors.REGISTRY) == {
        "reddit", "youtube", "hackernews", "obsidian", "keep", "firefox"}
    # firefox now imports "Export Tabs URLs" .txt (see test_firefox.py); a bogus path is ignored.
    assert connectors.get("firefox").can_import(Path("x")) is False


def test_dispatch_unknown(tmp_path):
    p = tmp_path / "mystery.xyz"
    p.write_text("?")
    with pytest.raises(ValueError):
        connectors.dispatch(p)
