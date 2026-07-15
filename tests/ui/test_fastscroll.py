"""#46 mobile fast-scroll bar (Nova Launcher style).

A thin track + proportional handle at the right edge. Dragging the handle
scrubs; the handle follows native scroll when not dragging.
"""

from __future__ import annotations

import pytest

expect = pytest.importorskip("playwright.sync_api").expect

pytestmark = pytest.mark.ui


def _wait_rows(page) -> None:
    page.wait_for_selector(".row[data-fullname]", timeout=15000)


def test_fastscroll_bar_visible_when_list_scrollable(pixel6_page):
    page = pixel6_page
    _wait_rows(page)

    state = page.evaluate(
        """() => {
          const bar = document.querySelector('.fastscroll-bar');
          const handle = document.querySelector('.fastscroll-handle');
          const se = document.scrollingElement;
          return {
            barExists: !!bar,
            barDisplay: bar ? getComputedStyle(bar).display : 'none',
            handleExists: !!handle,
            handleH: handle ? handle.offsetHeight : 0,
            max: Math.max(0, se.scrollHeight - window.innerHeight),
          };
        }"""
    )
    assert state["barExists"], "fastscroll-bar node should exist"
    assert state["handleExists"], "fastscroll-handle node should exist"
    assert state["max"] > 200, "fixture list should make the page scrollable"
    assert state["barDisplay"] != "none", "bar should be visible when list is scrollable"
    assert state["handleH"] > 0, "handle should have height"


def test_fastscroll_handle_proportional_and_follows_scroll(pixel6_page):
    page = pixel6_page
    _wait_rows(page)

    info = page.evaluate(
        """() => {
          const se = document.scrollingElement;
          const max = Math.max(0, se.scrollHeight - window.innerHeight);
          const handle = document.querySelector('.fastscroll-handle');
          return { max, viewH: window.innerHeight, scrollH: se.scrollHeight,
                   handleH: handle ? handle.offsetHeight : 0 };
        }"""
    )
    # Handle should be smaller than the viewport for a long list.
    assert info["handleH"] < info["viewH"], (
        f"handle ({info['handleH']}px) should be < viewport ({info['viewH']}px) for a long list"
    )

    # Scroll the document natively; the handle should move.
    page.evaluate("() => { document.scrollingElement.scrollTop = 600; }")
    page.wait_for_timeout(200)
    top_after = page.evaluate(
        "() => { const h = document.querySelector('.fastscroll-handle');"
        "  const t = h.style.transform || '';"
        "  const m = /translateY\\(([\\d.]+)px\\)/.exec(t);"
        "  return m ? parseFloat(m[1]) : -1; }"
    )
    assert top_after > 0, f"handle should have moved down after scroll; transform top={top_after}"


def test_fastscroll_dragging_handle_scrubs_document(pixel6_page):
    page = pixel6_page
    _wait_rows(page)

    before = page.evaluate("() => document.scrollingElement.scrollTop")
    # Press the handle near the top, drag down to 80% of viewport.
    page.evaluate(
        """() => new Promise((resolve) => {
          const bar = document.querySelector('.fastscroll-bar');
          const handle = document.querySelector('.fastscroll-handle');
          if (!bar || !handle) return resolve(false);
          const hRect = handle.getBoundingClientRect();
          const x = hRect.left + hRect.width / 2;
          const y0 = hRect.top + hRect.height / 2;
          const y1 = window.innerHeight * 0.8;
          const fire = (type, cx, cy) => bar.dispatchEvent(new PointerEvent(type, {
            bubbles: true, cancelable: true, composed: true,
            pointerType: 'touch', pointerId: 9, isPrimary: true,
            clientX: cx, clientY: cy,
          }));
          fire('pointerdown', x, y0);
          const steps = 12, dy = (y1 - y0) / steps;
          let i = 0;
          const step = () => {
            i++;
            fire('pointermove', x, Math.round(y0 + dy * i));
            if (i < steps) requestAnimationFrame(step);
            else { fire('pointerup', x, Math.round(y1)); resolve(true); }
          };
          requestAnimationFrame(step);
        })"""
    )
    page.wait_for_timeout(250)
    after = page.evaluate("() => document.scrollingElement.scrollTop")
    assert after > before + 100, (
        f"dragging handle down should scrub document down; before={before} after={after}"
    )


def test_fastscroll_handle_stays_inside_track(pixel6_page):
    """Regression: JS read --fastscroll-track-top/-bottom from :root (where
    they aren't defined) instead of the bar, so handle math used a full-viewport
    track and drifted ~120px below the visual track, overflowing its bottom."""
    page = pixel6_page
    _wait_rows(page)

    page.evaluate(
        "() => { const se = document.scrollingElement;"
        "  se.scrollTop = se.scrollHeight; }"
    )
    page.wait_for_timeout(250)
    rects = page.evaluate(
        """() => {
          const t = document.querySelector('.fastscroll-track').getBoundingClientRect();
          const h = document.querySelector('.fastscroll-handle').getBoundingClientRect();
          return { trackTop: t.top, trackBottom: t.bottom,
                   handleTop: h.top, handleBottom: h.bottom };
        }"""
    )
    assert rects["handleBottom"] <= rects["trackBottom"] + 1, (
        f"handle must not overflow track bottom at max scroll: {rects}"
    )
    assert rects["handleTop"] >= rects["trackTop"] - 1, (
        f"handle must not overflow track top: {rects}"
    )


def test_fastscroll_track_tap_maps_full_range(pixel6_page):
    """Regression: with the misread track offsets, a tap at the visual track
    top could never reach scrollTop 0 (and bottom never reached max)."""
    page = pixel6_page
    _wait_rows(page)

    res = page.evaluate(
        """() => {
          const bar = document.querySelector('.fastscroll-bar');
          const track = document.querySelector('.fastscroll-track');
          const se = document.scrollingElement;
          const r = track.getBoundingClientRect();
          const x = r.left + r.width / 2;
          const fire = (type, cy, pid) => bar.dispatchEvent(new PointerEvent(type, {
            bubbles: true, cancelable: true, composed: true,
            pointerType: 'touch', pointerId: pid, isPrimary: true,
            clientX: x, clientY: cy,
          }));
          const max = Math.max(0, se.scrollHeight - window.innerHeight);
          fire('pointerdown', r.bottom - 1, 11);
          fire('pointerup', r.bottom - 1, 11);
          const atBottom = se.scrollTop;
          fire('pointerdown', r.top + 1, 12);
          fire('pointerup', r.top + 1, 12);
          const atTop = se.scrollTop;
          return { max, atBottom, atTop };
        }"""
    )
    assert res["atBottom"] >= res["max"] - 2, (
        f"track-bottom tap should reach max scroll: {res}"
    )
    assert res["atTop"] <= 2, f"track-top tap should reach scrollTop 0: {res}"


def test_fastscroll_scrub_pauses_infinite_scroll(pixel6_page):
    """Regression (docs/bugs/46-fastscroll-scrub-loads.md): scrubbing deep used
    to fire a cascade of /items?offset=… page loads mid-drag. Loads must be
    paused while dragging; at most one may fire after the settle window."""
    page = pixel6_page
    _wait_rows(page)

    offset_loads: list[str] = []
    page.on(
        "request",
        lambda r: offset_loads.append(r.url)
        if "/items" in r.url and "offset=" in r.url and "offset=0" not in r.url
        else None,
    )

    # Drag the handle from its current spot to the track bottom (deep scrub).
    page.evaluate(
        """() => new Promise((resolve) => {
          const bar = document.querySelector('.fastscroll-bar');
          const track = document.querySelector('.fastscroll-track');
          const handle = document.querySelector('.fastscroll-handle');
          const hRect = handle.getBoundingClientRect();
          const tRect = track.getBoundingClientRect();
          const x = hRect.left + hRect.width / 2;
          const y0 = hRect.top + hRect.height / 2;
          const y1 = tRect.bottom - 2;
          const fire = (type, cx, cy) => bar.dispatchEvent(new PointerEvent(type, {
            bubbles: true, cancelable: true, composed: true,
            pointerType: 'touch', pointerId: 21, isPrimary: true,
            clientX: cx, clientY: cy,
          }));
          fire('pointerdown', x, y0);
          const steps = 16, dy = (y1 - y0) / steps;
          let i = 0;
          const step = () => {
            i++;
            fire('pointermove', x, Math.round(y0 + dy * i));
            if (i < steps) requestAnimationFrame(step);
            else { fire('pointerup', x, Math.round(y1)); resolve(true); }
          };
          requestAnimationFrame(step);
        })"""
    )
    # Mid-drag / pre-settle: no offset page loads at all.
    mid_drag = list(offset_loads)
    assert not mid_drag, f"no /items offset loads may fire mid-scrub: {mid_drag}"

    # After the settle window exactly one catch-up load fires (sentinel
    # re-check) — the fixture seeds >50 inbox rows so a second page exists.
    page.wait_for_timeout(600)
    assert len(offset_loads) == 1, (
        f"expected exactly one catch-up load after settle, got {offset_loads}"
    )


def test_fastscroll_hidden_on_desktop(desktop_page):
    page = desktop_page
    page.wait_for_selector(".row[data-fullname]", timeout=15000)
    # On desktop the install is a no-op (isDesktopPointer bails), so the node
    # is absent entirely — which is the correct desktop behavior.
    display = page.evaluate(
        "() => { const b = document.querySelector('.fastscroll-bar');"
        "  return b ? getComputedStyle(b).display : 'absent'; }"
    )
    assert display in ("none", "absent"), (
        f"fastscroll bar must be hidden or absent on desktop, got display={display}"
    )
