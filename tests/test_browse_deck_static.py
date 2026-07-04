"""P3.1 deck mode — served-static string guards.

Asserts the wire-up is in place: the deck module ships, the dock/settings
toggles exist in the rendered HTML, and CACHE + APP_VERSION were bumped
together (the standing ship rule). Mirrors the test_static_core.py shape."""

from content_hoarder.web import create_app


def _client(tmp_db):
    return create_app(tmp_db).test_client()


def test_deck_js_served_with_js_mime(tmp_db):
    r = _client(tmp_db).get("/static/browse/deck.js")
    assert r.status_code == 200
    assert "javascript" in r.headers["Content-Type"], r.headers["Content-Type"]
    src = r.data.decode("utf-8")
    # The deck module must expose the entry points main.js wires in.
    assert "export function initDeck" in src
    assert "deckKey" in src  # the keymap entry point


def test_index_html_has_deck_toggle_and_host(tmp_db):
    r = _client(tmp_db).get("/")
    assert r.status_code == 200
    html = r.data.decode("utf-8")
    assert 'id="dock-deck"' in html, "dock-deck button missing"
    assert 'id="set-deck-enter"' in html, "settings-panel deck button missing"
    assert 'id="deck-host"' in html, "deck-host section missing"


def test_sw_js_cache_bumped_to_v115_and_deck_in_shell(tmp_db):
    r = _client(tmp_db).get("/static/sw.js")
    assert r.status_code == 200
    src = r.data.decode("utf-8")
    assert 'ch-shell-v115' in src, "CACHE not bumped to v115"
    assert "/static/browse/deck.js" in src, "deck.js not in SHELL array"


def test_main_js_app_version_bumped_to_v115(tmp_db):
    r = _client(tmp_db).get("/static/browse/main.js")
    assert r.status_code == 200
    src = r.data.decode("utf-8")
    assert 'APP_VERSION = "v115"' in src, "APP_VERSION not v115"
    # The keydown handler must gate deck keys behind state.deck.
    assert "state.deck && deck.key" in src or "deck.key(e, state)" in src, (
        "deck keymap not wired into keydown handler"
    )
