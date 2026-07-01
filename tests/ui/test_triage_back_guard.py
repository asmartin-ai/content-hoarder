import json
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


def _clear_triage_state_script():
    return """
      localStorage.removeItem('ch_triage_filters_v1');
      localStorage.removeItem('ch_triage_session');
      sessionStorage.removeItem('ch_triage_reader_enter');
    """


def _swipe_current_triage_card_up(page):
    page.evaluate(
        """() => {
          const card = document.querySelector('.tcard');
          const r = card.getBoundingClientRect();
          const x = Math.round(r.left + r.width / 2);
          const y = Math.round(r.top + r.height / 2);
          const fire = (type, clientY, buttons) => card.dispatchEvent(new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            pointerId: 57,
            pointerType: 'touch',
            isPrimary: true,
            clientX: x,
            clientY,
            buttons,
          }));
          fire('pointerdown', y, 1);
          fire('pointermove', y - 24, 1);
          fire('pointermove', y - 138, 1);
          fire('pointerup', y - 138, 0);
        }"""
    )


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


def test_triage_filters_apply_clear_and_fit(browser, app_base_url):
    ctx, page = _new_pixel6_page(browser)
    try:
        page.add_init_script(_clear_triage_state_script())
        page.goto(f"{app_base_url}/triage", wait_until="networkidle")
        expect(page.locator(".tcard")).to_be_visible()

        page.evaluate(
            """() => localStorage.setItem('ch_triage_session', JSON.stringify({
              queue: [{ fullname: 'reddit:stale-filter-card' }],
              reviewed: 4,
              filters: 'stale',
              savedAt: Date.now()
            }))"""
        )

        page.locator("#filter-btn").click()
        expect(page.locator("#filter-pop")).to_be_visible()
        overflow = page.evaluate(
            "Math.ceil(document.documentElement.scrollWidth - document.documentElement.clientWidth)"
        )
        assert overflow <= 1

        with page.expect_response(lambda r: "/random?" in r.url and "source=youtube" in r.url):
            page.select_option("#source-filter", "youtube")
        expect(page.locator("#filter-active")).to_contain_text("YouTube")
        assert "stale-filter-card" not in (page.evaluate("localStorage.getItem('ch_triage_session')") or "")

        with page.expect_response(lambda r: "/random?" in r.url and "category=listenable" in r.url):
            page.locator("#category-filters [data-filter-value='listenable']").click()
        expect(page.locator("#filter-active")).to_contain_text("listenable")

        with page.expect_response(lambda r: "/random?" in r.url and "tag=coding" in r.url):
            page.locator("#tag-filters [data-filter-value='coding']").click()
        expect(page.locator("#filter-active")).to_contain_text("coding")

        with page.expect_response(lambda r: "/random?" in r.url and "mode=recent" in r.url):
            page.locator("#mode-filter [data-mode='recent']").click()
        expect(page.locator("#filter-active")).to_contain_text("Newest")
        expect(page.locator("#filter-count")).to_have_text("4")

        with page.expect_response(
            lambda r: "/random?" in r.url
            and "mode=smart" in r.url
            and "source=" not in r.url
            and "category=" not in r.url
            and "tag=" not in r.url
        ):
            page.locator("#filter-clear-pop").click()
        expect(page.locator("#filter-active")).to_be_hidden()
        expect(page.locator("#filter-count")).to_be_hidden()
        stored = page.evaluate("JSON.parse(localStorage.getItem('ch_triage_filters_v1'))")
        assert stored == {"source": "", "category": "", "tags": [], "mode": "smart"}
    finally:
        ctx.close()


def test_triage_swipe_up_reader_entry_keeps_back_guard(browser, app_base_url):
    ctx, page = _new_pixel6_page(browser)
    try:
        page.add_init_script(_clear_triage_state_script())
        page.goto(f"{app_base_url}/triage", wait_until="networkidle")
        _expect_triage(page, app_base_url)
        expect(page.locator(".tcard")).to_be_visible()

        _swipe_current_triage_card_up(page)
        expect(page).to_have_url(re.compile(rf"^{re.escape(app_base_url)}/\?open=.*from=triage"))
        reader = page.locator("#reader")
        expect(reader).to_have_class(re.compile(r"\bshow\b"))
        expect(reader).to_have_class(re.compile(r"\bfrom-triage\b"))
        expect(reader).to_have_class(re.compile(r"\btriage-enter\b"))
        assert page.evaluate("sessionStorage.getItem('ch_triage_reader_enter')") is None

        page.go_back(wait_until="domcontentloaded")
        _expect_triage(page, app_base_url)
    finally:
        ctx.close()


def test_triage_card_uses_pin_shell_without_selfpost_media(browser, app_base_url):
    item = {
        "fullname": "reddit:ui_triage_pin",
        "source": "reddit",
        "source_id": "ui_triage_pin",
        "kind": "post",
        "title": "Triage pin card fixture",
        "body": "This self post should render inside the pin-style triage body.",
        "url": "https://www.reddit.com/r/test/comments/ui_triage_pin/title/",
        "author": "op",
        "created_utc": 1700000000,
        "saved_utc": 1700000010,
        "first_seen_utc": 1700000010,
        "last_seen_utc": 1700000010,
        "status": "inbox",
        "metadata": {
            "subreddit": "test",
            "permalink": "/r/test/comments/ui_triage_pin/title/",
            "thumbnail": "https://b.thumbs.redditmedia.com/selfpost.jpg",
        },
    }
    ctx, page = _new_pixel6_page(browser)
    try:
        page.route(
            "**/random?*",
            lambda route: route.fulfill(
                status=200,
                content_type="application/json",
                body=json.dumps({"items": [item]}),
            ),
        )
        page.goto(f"{app_base_url}/triage", wait_until="networkidle")

        card = page.locator(".tcard.tcard-pin")
        expect(card).to_be_visible()
        expect(card.locator(".tcard-body")).to_be_visible()
        expect(card.locator(".tcard-snippet")).to_contain_text("self post should render")
        expect(card.locator(".tcard-media")).to_have_count(0)
        expect(page.locator("#actions")).to_be_visible()
    finally:
        ctx.close()
