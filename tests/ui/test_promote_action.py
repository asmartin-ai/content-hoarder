"""PKMS promote action — UI (Spec 15 §7, ADR 0027).

The browse row menu's Promote affordance must POST the bridge route and
surface the outcome: snackbar the PKMS response body on success, toast
data.error on failure; a successful receipt hides the Promote button on the
next menu open. The unconfigured path is the first contract (the bridge is
a no-op until PKMS_CAPTURE_URL/TOKEN exist).

The menu is opened via a synthetic contextmenu event on the row (the native
right-click gesture is the browser's; the listener is the unit under test).
The success path stubs the deliver seam exactly like the offline unit suite —
no live PKMS.
"""

import pytest

expect = pytest.importorskip("playwright.sync_api").expect

pytestmark = pytest.mark.ui

FULLNAME = "reddit:ui_seed"
PROMOTE_BTN = '.relay-btn[data-relay="promote"]'


def _open_row_menu(page):
    # Other UI suites share this session's seeded DB and may have pulled our
    # row out of the inbox (they drag the "first row"). Restore status + reload
    # so the row is guaranteed present and menu-open is deterministic.
    page.evaluate(
        """(fn) => fetch('/items/' + encodeURIComponent(fn) + '/status',
            {method: 'POST',
             headers: {'Content-Type': 'application/json'},
             body: JSON.stringify({status: 'inbox'})}).then(r => r.ok)""",
        FULLNAME,
    )
    page.reload(wait_until="networkidle")
    row = page.locator(f'.row[data-fullname="{FULLNAME}"]').first
    expect(row).to_be_visible()
    row.dispatch_event("contextmenu")
    # Every row carries an (initially hidden) relay strip; scope to this row.
    return row.locator(PROMOTE_BTN)


def test_promote_unconfigured_toasts_error(desktop_page, monkeypatch):
    # Force the unconfigured state even if this machine exports the vars.
    monkeypatch.setenv("PKMS_CAPTURE_URL", "")
    monkeypatch.setenv("PKMS_CAPTURE_TOKEN", "")

    page = desktop_page
    btn = _open_row_menu(page)
    expect(btn).to_be_visible()
    btn.click()
    expect(page.locator("#toast")).to_contain_text("PKMS not configured")


def test_promote_configured_snackbars_receipt_and_hides_button(desktop_page, monkeypatch):
    from content_hoarder.bridge import pkms

    monkeypatch.setenv("PKMS_CAPTURE_URL", "http://127.0.0.1:9")
    monkeypatch.setenv("PKMS_CAPTURE_TOKEN", "tok")
    monkeypatch.setattr(pkms, "deliver", lambda env: "saved \u2713 inbox/ui-promote.md")

    page = desktop_page
    btn = _open_row_menu(page)
    expect(btn).to_be_visible()
    btn.click()
    expect(page.locator("#toast")).to_contain_text("saved \u2713 inbox/ui-promote.md")

    # Re-open the menu: the receipt hides the Promote affordance (re-promote no-op).
    btn = _open_row_menu(page)
    expect(btn).to_be_hidden()
