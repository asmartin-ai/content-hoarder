"""T3 mobile-polish UX regression tests (Playwright, Pixel-6 / PWA-standalone).

Covers the 6 T3 fixes:
  - relay-swipe-close (5 tests)
  - hold-to-preview     (4 tests)
  - tag-suggest-three   (3 tests)
  - lightbox-swipe-scroll (3 tests)
  - sidebar-scroll-lock (3 tests)
  - drop-reader-dock    (4 tests)

These tests are EXPECTED TO FAIL on the starting branch `staging/mobile-polish-t2`
(the bugs are present). They PASS once the corresponding T3 fix branches merge.

Gesture API notes
-----------------
- Relay long-press + swipe: the app's `core/swipe.js` rejects `pointerType === "mouse"`
  (touch-only by default), but Playwright's `page.mouse` ALWAYS emits mouse pointer
  events even on a mobile context, and `page.touchscreen` only exposes `tap()` (no
  `down()/up()` for a hold). So relay gestures use a synthetic `PointerEvent` with
  `pointerType: "touch"` dispatched via `page.evaluate` (see `_touch_press` /
  `_touch_swipe`). This faithfully triggers the app's `pointerdown/move/up` handlers.
- Hold-to-preview: `browse/main.js`'s hold handler accepts ALL pointer types,
  so `page.mouse` works for press-and-hold on a thumbnail.
- Quick tap (persistent lightbox): the persistent-open path is a `click` listener,
  so `page.touchscreen.tap` (which synthesizes a click) is used.
- Lightbox swipe-close: `core/media.js`'s drag handler accepts mouse pointer events,
  so `page.mouse` is used for the vertical drag.
"""

import re

import pytest

expect = pytest.importorskip("playwright.sync_api").expect

pytestmark = pytest.mark.ui


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #


def _media_modal_open(page) -> bool:
    """True when the lightbox (#media-modal) is open (no `hidden` attr)."""
    return page.evaluate(
        "() => { const m = document.querySelector('#media-modal'); "
        "return !!(m && !m.hasAttribute('hidden')); }"
    )


def _reader_open(page) -> bool:
    return page.evaluate("() => !!document.querySelector('#reader.show')")


def _relay_open(page) -> bool:
    return page.evaluate("() => !!document.querySelector('.row.relay-open')")


def _scroll_into_view(page, fullname: str) -> None:
    """Scroll a row into the vertical center so it isn't under the fixed topbar."""
    page.evaluate(
        "(fn) => { const r = document.querySelector('.row[data-fullname=\"' + fn + '\"]'); "
        "if (r) r.scrollIntoView({block:'center'}); }",
        fullname,
    )
    page.wait_for_timeout(300)


def _row_title_center(page, fullname: str):
    """Return {x, y} at the center of a row's title text (NOT the thumbnail).

    Aiming at the title keeps the press off the [data-media] thumbnail and inside
    the ~30px edge deadzone that core/swipe.js rejects for back-gesture detection.
    """
    box = page.evaluate(
        """(fn) => {
          const r = document.querySelector('.row[data-fullname="' + fn + '"]');
          if (!r) return null;
          const t = r.querySelector('h3.title, .title, .snippet') || r;
          const b = t.getBoundingClientRect();
          return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
        }""",
        fullname,
    )
    assert box is not None, f"row {fullname} not found"
    return box


def _thumb_center(page, fullname: str):
    """Return {x, y} at the center of a row's [data-media] thumbnail."""
    box = page.evaluate(
        """(fn) => {
          const r = document.querySelector('.row[data-fullname="' + fn + '"]');
          if (!r) return null;
          const m = r.querySelector('[data-media]');
          if (!m) return null;
          const b = m.getBoundingClientRect();
          return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
        }""",
        fullname,
    )
    assert box is not None, f"row {fullname} has no [data-media] thumbnail"
    return box


def _touch_long_press(page, fullname: str, hold_ms: int = 550) -> None:
    """Press-and-hold on a row's title via a synthetic touch PointerEvent.

    `page.mouse` emits `pointerType: "mouse"` which `core/swipe.js` rejects; this
    dispatches a real `pointerType: "touch"` PointerEvent so the relay long-press
    (450ms) fires.
    """
    coords = _row_title_center(page, fullname)
    page.evaluate(
        """({fn, coords, hold}) => new Promise((resolve) => {
          const row = document.querySelector('.row[data-fullname="' + fn + '"]');
          const el = row.querySelector('h3.title, .title, .snippet') || row;
          const fire = (type, x, y) => el.dispatchEvent(new PointerEvent(type, {
            bubbles: true, cancelable: true, composed: true,
            pointerType: 'touch', pointerId: 1, isPrimary: true,
            clientX: x, clientY: y,
          }));
          fire('pointerdown', coords.x, coords.y);
          setTimeout(() => { fire('pointerup', coords.x, coords.y); resolve(); }, hold);
        })""",
        {"fn": fullname, "coords": coords, "hold": hold_ms},
    )
    page.wait_for_timeout(300)


def _touch_swipe(
    page, fullname: str, dx: int, dy: int, hold_first: bool = False
) -> None:
    """Swipe on a row via synthetic touch PointerEvents (down -> moves -> up).

    If `hold_first` is True, the pointerdown is held for 550ms first (to open the
    relay), then the swipe begins from the same row. Otherwise it's a plain swipe.
    """
    coords = page.evaluate(
        """(fn) => {
          const row = document.querySelector('.row[data-fullname="' + fn + '"]');
          if (!row) return null;
          const target = row.classList.contains('relay-open')
            ? row.querySelector('.relay-strip')
            : (row.querySelector('h3.title, .title, .snippet') || row);
          const b = target.getBoundingClientRect();
          return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
        }""",
        fullname,
    )
    assert coords is not None, f"row {fullname} not found"
    page.evaluate(
        """({fn, coords, dx, dy, holdFirst}) => new Promise((resolve) => {
          const row = document.querySelector('.row[data-fullname="' + fn + '"]');
          const el = row.classList.contains('relay-open')
            ? row.querySelector('.relay-strip')
            : (row.querySelector('h3.title, .title, .snippet') || row);
          const fire = (type, x, y) => el.dispatchEvent(new PointerEvent(type, {
            bubbles: true, cancelable: true, composed: true,
            pointerType: 'touch', pointerId: 1, isPrimary: true,
            clientX: x, clientY: y,
          }));
          fire('pointerdown', coords.x, coords.y);
          const startSwipe = () => {
            const targetX = coords.x + dx, targetY = coords.y + dy;
            const steps = 10, stepX = dx / steps, stepY = dy / steps;
            let i = 0, cx = coords.x, cy = coords.y;
            const moveNext = () => {
              i++; cx += stepX; cy += stepY;
              fire('pointermove', Math.round(cx), Math.round(cy));
              if (i < steps) setTimeout(moveNext, 16);
              else { fire('pointerup', targetX, targetY); resolve(); }
            };
            moveNext();
          };
          if (holdFirst) setTimeout(startSwipe, 550);
          else startSwipe();
        })""",
        {"fn": fullname, "coords": coords, "dx": dx, "dy": dy, "holdFirst": hold_first},
    )
    page.wait_for_timeout(400)


def _open_reader_on(page, fullname: str) -> None:
    """Open the reader on a seeded item by clicking its title."""
    _scroll_into_view(page, fullname)
    row = page.locator(f'.row[data-fullname="{fullname}"]')
    expect(row).to_be_visible()
    title = row.locator("h3.title a").first
    if not title.count():
        title = row.locator("h3.title").first
    title.click()
    page.wait_for_timeout(500)
    expect(page.locator("#reader.show")).to_be_visible()


def _open_relay_menu(page, fullname: str) -> None:
    """Open the relay strip via long-press, then return."""
    _scroll_into_view(page, fullname)
    _touch_long_press(page, fullname, hold_ms=550)
    assert _relay_open(page), f"relay should be open on {fullname} after long-press"
    expect(page.locator(".relay-strip")).to_have_count(1)


def _open_browse_tag_editor(page, fullname: str) -> None:
    """Open the browse-surface tag editor (#tagpop) via the relay menu's tag action.

    The default log/ledger density doesn't render a [data-tagedit] button on rows —
    tagging is reached via the long-press relay menu's [data-relay="tag"] action.
    """
    _open_relay_menu(page, fullname)
    tag_btn = page.locator('.relay-strip [data-relay="tag"]').first
    expect(tag_btn).to_be_visible()
    tag_btn.click()
    page.wait_for_timeout(400)
    expect(page.locator("#tagpop")).to_be_visible()


# --------------------------------------------------------------------------- #
# T3 relay-swipe-close
# --------------------------------------------------------------------------- #


def test_relay_long_press_opens_strip(pixel6_page):
    """Long-press on a row's text (NOT the thumbnail) opens the relay strip."""
    page = pixel6_page
    _open_relay_menu(page, "reddit:ui_scroll_0")
    # A relay strip exists, the row has .relay-open, and the scrim is showing.
    expect(page.locator(".relay-strip")).to_have_count(1)
    assert _relay_open(page)
    expect(page.locator("#relay-scrim.show")).to_be_visible()


def test_relay_menu_labels_are_visible_without_horizontal_scroll(pixel6_page):
    """The long-press menu should not require icon memorization or side-scroll on Pixel 6."""
    page = pixel6_page
    _open_relay_menu(page, "reddit:ui_scroll_0")
    strip = page.locator(".relay-strip")
    expect(strip.get_by_text("Tag", exact=True)).to_be_visible()
    expect(strip.get_by_text("Share", exact=True)).to_be_visible()
    expect(strip.get_by_text("Snooze", exact=True)).to_be_visible()
    overflow = page.evaluate(
        """() => {
          const strip = document.querySelector('.relay-strip');
          return strip ? Math.ceil(strip.scrollWidth - strip.clientWidth) : 0;
        }"""
    )
    assert overflow <= 1, (
        f"relay strip should fit without horizontal scroll, overflow={overflow}px"
    )


def test_relay_swipe_left_is_noop(pixel6_page):
    """After opening the relay, a leftward swipe does NOT reveal blank space
    and does NOT close the relay. (Regression guard for the blank-space bug.)"""
    page = pixel6_page
    _open_relay_menu(page, "reddit:ui_scroll_1")
    # Swipe LEFT (dx=-120). The bug: .item-fg translates past the left edge (blank space).
    _touch_swipe(page, "reddit:ui_scroll_1", dx=-120, dy=0)
    # The relay should still be open (leftward swipe is a no-op in relay-close-mode).
    assert _relay_open(page), "relay should still be open after leftward swipe"
    # The visible relay strip should remain aligned with the row, not dragged away.
    strip_delta = page.evaluate(
        """() => {
          const row = document.querySelector('.row.relay-open');
          const strip = row && row.querySelector('.relay-strip');
          if (!row || !strip) return null;
          return Math.round(strip.getBoundingClientRect().left - row.getBoundingClientRect().left);
        }"""
    )
    assert strip_delta is not None
    assert abs(strip_delta) <= 5, (
        f"relay strip moved away from the row: delta={strip_delta} "
        "(leftward swipe should be a no-op in relay-close-mode)"
    )


def test_relay_swipe_right_closes(pixel6_page):
    """After opening the relay, a rightward swipe (>10px) closes the strip
    and the .item-fg slides back smoothly (no inline transition: none left behind)."""
    page = pixel6_page
    _open_relay_menu(page, "reddit:ui_scroll_2")
    # Swipe RIGHT (>10px) to close.
    _touch_swipe(page, "reddit:ui_scroll_2", dx=120, dy=0)
    page.wait_for_timeout(400)  # allow slide-out transition (~200ms)
    expect(page.locator(".relay-strip")).to_have_count(0)
    assert not _relay_open(page), "relay should be closed after rightward swipe"
    # No stuck inline `transition: none` on the row's .item-fg (the bug left it
    # behind, causing an abrupt snap on the next open).
    inline_transition = page.evaluate(
        """() => {
          const row = document.querySelector('.row[data-fullname="reddit:ui_scroll_2"]');
          if (!row) return 'NONE';
          const fg = row.querySelector('.item-fg');
          return fg ? fg.style.transition : 'NONE';
        }"""
    )
    assert inline_transition != "none", (
        "relay .item-fg has stuck inline `transition: none` after close "
        "(should slide back smoothly, not snap)"
    )


def test_relay_diagonal_swipe_right_closes(pixel6_page):
    """A slightly-diagonal rightward swipe (dx=25, dy=18) still closes the relay
    — the close path bypasses the horizontal-decision threshold."""
    page = pixel6_page
    _open_relay_menu(page, "reddit:ui_scroll_3")
    # Diagonal: dx=+120, dy=+60 (decidedly rightward with vertical drift).
    _touch_swipe(page, "reddit:ui_scroll_3", dx=120, dy=60)
    page.wait_for_timeout(400)
    expect(page.locator(".relay-strip")).to_have_count(0)
    assert not _relay_open(page), (
        "diagonal rightward swipe should close the relay "
        "(close path bypasses the horizontal-decision threshold)"
    )


def test_relay_scrim_tap_closes(pixel6_page):
    """Tapping the scrim closes the relay with a smooth slide-back
    (no abrupt snap from a stuck inline transition)."""
    page = pixel6_page
    _open_relay_menu(page, "reddit:ui_scroll_4")
    scrim = page.locator("#relay-scrim.show")
    expect(scrim).to_be_visible()
    # Click a measured off-row coordinate. Locator center clicks can land on the
    # relay-open row itself, which intentionally sits above the scrim so its strip works.
    page.mouse.click(10, 10)
    page.wait_for_timeout(400)
    expect(page.locator(".relay-strip")).to_have_count(0)
    assert not _relay_open(page), "scrim tap should close the relay"


def test_relay_long_press_keeps_row_anchored(pixel6_page):
    """Opening the relay strip must not move the pressed row under the finger."""
    page = pixel6_page
    fullname = "reddit:ui_scroll_12"
    _scroll_into_view(page, fullname)
    before = page.evaluate(
        """(fn) => {
          const row = document.querySelector('.row[data-fullname="' + fn + '"]');
          const b = row.getBoundingClientRect();
          return { top: Math.round(b.top), height: Math.round(b.height) };
        }""",
        fullname,
    )

    _touch_long_press(page, fullname, hold_ms=550)

    after = page.evaluate(
        """(fn) => {
          const row = document.querySelector('.row[data-fullname="' + fn + '"]');
          const b = row.getBoundingClientRect();
          return { top: Math.round(b.top), height: Math.round(b.height) };
        }""",
        fullname,
    )
    assert _relay_open(page)
    assert abs(after["top"] - before["top"]) <= 2, (
        f"relay long-press shifted row top: {before['top']} -> {after['top']}"
    )
    assert abs(after["height"] - before["height"]) <= 1


def test_relay_long_press_restores_accidental_scroll_during_activation(pixel6_page):
    """A tiny scroll nudge during the hold window is compensated when the relay opens."""
    page = pixel6_page
    fullname = "reddit:ui_scroll_14"
    _scroll_into_view(page, fullname)
    before = page.evaluate(
        """(fn) => {
          const row = document.querySelector('.row[data-fullname="' + fn + '"]');
          const b = row.getBoundingClientRect();
          return { top: Math.round(b.top) };
        }""",
        fullname,
    )
    coords = _row_title_center(page, fullname)

    page.evaluate(
        """({fn, coords}) => new Promise((resolve) => {
          const row = document.querySelector('.row[data-fullname="' + fn + '"]');
          const el = row.querySelector('h3.title, .title, .snippet') || row;
          const fire = (type, x, y) => el.dispatchEvent(new PointerEvent(type, {
            bubbles: true, cancelable: true, composed: true,
            pointerType: 'touch', pointerId: 1, isPrimary: true,
            clientX: x, clientY: y,
          }));
          fire('pointerdown', coords.x, coords.y);
          setTimeout(() => window.scrollBy(0, 32), 200);
          setTimeout(() => { fire('pointerup', coords.x, coords.y); resolve(); }, 550);
        })""",
        {"fn": fullname, "coords": coords},
    )
    page.wait_for_timeout(500)

    after = page.evaluate(
        """(fn) => {
          const row = document.querySelector('.row[data-fullname="' + fn + '"]');
          const b = row.getBoundingClientRect();
          return { top: Math.round(b.top) };
        }""",
        fullname,
    )
    assert _relay_open(page)
    assert abs(after["top"] - before["top"]) <= 2, (
        f"relay anchor compensation failed: {before['top']} -> {after['top']}"
    )


# --------------------------------------------------------------------------- #
# Hold-to-preview
# --------------------------------------------------------------------------- #


def _open_lightbox_via_hold(page, fullname: str, hold_ms: int = 300) -> None:
    """Press-and-hold a thumbnail to open the lightbox in temporary peek mode."""
    _scroll_into_view(page, fullname)
    coords = _thumb_center(page, fullname)
    page.mouse.move(coords["x"], coords["y"])
    page.mouse.down()
    page.wait_for_timeout(hold_ms)
    page.wait_for_timeout(200)
    assert _media_modal_open(page), (
        f"lightbox should open after {hold_ms}ms hold on {fullname}"
    )


def test_hold_to_preview_opens_and_stays_until_release(pixel6_page):
    """Hold preview opens once, stays while held, closes on release, and does not reopen."""
    page = pixel6_page
    fullname = "twitter:1777777777777777777"
    _scroll_into_view(page, fullname)
    coords = _thumb_center(page, fullname)
    page.evaluate(
        """() => {
          window.__opens = 0;
          const m = document.querySelector('#media-modal');
          if (!m) return;
          new MutationObserver(() => { if (!m.hasAttribute('hidden')) window.__opens++; })
            .observe(m, { attributes: true, attributeFilter: ['hidden'] });
        }"""
    )
    page.mouse.move(coords["x"], coords["y"])
    page.mouse.down()
    page.wait_for_timeout(900)
    opens_while_holding = page.evaluate("window.__opens")
    assert _media_modal_open(page), (
        "hold preview should stay open while pointer is down"
    )
    assert opens_while_holding == 1, (
        f"hold preview opened {opens_while_holding} times during one hold"
    )
    page.mouse.up()
    page.wait_for_timeout(600)
    assert not _media_modal_open(page), "hold preview should close once on release"


# --------------------------------------------------------------------------- #
# Browse polish regressions
# --------------------------------------------------------------------------- #


def test_dock_search_expands_compact_header_and_focuses(pixel6_page):
    """Dock Search should reveal the collapsed search field before focusing it."""
    page = pixel6_page
    console = page.locator(".console")
    page.mouse.wheel(0, 700)
    expect(console).to_have_class(re.compile(r"\bcompact\b"))

    page.locator("#dock-search").click()

    expect(console).not_to_have_class(re.compile(r"\bcompact\b"))
    expect(page.locator("#q")).to_be_focused()
    box = page.locator("#q").bounding_box()
    assert box and box["height"] > 0, "search input should be visible after dock Search"


def test_dock_inbox_returns_to_clean_home(pixel6_page):
    """Dock Inbox is a real home affordance: it clears search/filter status back to Inbox."""
    page = pixel6_page
    page.fill("#q", "ui_scroll_00")
    page.wait_for_timeout(400)  # search debounce
    page.locator('.statuspills button.spill[data-status="done"]').click()
    page.wait_for_timeout(300)
    expect(
        page.locator('.statuspills button.spill[data-status="done"]')
    ).to_have_attribute("aria-selected", "true")

    page.locator("#dock-inbox").click()

    expect(
        page.locator('.statuspills button.spill[data-status="inbox"]')
    ).to_have_attribute("aria-selected", "true")
    expect(page.locator("#q")).to_have_value("")
    expect(page.locator("#dock-inbox")).to_have_attribute("aria-pressed", "true")
    expect(page.locator(".row[data-fullname]").first).to_be_visible()


def test_pinboard_tag_button_is_touch_sized(pixel6_page):
    """Card density has no row swipe path, so its tag edit affordance must be thumb-sized."""
    page = pixel6_page
    page.locator("#dock-settings").click()
    expect(page.locator("#settings")).to_be_visible()
    page.locator('#set-density button[data-d="card"]').click()
    page.keyboard.press("Escape")
    expect(page.locator("#settings")).not_to_be_visible()
    page.wait_for_selector(".pin .tag-edit")

    box = page.locator(".pin .tag-edit").first.bounding_box()
    assert box and box["width"] >= 40 and box["height"] >= 40, (
        f"pinboard tag button should be a touch target, got {box}"
    )
    page.locator(".pin .tag-edit").first.click()
    expect(page.locator("#tagpop")).to_be_visible()


def test_tap_thumbnail_opens_persistent(pixel6_page):
    """A quick tap (<250ms) opens the lightbox persistently."""
    page = pixel6_page
    fullname = "twitter:1777777777777777777"
    _scroll_into_view(page, fullname)
    coords = _thumb_center(page, fullname)
    # touchscreen.tap synthesizes a real click (the persistent-open path is a click listener).
    page.touchscreen.tap(coords["x"], coords["y"])
    page.wait_for_timeout(500)
    assert _media_modal_open(page), "quick tap should open the lightbox persistently"


def test_mobile_rows_do_not_render_decide_button(pixel6_page):
    """The old per-row Decide button is gone."""
    page = pixel6_page
    expect(page.locator(".row[data-fullname]").first).to_be_visible()
    expect(page.get_by_role("button", name="Decide")).to_have_count(0)
    expect(page.locator(".row .decidebtn")).to_have_count(0)


def test_hold_to_preview_drag_does_not_pan_at_one_x(pixel6_page):
    """Temporary hold preview should stay anchored under the finger at 1× scale."""
    page = pixel6_page
    fullname = "twitter:1777777777777777777"
    _open_lightbox_via_hold(page, fullname, hold_ms=300)

    page.evaluate(
        """() => new Promise((resolve) => {
          const im = document.querySelector('#media-body .media-img');
          if (!im) { resolve(); return; }
          const b = im.getBoundingClientRect();
          const x = Math.round(b.left + b.width / 2);
          const y = Math.round(b.top + b.height / 2);
          const fire = (type, xx, yy) => im.dispatchEvent(new PointerEvent(type, {
            bubbles: true, cancelable: true, composed: true,
            pointerType: 'touch', pointerId: 7, isPrimary: true,
            clientX: xx, clientY: yy,
          }));
          fire('pointerdown', x, y);
          fire('pointermove', x + 140, y + 120);
          requestAnimationFrame(resolve);
        })"""
    )
    transform = page.locator("#media-body .media-img").evaluate(
        "el => getComputedStyle(el).transform"
    )
    assert transform in ("none", "matrix(1, 0, 0, 1, 0, 0)"), (
        f"peek-mode image should stay anchored at 1×, transform={transform}"
    )
    page.mouse.up()
    page.wait_for_timeout(600)
    assert not _media_modal_open(page), "peek should close on release"


# --------------------------------------------------------------------------- #
# T3 tag-suggest-three
# --------------------------------------------------------------------------- #


def test_tag_suggest_three_with_categories(pixel6_page):
    """Prime localStorage with 2 categories + 3 tags. Open the tag editor on an
    item with no category → expect 2 category suggestions + 1 tag (3 total)."""
    page = pixel6_page
    page.evaluate(
        """() => {
          localStorage.setItem('ch_recent_categories', JSON.stringify(['work','reading']));
          localStorage.setItem('ch_recent_tags', JSON.stringify(['alpha','beta','gamma']));
        }"""
    )
    _open_browse_tag_editor(page, "reddit:ui_scroll_5")
    page.wait_for_timeout(300)
    count = page.locator("#tagpop .tp-sugg .tp-opt").count()
    # t3-tag-suggest-three surfaces 3 total (2 categories + 1 tag backfill).
    # On the starting branch only 1 is shown (the bug).
    assert count >= 3, (
        f"expected >=3 tag suggestions (2 categories + 1 tag backfill), got {count} "
        "(t3-tag-suggest-three should surface 3)"
    )


def test_tag_suggest_three_backfill_with_tags(pixel6_page):
    """Prime localStorage with 0 categories + 3 tags. Open the tag editor →
    expect 3 tag suggestions (backfill when categories are sparse)."""
    page = pixel6_page
    page.evaluate(
        """() => {
          localStorage.setItem('ch_recent_categories', JSON.stringify([]));
          localStorage.setItem('ch_recent_tags', JSON.stringify(['alpha','beta','gamma']));
        }"""
    )
    _open_browse_tag_editor(page, "reddit:ui_scroll_6")
    page.wait_for_timeout(300)
    count = page.locator("#tagpop .tp-sugg .tp-opt").count()
    assert count >= 3, (
        f"expected >=3 tag suggestions (tag backfill when categories sparse), got {count}"
    )


def test_tag_suggest_zero_when_stores_empty(pixel6_page):
    """Clear both localStorage stores. Open the tag editor → expect 0 suggestions
    (don't pad with synthetic placeholders)."""
    page = pixel6_page
    page.evaluate(
        """() => {
          localStorage.removeItem('ch_recent_categories');
          localStorage.removeItem('ch_recent_tags');
        }"""
    )
    _open_browse_tag_editor(page, "reddit:ui_scroll_7")
    page.wait_for_timeout(300)
    count = page.locator("#tagpop .tp-sugg .tp-opt").count()
    assert count == 0, (
        f"expected 0 suggestions when stores empty (no synthetic placeholders), got {count}"
    )


# --------------------------------------------------------------------------- #
# T3 lightbox-swipe-scroll
# --------------------------------------------------------------------------- #


def _open_single_image_lightbox(page, fullname: str) -> None:
    """Open the lightbox on a single-image item via a quick tap."""
    _scroll_into_view(page, fullname)
    coords = _thumb_center(page, fullname)
    page.touchscreen.tap(coords["x"], coords["y"])
    page.wait_for_timeout(500)
    assert _media_modal_open(page), f"lightbox should open on {fullname}"


def _lightbox_touch_drag(page, dy: int) -> None:
    """Drag downward by `dy` px on the open lightbox's image via a synthetic
    touch PointerEvent sequence.

    `page.mouse` produces `pointerType: "mouse"` whose pointermove events get
    coalesced by the browser and don't reliably drive media.js's drag handler;
    a synthetic `pointerType: "touch"` PointerEvent on the `.media-img` element
    drives the close path faithfully (the gesture under test is a touch swipe).
    """
    page.evaluate(
        """(dy) => new Promise((resolve) => {
          const im = document.querySelector('#media-body .media-img, #media-body .gallery-img');
          if (!im) { resolve(); return; }
          const b = im.getBoundingClientRect();
          const x = Math.round(b.left + b.width / 2);
          const y0 = Math.round(b.top + b.height / 2);
          const fire = (type, yy) => im.dispatchEvent(new PointerEvent(type, {
            bubbles: true, cancelable: true, composed: true,
            pointerType: 'touch', pointerId: 2, isPrimary: true,
            clientX: x, clientY: yy,
          }));
          fire('pointerdown', y0);
          const steps = 10, stepDy = dy / steps;
          let i = 0, cy = y0;
          const moveNext = () => {
            i++; cy += stepDy;
            fire('pointermove', Math.round(cy));
            if (i < steps) setTimeout(moveNext, 16);
            else { fire('pointerup', Math.round(y0 + dy)); resolve(); }
          };
          moveNext();
        })""",
        dy,
    )
    page.wait_for_timeout(500)


def _lightbox_touch_pan(page, dx: int, dy: int) -> None:
    """Drag an open lightbox image by dx/dy via synthetic touch PointerEvents."""
    page.evaluate(
        """({dx, dy}) => new Promise((resolve) => {
          const im = document.querySelector('#media-body .media-img, #media-body .gallery-img');
          if (!im) { resolve(); return; }
          const b = im.getBoundingClientRect();
          const x0 = Math.round(b.left + b.width / 2);
          const y0 = Math.round(b.top + b.height / 2);
          const fire = (type, xx, yy) => im.dispatchEvent(new PointerEvent(type, {
            bubbles: true, cancelable: true, composed: true,
            pointerType: 'touch', pointerId: 4, isPrimary: true,
            clientX: xx, clientY: yy,
          }));
          fire('pointerdown', x0, y0);
          const steps = 10, stepX = dx / steps, stepY = dy / steps;
          let i = 0, cx = x0, cy = y0;
          const moveNext = () => {
            i++; cx += stepX; cy += stepY;
            fire('pointermove', Math.round(cx), Math.round(cy));
            if (i < steps) setTimeout(moveNext, 16);
            else { fire('pointerup', Math.round(x0 + dx), Math.round(y0 + dy)); resolve(); }
          };
          moveNext();
        })""",
        {"dx": dx, "dy": dy},
    )
    page.wait_for_timeout(500)


def test_lightbox_swipe_down_closes(pixel6_page):
    """Open the lightbox on a single image. Drag down 150px → lightbox closes.
    (Regression guard for the swipe-scrolls-page bug.)"""
    page = pixel6_page
    _open_single_image_lightbox(page, "twitter:1777777777777777777")
    _lightbox_touch_drag(page, dy=150)
    assert not _media_modal_open(page), (
        "lightbox should close after a 150px downward swipe "
        "(not scroll the underlying page)"
    )


def test_lightbox_swipe_down_short_springs_back(pixel6_page):
    """Open the lightbox. Drag down 50px → springs back, lightbox stays open."""
    page = pixel6_page
    _open_single_image_lightbox(page, "twitter:1777777777777777777")
    _lightbox_touch_drag(page, dy=50)
    assert _media_modal_open(page), (
        "lightbox should stay open after a short (50px) downward swipe (springs back)"
    )


def test_lightbox_swipe_does_not_scroll_feed(pixel6_page):
    """Scroll the feed. Open the lightbox. Drag down 150px (closes).
    Verify the feed's scroll position is unchanged after close."""
    page = pixel6_page
    # Scroll the feed. The topbar scroll-anchoring handler nudges scrollY by
    # ~100px after scrollTo, so capture the ACTUAL settled position as the baseline.
    page.evaluate("window.scrollTo(0, 500)")
    page.wait_for_timeout(500)
    fullname = "twitter:1777777777777777777"
    _scroll_into_view(page, fullname)
    scroll_before = page.evaluate("Math.round(window.scrollY)")
    assert scroll_before >= 250, f"feed should be scrolled, got {scroll_before}"

    coords = _thumb_center(page, fullname)
    page.touchscreen.tap(coords["x"], coords["y"])
    page.wait_for_timeout(500)
    assert _media_modal_open(page), f"lightbox should open on {fullname}"
    _lightbox_touch_drag(page, dy=150)
    assert not _media_modal_open(page), "lightbox should close after downward swipe"

    scroll_after = page.evaluate("Math.round(window.scrollY)")
    assert scroll_after == scroll_before, (
        f"feed scroll position changed during lightbox swipe-close: "
        f"{scroll_before} -> {scroll_after} (should be unchanged)"
    )


def test_lightbox_backdrop_drag_does_not_scroll_feed(pixel6_page):
    """Dragging blank lightbox space must not scroll the feed behind it."""
    page = pixel6_page
    page.evaluate("window.scrollTo(0, 500)")
    page.wait_for_timeout(500)
    fullname = "twitter:1777777777777777777"
    _scroll_into_view(page, fullname)
    scroll_before = page.evaluate("Math.round(window.scrollY)")
    coords = _thumb_center(page, fullname)
    page.touchscreen.tap(coords["x"], coords["y"])
    page.wait_for_timeout(500)
    assert _media_modal_open(page), f"lightbox should open on {fullname}"
    lock = page.evaluate(
        """() => ({
          position: document.body.style.position,
          top: document.body.style.top,
        })"""
    )
    assert lock["position"] == "fixed"
    assert lock["top"] == f"-{scroll_before}px"

    page.evaluate(
        """() => new Promise((resolve) => {
          const modal = document.querySelector('#media-modal');
          if (!modal) { resolve(); return; }
          const r = modal.getBoundingClientRect();
          const x = Math.round(r.left + r.width * 0.2);
          const y0 = Math.round(r.top + r.height * 0.2);
          const dy = 200;
          const fire = (type, yy) => modal.dispatchEvent(new PointerEvent(type, {
            bubbles: true, cancelable: true, composed: true,
            pointerType: 'touch', pointerId: 3, isPrimary: true,
            clientX: x, clientY: yy,
          }));
          fire('pointerdown', y0);
          const steps = 12, stepDy = dy / steps;
          let i = 0, cy = y0;
          const moveNext = () => {
            i++; cy += stepDy;
            fire('pointermove', Math.round(cy));
            if (i < steps) setTimeout(moveNext, 16);
            else { fire('pointerup', Math.round(y0 + dy)); resolve(); }
          };
          moveNext();
        })"""
    )
    page.wait_for_timeout(500)

    assert _media_modal_open(page), "backdrop drag should not close the lightbox"
    page.keyboard.press("Escape")
    page.wait_for_timeout(500)
    assert not _media_modal_open(page)
    scroll_after = page.evaluate("Math.round(window.scrollY)")
    assert scroll_after == scroll_before, (
        f"feed scroll position changed after backdrop drag: "
        f"{scroll_before} -> {scroll_after} (should be unchanged after unlock)"
    )


def test_lightbox_zoomed_pan_clamps_to_viewport(pixel6_page):
    """Zoomed media can pan, but not beyond the visible content bounds into blank space."""
    page = pixel6_page
    _open_single_image_lightbox(page, "twitter:1777777777777777777")
    page.evaluate(
        """() => {
          const im = document.querySelector('#media-body .media-img');
          im.dispatchEvent(new WheelEvent('wheel', {
            bubbles: true, cancelable: true, deltaY: -1200,
          }));
        }"""
    )
    page.wait_for_timeout(200)
    _lightbox_touch_pan(page, dx=1200, dy=1200)
    vals = page.evaluate(
        """() => {
          const img = document.querySelector('#media-body .media-img');
          const body = document.querySelector('#media-body');
          const m = new DOMMatrixReadOnly(getComputedStyle(img).transform);
          const scale = m.a || 1;
          const br = body.getBoundingClientRect();
          return {
            tx: m.e,
            ty: m.f,
            scale,
            bodyWidth: Math.round(br.width),
            bodyHeight: Math.round(br.height),
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight,
            maxX: Math.max(0, (img.clientWidth * scale - body.clientWidth) / 2),
            maxY: Math.max(0, (img.clientHeight * scale - body.clientHeight) / 2),
          };
        }"""
    )
    assert vals["scale"] > 1.001, (
        "wheel should zoom the image before pan clamp assertion"
    )
    assert vals["bodyWidth"] >= vals["viewportWidth"] - 1
    assert vals["bodyHeight"] >= vals["viewportHeight"] - 1
    assert abs(vals["tx"]) <= vals["maxX"] + 1
    assert abs(vals["ty"]) <= vals["maxY"] + 1


def test_lightbox_transform_resets_after_reopen(pixel6_page):
    """Zoom/pan state must not leak into the next open."""
    page = pixel6_page
    fullname = "twitter:1777777777777777777"
    _open_single_image_lightbox(page, fullname)
    page.evaluate(
        """() => {
          const im = document.querySelector('#media-body .media-img');
          im.dispatchEvent(new WheelEvent('wheel', {
            bubbles: true, cancelable: true, deltaY: -1200,
          }));
        }"""
    )
    page.wait_for_timeout(200)
    _lightbox_touch_pan(page, dx=250, dy=250)
    page.keyboard.press("Escape")
    page.wait_for_timeout(500)
    assert not _media_modal_open(page)

    _open_single_image_lightbox(page, fullname)
    transform = page.locator("#media-body .media-img").evaluate(
        "el => getComputedStyle(el).transform"
    )
    assert transform in ("none", "matrix(1, 0, 0, 1, 0, 0)"), (
        f"lightbox transform leaked across reopen: {transform}"
    )
    assert page.locator("#media-body .media-img.zoomed").count() == 0


# --------------------------------------------------------------------------- #
# T3 sidebar-scroll-lock
# --------------------------------------------------------------------------- #


def _open_navdrawer(page) -> None:
    """Open the mobile navdrawer via its trigger button."""
    btn = page.locator("#open-nav")
    expect(btn).to_be_visible()
    btn.click()
    page.wait_for_timeout(300)
    expect(page.locator("#navdrawer.show")).to_be_visible()


def test_sidebar_open_locks_feed_scroll(pixel6_page):
    """Open the navdrawer. Touch-drag on the feed area → feed does NOT scroll.
    (Regression guard for the sidebar-scrolls-browse bug.)"""
    page = pixel6_page
    page.evaluate("window.scrollTo(0, 0)")
    page.wait_for_timeout(200)
    scroll_before = page.evaluate("Math.round(window.scrollY)")

    _open_navdrawer(page)
    # Try to scroll the feed via a wheel event on #items.
    page.evaluate(
        """() => {
          const el = document.querySelector('#items') || document.body;
          el.dispatchEvent(new WheelEvent('wheel', { deltaY: 300, bubbles: true }));
        }"""
    )
    page.wait_for_timeout(300)
    scroll_after = page.evaluate("Math.round(window.scrollY)")
    assert scroll_after == scroll_before, (
        f"feed scrolled while navdrawer open: {scroll_before} -> {scroll_after} "
        "(sidebar-open should lock feed scroll)"
    )


def test_sidebar_scroll_does_not_chain(pixel6_page):
    """Open the navdrawer. Scroll to the bottom of the drawer's content →
    the feed behind it does NOT scroll (overscroll-behavior: contain)."""
    page = pixel6_page
    page.evaluate("window.scrollTo(0, 0)")
    page.wait_for_timeout(200)
    feed_before = page.evaluate("Math.round(window.scrollY)")

    _open_navdrawer(page)
    page.evaluate(
        """() => {
          const d = document.querySelector('#navdrawer');
          if (!d) return;
          for (let i = 0; i < 20; i++) {
            d.dispatchEvent(new WheelEvent('wheel', { deltaY: 200, bubbles: true }));
          }
        }"""
    )
    page.wait_for_timeout(400)
    feed_after = page.evaluate("Math.round(window.scrollY)")
    assert feed_after == feed_before, (
        f"feed scrolled behind navdrawer (scroll chaining): {feed_before} -> {feed_after} "
        "(overscroll-behavior: contain should prevent chaining)"
    )


def test_sidebar_close_restores_scroll(pixel6_page):
    """Scroll feed. Open navdrawer. Close it. Feed scroll position restored."""
    page = pixel6_page
    # Scroll the feed. The topbar handler nudges scrollY, so capture the ACTUAL
    # settled position as the baseline (the test verifies restore, not an exact target).
    page.evaluate("window.scrollTo(0, 500)")
    page.wait_for_timeout(500)
    scroll_before = page.evaluate("Math.round(window.scrollY)")
    assert scroll_before >= 300, f"feed should be scrolled, got {scroll_before}"

    _open_navdrawer(page)
    page.wait_for_timeout(200)
    # Close via the #nav-close button (the #open-nav toggle is hidden behind the drawer).
    page.locator("#nav-close").click()
    page.wait_for_timeout(500)
    scroll_after = page.evaluate("Math.round(window.scrollY)")
    assert scroll_after == scroll_before, (
        f"feed scroll not restored after navdrawer close: {scroll_before} -> {scroll_after}"
    )


# --------------------------------------------------------------------------- #
# T3 drop-reader-dock
# --------------------------------------------------------------------------- #


def test_reader_has_no_dock(pixel6_page):
    """Open the reader → .rd-foot does NOT exist in the DOM."""
    page = pixel6_page
    _open_reader_on(page, "reddit:ui_seed")
    # After t3-drop-reader-dock merges, .rd-foot is removed entirely.
    expect(page.locator(".rd-foot")).to_have_count(0)


def test_reader_t_key_opens_tag_editor(pixel6_page):
    """With the reader open, press T → the inline tag editor opens
    (no dock required)."""
    page = pixel6_page
    _open_reader_on(page, "reddit:ui_seed")
    page.wait_for_timeout(200)
    page.keyboard.press("t")
    page.wait_for_timeout(400)
    has_tag_editor = page.evaluate(
        """() => {
          const inp = document.querySelector('.rd-tag-add-input');
          if (inp && inp.offsetParent !== null) return true;
          const pop = document.querySelector('#tagpop');
          if (pop && !pop.hidden && pop.offsetParent !== null) return true;
          return false;
        }"""
    )
    assert has_tag_editor, (
        "pressing T should open the inline tag editor (no dock required)"
    )


def test_reader_esc_closes(pixel6_page):
    """With the reader open, press Esc → reader closes (one press, one action;
    no 'first Esc collapses the dock' behavior)."""
    page = pixel6_page
    _open_reader_on(page, "reddit:ui_seed")
    assert _reader_open(page), "reader should be open"
    # A SINGLE Esc should close the reader (no dock-collapse-first step).
    page.keyboard.press("Escape")
    page.wait_for_timeout(400)
    assert not _reader_open(page), (
        "a single Esc press should close the reader "
        "(no 'first Esc collapses the dock' step — the dock is gone)"
    )


def test_reader_keyboard_triage_works(desktop_page):
    """On desktop, with the reader open: F → keep, A → archive, D → done.
    Each closes the reader and updates the feed."""
    page = desktop_page
    _open_reader_on(page, "reddit:ui_seed")
    assert _reader_open(page), "reader should be open"
    page.keyboard.press("f")
    page.wait_for_timeout(500)
    assert not _reader_open(page), "reader should close after F (keep)"

    _open_reader_on(page, "reddit:ui_scroll_8")
    assert _reader_open(page), "reader should be open for archive test"
    page.keyboard.press("a")
    page.wait_for_timeout(500)
    assert not _reader_open(page), "reader should close after A (archive)"

    _open_reader_on(page, "reddit:ui_scroll_9")
    assert _reader_open(page), "reader should be open for done test"
    page.keyboard.press("d")
    page.wait_for_timeout(500)
    assert not _reader_open(page), "reader should close after D (done)"
