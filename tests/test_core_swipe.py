"""Node-backed tests for static/core/swipe.js.

The helper is DOM-facing, but its event contract is small enough to exercise with a
minimal fake element in Node. These regressions pin the triage-consolidation seams:
left-long must not depend on right-long, vertical callbacks are opt-in, and triage can
keep haptics at the action layer by passing haptics:false.
"""

import shutil
import subprocess

import pytest

STATIC = "src/content_hoarder/static"


def _node(script: str) -> str:
    node = shutil.which("node")
    if not node:
        pytest.skip("node not available")
    r = subprocess.run(
        [node, "--input-type=module", "-e", script],
        cwd=STATIC,
        capture_output=True,
        text=True,
    )
    assert r.returncode == 0, r.stderr + r.stdout
    return r.stdout.strip()


FAKE_DOM = r"""
import assert from 'node:assert/strict';
import { attachSwipe } from './core/swipe.js';

globalThis.window = {
  innerWidth: 400,
  addEventListener() {},
  removeEventListener() {},
};
let vibrates = 0;
Object.defineProperty(globalThis, 'navigator', {
  value: { vibrate() { vibrates += 1; } },
  configurable: true,
});

function fakeClassList() {
  const s = new Set();
  return {
    add: (...xs) => xs.forEach((x) => s.add(x)),
    remove: (...xs) => xs.forEach((x) => s.delete(x)),
    toggle: (x, force) => {
      if (force === undefined ? !s.has(x) : force) s.add(x);
      else s.delete(x);
    },
    contains: (x) => s.has(x),
    values: () => Array.from(s),
  };
}

function fakeEl() {
  const listeners = {};
  return {
    style: {},
    classList: fakeClassList(),
    querySelector: () => null,
    setPointerCapture() {},
    addEventListener(type, fn) { listeners[type] = fn; },
    dispatch(type, props) {
      const ev = {
        pointerType: 'touch',
        pointerId: 1,
        button: 0,
        cancelable: true,
        target: { closest: () => null },
        preventDefault() { this.defaultPrevented = true; },
        stopPropagation() {},
        ...props,
      };
      listeners[type](ev);
      return ev;
    },
  };
}

const wait = (ms = 190) => new Promise((resolve) => setTimeout(resolve, ms));
"""


def test_left_long_commit2_works_without_right_long():
    _node(
        FAKE_DOM
        + r"""
const el = fakeEl();
let left = 0, leftLong = 0;
attachSwipe(el, {
  commit: 80,
  commit2: 170,
  haptics: false,
  onLeft: () => { left += 1; },
  onLeftLong: () => { leftLong += 1; },
});
el.dispatch('pointerdown', { clientX: 220, clientY: 200 });
el.dispatch('pointermove', { clientX: 35, clientY: 202 });
el.dispatch('pointerup', { clientX: 35, clientY: 202 });
await wait();
assert.equal(left, 0);
assert.equal(leftLong, 1);
"""
    )


def test_right_swipe_past_commit2_still_fires_right_when_only_left_long_exists():
    _node(
        FAKE_DOM
        + r"""
const el = fakeEl();
let right = 0, leftLong = 0;
attachSwipe(el, {
  commit: 80,
  commit2: 170,
  haptics: false,
  onRight: () => { right += 1; },
  onLeftLong: () => { leftLong += 1; },
});
el.dispatch('pointerdown', { clientX: 40, clientY: 200 });
el.dispatch('pointermove', { clientX: 230, clientY: 200 });
el.dispatch('pointerup', { clientX: 230, clientY: 200 });
await wait();
assert.equal(right, 1);
assert.equal(leftLong, 0);
"""
    )


def test_vertical_callbacks_are_opt_in():
    _node(
        FAKE_DOM
        + r"""
const passive = fakeEl();
let passiveUp = 0;
attachSwipe(passive, { commit: 80, onUp: null, onLeft: () => {} });
passive.dispatch('pointerdown', { clientX: 200, clientY: 200 });
passive.dispatch('pointermove', { clientX: 202, clientY: 90 });
passive.dispatch('pointerup', { clientX: 202, clientY: 90 });
await wait();
assert.equal(passiveUp, 0);
assert.equal(passive.style.transform || '', '');

const active = fakeEl();
let up = 0, down = 0;
attachSwipe(active, {
  commit: 80,
  haptics: false,
  onUp: () => { up += 1; },
  onDown: () => { down += 1; },
});
active.dispatch('pointerdown', { clientX: 200, clientY: 200 });
active.dispatch('pointermove', { clientX: 202, clientY: 95 });
active.dispatch('pointerup', { clientX: 202, clientY: 95 });
await wait(150);
assert.equal(up, 1);
assert.equal(down, 0);
assert(active.classList.contains('swipe-open'));
"""
    )


def test_haptics_can_be_disabled_for_triage_action_level_feedback():
    _node(
        FAKE_DOM
        + r"""
const el = fakeEl();
attachSwipe(el, {
  commit: 80,
  commit2: 170,
  haptics: false,
  onRight: () => {},
  onLeftLong: () => {},
});
el.dispatch('pointerdown', { clientX: 200, clientY: 200 });
el.dispatch('pointermove', { clientX: 20, clientY: 200 });
el.dispatch('pointerup', { clientX: 20, clientY: 200 });
await wait();
assert.equal(vibrates, 0);
"""
    )
