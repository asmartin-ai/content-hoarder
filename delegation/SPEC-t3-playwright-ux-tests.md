# SPEC — T3 Playwright UX verification tests

**Task ID:** `t3-playwright-ux-tests`
**Worktree branch:** `delegate/t3-playwright-ux-tests`
**Branch off:** `staging/mobile-polish-t2` (NOT `main`) — but see "Merge order" below; this task
should be the LAST to merge so its assertions match the final shipped behavior.
**SW cache version:** none — this is a test-only task, no UI changes, no SW bump.
**Source:** `MOBILE-POLISH-T3-BATCH.md` item #8 — "set up tooling so you can better verify UX
changes"

## Goal

Add Playwright tests that cover the gestures/flows the T2 sprint shipped and the T3 batch fixes.
The existing `tests/ui/test_smoke.py` covers feed load, gallery lightbox, topbar collapse — but
NOT relay, peek, tag suggestions, lightbox swipe-close, or sidebar scroll-lock. These slipped
through T2 because there was no automated check.

The new tests must:
- Cover each of the 6 T3 fixes (relay-swipe-close, peek-flicker, tag-suggest-three,
  lightbox-swipe-scroll, sidebar-scroll-lock, drop-reader-dock).
- Use the existing `pixel6_page` fixture (Pixel-6 viewport + PWA-standalone emulation).
- Be deterministic — no reliance on real-device haptics or multi-touch (those stay manual).
- Run as part of `pytest -m ui` (already excluded from the default suite).

## Files in scope

- `tests/ui/test_mobile_ux.py` — **new file.** All the new tests live here. Don't modify
  `test_smoke.py` (its existing tests are the baseline; add to it only if a regression test
  naturally belongs there).
- `tests/ui/conftest.py` — only if a new fixture is needed (see Design constraints). Prefer
  reusing `pixel6_page` + `app_base_url`.

**Do NOT touch:** any app source (`src/`), `sw.js`, `main.js`, etc. This task adds tests only.
If a test reveals a bug that needs an app fix, that's a separate task — note it in the report.

## Design constraints (locked)

- **One test per T3 fix.** Don't write one giant test that covers everything — failures must be
  attributable. (It's fine for a test to have multiple assertions if they're all about the same
  fix.)
- **Use `pixel6_page` for mobile-gesture tests.** Use `desktop_page` only for tests that are
  specifically about desktop behavior (e.g., the reader dock removal — verify keyboard
  shortcuts work on desktop).
- **Pointer Events via Playwright's `page.mouse` or `page.touchscreen`.** For touch gestures,
  prefer `page.touchscreen.tap(x, y)` / `page.touchscreen.move(x, y)` / `page.touchscreen.up()`.
  For long-press, use `page.touchscreen.tap(x, y)` with a delay (Playwright's `tap` accepts a
  `delay`? — verify; if not, use `touchscreen.down` + `page.wait_for_timeout` + `touchscreen.up`).
- **Multi-touch (pinch) is NOT testable in Playwright** (it emulates a single pointer). Don't
  write a pinch test. The lightbox-swipe test covers the 1× close path only; the zoomed-pan path
  is a manual check.
- **No real haptics.** `navigator.vibrate` is a no-op in headless Chromium; don't assert on it.
- **Deterministic data.** The `app_base_url` fixture seeds a synthetic DB (`_seed_ui_db` in
  conftest.py). Use the seeded items — don't rely on `data/app.db`. If a test needs an item
  with a specific shape (e.g., a category, a gallery), either use an existing seeded item or
  add one to `_seed_ui_db` (in conftest.py — that's an allowed edit for this task).
- **No network.** The app runs in-process against the synthetic DB; all tests are offline. Don't
  write a test that hits reddit.com or i.ytimg.com — use `/static/icon-*.png` URLs (the seeded
  gallery item already does).
- **Tag-suggestion test needs primed localStorage.** The `t3-tag-suggest-three` fix reads from
  `localStorage.ch_recent_tags` and `ch_recent_categories`. The test must prime these via
  `page.evaluate("localStorage.setItem(…)")` BEFORE opening the tag editor. (The `pixel6_page`
  fixture navigates to the app first, so localStorage is available.)
- **Relay-swipe test needs a non-media row.** Long-press on a media thumbnail triggers
  hold-to-preview (B4), not the relay. The relay-swipe test must long-press on a row's TEXT
  area (title/byline), not the thumbnail. Pick a seeded item that has a thumbnail and verify
  the long-press lands on the text.
- **Lightbox-swipe test needs a single-image item.** The seeded `ui_gallery` item has a gallery;
  for the swipe-close test, use a single-image item (or add one to `_seed_ui_db`). The
  `ui_seed` item has a permalink but no image — add a new seeded item with a single
  `/static/icon-192.png` image for this test.
- **Drop-reader-dock test is a deletion verification.** After `t3-drop-reader-dock` merges,
  `.rd-foot` must not exist in the DOM. The test asserts `page.locator(".rd-foot").count() == 0`
  AND that the `T` key still opens the inline tag editor (no dock required).
- **Test names follow the existing convention:** `test_<behavior>_<context>`. E.g.,
  `test_relay_long_press_then_swipe_right_closes`.
- **Mark every test `pytestmark = pytest.mark.ui`** at the module top (same as `test_smoke.py`).

## Tests to write

```python
# tests/ui/test_mobile_ux.py

import re
import pytest
from playwright.sync_api import expect

pytestmark = pytest.mark.ui


# --- T3 relay-swipe-close ---

def test_relay_long_press_opens_strip(pixel6_page):
    """Long-press on a row's text (NOT the thumbnail) opens the relay strip."""

def test_relay_swipe_left_is_noop(pixel6_page):
    """After opening the relay, a leftward swipe does NOT reveal blank space
    and does NOT close the relay. (Regression guard for the blank-space bug.)"""

def test_relay_swipe_right_closes(pixel6_page):
    """After opening the relay, a rightward swipe (>10px) closes the strip
    and the .item-fg slides back smoothly (no inline transition: none left behind)."""

def test_relay_diagonal_swipe_right_closes(pixel6_page):
    """A slightly-diagonal rightward swipe (dx=25, dy=18) still closes the relay
    — the close path bypasses the horizontal-decision threshold."""

def test_relay_scrim_tap_closes(pixel6_page):
    """Tapping the scrim closes the relay with a smooth slide-back
    (no abrupt snap from a stuck inline transition)."""


# --- T3 peek-flicker ---

def test_hold_to_preview_opens_lightbox(pixel6_page):
    """Press-and-hold a thumbnail (300ms) opens the lightbox in peek mode."""

def test_hold_to_preview_no_flicker(pixel6_page):
    """During a 2-second hold, the lightbox opens exactly once and stays open
    — no open/close cycling. (Regression guard for the flicker bug.)"""

def test_hold_to_preview_release_closes(pixel6_page):
    """Releasing the hold closes the lightbox."""

def test_tap_thumbnail_opens_persistent(pixel6_page):
    """A quick tap (<250ms) opens the lightbox persistently (the _suppressNextClick
    guard doesn't swallow the tap's click)."""


# --- T3 tag-suggest-three ---

def test_tag_suggest_three_with_categories(pixel6_page):
    """Prime localStorage with 2 categories + 3 tags. Open the tag editor on an
    item with no category → expect 2 category suggestions + 1 tag (3 total)."""

def test_tag_suggest_three_backfill_with_tags(pixel6_page):
    """Prime localStorage with 0 categories + 3 tags. Open the tag editor →
    expect 3 tag suggestions (backfill when categories are sparse)."""

def test_tag_suggest_zero_when_stores_empty(pixel6_page):
    """Clear both localStorage stores. Open the tag editor → expect 0 suggestions
    (don't pad with synthetic placeholders)."""


# --- T3 lightbox-swipe-scroll ---

def test_lightbox_swipe_down_closes(pixel6_page):
    """Open the lightbox on a single image. Drag down 150px → lightbox closes.
    (Regression guard for the swipe-scrolls-page bug.)"""

def test_lightbox_swipe_down_short_springs_back(pixel6_page):
    """Open the lightbox. Drag down 50px → springs back, lightbox stays open."""

def test_lightbox_swipe_does_not_scroll_feed(pixel6_page):
    """Scroll the feed 300px. Open the lightbox. Drag down 150px (closes).
    Verify the feed's scroll position is unchanged after close."""


# --- T3 sidebar-scroll-lock ---

def test_sidebar_open_locks_feed_scroll(pixel6_page):
    """Open the navdrawer. Touch-drag on the feed area → feed does NOT scroll.
    (Regression guard for the sidebar-scrolls-browse bug.)"""

def test_sidebar_scroll_does_not_chain(pixel6_page):
    """Open the navdrawer. Scroll to the bottom of the drawer's content →
    the feed behind it does NOT scroll (overscroll-behavior: contain)."""

def test_sidebar_close_restores_scroll(pixel6_page):
    """Scroll feed 300px. Open navdrawer. Close it. Feed scroll position restored."""


# --- T3 drop-reader-dock ---

def test_reader_has_no_dock(pixel6_page):
    """Open the reader → .rd-foot does NOT exist in the DOM."""

def test_reader_t_key_opens_tag_editor(pixel6_page):
    """With the reader open, press T → the inline tag editor opens
    (no dock required)."""

def test_reader_esc_closes(pixel6_page):
    """With the reader open, press Esc → reader closes (one press, one action;
    no 'first Esc collapses the dock' behavior)."""

def test_reader_keyboard_triage_works(desktop_page):
    """On desktop, with the reader open: F → keep, A → archive, D → done.
    Each closes the reader and updates the feed."""
```

## Implementation notes

- **Long-press in Playwright:** `page.touchscreen.tap(x, y)` doesn't take a delay. Use the
  lower-level API:
  ```python
  page.touchscreen.tap(x, y)  # for a quick tap
  # for a long-press:
  page.mouse.move(x, y)  # touchscreen.down needs the cursor positioned? — verify
  page.touchscreen.down()
  page.wait_for_timeout(300)  # hold
  page.touchscreen.up()
  ```
  Actually, `page.touchscreen` in Playwright Python has `tap(x, y)` and `down()/up()/move()`
  only on `page.mouse`. For touch, `tap` is the high-level API; for a hold, you may need to
  use `page.mouse` with `is_mobile=True` (Playwright's mouse emulates touch on mobile
  contexts). The agent should experiment and document which API works for the long-press.
- **Swipe gesture in Playwright:**
  ```python
  page.mouse.move(x1, y1)
  page.mouse.down()
  page.mouse.move(x2, y2, steps=10)  # steps = intermediate events for smoothness
  page.mouse.up()
  ```
  On a mobile context (`is_mobile: True`), `page.mouse` events are dispatched as touch events.
  Verify this works for the relay-swipe and lightbox-swipe tests.
- **`page.evaluate` for state checks:** Use it to read `localStorage`, `itemsEl.scrollTop`,
  `document.body.scrollTop`, the presence of inline `style.transition` on an element, etc.
- **`expect(locator).to_have_count(0)`** for absence assertions (e.g., `.rd-foot` count is 0).
- **Wait for animations:** After a swipe-close, the relay strip's slide-out transition takes
  ~200ms. Use `page.wait_for_timeout(300)` or `page.wait_for_selector(".relay-strip", state="hidden")`
  before asserting.
- **Seed data additions:** If you need to add an item to `_seed_ui_db` (e.g., a single-image
  item for the lightbox-swipe test), add it in `tests/ui/conftest.py`'s `_seed_ui_db` function.
  Document the addition in the report.
- **Skip gracefully if a feature isn't testable:** If Playwright can't emulate a gesture (e.g.,
  two-finger pinch), write the test as `pytest.skip("requires real multi-touch")` with a
  comment pointing to the manual check. Don't skip a whole test category — only the untestable
  assertion.

## Acceptance

1. **All new tests pass** on a branch that has the T3 fixes merged. (The agent runs them
   against its own starting branch `staging/mobile-polish-t2`, where the bugs still exist —
   so some tests will FAIL there. That's expected and proves the tests catch the regressions.
   The agent should:
   - Run the tests, confirm they FAIL on `staging/mobile-polish-t2` (the bugs are present).
   - Note in the report which tests fail and why (each should map to a T3 bug).
   - The tests will PASS once the corresponding T3 fix branches merge into the integration
     branch.)
2. **No new app source changes.** This task adds tests only. If a test reveals an app bug that
   needs a fix, note it — don't fix it here.
3. **`pytest -m ui` still passes** the existing `test_smoke.py` + the new tests (once the T3
   fixes are merged). On the starting branch (`staging/mobile-polish-t2`), the existing tests
   pass and the new tests fail (as expected).
4. **Tests are deterministic.** Running `pytest -m ui` twice in a row gives the same result
   (no flaky timing). Use `wait_for_timeout` / `wait_for_selector` generously.
5. **Tests don't hit the network.** Verify no test makes a real HTTP request to an external
   host. (The `app_base_url` fixture serves the app in-process; all asset URLs are
   `/static/…`.)
6. **Test names are descriptive** and match the convention `test_<behavior>_<context>`.

## Validation block

```
# 1. Confirm Playwright is installed:
.venv/Scripts/python.exe -c "import playwright; print('OK')"
.venv/Scripts/python.exe -m playwright install chromium 2>&1 | tail -3   # if not installed

# 2. Run the new tests on the starting branch (staging/mobile-polish-t2) — expect FAILURES
#    (the bugs are present). Capture which tests fail and map each to a T3 bug:
.venv/Scripts/python.exe -m pytest tests/ui/test_mobile_ux.py -m ui -v --tb=line 2>&1 | tail -40

# 3. Confirm the existing UI smoke tests still pass (no regression from the new test file):
.venv/Scripts/python.exe -m pytest tests/ui/test_smoke.py -m ui -q --tb=no 2>&1 | tail -5

# 4. No app source changed:
git diff --name-only staging/mobile-polish-t2..HEAD | grep -v '^tests/' | grep -v '^delegation/'
# → expect ZERO hits (only tests/ and delegation/ files changed)

# 5. SW cache unchanged:
grep 'const CACHE' src/content_hoarder/static/sw.js   # → still "ch-shell-v86"
```

## Report back

- Branch: `delegate/t3-playwright-ux-tests`
- Files changed (should be `tests/ui/test_mobile_ux.py` + maybe `tests/ui/conftest.py` only):
- New tests added (list each test name + which T3 fix it covers):
- Tests that FAIL on the starting branch (each should map to a T3 bug — list the test + the bug):
- Tests that PASS on the starting branch (these are regression guards for already-working
  behavior, or for the deletion-verification tests where the dock still exists):
- Did you need to add seed data to `_seed_ui_db`? If so, what item(s)?:
- Did you need to add a new fixture to `conftest.py`? If so, what and why?:
- Which Playwright API did you use for long-press (`touchscreen` vs `mouse` on mobile context)?:
- Anything punted to T1 (e.g., gestures Playwright can't emulate):
