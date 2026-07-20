"""Static guards for ready-to-code frontend packets (specs 04/05/06 + splash)."""

from __future__ import annotations

import re
from pathlib import Path

from content_hoarder.web import create_app

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "src" / "content_hoarder" / "static"
TPL = ROOT / "src" / "content_hoarder" / "templates" / "index.html"


def test_apple_touch_startup_images_present(tmp_db):
    head = create_app(tmp_db).test_client().get("/").get_data(as_text=True)
    head = head[: head.index("</head>")]
    links = re.findall(r"<link\b[^>]*>", head, re.I)
    splash = [
        t
        for t in links
        if re.search(r'rel\s*=\s*["\']apple-touch-startup-image["\']', t, re.I)
    ]
    assert len(splash) >= 8, f"expected multiple splash links, got {len(splash)}"
    # one asset must be served
    href = re.search(r'href\s*=\s*["\']([^"\']+)["\']', splash[0], re.I).group(1)
    resp = create_app(tmp_db).test_client().get(href)
    assert resp.status_code == 200, href
    assert resp.headers.get("Content-Type", "").startswith("image/")


def test_splash_files_exist_on_disk():
    d = STATIC / "splashes"
    assert d.is_dir()
    pngs = list(d.glob("splash-*.png"))
    assert len(pngs) >= 8


def test_header_sync_newest_control(tmp_db):
    html = create_app(tmp_db).test_client().get("/").get_data(as_text=True)
    assert 'id="btn-sync-newest"' in html
    js = (STATIC / "browse" / "main.js").read_text(encoding="utf-8")
    assert "runSyncNewest" in js
    assert "btn-sync-newest" in js
    api = (STATIC / "core" / "api.js").read_text(encoding="utf-8")
    assert "redditSync" in api


def test_reddit_image_opens_thread_gate():
    js = (STATIC / "browse" / "main.js").read_text(encoding="utf-8")
    assert 'img && !(item.source === "reddit" && m.permalink)' in js


def test_browse_meta_includes_hn_author_link():
    js = (STATIC / "browse" / "render.js").read_text(encoding="utf-8")
    assert "news.ycombinator.com/user?id=" in js
    assert 'item.source === "hackernews" && item.author' in js


def test_app_version_v126():
    main = (STATIC / "browse" / "main.js").read_text(encoding="utf-8")
    sw = (STATIC / "sw.js").read_text(encoding="utf-8")
    assert 'APP_VERSION = "v126"' in main
    assert "ch-shell-v126" in sw
