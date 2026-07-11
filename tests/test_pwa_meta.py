"""Spec 13 — iPhone PWA installability: Apple meta tags + theme-color unification.

The served index page head must carry the Apple/mobile PWA meta tags so iOS
"Add to Home Screen" launches a proper standalone app, and the head
``theme-color`` must match the manifest (both ``#0f1115``).
"""

import json
import re
from pathlib import Path

from content_hoarder.web import create_app


ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "src" / "content_hoarder" / "static" / "manifest.webmanifest"


def _head_html(tmp_db) -> str:
    resp = create_app(tmp_db).test_client().get("/")
    assert resp.status_code == 200
    html = resp.get_data(as_text=True)
    assert "</head>" in html, "no </head> in served index page"
    return html[: html.index("</head>")]


def _meta_content(head: str, name: str) -> str | None:
    """Return the ``content`` of a ``<meta name=...>`` tag, tolerant to
    attribute order, quote style, self-closing slash, and whitespace."""
    for tag in re.findall(r"<meta\b[^>]*>", head, re.I):
        nm = re.search(r'\bname\s*=\s*["\']([^"\']*)["\']', tag, re.I)
        if nm and nm.group(1).lower() == name.lower():
            cm = re.search(r'\bcontent\s*=\s*["\']([^"\']*)["\']', tag, re.I)
            return cm.group(1) if cm else None
    return None


def test_apple_pwa_meta_tags_present(tmp_db):
    head = _head_html(tmp_db)
    assert _meta_content(head, "apple-mobile-web-app-capable") == "yes"
    assert _meta_content(head, "mobile-web-app-capable") == "yes"
    assert (
        _meta_content(head, "apple-mobile-web-app-status-bar-style")
        == "black-translucent"
    )
    assert _meta_content(head, "apple-mobile-web-app-title") == "Hoarder"


def test_apple_touch_icon_link_present(tmp_db):
    head = _head_html(tmp_db)
    links = re.findall(r"<link\b[^>]*>", head, re.I)
    hit = False
    for tag in links:
        rel = re.search(r'\brel\s*=\s*["\']([^"\']*)["\']', tag, re.I)
        href = re.search(r'\bhref\s*=\s*["\']([^"\']*)["\']', tag, re.I)
        if (
            rel
            and rel.group(1).lower() == "apple-touch-icon"
            and href
            and href.group(1) == "/static/apple-touch-icon.png"
        ):
            hit = True
    assert hit, "apple-touch-icon <link> to /static/apple-touch-icon.png missing"


def test_apple_touch_icon_is_served(tmp_db):
    resp = create_app(tmp_db).test_client().get("/static/apple-touch-icon.png")
    assert resp.status_code == 200, "apple-touch-icon.png not served"
    assert resp.headers.get("Content-Type", "").startswith("image/")


def test_theme_color_matches_manifest(tmp_db):
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    theme = manifest["theme_color"]
    assert theme == "#0f1115"  # spec 13 target
    head = _head_html(tmp_db)
    got = _meta_content(head, "theme-color")
    assert got is not None, "theme-color meta missing from head"
    assert got == theme, f"head theme-color {got!r} != manifest {theme!r}"
