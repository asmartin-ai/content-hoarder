"""Playwright UI tests — real browser + Pixel-6 / PWA emulation against the running app.

Run:   pytest -m ui                      (needs chromium: `playwright install chromium`)
These are EXCLUDED from the default `pytest` run (pyproject addopts `-m "not ui"`), so the
fast unit suite + CI stay browser-free.

Safety (the duplicate-server lesson, 2026-06-22): the app is served IN-PROCESS on a free port
against a COPY of the live DB with auto-sync DISABLED — tests never mutate live data and never
spin a second Reddit sync scheduler.
"""
from __future__ import annotations

import shutil
import socket
import threading

import pytest

# `playwright`/`browser` fixtures come from the pytest-playwright plugin.

# Skip collecting the whole UI suite when Playwright isn't installed (CI installs only [dev]) — otherwise
# test_smoke.py's `from playwright.sync_api import ...` would ImportError at COLLECTION, even though the
# tests are deselected at run time. Locally: `pip install -e .[ui] && playwright install chromium`.
try:
    import playwright.sync_api  # noqa: F401
except Exception:                # pragma: no cover
    collect_ignore_glob = ["*"]

# Pixel 6 is a built-in Playwright device descriptor (viewport 412x839, DSF 2.625, touch).
# Playwright can't emulate `display-mode: standalone` natively (microsoft/playwright#26853), so we
# inject a matchMedia shim → the app renders as an installed PWA.
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


@pytest.fixture(scope="session")
def app_base_url(tmp_path_factory) -> str:
    """Serve the app on a free localhost port against a throwaway copy of the live DB."""
    from werkzeug.serving import make_server

    from content_hoarder import config, db, reddit_sync
    from content_hoarder.web import create_app

    src = config.db_path()
    dbcopy = tmp_path_factory.mktemp("ch-ui-db") / "app.db"
    shutil.copy2(src, dbcopy)
    with db.connect(str(dbcopy)) as c:
        reddit_sync.set_autosync_enabled(c, False)   # no background scheduler / no Reddit hits

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
