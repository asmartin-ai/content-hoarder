## Epic 12 — Search operators in the search bar  (`enhancement`, `area:search`)
*Mimic Gmail / Discord / Google search-operator syntax in the main search bar so power queries don't
need separate filter controls.*

- [x] ~~**P2 — Parse `key:value` operators alongside free text.**~~ Shipped (`feat/search-operators`,
  merged): `search_query.py` parses `source:`/`kind:`/`status:`/`subreddit:`/`tag:`/`is:saved`/`is:nsfw`/
  `before:`/`after:`/`score:>N`, quoted `"exact"`, and `-negation` into `db.search_items` filters on both
  `/items` and `/reddit`; unknown/malformed operators degrade to free text. Case-normalized values;
  negation honored even with no positive term.
- [x] ~~**Tag operator semantics.**~~ Shipped: repeated `tag:` = AND (`tags_all`), `tag:a,b`/`tag:a|b` =
  OR; `search_items` gained the AND mode.
- [x] ~~**P2 — Operator suggestions / autocomplete (Gmail/Discord-style).**~~ ✅ Shipped 2026-06-13
  (`static/browse/operators.js`): the `#oppop` popover now gives context-aware suggestions — typing
  suggests operator KEYS, and after `key:` it suggests VALUES (`source:` → the 6 sources;
  status:/kind:/is:/has: static lists; `tag:` pulls the curated tag list). Keyboard-navigable (↑/↓ +
  Enter/Tab, Esc), mouse too, and applied operators render as removable ✕ chips. Vocabulary mirrors
  `search_query.py`. Preview-verified end-to-end. *(User-requested.)*
- [x] **P2 — Cross-source / boolean queries — Model B → SHIPPED 2026-06-14 (`b92fe63`).** Research done
  (`docs/search-boolean-research.md` in repo @ main): user approved **Model B** — comma/pipe
  multi-value (`source:reddit,youtube`) + same-key-repeat=OR on single-valued keys
  (source/kind/status/subreddit/has); `tag:` keeps comma=OR / repeat=AND; bare `AND`/`OR` stay
  free text (documented non-feature); NO boolean grammar. Build in flight: trio/quad batch 2
  spec `search-multivalue` (2026-06-12).
  **SHIPPED 2026-06-14 (`b92fe63` on main — bakeoff Batch-4, glm-5p1's diff):** the
  `source/kind/status/subreddit/has` comma=OR + same-key-repeat=OR half is now LIVE — `ParsedQuery`
  fields are `str | list[str] | None`, `db.search_items` emits `IN (…)` (subreddit keeps COLLATE NOCASE,
  `has_media` maps each member), and every existing single-value query is byte-for-byte unchanged. The
  `tag:` half was already live. **Model B complete.**
- [x] ~~**P2 — `has:` media-type operator.**~~ Shipped (overnight 2026-06-10): `has:video`
  (= `reddit_video`) / `has:image` / `has:gallery` on browse + `/reddit`; unknown values
  degrade to free text.
- [x] ~~**P2 — Fuzzy-by-default; `"quotes"` for exact.**~~ Shipped (overnight 2026-06-10,
  user-approved): bare terms fuzzy (trgm), quoted phrases exact (FTS), checkbox repurposed
  to **Exact** (`?exact=1`) on both views; sw.js shell cache v13. Caveat kept: a query
  mixing bare + quoted terms takes the exact path entirely (documented degrade).
- [x] ~~**P2 — Bare `r/<sub>` as subreddit shorthand.**~~ ✅ Shipped 2026-06-17 (F9 bakeoff). A standalone
  `^r/<sub>$` token in `search_query.parse` now maps to the subreddit filter, equivalent to
  `subreddit:<sub>` (matched COLLATE NOCASE downstream). Resolved as an **alias** — `subreddit:` is
  unchanged, not deprecated. Anchored to a standalone token so reddit URLs / mid-text `r/…` aren't captured.
  5 tests. **Follow-up shipped:** `author:` and bare `u/<user>` now filter the first-class `author` column
  case-insensitively, including comma/pipe OR forms. The operator-rename pass remains in the Icebox below.
- [x] ~~**P3 — `Exact` checkbox shouldn't close the operator suggestions popover.**~~ ✅ Done 2026-06-20 (Task C): `scheduleClose` now re-checks `document.activeElement` when the timer fires (clicking the in-popover checkbox blurs the input with a null `relatedTarget`). *(User-reported
  2026-06-17.)* Clicking the **Exact-only** checkbox in the search bar dismisses the `#oppop` suggestions. The
  toggle shouldn't blur/close the popover — keep suggestions open so the user can keep building the query.
  Touches `operators.js` (popover open/close on focus/blur) + the exact-checkbox handler.
- [ ] **P3 — Image text search via OCR.** *(User-requested 2026-06-17.)* Make text *inside* images
  searchable — screenshots, infographics, memes with captions, slide/diagram images — so a bare query
  matches words that only appear in the picture, not the title/body. Two halves:
  - **OCR enrich pass** (the real work): a new opt-in pass (e.g. `enrich --source <s> --ocr` or a dedicated
    `ocr` CLI) that runs OCR over an item's image(s), stores the extracted text on `metadata.ocr_text`, and
    stamps an `ocr_at` timestamp so it's skip-if-present + resumable (mirror the existing enrich/recovery
    passes: `--limit`, dry-run, chunked). Covers reddit image/gallery posts, HN/firefox link previews, and
    any item with a stored image; gallery items OCR each frame. **Open: engine** — Tesseract via
    `pytesseract` (needs the Tesseract binary on PATH; no cloud, fits the local-first rule) vs. a local
    vision model over the `local-llm-bridge` (the user has the GPU for it; better on stylized/meme text) —
    pick after a small accuracy spot-check. **Open: image bytes source** — reuse already-cached
    thumbnails/media where present (offline, cheap) vs. fetch full-res on demand (network, rate-limited like
    the other recovery passes). Mind volume (thousands of images) and junk output (threshold on confidence;
    skip tiny/again-decorative images).
  - **Search wiring** (small): fold `metadata.ocr_text` into the item's `search_text` / `items_fts` (so the
    existing fuzzy+FTS path finds it with zero new query syntax — see `db.build_search_text` +
    `items_fts` triggers), and optionally add a `has:text` / `is:ocr` operator to filter to items that have
    OCR'd text. Keep OCR text out of the visible card (search-only) unless the user wants a "text found in
    image" affordance.
  Relates to Epic 4 (media/recovery enrich passes) and Epic 2 (enrich infra). Sizable — sequence the engine
  spot-check + enrich pass first, the FTS/operator wiring second.

### Icebox — operator naming *(Epic 12)*
- [ ] **P3 — Revisit operator names for intuitiveness (Icebox).** *(User idea 2026-06-17.)* The current
  vocabulary (`source:`/`kind:`/`status:`/`subreddit:`/`tag:`/`is:`/`has:`/`before:`/`after:`/`score:`) should
  be revisited for names that read more intuitively. Pairs with the bare-`r/` shorthand above. Gather the
  rename list before touching `search_query.py` + `operators.js` (keep old names as aliases for a transition).
  Reactivate when the user has a concrete naming preference.
