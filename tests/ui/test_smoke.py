"""Smoke + regression UI tests on a real (headless) Chromium, Pixel-6 / PWA emulation.

Guards the kinds of bugs that slipped through unit tests this session (gallery view, top-bar
behaviour) — these only show up in a real browser at a mobile viewport.
"""
import re

import pytest
from playwright.sync_api import expect

pytestmark = pytest.mark.ui


def test_feed_loads_on_pixel6(pixel6_page):
    page = pixel6_page
    expect(page.locator(".row[data-fullname]").first).to_be_visible()
    assert page.viewport_size["width"] == 412            # Pixel 6 descriptor
    assert page.evaluate("navigator.maxTouchPoints > 0 || 'ontouchstart' in window")


def test_version_badge_shows(pixel6_page):
    badge = pixel6_page.locator("#app-version")
    expect(badge).to_have_text(re.compile(r"^v\d+$"))    # e.g. v69 — proves main.js wired the badge


def test_runs_as_standalone_pwa(pixel6_page):
    # the matchMedia shim makes display-mode: standalone match (installed-PWA rendering)
    assert pixel6_page.evaluate("window.matchMedia('(display-mode: standalone)').matches") is True


def test_gallery_opens_as_stacked_lightbox(pixel6_page):
    """REGRESSION GUARD (2026-06-22): a gallery must open the plain STACKED lightbox —
    a vertical column of plain-src images, NOT the min-height:50vh lazy-placeholder version."""
    page = pixel6_page
    page.fill("#q", "has:gallery")
    page.press("#q", "Enter")
    page.wait_for_selector(".row[data-fullname] [data-media]")
    page.wait_for_timeout(400)             # let the filtered feed re-render settle (rows swap out)
    media = page.locator(".row[data-fullname] [data-media]").first
    if "nsfw" in (media.get_attribute("class") or ""):
        media.click()                      # first tap reveals an NSFW thumbnail
        page.wait_for_timeout(200)
    page.locator(".row[data-fullname] [data-media]").first.click()   # re-resolve (avoid stale handle)

    gallery = page.locator("#media-body .media-gallery")
    expect(gallery).to_be_visible()
    assert page.evaluate(
        "getComputedStyle(document.querySelector('#media-body .media-gallery')).flexDirection"
    ) == "column"                          # stacked vertically
    imgs = page.locator("#media-body .gallery-img")
    expect(imgs.first).to_be_visible()
    # the bug: lazy version used data-src placeholders with an inline min-height
    assert not page.evaluate(
        "[...document.querySelectorAll('#media-body .gallery-img')].some(im => im.style.minHeight)"
    ), "gallery images must not have min-height placeholders (the reverted lazy view)"
    assert page.evaluate(
        "[...document.querySelectorAll('#media-body .gallery-img')].every(im => im.getAttribute('src'))"
    ), "gallery images must have a plain src (not data-src)"


def test_topbar_shrinks_on_scroll_then_expands(pixel6_page):
    """The collapsing top bar: compacts when scrolled down, expands back near the top.
    Real Chromium runs the scroll handler (the preview tool couldn't), so this is meaningful."""
    page = pixel6_page
    console = page.locator(".console")
    expect(console).not_to_have_class(re.compile(r"\bcompact\b"))   # starts expanded at the top
    page.mouse.wheel(0, 600)                                        # scroll down past the threshold
    page.wait_for_timeout(150)
    expect(console).to_have_class(re.compile(r"\bcompact\b"))       # collapsed
    page.evaluate("window.scrollTo(0, 0)")                          # back to the top
    page.wait_for_timeout(150)
    expect(console).not_to_have_class(re.compile(r"\bcompact\b"))   # expanded again
