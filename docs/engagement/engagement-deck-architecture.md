# Engagement deck architecture decision

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
- The archived/local backlog already records the relevant integration facts for the decision gate: AnkiConnect is localhost JSON-RPC, requires desktop Anki running, and commonly uses port `8765`.

## Deferred until the Anki prototype

- exact AnkiConnect URL default and env/config key;
- due-card query shape;
- answer action mapping beyond the backlog minimum of Again/Good;
- UI placement and swipe gestures;
- live AnkiConnect smoke test.

## Tests

`tests/test_card_sources.py` pins the normalized card shape, weighted interleaving, empty optional lanes, and invalid weight rejection.
