"""Playwright UI tests - real browser + Pixel-6 / PWA emulation against the running app.

Run:   pytest -m ui                      (needs chromium: `playwright install chromium`)
These are EXCLUDED from the default `pytest` run (pyproject addopts `-m "not ui"`), so the
fast unit suite + CI stay browser-free.

Safety (the duplicate-server lesson, 2026-06-22): the app is served IN-PROCESS on a free port
against a synthetic temp DB with auto-sync DISABLED; tests never mutate live data and never spin
a second Reddit sync scheduler.
"""
from __future__ import annotations

import json
import importlib.util
import socket
import threading
import time
from collections.abc import Generator

import pytest

# `playwright`/`browser` fixtures come from the pytest-playwright plugin.

# Skip collecting the whole UI suite when Playwright isn't installed (CI installs only [dev]) - otherwise
# test modules would ImportError at COLLECTION, even though the tests are deselected at run time.
# Locally: `pip install -e .[ui] && playwright install chromium`.
if (importlib.util.find_spec("playwright") is None
        or importlib.util.find_spec("playwright.sync_api") is None):  # pragma: no cover
    collect_ignore_glob = ["*"]

# Pixel 6 is a built-in Playwright device descriptor (viewport 412x839, DSF 2.625, touch).
# Playwright can't emulate `display-mode: standalone` natively (microsoft/playwright#26853), so we
# inject a matchMedia shim -> the app renders as an installed PWA.
PWA_STANDALONE_INIT = r"""
(() => {
  const orig = window.matchMedia.bind(window);
  window.matchMedia = (q) => /display-mode\s*:\s*standalone/.test(String(q))
    ? { matches: true, media: q, onchange: null, addEventListener() {}, removeEventListener() {},
        addListener() {}, removeListener() {}, dispatchEvent() { return false; } }
    : orig(q);
})()
"""


# Pixel 6 descriptor, defined manually from Playwright's deviceDescriptorsSource.json (the bundled
# pytest-playwright may be too old to have "Pixel 6" in playwright.devices). snake_case keys = the
# Python new_context() params. Ref: microsoft/playwright .../deviceDescriptorsSource.json.
PIXEL_6 = {
    "user_agent": ("Mozilla/5.0 (Linux; Android 12; Pixel 6) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36"),
    "viewport": {"width": 412, "height": 839},
    "screen": {"width": 412, "height": 915},
    "device_scale_factor": 2.625,
    "is_mobile": True,
    "has_touch": True,
}


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _seed_ui_db(db_path: str) -> None:
    from content_hoarder import db, models, reddit_sync

    now = int(time.time())
    with db.connect(db_path) as c:
        rows = [
            models.new_item(
                source="reddit",
                source_id="ui_empty_gallery",
                kind="post",
                title="UI empty gallery item",
                url="https://www.reddit.com/gallery/ui-empty-gallery",
                created_utc=now - 300,
                now=now - 300,
                metadata={"subreddit": "test", "media_type": "gallery", "gallery": []},
            ),
            models.new_item(
                source="reddit",
                source_id="ui_gallery",
                kind="post",
                title="UI gallery item",
                url="https://www.reddit.com/gallery/ui-gallery",
                created_utc=now - 200,
                now=now - 200,
                metadata={
                    "subreddit": "test",
                    "media_type": "gallery",
                    "thumbnail": "/static/icon-192.png",
                    "gallery": ["/static/icon-512.png", "/static/icon-192.png"],
                    "gallery_preview": ["/static/icon-512.png", "/static/icon-192.png"],
                },
            ),
            models.new_item(
                source="reddit",
                source_id="ui_seed",
                kind="post",
                title="UI seed item",
                url="https://www.reddit.com/r/test/comments/ui_seed/ui_seed/",
                created_utc=now - 100,
                now=now - 100,
                metadata={
                    "subreddit": "test",
                    "permalink": "/r/test/comments/ui_seed/ui_seed/",
                    "tags": ["coding"],
                },
            ),
            models.new_item(
                source="reddit",
                source_id="ui_text_thumb",
                kind="post",
                title="AskReddit synthetic text thumbnail",
                body="Thread text preview body from a self post.",
                url="https://www.reddit.com/r/AskReddit/comments/ui_text_thumb/title/",
                created_utc=now - 90,
                now=now - 90,
                metadata={
                    "subreddit": "AskReddit",
                    "permalink": "/r/AskReddit/comments/ui_text_thumb/title/",
                    "thumbnail": "https://b.thumbs.redditmedia.com/selfpost.jpg",
                },
            ),
            models.new_item(
                source="reddit",
                source_id="ui_old_done",
                kind="post",
                title="UI old Done item",
                url="https://example.test/ui-old-done",
                created_utc=now - 60 * 86400,
                now=now - 60 * 86400,
            ),
            models.new_item(
                source="reddit",
                source_id="ui_recent_done",
                kind="post",
                title="UI recent Done item",
                url="https://example.test/ui-recent-done",
                created_utc=now - 3 * 86400,
                now=now - 3 * 86400,
            ),
            models.new_item(
                source="youtube",
                source_id="ReaderVid01",
                kind="video",
                title="Reader YouTube video",
                body="Fallback body should not replace the enriched description.",
                url="https://www.youtube.com/watch?v=ReaderVid01",
                author="Reader Channel",
                metadata={
                    "channel": "Reader Channel",
                    "duration": 125,
                    "playlist": "Reader Playlist",
                    "availability": "public",
                    "view_count": 12345,
                    "yt_categories": ["Education", "Technology"],
                    "category": "listenable",
                    "tags": ["listenable", "coding"],
                    "description": "Stored local description for the reader.",
                    "thumbnail": "https://i.ytimg.com/vi/ReaderVid01/hqdefault.jpg",
                    "companions": [
                        {"source": "reddit", "fullname": "reddit:ui_gallery", "permalink": "/r/test/comments/ui_gallery/"}
                    ],
                },
                now=now - 400,
            ),
            models.new_item(
                source="hackernews",
                source_id="424242",
                kind="story",
                title="Sparse imported HN title",
                url="https://news.ycombinator.com/item?id=424242",
                author="pg",
                metadata={"tags": ["coding"], "category": "reading"},
                now=now - 399,
            ),
            models.new_item(
                source="twitter",
                source_id="1777777777777777777",
                kind="tweet",
                title="A saved tweet with <unsafe> text and a link.",
                url="https://x.com/reader/status/1777777777777777777",
                author="reader",
                metadata={
                    "author_handle": "reader",
                    "author_name": "Reader Person",
                    "in_reply_to_screen_name": "someone",
                    "quote_tweet": {
                        "author_handle": "quoted",
                        "author_name": "Quoted Person",
                        "text": "quoted <script> text",
                        "permalink": "https://x.com/quoted/status/1666666666666666666",
                    },
                    "outlinks": ["https://example.com/article?x=1&y=2"],
                    "media_urls": ["/static/icon-192.png"],
                    "thumbnail": "/static/icon-192.png",
                    "media_type": "image",
                },
                now=now - 401,
            ),
            models.new_item(
                source="keep",
                source_id="ui-checklist",
                kind="note",
                title="Reader checklist note",
                body="[ ] keep style task\n- [x] markdown style task\nPlain note text.",
                now=now - 402,
            ),
        ]
        rows.extend(
            models.new_item(
                source="reddit",
                source_id=f"ui_scroll_{i}",
                kind="post",
                title=f"UI scroll item {i:02d}",
                body="Synthetic row for deterministic browser tests.",
                url=f"https://www.reddit.com/r/test/comments/ui_scroll_{i}/",
                created_utc=now - 1000 - i,
                now=now - 1000 - i,
                metadata={"subreddit": "test", "permalink": f"/r/test/comments/ui_scroll_{i}/"},
            )
            for i in range(30)
        )
        for item in rows:
            db.merge_upsert(c, item)
        db.set_reddit_thread(
            c,
            "hackernews:424242",
            json.dumps(
                {
                    "id": 424242,
                    "title": "Cached HN Reader Story",
                    "url": "https://example.test/hn-reader-story",
                    "author": "pg",
                    "points": 128,
                    "text": "<p>Cached story text.</p>",
                    "created_at_i": now - 500,
                    "type": "story",
                    "children": [
                        {
                            "id": 424243,
                            "author": "dang",
                            "text": "<p>First cached HN comment.</p>",
                            "points": 42,
                            "created_at_i": now - 450,
                            "type": "comment",
                            "children": [
                                {
                                    "id": 424244,
                                    "author": "hnreply",
                                    "text": "<p>Nested cached HN reply.</p>",
                                    "points": 7,
                                    "created_at_i": now - 430,
                                    "type": "comment",
                                    "children": [],
                                }
                            ],
                        }
                    ],
                }
            ),
            commit=False,
        )
        c.execute(
            "UPDATE items SET status='done', processed_utc=? WHERE fullname='reddit:ui_old_done'",
            (now - 45 * 86400,),
        )
        c.execute(
            "UPDATE items SET status='done', processed_utc=? WHERE fullname='reddit:ui_recent_done'",
            (now - 3 * 86400,),
        )
        db.set_setting(c, "done_retention_days", "30")
        reddit_sync.set_autosync_enabled(c, False)
        c.commit()


@pytest.fixture(scope="session")
def app_base_url(tmp_path_factory) -> Generator[str, None, None]:
    """Serve the app on a free localhost port against a synthetic throwaway DB."""
    from werkzeug.serving import make_server

    from content_hoarder.web import create_app

    dbcopy = tmp_path_factory.mktemp("ch-ui-db") / "app.db"
    _seed_ui_db(str(dbcopy))

    app = create_app(db_path=str(dbcopy))
    port = _free_port()
    srv = make_server("127.0.0.1", port, app, threaded=True)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    try:
        yield f"http://127.0.0.1:{port}"
    finally:
        srv.shutdown()


@pytest.fixture
def pixel6_page(browser, app_base_url):
    """A Pixel-6 (PWA-standalone) page already navigated to the app."""
    ctx = browser.new_context(**PIXEL_6)
    ctx.add_init_script(PWA_STANDALONE_INIT)
    page = ctx.new_page()
    page.goto(app_base_url, wait_until="networkidle")
    try:
        yield page
    finally:
        ctx.close()


@pytest.fixture
def desktop_page(browser, app_base_url):
    """A desktop-viewport page for the non-mobile layout."""
    ctx = browser.new_context(viewport={"width": 1280, "height": 800})
    page = ctx.new_page()
    page.goto(app_base_url, wait_until="networkidle")
    try:
        yield page
    finally:
        ctx.close()
