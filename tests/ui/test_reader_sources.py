import re

import pytest
from playwright.sync_api import expect

pytestmark = pytest.mark.ui


def _open_reader(page, fullname: str):
    page.locator(f'.row[data-fullname="{fullname}"] .title').click()
    expect(page.locator("#reader")).to_have_class(re.compile(r"\bshow\b"))


def _close_reader(page):
    page.locator("#reader-close").click()
    expect(page.locator("#reader")).not_to_have_class(re.compile(r"\bshow\b"))


def test_youtube_item_opens_in_reader_with_local_metadata(desktop_page):
    page = desktop_page
    page.route("https://www.youtube-nocookie.com/**", lambda route: route.abort())

    _open_reader(page, "youtube:ReaderVid01")
    iframe = page.locator("#reader-post .rd-youtube-video iframe")
    expect(iframe).to_have_count(1)
    expect(iframe).to_have_attribute("src", "https://www.youtube-nocookie.com/embed/ReaderVid01")
    expect(page.locator("#reader-post")).to_contain_text("Reader Channel")
    expect(page.locator("#reader-post")).to_contain_text("2:05")
    expect(page.locator("#reader-post")).to_contain_text("Reader Playlist")
    expect(page.locator("#reader-post")).to_contain_text("12k")
    expect(page.locator("#reader-post")).to_contain_text("Stored local description")
    expect(page.locator("#reader-post .rd-companions .comp-link")).to_have_count(1)

    _close_reader(page)
    expect(page.locator("#reader iframe")).to_have_count(0)


def test_twitter_item_opens_in_reader_with_quote_outlink_and_media(desktop_page):
    page = desktop_page

    _open_reader(page, "twitter:1777777777777777777")
    expect(page.locator("#reader-post .rd-tweet-text")).to_contain_text("A saved tweet")
    expect(page.locator("#reader-post .rd-reply-context")).to_contain_text("@someone")
    expect(page.locator("#reader-post .rd-tweet-quote")).to_contain_text("Quoted Person")
    expect(page.locator("#reader-post .rd-tweet-quote")).to_contain_text("quoted <script> text")
    expect(page.locator('#reader-post .rd-outlinks a[href="https://example.com/article?x=1&y=2"]')).to_have_count(1)
    expect(page.locator("#reader-post .rd-tweet-media img")).to_have_count(1)


def test_note_checklist_toggle_persists_after_reopen(desktop_page):
    page = desktop_page

    _open_reader(page, "keep:ui-checklist")
    first = page.locator("#reader-post .rd-keep-checklist input").first
    expect(first).not_to_be_checked()
    with page.expect_response(lambda r: "/items/keep%3Aui-checklist/body" in r.url and r.request.method == "POST"):
        first.click()
    expect(first).to_be_checked()

    _close_reader(page)
    _open_reader(page, "keep:ui-checklist")
    expect(page.locator("#reader-post .rd-keep-checklist input").first).to_be_checked()
