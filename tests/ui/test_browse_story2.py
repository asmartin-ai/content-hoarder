"""Playwright coverage for QA Story 2: I scan the inbox and pick something to read.

Tests source tabs, focus mode, status nav, tag rail, pulse strip, and stats modal
using the seeded synthetic DB at a Pixel-6 PWA viewport.
"""

import pytest
from playwright.sync_api import expect

pytestmark = pytest.mark.ui


# --------------------------------------------------------------------------- #
# Story 2 — "I scan the inbox and pick something to read"
# --------------------------------------------------------------------------- #


def test_source_tabs_switch_list(pixel6_page):
    """Status pills switch the list and show per-status counts.

    On Pixel-6 mobile, .folders is display:none; the active nav is .statuspills.
    """
    page = pixel6_page
    # On mobile, .statuspills is the visible status nav (Inbox, Keep, Archived, Done, All)
    pills = page.locator('.statuspills button.spill[role="tab"]')
    expect(pills.first).to_be_visible()
    count = pills.count()
    assert count >= 4, f"expected >=4 status pills, got {count}"

    # Inbox should be selected initially
    inbox = page.locator('.statuspills button.spill[data-status="inbox"]')
    expect(inbox).to_be_visible()
    expect(inbox).to_have_attribute("aria-selected", "true")

    # Click "Done" — should filter and show items
    done = page.locator('.statuspills button.spill[data-status="done"]')
    expect(done).to_be_visible()
    done.click()
    page.wait_for_timeout(400)

    expect(done).to_have_attribute("aria-selected", "true")
    expect(inbox).to_have_attribute("aria-selected", "false")
    # Done count badge should be visible (seeded with 2 Done items)
    done_count = done.locator(".n")
    expect(done_count).to_be_visible()


def test_focus_mode_toggle(pixel6_page):
    """Focus button toggles body.focus and shows the batchstrip."""
    page = pixel6_page
    toggle = page.locator("#dock-focus")
    expect(toggle).to_be_visible()

    # Body should NOT have the 'focus' class initially
    classes = page.evaluate("() => document.body.className")
    assert "focus" not in classes

    toggle.click()
    page.wait_for_timeout(300)

    classes = page.evaluate("() => document.body.className")
    assert "focus" in classes

    # Batchstrip should now be visible
    batchstrip = page.locator("#batchstrip")
    expect(batchstrip).to_be_visible()

    # Toggle off
    toggle.click()
    page.wait_for_timeout(300)

    classes = page.evaluate("() => document.body.className")
    assert "focus" not in classes


def test_status_nav_pills_filter(pixel6_page):
    """Status pills (.statuspills) filter the list."""
    page = pixel6_page
    page.wait_for_selector(".row[data-fullname]")

    # The initial "Inbox" pill is selected; items are visible
    inbox_items = page.locator(".row[data-fullname]")
    initial_count = inbox_items.count()
    assert initial_count > 0, "expected inbox items on first load"

    # Click "Done" status pill
    done_pill = page.locator('.statuspills button.spill[data-status="done"]')
    expect(done_pill).to_be_visible()
    done_pill.click()
    page.wait_for_timeout(400)

    # Should now only show Done items
    done_items = page.locator(".row[data-fullname]")
    done_count = done_items.count()
    assert done_count < initial_count, "Done filter should reduce visible items"

    # Done pill should be selected
    expect(done_pill).to_have_attribute("aria-selected", "true")


def test_tag_rail_visible(pixel6_page):
    """The sidebar rail is accessible via the hamburger drawer on mobile.

    On Pixel-6, .rail is display:none by default; the nav is in the .navdrawer slide-in.
    """
    page = pixel6_page
    # On mobile, the hamburger button (.nav-burger) opens the drawer
    burger = page.locator(".nav-burger")
    expect(burger).to_be_visible()

    # Click the hamburger to open the nav drawer
    burger.click()
    page.wait_for_timeout(400)

    # The navdrawer should now be visible and contain source entries
    drawer = page.locator("#navdrawer")
    expect(drawer).to_be_visible()

    # The drawer has source buttons (e.g. "Reddit 33", "YouTube 1") rendered by JS
    expect(drawer.locator("button").first).to_be_visible()


def test_pulse_strip_visible(pixel6_page):
    """The 'wins' pulse strip shows TODAY progress."""
    page = pixel6_page
    wins = page.locator("#wins")
    expect(wins).to_be_visible()
    # Contains "TODAY" label
    expect(wins.locator(".wlab")).to_contain_text("TODAY")


def test_settings_sheet_opens(pixel6_page):
    """The settings panel opens via the dock MORE button on mobile.

    On Pixel-6, #open-settings is display:none; settings are accessed via #dock-settings.
    """
    page = pixel6_page
    # On mobile, the dock MORE button opens the settings sheetpanel
    settings_btn = page.locator("#dock-settings")
    expect(settings_btn).to_be_visible()
    settings_btn.click()
    page.wait_for_timeout(300)

    # Settings sheetpanel should be visible
    settings_panel = page.locator("#settings")
    expect(settings_panel).to_be_visible()

    # Stats button is inside the settings panel
    stats_btn = page.locator("#open-stats")
    expect(stats_btn).to_be_visible()
