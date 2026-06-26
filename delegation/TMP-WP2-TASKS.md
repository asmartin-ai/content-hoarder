# TMP-WP2 — Sandboxed code tasks (no live data, no DB)

Agent profile: has a sandboxed checkout of the code, can run offline tests with synthetic fixtures, but has **no access to live websites or the real database** (`data/app.db`). Tasks below are design + implementation work; some are blocked on user decisions (Q1–Q9) or on WP1 findings.

| # | Epic | Task | Blocked on |
|---|------|------|------------|
| 1 | 26 P2 | Taxonomy model reorg — unify categories (`metadata.category`) ↔ tags (`metadata.tags`) | ~~Q1 (namespace vs separate field)~~ **DONE**: three-system model formalized in `docs/taxonomy.md`, `categorize.py` module docstring, `db.py` dual-write comments. Categories stay first-class (no collapse). |
| 2 | 26 P2 | Folders at save time — folder primitive alongside categories + tags | ~~Q1 (reserved namespace vs `metadata.folder`)~~ **DONE**: `metadata.folder` field + `folders` registry table + derived-rule evaluation engine (`folders.py`) + CLI (`folder list/create/rename/delete/evaluate/assign/stats`) + 6 web routes + 24 tests. Derived from saved queries (not save-time picker), per B5/Epic 21 constraint. Docs updated in `docs/taxonomy.md`. |
| 3 | 26 P2 | Rule-based + AI-based tagging + new-tag suggestions (reviewable queue) | ~~Q1 (model shape)~~ `tag_suggest.py` done; rule-suggest, discovery, LLM-suggest, queue API + CLI + web routes + 28 tests. Model shape still pending for task 1–2. |
| 4 | 26 P3 | User-tag table — pre-create empty tags, rename-in-vocabulary, delete-from-vocab | Q1 (table vs inline) |
| 5 | 12 P3 | OCR enrich pass (`enrich --ocr`) + fold `metadata.ocr_text` into `items_fts` | Q3 (engine), `has:ocr`/`has:text` operator |
| 6 | 5 P2 | Rework keyboard controls — new ergonomic one-hand scheme | Q2 |
| 7 | 5 P3 | Drag-and-drop to buckets (SortableJS ~20KB vs html5sortable ~4KB) | — |
| 8 | 8 P2 | Predictive prefetch cache — per-source × per-sort warm | Design: cache location / invalidation / memory bound |
| 9 | 8 P2 | Redesign app icon (backwards-E forming H, teal on `#0f1115`) | Q6 |
| 10 | 8 P3 | 60fps UI audit — layout thrash, transforms, `will-change` (Pixel-6 target) | — |
| 11 | 15 P2 | Video plays inline in the reader media tile (no lightbox) | — |
| 12 | 15 P3 | Inline comment video (`v.redd.it`/gfycat/redgifs/streamable) in reader threads | RES screenshots from user |
| 13 | 15 P2 | Obsidian write-back — persist absolute vault root, write edits to `.md` on disk | Q7 |
| 14 | 16 P2 | Long-press → group-select (mobile) | — |
| 15 | 16 P3 | Mobile-friendly scrollbar + collapsing top bar visual polish | — |
| 16 | 16 P3 | Swipe-only interactions mode on mobile (optional, no inline icons) | — |
| 17 | 17 P2 | Unify Reddit (`/reddit`) + Inbox/Triage into one surface | Large; sequence after settings/mobile |
| 18 | 18 P3 | Custom YouTube view (duration, channel grouping, playlist order, processing-areas) | — |
| 19 | 20 P2 | Triage visual rework (design bakeoff, GLM arm) + 4-directional gesture visual hints | — |
| 20 | 21 P2 | `purge-done` settings UI (retention-window control) + scheduled-sweep entrypoint | Design: retention-window control, sweep trigger |
| 21 | 22 P3 | Triage-as-separate-app architecture + card-source interface `{id, source_app, render(), actions[], on_action()}` | Q4 |
| 22 | 22 P3 | Anki interleave prototype (AnkiConnect JSON-RPC localhost:8765) | Q4 + port collision with PKMS (8765) |
| 23 | 24 icebox | Comments table normalization design (blob → normalized `comments` table) | Reactivation: want sort-in-SQL / single-comment writes |
| 24 | 25 P3 | Human-mimic jitter (log-normal / two-state Markov / empirical sampling) | — (user's own learning project) |
| 25 | 4 P2 | RedGifs resolver implementation (connector + metadata rewrite) | WP1#3 (API validated first) |
| 26 | 7 P2 | Twitter/X bookmarks connector (`twitter:<tweet_id>`) | Q9 + browser-export format research |
| 27 | 7 P3 | Live Firefox tab integration (WebExtension / sessionstore / bookmarklet) | Shape choice (a/b/c) |
| 28 | 21 P3 | LLM identity-vs-actionable classifier (resurfacing candidate quality) | Local-LLM/GPU availability |
| 29 | 20 P3 | Unused `app.css` selectors audit (per-selector usage checks before deletion) | — |
| 30 | 5 P3 | Image/gallery lightbox zoom + pan (pinch-to-zoom on mobile) | — |

## Decision gates needing user input before these can start cleanly
- **Q1** → tasks 1–4 (taxonomy reorg is the big structural one)
- **Q3** → task 5 (OCR engine)
- **Q4** → tasks 21–22 (triage-app architecture)
- **Q7** → task 13 (vault root storage)

## Open user questions (decision gates), restated
- **Q1 — Taxonomy/folders (Epic 26):** processing categories as reserved tag namespace vs separate `metadata.category` field? Folders as reserved single-select namespace vs first-class `metadata.folder`?
- **Q2 — Keyboard (Epic 5):** target ergonomic scheme, or have the agent propose 2–3 options?
- **Q3 — OCR engine (Epic 12):** Tesseract via `pytesseract` (binary on PATH, no GPU) vs local vision model over `local-llm-bridge` (GPU, better on meme text)? Or have WP1 spot-check accuracy first?
- **Q4 — Triage-app architecture (Epic 22):** (a) same Flask app, pluggable card sources; (b) sibling service reading `app.db`; (c) separate app consuming an HTTP API. Overlaps the PKMS capture-endpoint question (Epic 21 icebox) — answer together.
- **Q5 — Operator naming (Epic 12 icebox):** concrete rename preferences for `source:`/`kind:`/`status:`/`subreddit:`/`tag:`/`is:`/`has:`/`before:`/`after:`/`score:`? (reactivate when ready)
- **Q6 — App icon (Epic 8):** confirm the backwards-E-forming-H mark?
- **Q7 — Obsidian write-back (Epic 15):** OK to persist the absolute vault root path in the DB?
- **Q8 — nsfw\_erotic bulk-unsave (Epic 9):** dry-run first + confirm surface; `nsfw_talk` as separate target?
- **Q9 — Twitter/X connector (Epic 7):** quote-tweet/thread context (flatten or preserve)? NSFW = reuse `nsfw_*` opt-in? Promote tweet-embedded YouTube links into `youtube:` items?
