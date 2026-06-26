from __future__ import annotations

import re
import socket
import threading

import pytest
from playwright.sync_api import expect

from content_hoarder import db, models, reddit_sync
from content_hoarder.web import create_app

pytestmark = pytest.mark.ui

VIDEO_ID = "dQw4w9WgXcQ"


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


@pytest.fixture(scope="session")
def note_app_base_url(tmp_path_factory) -> str:
    from werkzeug.serving import make_server

    db_path = tmp_path_factory.mktemp("ch-ui-note-reader") / "app.db"
    with db.connect(str(db_path)) as conn:
        reddit_sync.set_autosync_enabled(conn, False)
        db.merge_upsert(conn, models.new_item(
            source="keep",
            source_id="video-note",
            kind="note",
            title="Video note",
            body=(
                "These are my notes before the link.\n\n"
                f"https://www.youtube.com/watch?v={VIDEO_ID}&t=42\n\n"
                "[x] follow up item"
            ),
            now=1000,
        ))
        db.merge_upsert(conn, models.new_item(
            source="keep",
            source_id="plain-note",
            kind="note",
            title="Plain note",
            body="A note with no video link, just text.",
            now=1001,
        ))

    app = create_app(db_path=str(db_path))
    port = _free_port()
    srv = make_server("127.0.0.1", port, app, threaded=True)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    try:
        yield f"http://127.0.0.1:{port}"
    finally:
        srv.shutdown()


@pytest.fixture
def note_page(browser, note_app_base_url):
    ctx = browser.new_context(viewport={"width": 1280, "height": 800})
    page = ctx.new_page()
    page.route("https://www.youtube-nocookie.com/**", lambda route: route.abort())
    page.goto(note_app_base_url, wait_until="networkidle")
    try:
        yield page
    finally:
        ctx.close()


def test_note_with_one_youtube_link_renders_video_and_body(note_page):
    page = note_page
    page.locator('.row[data-fullname="keep:video-note"] .title').click()

    expect(page.locator("#reader")).to_have_class(re.compile(r"\bshow\b"))
    iframe = page.locator("#reader-post .rd-note-video-wrap iframe")
    expect(iframe).to_have_attribute(
        "src",
        f"https://www.youtube-nocookie.com/embed/{VIDEO_ID}",
    )
    expect(page.locator("#reader-comments .rd-body")).to_contain_text(
        "These are my notes before the link."
    )
    expect(page.locator("#reader-comments .rd-keep-checklist input")).to_be_checked()

    page.go_back()
    expect(page.locator("#reader")).not_to_have_class(re.compile(r"\bshow\b"))
    expect(page.locator("#reader iframe")).to_have_count(0)


def test_note_without_youtube_link_keeps_existing_note_reader(note_page):
    page = note_page
    page.locator('.row[data-fullname="keep:plain-note"] .title').click()

    expect(page.locator("#reader")).to_have_class(re.compile(r"\bshow\b"))
    expect(page.locator("#reader-post .rd-note-video-wrap iframe")).to_have_count(0)
    expect(page.locator("#reader-post .rd-body")).to_contain_text(
        "A note with no video link, just text."
    )
