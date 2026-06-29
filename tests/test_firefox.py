import json

from content_hoarder.connectors.firefox import (
    FIREFOX_TABS_SCHEMA,
    FirefoxConnector,
    item_from_tab_record,
)

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
    assert (
        ff.can_import(_write(tmp_path, "ids.txt", "123\n456\n")) is False
    )  # HN-style id list


def test_firefox_import(tmp_path):
    its = list(FirefoxConnector().import_file(_write(tmp_path, "tabs.txt", _SAMPLE)))
    assert len(its) == 2
    assert its[0]["source"] == "firefox" and its[0]["kind"] == "tab"
    assert its[0]["url"] == "https://modrinth.com/modpack/the-vanilla-experience"
    assert its[0]["title"] == "The Vanilla Experience | TVE"
    md0 = json.loads(its[0]["metadata"])
    assert md0["domain"] == "modrinth.com" and md0["window"] == "17"
    assert md0["favicon"] == "https://modrinth.com/favicon.ico"
    assert md0["open_in_firefox"] is True
    assert md0["firefox_capture_source"] == "export-tabs-urls"
    assert json.loads(its[1]["metadata"]).get("pinned") == 1
    # stable url-hash id → re-importing the overlapping daily exports de-dups
    again = list(FirefoxConnector().import_file(_write(tmp_path, "again.txt", _SAMPLE)))
    assert again[0]["fullname"] == its[0]["fullname"]


def test_firefox_json_can_import_and_maps_extension_tabs(tmp_path):
    payload = {
        "schema": FIREFOX_TABS_SCHEMA,
        "source": "webextension",
        "captured_at": 1770000000,
        "snapshot_id": "snap-1",
        "tabs": [
            {
                "url": "https://modrinth.com/modpack/the-vanilla-experience",
                "title": "The Vanilla Experience | TVE",
                "favIconUrl": "https://modrinth.com/favicon.ico",
                "windowId": 17,
                "index": 3,
                "pinned": True,
                "active": False,
                "discarded": True,
                "lastAccessed": 1770000000123,
                "cookieStoreId": "firefox-default",
                "groupId": -1,
            }
        ],
    }
    p = tmp_path / "tabs.json"
    p.write_text(json.dumps(payload), encoding="utf-8")

    ff = FirefoxConnector()
    assert ff.can_import(p) is True
    its = list(ff.import_file(p))
    assert len(its) == 1
    item = its[0]
    assert item["source"] == "firefox" and item["kind"] == "tab"
    assert item["url"] == "https://modrinth.com/modpack/the-vanilla-experience"
    assert item["title"] == "The Vanilla Experience | TVE"
    md = json.loads(item["metadata"])
    assert md["domain"] == "modrinth.com"
    assert md["favicon"] == "https://modrinth.com/favicon.ico"
    assert md["window"] == "17"
    assert md["pinned"] == 1
    assert md["open_in_firefox"] is True
    assert md["firefox_capture_source"] == "webextension"
    assert md["firefox_captured_at"] == 1770000000
    assert md["firefox_snapshot_id"] == "snap-1"
    assert md["firefox_index"] == 3
    assert md["firefox_active"] == 0
    assert md["firefox_discarded"] == 1
    assert md["firefox_last_accessed_ms"] == 1770000000123
    assert md["firefox_cookie_store_id"] == "firefox-default"
    assert md["firefox_group_id"] == -1


def test_firefox_json_matches_txt_identity_for_same_url(tmp_path):
    txt_item = list(
        FirefoxConnector().import_file(_write(tmp_path, "tabs.txt", _SAMPLE))
    )[0]
    payload = {
        "schema": FIREFOX_TABS_SCHEMA,
        "source": "json_export",
        "tabs": [
            {
                "url": "https://modrinth.com/modpack/the-vanilla-experience",
                "title": "The Vanilla Experience | TVE",
            }
        ],
    }
    p = tmp_path / "tabs.json"
    p.write_text(json.dumps(payload), encoding="utf-8")
    json_item = list(FirefoxConnector().import_file(p))[0]
    assert json_item["fullname"] == txt_item["fullname"]


def test_firefox_tab_record_skips_private_and_non_http_urls():
    assert item_from_tab_record({"url": "about:config", "title": "Config"}) is None
    assert (
        item_from_tab_record({"url": "file:///C:/secret.txt", "title": "Local"}) is None
    )
    assert (
        item_from_tab_record(
            {
                "url": "https://example.com/private",
                "title": "Private",
                "incognito": True,
            }
        )
        is None
    )


def test_firefox_url_normalization_dedups(tmp_path):
    base = (
        "Export Tabs URLs\n\nWindow::: id: 1  tabs count: 1\n\nT\n{url}\n"
        "https://x/favicon.ico\nfalse\n"
    )
    a = list(
        FirefoxConnector().import_file(
            _write(tmp_path, "a.txt", base.format(url="https://Example.com/Path"))
        )
    )
    b = list(
        FirefoxConnector().import_file(
            _write(tmp_path, "b.txt", base.format(url="https://example.com/Path/#frag"))
        )
    )
    assert (
        a[0]["fullname"] == b[0]["fullname"]
    )  # host-case + trailing slash + fragment ignored


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
    its = {
        i["source_id"]: i
        for i in FirefoxConnector().import_file(_write(tmp_path, "yt.txt", _YT_TABS))
    }

    v = its["q_ZTwCx1VSI"]
    assert v["source"] == "youtube" and v["kind"] == "video"
    assert v["fullname"] == "youtube:q_ZTwCx1VSI"
    assert v["url"] == "https://youtu.be/q_ZTwCx1VSI"
    assert (
        v["title"] == "Fauna's physics lecture"
    )  # "(29) " prefix + " - YouTube" suffix stripped
    md = json.loads(v["metadata"])
    assert md["open_in_firefox"] is True
    assert md["firefox_window"] == "9" and md["firefox_pinned"] == 1
    assert md["thumbnail"].endswith("/q_ZTwCx1VSI/hqdefault.jpg")
    assert (
        "playlist" not in md and "position" not in md
    )  # additive markers only (no WL clobber)

    assert (
        its["ZuXClAmjc3Q"]["source"] == "youtube"
    )  # youtu.be short form is promoted too

    # a non-YouTube host carrying a ?v= param must NOT be mis-promoted; both stay firefox tabs
    tabs = [i for i in its.values() if i["source"] == "firefox"]
    assert {t["url"] for t in tabs} == {
        "https://example.com/post?v=notarealytid",
        "https://modrinth.com/mod/portal-gels",
    }
    assert all(t["kind"] == "tab" for t in tabs)


def test_firefox_json_youtube_tab_promotes_and_preserves_original_url(tmp_path):
    payload = {
        "schema": FIREFOX_TABS_SCHEMA,
        "source": "webextension",
        "captured_at": 1770000000,
        "tabs": [
            {
                "url": "https://www.youtube.com/watch?v=q_ZTwCx1VSI&list=WL&index=5",
                "title": "(29) Fauna's physics lecture - YouTube",
                "window": 9,
                "pinned": True,
            }
        ],
    }
    p = tmp_path / "yt.json"
    p.write_text(json.dumps(payload), encoding="utf-8")

    item = list(FirefoxConnector().import_file(p))[0]
    assert item["fullname"] == "youtube:q_ZTwCx1VSI"
    assert item["title"] == "Fauna's physics lecture"
    assert item["url"] == "https://youtu.be/q_ZTwCx1VSI"
    md = json.loads(item["metadata"])
    assert md["open_in_firefox"] is True
    assert md["firefox_window"] == "9"
    assert md["firefox_pinned"] == 1
    assert (
        md["firefox_original_url"]
        == "https://www.youtube.com/watch?v=q_ZTwCx1VSI&list=WL&index=5"
    )
    assert md["firefox_capture_source"] == "webextension"
    assert md["firefox_captured_at"] == 1770000000


def test_clean_yt_tab_title():
    from content_hoarder.connectors.firefox import _clean_yt_tab_title

    assert _clean_yt_tab_title("(29) Foo Bar - YouTube") == "Foo Bar"
    assert _clean_yt_tab_title("(1) X") == "X"
    assert _clean_yt_tab_title("Title - YouTube") == "Title"
    assert _clean_yt_tab_title("No suffix or badge") == "No suffix or badge"


def test_youtube_id_host_guard_and_embed_sentinels():
    from content_hoarder.connectors.firefox import youtube_id

    assert youtube_id("https://www.youtube.com/watch?v=dQw4w9WgXcQ") == "dQw4w9WgXcQ"
    assert (
        youtube_id("https://m.youtube.com/watch?v=abc12345678&list=WL") == "abc12345678"
    )
    # playlist/live embeds capture an 11-char non-id sentinel — must NOT be promoted
    assert youtube_id("https://www.youtube.com/embed/videoseries?list=PLx") == ""
    assert youtube_id("https://www.youtube.com/embed/live_stream?channel=X") == ""
    # non-YouTube host with a ?v= param is not a video
    assert youtube_id("https://example.com/page?v=fakevid12") == ""
    # short non-id embed paths (< 11 chars) must NOT be promoted — the {6,} regex captures
    # them but len-check filters them out (e.g. "/embed/playlist" → "playlist", 8 chars)
    assert youtube_id("https://www.youtube.com/embed/playlist?list=PLxxx") == ""
    assert youtube_id("https://www.youtube.com/embed/shorts") == ""
