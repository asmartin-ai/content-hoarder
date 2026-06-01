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
