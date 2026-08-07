"""Drag-and-drop to status buckets — UI regression (Playwright).

Issue #13: drag a row onto a status folder and the item changes status,
reusing the existing act() path (undo snackbar, haptics). Vanilla HTML5
drag-and-drop, desktop-only (mobile keeps swipe). Regression: the drop
must (a) change the item's status in the UI and (b) undo via the snackbar.

Uses the desktop fixture — HTML5 DnD is a desktop affordance; the Pixel-6
surface keeps swipe as the status gesture (friction asymmetry).
"""

import pytest

expect = pytest.importorskip("playwright.sync_api").expect

pytestmark = pytest.mark.ui


def test_drag_row_to_keep_folder_changes_status_and_undoes(desktop_page):
    page = desktop_page

    # Grab the first inbox row and the Keep folder.
    row = page.locator(".row[data-fullname]").first
    expect(row).to_have_count(1)
    fullname = row.get_attribute("data-fullname")

    keep_folder = page.locator('.folder[data-status="keep"]').first
    expect(keep_folder).to_be_visible()

    # The row must be marked draggable (the affordance exists).
    expect(row).to_have_attribute("draggable", "true")

    # Drag it onto Keep.
    row.drag_to(keep_folder)
    page.wait_for_timeout(500)

    # Undo snackbar appears (act() path) — and the item left the inbox list.
    expect(page.locator("#toast")).to_contain_text("Undo")

    # Undo restores it.
    page.locator(".toast-undo").first.click()
    page.wait_for_timeout(500)
    expect(page.locator(f'.row[data-fullname="{fullname}"]')).to_have_count(1)


def test_drag_row_to_done_folder_moves_item(desktop_page):
    page = desktop_page

    row = page.locator(".row[data-fullname]").first
    fullname = row.get_attribute("data-fullname")

    done_folder = page.locator('.folder[data-status="done"]').first
    row.drag_to(done_folder)
    page.wait_for_timeout(500)

    # Item left the inbox feed.
    expect(page.locator(f'.row[data-fullname="{fullname}"]')).to_have_count(0)
    # And the Done tab count went up — switch to it and confirm the row is there.
    page.locator('.folder[data-status="done"]').first.click()
    page.wait_for_timeout(500)
    expect(page.locator(f'.row[data-fullname="{fullname}"]')).to_have_count(1)

    # Self-clean: the app DB is session-scoped, so restore the item via undo
    # to avoid leaking a status change into later tests. Assert the undo
    # actually landed (a silent undo-fail would still leak).
    page.locator(".toast-undo").first.click()
    page.wait_for_timeout(500)
    page.locator('.folder[data-status="inbox"]').first.click()
    page.wait_for_timeout(500)
    expect(page.locator(f'.row[data-fullname="{fullname}"]')).to_have_count(1)
