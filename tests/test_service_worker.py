import re
from pathlib import Path

from content_hoarder.web import create_app


ROOT = Path(__file__).resolve().parents[1]
SW = ROOT / "src" / "content_hoarder" / "static" / "sw.js"


def _shell_urls() -> list[str]:
    text = SW.read_text(encoding="utf-8")
    match = re.search(r"const SHELL = \[(.*?)\];", text, re.S)
    assert match, "service worker SHELL list not found"
    return re.findall(r'"([^"]+)"', match.group(1))


def test_service_worker_shell_urls_are_local_and_served(tmp_db):
    urls = _shell_urls()
    assert "/static/tokens.css" in urls
    assert "/static/vendor/hls.min.js" in urls
    assert "/reddit" in urls
    assert not any(u.startswith(("/items", "/stats", "/media")) for u in urls)

    client = create_app(tmp_db).test_client()
    for url in urls:
        resp = client.get(url)
        assert resp.status_code == 200, url


def test_service_worker_uses_navigation_fallback_for_pages_only():
    text = SW.read_text(encoding="utf-8")
    assert 'const isPage = req.mode === "navigate";' in text
    assert 'if (req.method !== "GET") return;' in text
