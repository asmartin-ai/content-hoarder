import json

from content_hoarder.connectors.firefox import FirefoxConnector

_SAMPLE = """# Altering format (including header below) may affect importing functionality.
Export Tabs URLs import file - Rich format - Tabs Count: 2

Window::: id: 17  tabs count: 2

The Vanilla Experience | TVE
https://modrinth.com/modpack/the-vanilla-experience
https://modrinth.com/favicon.ico
false

Portal Gels - Minecraft Mod
https://modrinth.com/mod/portal-gels
https://modrinth.com/favicon.ico
true
"""


def _write(tmp_path, name, text):
    p = tmp_path / name
    p.write_text(text, encoding="utf-8")
    return p


def test_firefox_can_import(tmp_path):
    ff = FirefoxConnector()
    assert ff.can_import(_write(tmp_path, "tabs.txt", _SAMPLE)) is True
    assert ff.can_import(_write(tmp_path, "ids.txt", "123\n456\n")) is False  # HN-style id list


def test_firefox_import(tmp_path):
    its = list(FirefoxConnector().import_file(_write(tmp_path, "tabs.txt", _SAMPLE)))
    assert len(its) == 2
    assert its[0]["source"] == "firefox" and its[0]["kind"] == "tab"
    assert its[0]["url"] == "https://modrinth.com/modpack/the-vanilla-experience"
    assert its[0]["title"] == "The Vanilla Experience | TVE"
    md0 = json.loads(its[0]["metadata"])
    assert md0["domain"] == "modrinth.com" and md0["window"] == "17"
    assert md0["favicon"] == "https://modrinth.com/favicon.ico"
    assert json.loads(its[1]["metadata"]).get("pinned") == 1
    # stable url-hash id → re-importing the overlapping daily exports de-dups
    again = list(FirefoxConnector().import_file(_write(tmp_path, "again.txt", _SAMPLE)))
    assert again[0]["fullname"] == its[0]["fullname"]


def test_firefox_url_normalization_dedups(tmp_path):
    base = ("Export Tabs URLs\n\nWindow::: id: 1  tabs count: 1\n\nT\n{url}\n"
            "https://x/favicon.ico\nfalse\n")
    a = list(FirefoxConnector().import_file(_write(tmp_path, "a.txt",
        base.format(url="https://Example.com/Path"))))
    b = list(FirefoxConnector().import_file(_write(tmp_path, "b.txt",
        base.format(url="https://example.com/Path/#frag"))))
    assert a[0]["fullname"] == b[0]["fullname"]  # host-case + trailing slash + fragment ignored


_YT_TABS = """Export Tabs URLs - Rich format - Tabs Count: 4

Window::: id: 9  tabs count: 4

(29) Fauna's physics lecture - YouTube
https://www.youtube.com/watch?v=q_ZTwCx1VSI&list=WL&index=5
https://www.youtube.com/favicon.ico
true

Koyori karaoke
https://youtu.be/ZuXClAmjc3Q?t=42
https://www.youtube.com/favicon.ico
false

Some Article
https://example.com/post?v=notarealytid
https://example.com/favicon.ico
false

Modrinth thing
https://modrinth.com/mod/portal-gels
https://modrinth.com/favicon.ico
false
"""


def test_firefox_youtube_tab_promoted_to_youtube_item(tmp_path):
    its = {i["source_id"]: i for i in
           FirefoxConnector().import_file(_write(tmp_path, "yt.txt", _YT_TABS))}

    v = its["q_ZTwCx1VSI"]
    assert v["source"] == "youtube" and v["kind"] == "video"
    assert v["fullname"] == "youtube:q_ZTwCx1VSI"
    assert v["url"] == "https://youtu.be/q_ZTwCx1VSI"
    assert v["title"] == "Fauna's physics lecture"     # "(29) " prefix + " - YouTube" suffix stripped
    md = json.loads(v["metadata"])
    assert md["open_in_firefox"] is True
    assert md["firefox_window"] == "9" and md["firefox_pinned"] == 1
    assert md["thumbnail"].endswith("/q_ZTwCx1VSI/hqdefault.jpg")
    assert "playlist" not in md and "position" not in md   # additive markers only (no WL clobber)

    assert its["ZuXClAmjc3Q"]["source"] == "youtube"       # youtu.be short form is promoted too

    # a non-YouTube host carrying a ?v= param must NOT be mis-promoted; both stay firefox tabs
    tabs = [i for i in its.values() if i["source"] == "firefox"]
    assert {t["url"] for t in tabs} == {
        "https://example.com/post?v=notarealytid",
        "https://modrinth.com/mod/portal-gels",
    }
    assert all(t["kind"] == "tab" for t in tabs)


def test_clean_yt_tab_title():
    from content_hoarder.connectors.firefox import _clean_yt_tab_title
    assert _clean_yt_tab_title("(29) Foo Bar - YouTube") == "Foo Bar"
    assert _clean_yt_tab_title("(1) X") == "X"
    assert _clean_yt_tab_title("Title - YouTube") == "Title"
    assert _clean_yt_tab_title("No suffix or badge") == "No suffix or badge"


def test_youtube_id_host_guard_and_embed_sentinels():
    from content_hoarder.connectors.firefox import youtube_id
    assert youtube_id("https://www.youtube.com/watch?v=dQw4w9WgXcQ") == "dQw4w9WgXcQ"
    assert youtube_id("https://m.youtube.com/watch?v=abc12345678&list=WL") == "abc12345678"
    # playlist/live embeds capture an 11-char non-id sentinel — must NOT be promoted
    assert youtube_id("https://www.youtube.com/embed/videoseries?list=PLx") == ""
    assert youtube_id("https://www.youtube.com/embed/live_stream?channel=X") == ""
    # non-YouTube host with a ?v= param is not a video
    assert youtube_id("https://example.com/page?v=fakevid12") == ""
    # short non-id embed paths (< 11 chars) must NOT be promoted — the {6,} regex captures
    # them but len-check filters them out (e.g. "/embed/playlist" → "playlist", 8 chars)
    assert youtube_id("https://www.youtube.com/embed/playlist?list=PLxxx") == ""
    assert youtube_id("https://www.youtube.com/embed/shorts") == ""
