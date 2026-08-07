"""Issue #40 — reader opens with triage slide-up when invoked from the deck swipe-up.

Regression: the deck's ↑ gesture must open the reader with the `triage-enter`
class (slide-up from the bottom), and close must clear it so the next open
uses the base entrance. The deep-link path (?open=…&from=triage&enter=up)
shares the same reader code; the deck swipe-up is the gesture the issue names.
"""

import json
import re

import pytest
from playwright.sync_api import expect

pytestmark = pytest.mark.ui


def _deck_item(fullname="reddit:ui_deck_reader"):
    return {
        "fullname": fullname,
        "source": "reddit",
        "source_id": fullname.split(":")[1],
        "kind": "post",
        "title": "Deck reader fixture card",
        "url": "https://www.reddit.com/r/test/comments/ui_deck_reader/",
        "status": "inbox",
        "metadata": {"subreddit": "test", "permalink": "/r/test/comments/ui_deck_reader/"},
    }


def _swipe_up_on_card(page) -> None:
    """Swipe upward on the current .deck-card via synthetic touch PointerEvents."""
    coords = page.evaluate(
        """() => {
          const card = document.querySelector('.deck-card');
          if (!card) return null;
          const b = card.getBoundingClientRect();
          return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
        }"""
    )
    assert coords is not None, "deck card not found"
    page.evaluate(
        """({coords}) => new Promise((resolve) => {
          const card = document.querySelector('.deck-card');
          const fire = (type, x, y) => card.dispatchEvent(new PointerEvent(type, {
            bubbles: true, cancelable: true, composed: true,
            pointerType: 'touch', pointerId: 1, isPrimary: true,
            clientX: x, clientY: y,
          }));
          fire('pointerdown', coords.x, coords.y);
          const dy = -200, steps = 10, stepY = dy / steps;
          let i = 0, cy = coords.y;
          const moveNext = () => {
            i++; cy += stepY;
            fire('pointermove', coords.x, Math.round(cy));
            if (i < steps) setTimeout(moveNext, 16);
            else { fire('pointerup', coords.x, Math.round(cy)); resolve(); }
          };
          moveNext();
        })""",
        {"coords": coords},
    )


def test_deck_swipe_up_opens_reader_with_triage_enter(pixel6_page):
    page = pixel6_page
    page.route(
        "**/random?*",
        lambda route: route.fulfill(
            status=200,
            content_type="application/json",
            body=json.dumps({"items": [_deck_item()]}),
        ),
    )
    page.goto(page.url.split("?")[0] + "?deck=1", wait_until="networkidle")
    expect(page.locator(".deck-card")).to_have_count(1)

    _swipe_up_on_card(page)
    page.wait_for_timeout(300)

    # Reader opened from the deck must carry the slide-up class (issue #40:
    # the ↑ gesture enters from the bottom, not the base right-side entrance).
    reader = page.locator("#reader")
    expect(reader).to_have_class(re.compile(r"\bshow\b"))
    expect(reader).to_have_class(re.compile(r"\btriage-enter\b"))
    expect(reader).to_contain_text("Deck reader fixture card")

    # Close: the triage-enter class must be cleared so the next open rests at
    # the base entrance (off-right), not stuck in slide-up mode. Wait for the
    # 200ms entrance transition to finish first so the close button isn't
    # mid-flight under suite load.
    page.wait_for_timeout(400)
    page.locator("#reader-close").click()
    page.wait_for_timeout(400)
    expect(reader).not_to_have_class(re.compile(r"\bshow\b"))
    expect(reader).not_to_have_class(re.compile(r"\btriage-enter\b"))
