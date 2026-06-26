import re

import pytest
from playwright.sync_api import expect

from conftest import PIXEL_6, PWA_STANDALONE_INIT

pytestmark = pytest.mark.ui


def _new_pixel6_page(browser):
    ctx = browser.new_context(**PIXEL_6)
    ctx.add_init_script(PWA_STANDALONE_INIT)
    page = ctx.new_page()
    return ctx, page


def _expect_browse(page, app_base_url):
    expect(page).to_have_url(re.compile(rf"^{re.escape(app_base_url)}/?$"))
    expect(page.locator("body")).to_have_attribute("data-page", "browse")


def _expect_triage(page, app_base_url):
    expect(page).to_have_url(re.compile(rf"^{re.escape(app_base_url)}/triage(?:[?#].*)?$"))
    expect(page.locator("body")).to_have_attribute("data-page", "triage")


def test_direct_triage_entry_back_returns_to_browse(browser, app_base_url):
    ctx, page = _new_pixel6_page(browser)
    try:
        page.goto(f"{app_base_url}/triage", wait_until="networkidle")
        _expect_triage(page, app_base_url)
        assert page.evaluate("history.state && history.state.chTriageEntry") is True

        page.go_back(wait_until="domcontentloaded")
        _expect_browse(page, app_base_url)
    finally:
        ctx.close()


def test_browse_to_triage_back_still_returns_to_browse(pixel6_page, app_base_url):
    page = pixel6_page
    page.locator("a.fab[href='/triage']").click()
    _expect_triage(page, app_base_url)
    assert page.evaluate("!(history.state && history.state.chTriageEntry)")

    page.go_back(wait_until="domcontentloaded")
    _expect_browse(page, app_base_url)


def test_triage_overlay_back_precedes_entry_guard(browser, app_base_url):
    ctx, page = _new_pixel6_page(browser)
    try:
        page.goto(f"{app_base_url}/triage", wait_until="networkidle")
        _expect_triage(page, app_base_url)

        page.evaluate(
            """async () => {
              const { pushOverlay } = await import('/static/core/overlaynav.js');
              const modal = document.getElementById('media-modal');
              const body = document.getElementById('media-body');
              body.innerHTML = '<p data-test-overlay>overlay</p>';
              modal.hidden = false;
              pushOverlay(() => {
                modal.hidden = true;
                body.innerHTML = '';
                modal.dataset.closedByBack = '1';
              });
            }"""
        )
        expect(page.locator("#media-modal")).to_be_visible()

        page.go_back()
        expect(page.locator("#media-modal")).to_be_hidden()
        assert page.locator("#media-modal").get_attribute("data-closed-by-back") == "1"
        _expect_triage(page, app_base_url)

        page.go_back(wait_until="domcontentloaded")
        _expect_browse(page, app_base_url)
    finally:
        ctx.close()


def test_reloading_direct_triage_entry_does_not_stack_guards(browser, app_base_url):
    ctx, page = _new_pixel6_page(browser)
    try:
        page.goto(f"{app_base_url}/triage", wait_until="networkidle")
        _expect_triage(page, app_base_url)

        page.reload(wait_until="networkidle")
        page.reload(wait_until="networkidle")
        _expect_triage(page, app_base_url)
        assert page.evaluate("history.state && history.state.chTriageEntry") is True

        page.go_back(wait_until="domcontentloaded")
        _expect_browse(page, app_base_url)
    finally:
        ctx.close()
