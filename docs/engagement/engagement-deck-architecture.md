# Engagement deck architecture decision

> Snapshot as of 2026-06-29.

Status: **proposed / needs user sign-off** (2026-06-29 autonomous run)

## Decision

Build the first engagement-deck prototype **inside the existing Flask app** with pluggable backend card sources, not as a sibling service or fully separate app yet.

The shared seam is `content_hoarder.card_sources`:

- a source exposes `cards(limit, **context)`;
- each card has the minimal shape `{id, source_app, kind, title, actions}` plus source-specific payload;
- `card_sources.deck()` interleaves weighted sources, e.g. content:Anki at `2:1`;
- unavailable optional lanes return `[]` and disappear without an error card.

## Why this shape

1. **Smallest reversible step.** It keeps the existing SQLite write owner and triage routes in one process, avoiding cross-process status-write coordination before the feature proves useful.
2. **Modular enough to split later.** A card source is already source-owned and action-routed. If a later separate app is justified, this interface becomes the HTTP boundary.
3. **Fits the no-guilt rule.** Optional integrations like Anki should silently vanish when offline, not create red badges or overdue copy.
4. **Avoids the known port collision.** AnkiConnect conventionally uses `localhost:8765`, which collides with PKMS's capture service noted in Epic 24. The content-hoarder side should not assume that port is free; when the Anki lane is built, make the URL configurable and default to a non-conflicting value after user review.

## Online/reference notes

- GitHub `FooSoft/anki-connect` is archived and says the project moved to SourceHut.
- SourceHut's current README fetch was blocked by bot protection during this run.
- The archived GitHub tag `23.10.29.0` still carries the AnkiConnect docs used for the backend prototype: local HTTP JSON-RPC, default `127.0.0.1:8765`, request shape `{action, version, params, key?}`, response shape `{result, error}`, `findCards`, `cardsInfo`, and `answerCards` with ease `1` = Again and `3` = Good.

## Backend prototype shipped in this run

`content_hoarder.anki_connect` adds an optional AnkiConnect adapter:

- `invoke()` posts version-6 JSON-RPC through the shared stdlib `_http.request` primitive;
- `AnkiDueCardSource` queries due cards with `findCards("is:due")`, fetches `cardsInfo`, and emits engagement-deck cards;
- offline/unavailable Anki returns `[]`, so the lane disappears without an error/guilt state;
- `answer_card()` exposes only the backlog-minimum actions: `again` → ease `1`, `good` → ease `3`.

## Deferred until UI/user review

- exact AnkiConnect URL default if `8765` conflicts locally, plus env/config key;
- UI placement and swipe gestures;
- whether to expose Hard/Easy beyond Again/Good;
- live AnkiConnect smoke test.

## Tests

`tests/test_card_sources.py` pins the normalized card shape, weighted interleaving, empty optional lanes, and invalid weight rejection.

`tests/test_anki_connect.py` pins the AnkiConnect request/response adapter, API-key pass-through, offline disappearance, due-card card shape, and Again/Good answering.
