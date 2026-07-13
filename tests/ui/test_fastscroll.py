"""#46 mobile fast-scroll handle (right-edge scrub).

Browse scrolls the document; the handle hit-tests near the right edge of
#items and maps finger Y → document.scrollingElement.scrollTop.

`pixel6_page` already navigates to the app base URL.
"""

from __future__ import annotations

import pytest

expect = pytest.importorskip("playwright.sync_api").expect

pytestmark = pytest.mark.ui


def _wait_rows(page) -> None:
    page.wait_for_selector(".row[data-fullname]", timeout=15000)


def _edge_drag(page, *, from_y_ratio: float, to_y_ratio: float, from_left: bool = False) -> None:
    """Synthetic touch pointer scrub on #items near the right (or left) edge."""
    page.evaluate(
        """({fromYRatio, toYRatio, fromLeft}) => new Promise((resolve) => {
          const list = document.getElementById('items');
          if (!list) return resolve(false);
          const w = window.innerWidth;
          const h = window.innerHeight;
          const x = fromLeft ? 20 : (w - 8);
          const y0 = Math.round(h * fromYRatio);
          const y1 = Math.round(h * toYRatio);
          const fire = (type, x, y, target) => target.dispatchEvent(new PointerEvent(type, {
            bubbles: true, cancelable: true, composed: true,
            pointerType: 'touch', pointerId: 7, isPrimary: true,
            clientX: x, clientY: y,
          }));
          fire('pointerdown', x, y0, list);
          const steps = 12;
          let i = 0;
          const step = () => {
            i++;
            const t = i / steps;
            const y = Math.round(y0 + (y1 - y0) * t);
            fire('pointermove', x, y, window);
            if (i < steps) requestAnimationFrame(step);
            else {
              fire('pointerup', x, y1, window);
              resolve(true);
            }
          };
          requestAnimationFrame(step);
        })""",
        {
            "fromYRatio": from_y_ratio,
            "toYRatio": to_y_ratio,
            "fromLeft": from_left,
        },
    )
    page.wait_for_timeout(200)


def test_fastscroll_right_edge_scrubs_document(pixel6_page):
    page = pixel6_page
    _wait_rows(page)

    metrics_before = page.evaluate(
        """() => {
          const se = document.scrollingElement;
          return {
            scrollTop: se.scrollTop,
            max: Math.max(0, se.scrollHeight - window.innerHeight),
          };
        }"""
    )
    assert metrics_before["max"] > 200, "fixture list should make the page scrollable"

    _edge_drag(page, from_y_ratio=0.15, to_y_ratio=0.85)

    after = page.evaluate(
        """() => {
          const se = document.scrollingElement;
          const h = document.querySelector('.fastscroll-handle');
          return {
            scrollTop: se.scrollTop,
            handleExists: !!h,
          };
        }"""
    )
    assert after["handleExists"], "fastscroll handle node should be created on first edge drag"
    assert after["scrollTop"] > metrics_before["scrollTop"] + 80, (
        f"expected document scroll to move substantially, got {after['scrollTop']}"
    )


def test_fastscroll_left_edge_does_not_create_handle(pixel6_page):
    page = pixel6_page
    _wait_rows(page)

    page.evaluate(
        """() => {
          document.querySelectorAll('.fastscroll-handle').forEach((n) => n.remove());
          document.scrollingElement.scrollTop = 0;
        }"""
    )

    before_top = page.evaluate("() => document.scrollingElement.scrollTop")
    _edge_drag(page, from_y_ratio=0.2, to_y_ratio=0.8, from_left=True)
    after = page.evaluate(
        """() => ({
          scrollTop: document.scrollingElement.scrollTop,
          handleExists: !!document.querySelector('.fastscroll-handle'),
        })"""
    )
    assert not after["handleExists"], "left-edge press must not arm the fastscroll handle"
    assert abs(after["scrollTop"] - before_top) < 120


def test_fastscroll_handle_fades_after_release(pixel6_page):
    page = pixel6_page
    _wait_rows(page)
    _edge_drag(page, from_y_ratio=0.2, to_y_ratio=0.6)
    page.wait_for_timeout(450)  # FADE_MS = 300
    active = page.evaluate(
        "() => !!document.querySelector('.fastscroll-handle.active')"
    )
    assert not active, "handle should drop .active after fade timeout"
