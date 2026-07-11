"""P3.3 subreddit facet — UI regression (Playwright).

Asserts that clicking the reddit source in the rail surfaces the subreddit
sub-facet, and clicking a subreddit chip filters the items list. The
subreddit endpoint is served from the real (synthetic-seeded) UI DB, so no
page.route mocking is needed.

Uses the desktop fixture: the subreddit sub-facet lives in ``#rail-sources``
which is ``display:none`` below 700px (mobile uses the ``.navdrawer``).
"""

import pytest

expect = pytest.importorskip("playwright.sync_api").expect

pytestmark = pytest.mark.ui


def test_subreddit_facet_drills_down(desktop_page):
    page = desktop_page

    # Click the reddit source in the rail to scope to source=reddit.
    reddit_btn = page.locator("#rail-sources [data-source='reddit']").first
    reddit_btn.click()
    page.wait_for_timeout(400)

    # The subreddit sub-facet should appear under the rail.
    sub_slot = page.locator("#rail-subreddits")
    expect(sub_slot).to_be_visible()
    expect(sub_slot.locator("[data-subreddit]")).not_to_have_count(0)

    # Click the first subreddit chip — the URL state should reflect a filter
    # (the chip strip shows subreddit:<name>).
    first_sub = sub_slot.locator("[data-subreddit]").first
    sub_name = first_sub.get_attribute("data-subreddit")
    first_sub.click()
    page.wait_for_timeout(400)

    chip = page.locator(".fchip", has_text="subreddit:" + sub_name)
    expect(chip).to_have_count(1)


def test_subreddit_facet_hidden_when_not_reddit(pixel6_page):
    """The sub-facet only renders when source=reddit is the active filter."""
    page = pixel6_page
    # On initial load (status=inbox, no source), the facet must be absent.
    expect(page.locator("#rail-subreddets")).to_have_count(0)
    expect(page.locator("#rail-subreddits")).to_have_count(0)
