# Spec: search-bar operators (Epic 12)

> **STATUS 2026-06-13 — SHIPPED.** Operator parsing (`search_query.py`) merged on
> `feat/search-operators`; the discovery/autocomplete popover (`static/browse/operators.js`,
> context-aware key+value suggestions + applied-operator chips) shipped 2026-06-13. This spec is the
> historical design — the v2 `app.js` line references below predate v3 (app.js has since been removed).

**Branch:** `feat/search-operators`
**Audience:** an implementer with no prior context on this repo. Everything you need is below; verify
the referenced line numbers (they drift) by reading the cited functions before editing.

## Goal

Let the main search bar accept Gmail/Discord-style `key:value` operators mixed with free text, so power
queries don't need the separate dropdown controls. Examples to support:

```
minecraft source:reddit tag:memes              # free text + filters
source:youtube before:2023-01-01 score:>100
subreddit:hololive is:nsfw
kind:post status:inbox -removed                 # negation
"exact phrase" tag:coding,japan                 # quoted exact + OR-tags
```

Operators must translate into the **existing** query layer (`db.search_items`), so the bar drives the
same filters the dropdowns do today. The remaining free text keeps using the FTS path.

**Out of scope (later polish, do NOT build now):** autocomplete, operator chips/pills in the input,
saved searches. This task is the parser + wiring + tests only.

---

## How search works today (read these first)

- **`src/content_hoarder/db.py` → `search_items(conn, q="", *, source, kind, status, category, tags,
  subreddit, is_saved, open_in_firefox, include_consolidated, fuzzy, sort, order, limit, offset)`**
  (around line 420). This is the single query layer. It builds SQL filters in a nested `add_filters()`
  helper, then either:
  - **free text present** → JOIN an FTS table: `items_fts` (exact, built by `_fts_query`, ~line 391) or
    `items_trgm` (trigram fuzzy, built by `_trigram_match`, ~line 399) when `fuzzy=True`; or
  - **no free text** → plain `SELECT * FROM items WHERE <filters>`.
  Sort is via `_order_clause` (~line 408) over `_SORT_COLUMNS`.
- **`src/content_hoarder/web.py` → `/items`** (~line 54) reads `request.args` and maps each query param
  to a `search_items` kwarg. `tag` is repeated (`a.getlist("tag")`). The Reddit view reuses
  `search_items(..., source="reddit")` (~line 247).
- **`src/content_hoarder/static/app.js` → `buildQuery()`** (~line 538) assembles the `URLSearchParams`
  and sends the raw search text as `q`. The dropdowns/sidebar set `source`, `status`, `tag`, `sort`,
  `fuzzy` separately.

Relevant item fields (JSON in `items.metadata`, except top-level columns):
- top-level columns: `source`, `kind`, `status`, `is_saved`, `created_utc`, `title`, `body`.
- `metadata.subreddit`, `metadata.score` (reddit, hydrated by `enrich --source reddit --scores`),
  `metadata.over_18`, `metadata.tags` (JSON list), `metadata.category`.
- Valid tags live in `categorize.FILTER_TAGS`; NSFW buckets are the tags `nsfw_erotic`, `nsfw_other`,
  `nsfw_talk` (note: `over_18` is too sparse to rely on — drive `is:nsfw` off these tags).

---

## Architecture (recommended)

Keep `search_items` a pure filter layer. Add the parsing as a **separate, unit-testable module** and
call it from the route, not the frontend (so the API is the single source of truth and the frontend
needs no change — it already sends raw `q`).

1. **New module `src/content_hoarder/search_query.py`** with a pure function:

   ```python
   def parse(q: str) -> ParsedQuery
   ```

   Returns a small dataclass / dict:
   - `text: str` — leftover free text (operators stripped), passed to `search_items(q=...)`.
   - `source, kind, status, subreddit: str | None`
   - `tags: list[str]`, `tags_all: bool` — repeated `tag:` ⇒ AND (`tags_all=True`);
     `tag:a,b` or `tag:a|b` ⇒ OR for that token.
   - `is_saved: int | None` (from `is:saved`), `nsfw: bool` (from `is:nsfw`).
   - `before: int | None`, `after: int | None` — unix seconds parsed from `YYYY-MM-DD`.
   - `score_min/score_max` or `(score_op, score_val)` — from `score:>100`, `score:<5`, `score:100`.
   - `exclude: list[str]` — `-term` negations (apply as FTS `NOT`).
   - `exact: list[str]` — `"quoted phrases"` (apply as FTS phrase queries).

   Parsing rules: split on whitespace respecting double-quotes; a token matching `^-?(\w+):(.+)$`
   where the key is a known operator becomes a filter, otherwise it stays as free text. Unknown
   `key:value` tokens fall through to free text (don't error). Be tolerant of malformed values
   (e.g. bad date → ignore that operator, keep the rest).

2. **Extend `db.search_items`** with new kwargs and filters:
   - `before: int | None`, `after: int | None` → `created_utc < ?` / `>= ?`.
   - `score_min/score_max` → `CAST(json_extract(metadata,'$.score') AS INTEGER)` comparisons
     (NULL score excluded when a score filter is active).
   - `tags_all: bool` → when true, AND the tags (one `EXISTS(... value = ?)` per tag) instead of the
     current OR `value IN (...)`.
   - `nsfw: bool` → tags-membership in `("nsfw_erotic","nsfw_other","nsfw_talk")`.
   - FTS extension: have `_fts_query` (and the caller) incorporate `exact` phrases (FTS5 `"..."`) and
     `exclude` terms (FTS5 `NOT "term"`). Keep the existing per-token quoting so bare OR/AND/NEAR stay
     literals. Verify a query that is *only* negations/operators with no positive free text still works
     (FTS5 requires at least one positive term — fall back to the no-FTS `SELECT` path when `text` and
     `exact` are both empty).

3. **Wire it in `web.py`**: in `/items` (and `/reddit`), run `parse(a.get("q",""))`, then merge with the
   explicit dropdown params. **Precedence rule (document it in code):** an explicit dropdown param wins
   only if the operator for that key is absent; if the user typed an operator, the operator wins. Pass
   `parsed.text` as `q` and the merged filters as kwargs.

4. **Frontend:** no change required (raw `q` already flows through). Optionally update the search input
   `placeholder`/title to hint at operators. Do **not** build chips/autocomplete.

---

## Decisions to make (pick the simple option, note it in the PR)

- `is:nsfw` ⇒ membership in the three `nsfw_*` tags (not `over_18`). `is:saved` ⇒ `is_saved=1`.
- Multi-tag logic: repeated `tag:` = AND; comma/pipe inside one token = OR. Mirror this in
  `search_items(tags, tags_all)`.
- Date format: `YYYY-MM-DD` only (UTC midnight). `before:` exclusive, `after:` inclusive.
- `score:` applies to `metadata.score` (reddit). It's a no-op filter for sources without a score.

---

## Acceptance criteria

- `source:`, `kind:`, `status:`, `subreddit:`, `tag:` (AND + OR forms), `is:saved`, `is:nsfw`,
  `before:`, `after:`, `score:>N` / `score:<N` / `score:N`, quoted `"exact"`, and `-negation` all work
  from the search bar and compose with each other **and** with the existing dropdown filters.
- Unknown/malformed operators degrade to free text without 500ing.
- Existing behavior is unchanged when no operators are present (the dropdowns and plain search still
  work identically; the FTS exact + `#fuzzy` paths are preserved).
- Non-destructive: read-only query path; no schema or data changes.

## Testing (this repo runs offline pytest)

- Add `tests/test_search_query.py`: pure-function tests for `parse()` — each operator, combinations,
  quoting, negation, malformed values, unknown keys falling through to text.
- Extend `tests/test_db.py` and/or `tests/test_web.py`: seed items with `db.merge_upsert` +
  `models.new_item` (see existing tests for the pattern), then assert `search_items` / `GET /items`
  return the right rows for representative operator queries (including AND-tags, date range, score,
  nsfw, negation).
- Run: `.venv\Scripts\python.exe -m pytest -q` (Windows; all tests are offline). Keep the suite green.
- Conventional Commits (`feat(search): ...`, `test(search): ...`). Small logical commits.

## Constraints / gotchas

- Windows dev box; use the project venv at `.venv\Scripts\python.exe`. One venv per project.
- FTS5 syntax is strict — an unquoted bare `OR`/`AND`/`NEAR`/`NOT` or an empty MATCH 500s the request.
  That's exactly why `_fts_query` quotes every token; preserve that discipline when adding phrases/NOT.
- Don't regress the `fuzzy` (trigram) path or the `include_consolidated` / `open_in_firefox` filters.
