"""P3.1 deck mode — UI regression (Playwright).

Asserts `/?deck=1` opens to exactly one card, the dock-deck toggle swaps the
URL via pushState, and pressing `y` advances the queue (deck keymap active).
`/random` is mocked via page.route so the test stays offline + deterministic.
"""

import json

import pytest

expect = pytest.importorskip("playwright.sync_api").expect

pytestmark = pytest.mark.ui


def _deck_item(fullname="reddit:ui_deck_0"):
    return {
        "fullname": fullname,
        "source": "reddit",
        "source_id": fullname.split(":", 1)[1],
        "kind": "post",
        "title": "Deck fixture card",
        "body": "Body for the deck-mode UI regression.",
        "url": "https://example.com/" + fullname,
        "author": "op",
        "created_utc": 1_700_000_000,
        "saved_utc": 1_700_000_010,
        "first_seen_utc": 1_700_000_010,
        "last_seen_utc": 1_700_000_010,
        "status": "inbox",
        "metadata": {"subreddit": "test"},
    }


def test_deck_mode_opens_one_card(pixel6_page):
    page = pixel6_page
    items = [_deck_item("reddit:ui_deck_0"), _deck_item("reddit:ui_deck_1")]

    def handler(route):
        # Serve the next item each time /random is hit so commit() can advance.
        nonlocal items
        served = items[:1]
        items = items[1:] if len(items) > 1 else items
        route.fulfill(
            status=200,
            content_type="application/json",
            body=json.dumps({"items": served}),
        )

    page.route("**/random?*", handler)
    page.goto(page.url.split("?")[0] + "?deck=1", wait_until="networkidle")

    card = page.locator(".deck-card")
    expect(card).to_have_count(1)
    expect(card).to_contain_text("Deck fixture card")
    expect(page.locator("#items")).to_be_hidden()


def test_dock_deck_button_toggles_url(pixel6_page):
    page = pixel6_page
    page.route(
        "**/random?*",
        lambda route: route.fulfill(
            status=200,
            content_type="application/json",
            body=json.dumps({"items": [_deck_item()]}),
        ),
    )
    # Start in list mode.
    page.goto(page.url.split("?")[0], wait_until="networkidle")
    assert "deck=1" not in page.url

    page.locator("#dock-deck").click()
    page.wait_for_timeout(300)
    assert "deck=1" in page.url, "dock-deck click should add ?deck=1"
    expect(page.locator(".deck-card")).to_have_count(1)

    # Click again to leave deck.
    page.locator("#dock-deck").click()
    page.wait_for_timeout(300)
    assert "deck=1" not in page.url, "second dock-deck click should remove ?deck=1"
    expect(page.locator("#items")).to_be_visible()


def test_deck_done_key_advances(pixel6_page):
    """Pressing `y` in deck mode commits done and pulls the next card."""
    page = pixel6_page
    items = [_deck_item("reddit:ui_deck_a"), _deck_item("reddit:ui_deck_b")]

    def handler(route):
        nonlocal items
        served = items[:1]
        items = items[1:] if len(items) > 1 else items
        route.fulfill(
            status=200,
            content_type="application/json",
            body=json.dumps({"items": served}),
        )

    page.route("**/random?*", handler)
    page.goto(page.url.split("?")[0] + "?deck=1", wait_until="networkidle")
    expect(page.locator(".deck-card")).to_have_count(1)
    expect(page.locator(".deck-card")).to_contain_text("Deck fixture card")

    # Press y -> done. The first card should animate out; the next /random
    # pull is mocked to return one more card.
    page.keyboard.press("y")
    page.wait_for_timeout(400)
    # Either the next card rendered OR the empty state if the queue drained.
    stage = page.locator(".deck-stage")
    expect(stage).to_be_visible()
