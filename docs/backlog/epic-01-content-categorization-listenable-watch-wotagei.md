## Epic 1 — Content categorization: listenable / watch / wotagei  (`enhancement`, `area:youtube`)
*Motivation: many Watch-Later videos are "listenable" (music, podcasts, long-form discussion à la
Isaac Arthur / Perun) and can be processed passively; wotagei (ヲタ芸) should be handled in its own
area. Goal: tag videos so they can be filtered into dedicated "processing areas".*

- [x] ~~**Heuristic categorizer (no LLM first).**~~ Shipped: `categorize.py` + CLI `categorize`
  (`listenable`/`watch`/`wotagei`/`unknown` from duration ≥30min, a channel allowlist, and a wotagei
  title-keyword), stored on `metadata.category`. First run on WL2: listenable 626 / watch 1315 /
  wotagei 3 / unknown 3054 — re-tune the allowlist + thresholds in `categorize.py`.
- [x] ~~**"Processing areas" = category filters.**~~ Shipped: a category facet on `db.search_items`
  + `/items?category=` + the `#category` selector in the browse topbar.
- [x] ~~**Local-LLM auto-classify (`assist/llm.py`).**~~ Shipped: `llm.classify`/`classify_source`
  classify into listenable/watch/wotagei/unknown via the injectable `_chat`, stored on
  `metadata.category` + `category_source='llm'`; CLI `categorize --llm [--source --limit --all]`.
  By default re-classifies the `NULL`/`unknown` tail (preserves confident heuristic/manual categories);
  `--all` re-does every item. Offline tests inject `chat=`. Manual override remains `POST /items/<fn>/category`.
- [x] ~~**P3 — Widen wotagei detection vocabulary.**~~ Shipped (trio/quad batch 2 winner GLM-5.1,
  `b6baa07` on main): `_WOTAGEI_RE` now also matches `otagei`/`打ち師`/`サイリウムダンス`/
  `ペンライトダンス`/`cyalume` (word-boundaried for precision; bare penlight/サイリウム excluded).
  Further idol-event/performer/channel terms can still be appended as the user supplies them.
- [x] ~~**Manual re-tagging UI.**~~ Shipped: a category chip-row on the triage card (youtube items)
  + `POST /items/<fn>/category` (validated, non-destructive). List-row picker left out to avoid
  clutter — triage is the focused single-item view.
