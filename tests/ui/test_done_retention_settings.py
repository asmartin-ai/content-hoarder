from __future__ import annotations

import re
import socket
import threading

import pytest
from playwright.sync_api import expect

from content_hoarder import db, models, reddit_sync
from content_hoarder.web import create_app

from conftest import PIXEL_6, PWA_STANDALONE_INIT

pytestmark = pytest.mark.ui

NOW = 2_000_000_000


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


@pytest.fixture
def retention_app_base_url(tmp_path) -> str:
    from werkzeug.serving import make_server
    import content_hoarder.web as web

    orig_time = web.time.time
    web.time.time = lambda: NOW
    db_path = tmp_path / "app.db"
    with db.connect(str(db_path)) as conn:
        reddit_sync.set_autosync_enabled(conn, False)
        db.merge_upsert(conn, models.new_item(
            source="reddit", source_id="old_done", kind="post", title="Old done",
            url="https://example.com/old", now=NOW - 5000,
        ))
        db.merge_upsert(conn, models.new_item(
            source="reddit", source_id="week_old_done", kind="post", title="Week old done",
            url="https://example.com/week", now=NOW - 4000,
        ))
        db.merge_upsert(conn, models.new_item(
            source="reddit", source_id="keep_me", kind="post", title="Keep me",
            url="https://example.com/keep", now=NOW - 3000,
        ))
        conn.execute(
            "UPDATE items SET status='done', processed_utc=?, status_prev='inbox' "
            "WHERE fullname='reddit:old_done'",
            (NOW - 31 * 86400,),
        )
        conn.execute(
            "UPDATE items SET status='done', processed_utc=?, status_prev='inbox' "
            "WHERE fullname='reddit:week_old_done'",
            (NOW - 8 * 86400,),
        )
        conn.execute(
            "UPDATE items SET status='keep', processed_utc=?, status_prev='inbox' "
            "WHERE fullname='reddit:keep_me'",
            (NOW - 4 * 86400,),
        )
        db.set_setting(conn, "done_retention_days", "30")

    app = create_app(db_path=str(db_path))
    port = _free_port()
    srv = make_server("127.0.0.1", port, app, threaded=True)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    try:
        yield f"http://127.0.0.1:{port}"
    finally:
        srv.shutdown()
        web.time.time = orig_time


@pytest.fixture
def retention_page(browser, retention_app_base_url):
    ctx = browser.new_context(**PIXEL_6)
    ctx.add_init_script(PWA_STANDALONE_INIT)
    page = ctx.new_page()
    page.goto(retention_app_base_url, wait_until="networkidle")
    try:
        yield page
    finally:
        ctx.close()


def test_done_retention_sheet_updates_preview_and_purges_done_feed(retention_page):
    page = retention_page
    page.get_by_role("tab", name=re.compile("^Done")).click()
    expect(page.locator(".row[data-fullname]")).to_have_count(2)

    page.locator("#dock-settings").click()
    expect(page.locator("#done-retention-current")).to_have_text("Current window: 30 days.")
    expect(page.locator("#done-retention-preview")).to_contain_text("1")
    expect(page.locator("#done-retention-purge")).to_be_disabled()

    page.locator('#set-done-retention button[data-days="7"]').click()
    expect(page.locator("#done-retention-current")).to_have_text("Current window: 7 days.")
    expect(page.locator("#done-retention-preview")).to_contain_text("2")
    expect(page.locator("#done-retention-purge")).to_be_disabled()

    page.locator("#done-retention-confirm").check()
    expect(page.locator("#done-retention-purge")).to_be_enabled()
    page.locator("#done-retention-purge").click()

    expect(page.locator("#toast")).to_contain_text("Purged 2 Done items.")
    expect(page.locator("#done-retention-preview")).to_contain_text("Nothing is eligible right now.")
    expect(page.locator(".row[data-fullname]")).to_have_count(0)
