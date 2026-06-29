## Epic 22 — Triage as a separate app: the engagement deck  (`research`, `area:triage`)
*User idea (2026-06-12): spin triage out into its own app that hooks into the content-hoarder
DB, so OTHER card types can be laced into the triage stream to keep engagement up — first
candidate: **Anki flashcards** interleaved between content cards. Triage becomes one
swipe-stream for "things needing a small decision," and the variety itself is the
engagement mechanic.*

- [x] ~~**P3 — Architecture research FIRST (decision gate).**~~ ✅ Proposed/shipped 2026-06-29 (autonomous run; needs user sign-off): first prototype stays **inside the existing Flask app** behind pluggable backend card sources, not a sibling service yet. `content_hoarder.card_sources` now pins the minimal source/card seam (`cards(limit, **context)`, cards shaped as `{id, source_app, kind, title, actions}` + source payload) and weighted interleaving (`deck()`), with optional lanes disappearing by returning `[]`. Rationale and caveats live in `docs/engagement/engagement-deck-architecture.md`; tests in `tests/test_card_sources.py`. Original gate: decide between (a) same Flask app, pluggable card sources behind `/random`; (b) sibling service reading `app.db` directly; (c) separate app over HTTP, while accounting for Epic 17 and the PKMS sibling-service question.
- [ ] **P3 — Anki interleave prototype (after the architecture gate).** AnkiConnect
  (localhost:8765 JSON-RPC, requires desktop Anki running) exposes due cards + answering;
  interleave N content cards : 1 due flashcard. Swipe maps to Again/Good at minimum. Offline
  Anki = the lane simply doesn't appear (no error state, no guilt).
