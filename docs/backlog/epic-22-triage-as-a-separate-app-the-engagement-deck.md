## Epic 22 — Triage as a separate app: the engagement deck  (`research`, `area:triage`)
*User idea (2026-06-12): spin triage out into its own app that hooks into the content-hoarder
DB, so OTHER card types can be laced into the triage stream to keep engagement up — first
candidate: **Anki flashcards** interleaved between content cards. Triage becomes one
swipe-stream for "things needing a small decision," and the variety itself is the
engagement mechanic.*

- [ ] **P3 — Architecture research FIRST (decision gate).** Decide the shape before any build:
  (a) same Flask app, pluggable card sources behind the existing `/random` batch endpoint
  (cheapest, no new process); (b) sibling service reading `app.db` directly (SQLite
  cross-process write coordination needed — triage writes statuses); (c) fully separate app
  consuming an HTTP API the hoarder exposes (cleanest seam, most work). Overlaps the open
  PKMS sibling-service question (Epic 21 icebox) — answer them together. Note the tension
  with Epic 17 (unify surfaces): that unification targeted browse+reddit; triage spinning
  OUT can coexist, but decide deliberately. Sketch the card-source interface while deciding:
  a card = `{id, source_app, render(), actions[], on_action()}` — content items, Anki due
  cards, and the Epic 20 resurfacing/surprise-me cards would all implement it.
- [ ] **P3 — Anki interleave prototype (after the architecture gate).** AnkiConnect
  (localhost:8765 JSON-RPC, requires desktop Anki running) exposes due cards + answering;
  interleave N content cards : 1 due flashcard. Swipe maps to Again/Good at minimum. Offline
  Anki = the lane simply doesn't appear (no error state, no guilt).
