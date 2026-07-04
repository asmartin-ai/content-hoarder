"""P3.1 deck mode — offline Node-backed test of the deck keymap.

Mirrors tests/test_core_swipe.py's _node + fake-element harness. Asserts the
deck keymap (s/e/y/u/z/space + arrows) routes correctly ONLY when state.deck
is true; in list mode (state.deck false), the same keys must NOT be consumed
by deck (so the list-mode s/e/y handlers keep working)."""

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
import { initDeck, setHost, _test } from './browse/deck.js';

/* deck.js imports esc from ../core/util.js — that's a real module under STATIC,
   so the import resolves. No fake needed beyond what deck.js touches at call
   time. We inject fake deps via initDeck so the keymap's commit/advance never
   reach the network. */

let committed = [];
const deps = {
  api: {
    getJSON: async () => ({ items: [] }),
    setStatus: async (fn, s) => { committed.push([fn, s]); },
    undoItem: async (fn) => {},
  },
  toast: () => {},
  snackbar: (msg, undoFn) => {},
  attachSwipe: () => {},
  COPY: { keep: 'k', archived: 'a', done: 'd', inbox: 'i' },
  glyph: (it) => (it && it.source ? it.source[0] : '.'),
  metaLine: () => '',
  snooze: () => {},
  openReader: () => {},
  bumpPulse: () => {},
  toggleDeck: () => {},
};
initDeck(deps);

/* commit() reads `host.querySelector('.deck-card')` for the leave-anim. In
   Node there is no DOM, so give it a fake host that reports no card — the
   commit path tolerates that (it skips the anim and proceeds). */
const fakeHost = {
  querySelector: () => null,
  querySelectorAll: () => [],
  innerHTML: '',
  hidden: false,
};
setHost(fakeHost);

function keyEvent(k) {
  return {
    key: k,
    preventDefault() { this.defaultPrevented = true; },
    defaultPrevented: false,
  };
}

/* Seed the queue so commit() has something to act on; then re-stub after each
   commit by re-seeding. _test.setQueue replaces the queue in place. */
function seedQueue() {
  _test.setQueue([
    { fullname: 'a:1', source: 'a', title: 'A' },
    { fullname: 'a:2', source: 'a', title: 'B' },
  ]);
}
"""


def test_deck_key_consumed_when_deck_active():
    _node(
        FAKE_DOM
        + r"""
const state = { deck: true };
// s -> keep
let e = keyEvent('s');
let consumed = _test.deckKey(e, state);
assert.equal(consumed, true);
assert.equal(e.defaultPrevented, true);

// e -> archived
e = keyEvent('e');
consumed = _test.deckKey(e, state);
assert.equal(consumed, true);

// ArrowRight -> archived
e = keyEvent('ArrowRight');
consumed = _test.deckKey(e, state);
assert.equal(consumed, true);

// y -> done
e = keyEvent('y');
consumed = _test.deckKey(e, state);
assert.equal(consumed, true);

// ArrowLeft -> done
e = keyEvent('ArrowLeft');
consumed = _test.deckKey(e, state);
assert.equal(consumed, true);

// Space -> skip (advance, not commit)
e = keyEvent(' ');
consumed = _test.deckKey(e, state);
assert.equal(consumed, true);

console.log('OK active');
"""
    )


def test_deck_keys_pass_through_when_deck_inactive():
    """In list mode (state.deck false), the deck keymap MUST NOT consume keys.
       s/e/y are list-mode keys (cursor/redo/open-url) and must keep working."""
    _node(
        FAKE_DOM
        + r"""
const state = { deck: false };
for (const k of ['s', 'e', 'y', 'u', 'z', ' ', 'ArrowRight', 'ArrowLeft']) {
  const e = keyEvent(k);
  const consumed = _test.deckKey(e, state);
  assert.equal(consumed, false, 'deck consumed ' + k + ' while inactive');
  assert.equal(e.defaultPrevented, false, 'deck preventDefaulted ' + k + ' while inactive');
}
console.log('OK inactive');
"""
    )


def test_deck_commit_advances_queue():
    _node(
        FAKE_DOM
        + r"""
seedQueue();
assert.equal(_test.getQueue().length, 2);
const state = { deck: true };
_test.setQueue([
  { fullname: 'a:1', source: 'a', title: 'A' },
  { fullname: 'a:2', source: 'a', title: 'B' },
]);
await _test.commit(state, _test.getQueue()[0], 'done');
// commit shifts the head off the queue
assert.equal(_test.getQueue().length, 1);
assert.equal(_test.getQueue()[0].fullname, 'a:2');
console.log('OK commit');
"""
    )


def test_deck_skip_requeues_head():
    _node(
        FAKE_DOM
        + r"""
const state = { deck: true };
_test.setQueue([
  { fullname: 'a:1', source: 'a', title: 'A' },
  { fullname: 'a:2', source: 'a', title: 'B' },
  { fullname: 'a:3', source: 'a', title: 'C' },
]);
_test.advance(state, false); // skip -> head rotates to back
const q = _test.getQueue();
assert.equal(q[0].fullname, 'a:2');
assert.equal(q[2].fullname, 'a:1'); // skipped item is now last
console.log('OK skip');
"""
    )
