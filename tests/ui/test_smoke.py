"""Smoke + regression UI tests on a real (headless) Chromium, Pixel-6 / PWA emulation.

Guards the kinds of bugs that slipped through unit tests this session (gallery view, top-bar
behaviour) — these only show up in a real browser at a mobile viewport.
"""

import re

import pytest

expect = pytest.importorskip("playwright.sync_api").expect

pytestmark = pytest.mark.ui


def test_feed_loads_on_pixel6(pixel6_page):
    page = pixel6_page
    expect(page.locator(".row[data-fullname]").first).to_be_visible()
    assert page.viewport_size["width"] == 412  # Pixel 6 descriptor
    assert page.evaluate("navigator.maxTouchPoints > 0 || 'ontouchstart' in window")


def test_version_badge_shows(pixel6_page):
    badge = pixel6_page.locator("#app-version")
    expect(badge).to_have_text(
        re.compile(r"^v\d+$")
    )  # e.g. v69 — proves main.js wired the badge


def test_runs_as_standalone_pwa(pixel6_page):
    # the matchMedia shim makes display-mode: standalone match (installed-PWA rendering)
    assert (
        pixel6_page.evaluate("window.matchMedia('(display-mode: standalone)').matches")
        is True
    )


def test_gallery_opens_as_stacked_lightbox(pixel6_page):
    """REGRESSION GUARD (2026-06-22): a gallery must open the plain STACKED lightbox —
    a vertical column of plain-src images, NOT the min-height:50vh lazy-placeholder version."""
    page = pixel6_page
    page.fill("#q", "has:gallery")
    page.press("#q", "Enter")
    page.wait_for_selector(".row[data-fullname] [data-media]")
    page.wait_for_timeout(400)  # let the filtered feed re-render settle (rows swap out)
    media = page.locator(".row[data-fullname] [data-media]").first
    if "nsfw" in (media.get_attribute("class") or ""):
        media.click()  # first tap reveals an NSFW thumbnail
        page.wait_for_timeout(200)
    page.locator(
        ".row[data-fullname] [data-media]"
    ).first.click()  # re-resolve (avoid stale handle)

    gallery = page.locator("#media-body .media-gallery")
    expect(gallery).to_be_visible()
    assert (
        page.evaluate(
            "getComputedStyle(document.querySelector('#media-body .media-gallery')).flexDirection"
        )
        == "column"
    )  # stacked vertically
    imgs = page.locator("#media-body .gallery-img")
    expect(imgs.first).to_be_visible()
    # the bug: lazy version used data-src placeholders with an inline min-height
    assert not page.evaluate(
        "[...document.querySelectorAll('#media-body .gallery-img')].some(im => im.style.minHeight)"
    ), "gallery images must not have min-height placeholders (the reverted lazy view)"
    assert page.evaluate(
        "[...document.querySelectorAll('#media-body .gallery-img')].every(im => im.getAttribute('src'))"
    ), "gallery images must have a plain src (not data-src)"


def test_empty_gallery_no_iframe(pixel6_page):
    """REGRESSION GUARD (2026-06-22): gallery items with no captured image URLs must NOT
    show a reddit iframe in the lightbox. They should show a clean placeholder + 'Open on
    Reddit ↗' link instead. Search for a known empty-gallery fullname or a gallery item whose
    card has no inline images (falls through to the embed button)."""
    page = pixel6_page
    # Gallery items whose media_type is gallery but gallery array is empty render as a
    # .tcard-embed with a "🖼 Gallery" button. Find one via a /gallery/ URL search.
    page.fill("#q", "has:gallery reddit.com/gallery")
    page.press("#q", "Enter")
    page.wait_for_selector(".row[data-fullname]")
    page.wait_for_timeout(400)

    # Look for an embed button (the empty-gallery fallthrough card)
    embed_btn = page.locator(".tcard-embed .rd-preview-lg").first
    if not embed_btn.is_visible():
        pytest.skip("No empty-gallery items in this DB copy")

    embed_btn.click()
    page.wait_for_timeout(300)

    # The bug: empty-gallery items showed a reddit-embed-frame <iframe>.
    # After the fix: the card body shows a placeholder + link, NOT an iframe.
    holder = page.locator(".tcard-embed").first
    assert not holder.locator("iframe").count(), (
        "Empty-gallery embed must NOT contain an iframe"
    )
    assert holder.locator(".media-fallback").count() > 0, (
        "Empty-gallery embed should show a placeholder fallback link"
    )


def test_topbar_shrinks_on_scroll_then_expands(pixel6_page):
    """The collapsing top bar: compacts when scrolled down, expands back near the top.
    Real Chromium runs the scroll handler (the preview tool couldn't), so this is meaningful."""
    page = pixel6_page
    console = page.locator(".console")
    expect(console).not_to_have_class(
        re.compile(r"\bcompact\b")
    )  # starts expanded at the top
    page.mouse.wheel(0, 600)  # scroll down past the threshold
    page.wait_for_timeout(150)
    expect(console).to_have_class(re.compile(r"\bcompact\b"))  # collapsed
    page.evaluate("window.scrollTo(0, 0)")  # back to the top
    expect(console).not_to_have_class(
        re.compile(r"\bcompact\b")
    )  # expanded again (expect auto-waits)


def test_topbar_tracks_near_top_scroll_smoothly(pixel6_page):
    """Near the top, small swipes should scrub the header open/closed without idle pop."""
    page = pixel6_page
    console = page.locator(".console")
    expect(console).not_to_have_class(re.compile(r"compact"))

    page.evaluate("window.scrollTo(0, 55)")
    page.wait_for_function(
        "parseFloat(document.querySelector('.console').style.getPropertyValue('--console-collapse')) > 0.35"
    )
    mid = page.evaluate(
        "parseFloat(document.querySelector('.console').style.getPropertyValue('--console-collapse'))"
    )
    assert 0.35 < mid < 0.65, f"expected partial collapse near top, got {mid}"
    expect(console).not_to_have_class(re.compile(r"compact"))

    page.evaluate("window.scrollTo(0, 700)")
    page.wait_for_function(
        "document.querySelector('.console').classList.contains('compact')"
    )

    page.evaluate("window.scrollTo(0, 8)")
    page.wait_for_function(
        "parseFloat(document.querySelector('.console').style.getPropertyValue('--console-collapse')) < 0.2"
    )
    expect(console).not_to_have_class(re.compile(r"compact"))


def test_topbar_no_flicker_near_top(pixel6_page):
    """REGRESSION GUARD (2026-06-22): the collapsing bar must not FLIP rapidly near the top, where
    expanding grows the bar and scroll-anchoring nudges scrollY. Count .console class mutations over a
    scroll-down-then-back-to-top sequence — a healthy run toggles a small, bounded number of times."""
    page = pixel6_page
    page.evaluate(
        "() => { window.__t = 0; const h = document.querySelector('.console');"
        " new MutationObserver(() => { window.__t++; }).observe(h, {attributes: true, attributeFilter: ['class']}); }"
    )
    page.mouse.wheel(0, 700)  # scroll well down → collapse
    page.wait_for_timeout(600)
    page.evaluate("window.scrollTo(0, 8)")  # back to near the top → expand
    page.wait_for_timeout(900)  # leave time for any flicker to manifest
    toggles = page.evaluate("window.__t")
    assert toggles <= 4, (
        f"top bar flickered: {toggles} class mutations (expected ~2: collapse + expand)"
    )
    expect(page.locator(".console")).not_to_have_class(
        re.compile(r"\bcompact\b")
    )  # settled expanded


def test_gotop_scrolls_to_top_and_expands_topbar(pixel6_page):
    """The mobile ↑ affordance should finish at the true top with chrome expanded and hidden again."""
    page = pixel6_page
    page.evaluate(
        "() => { window.__t = 0; const h = document.querySelector('.console');"
        " new MutationObserver(() => { window.__t++; }).observe(h, {attributes: true, attributeFilter: ['class']});"
        " window.scrollTo(0, document.documentElement.scrollHeight); }"
    )
    page.wait_for_function(
        "window.scrollY > 700 && document.querySelector('#gotop').classList.contains('show')"
    )
    expect(page.locator(".console")).to_have_class(re.compile("(^| )compact( |$)"))

    page.locator("#gotop").click()
    page.wait_for_function("Math.round(window.scrollY) === 0")
    expect(page.locator(".console")).not_to_have_class(re.compile("(^| )compact( |$)"))
    expect(page.locator("#gotop")).not_to_have_class(re.compile("(^| )show( |$)"))
    page.wait_for_timeout(450)
    assert round(page.evaluate("window.scrollY")) == 0
    expect(page.locator(".console")).not_to_have_class(re.compile("(^| )compact( |$)"))
    expect(page.locator("#gotop")).not_to_have_class(re.compile("(^| )show( |$)"))
    toggles = page.evaluate("window.__t")
    assert toggles <= 4, f"↑ caused top-bar flicker: {toggles} class mutations"


def test_gotop_respects_reduced_motion(pixel6_page):
    """Reduced-motion users get an immediate jump, not a long programmatic smooth scroll."""
    page = pixel6_page
    page.emulate_media(reduced_motion="reduce")
    page.evaluate("window.scrollTo(0, document.documentElement.scrollHeight)")
    page.wait_for_function(
        "window.scrollY > 700 && document.querySelector('#gotop').classList.contains('show')"
    )

    page.locator("#gotop").click()
    page.evaluate("() => new Promise(requestAnimationFrame)")
    assert round(page.evaluate("window.scrollY")) == 0
    expect(page.locator(".console")).not_to_have_class(re.compile("(^| )compact( |$)"))
    expect(page.locator("#gotop")).not_to_have_class(re.compile("(^| )show( |$)"))
    page.wait_for_timeout(220)
    assert round(page.evaluate("window.scrollY")) == 0
    expect(page.locator(".console")).not_to_have_class(re.compile("(^| )compact( |$)"))
    expect(page.locator("#gotop")).not_to_have_class(re.compile("(^| )show( |$)"))
