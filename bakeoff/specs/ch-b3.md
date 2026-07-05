# CH-B3 delegation spec — OCR text → FTS search wiring (`is:ocr`)

## Role & tier
You are the EXECUTOR for one bounded task handed down by a T1-frontier orchestrator.
Do exactly the task; do not re-scope, refactor beyond it, or touch unrelated files.

## Environment
- User: Kenja. OS: Windows.
- CWD / repo root: K:\Projects\content-hoarder
- Python exe: K:\Projects\content-hoarder\.venv\Scripts\python.exe
- pytest path args: forward slashes (K:/Projects/content-hoarder/tests/test_bakeoff_ch_b3_ocr_search.py).

## Edit format (NON-NEGOTIABLE)
- Use --edit-format diff.

## Goal
Make `tests/test_bakeoff_ch_b3_ocr_search.py` pass without modifying the test file.

The oracle pins a 3-part contract:
1. `models.build_search_text(item, metadata)` MUST fold `metadata.ocr_text` into
   the search blob when present (non-empty). When `ocr_text` is empty/None/absent,
   the blob MUST be byte-identical to the same item built with `ocr_text` absent
   (strictly additive — no whitespace restructuring on items without OCR text).
2. `search_query.parse("is:ocr")` MUST produce a structured operator (a boolean
   flag) — NOT degrade to free text. The flag's field name is the implementer's
   choice (`ocr`, `is_ocr`, or `has_ocr`); the test accepts any of these. Existing
   flags (`deleted`, `nsfw`, `snoozed`, `decayed`) MUST remain False.
3. `db.search_items(conn, <flag>=True)` MUST return only items with a non-empty
   `metadata.ocr_text` and MUST exclude items without one. The test passes the
   parsed flag through to `search_items` by the same name search_query exposed
   (so `parse` and `search_items` must use the same flag name).

## Files in scope (the ONLY files you may edit)
- `src/content_hoarder/models.py`
- `src/content_hoarder/search_query.py`
- `src/content_hoarder/db.py`

## Approach (suggested)
- `models.py`: `build_search_text` reads from `_META_SEARCH_KEYS` (a list/tuple
  of metadata keys folded into the blob). Add `"ocr_text"` to that list. The
  existing loop already skips falsy values (`if not val: continue`), so empty
  `ocr_text` produces no extra whitespace. Confirm byte-identity: an item with
  `ocr_text=""` produces the same blob as one without `ocr_text` because the
  list/tuple lookup returns None for the missing key (also falsy, also skipped).
- `search_query.py`: the `is:` operator is parsed in `parse(q)`. Add an
  `elif v == "ocr":` branch alongside the existing `is:deleted`, `is:nsfw`,
  etc. Set a new boolean field on `ParsedQuery` — pick `ocr` (the test accepts
  `ocr`, `is_ocr`, or `has_ocr`; `ocr` is the shortest and cleanest). Add
  `ocr: bool = False` to the `@dataclass(frozen=True) ParsedQuery` definition.
- `db.py`: `search_items` accepts keyword filters. Add an `ocr: bool = False`
  parameter (mirroring `deleted: bool = False`). In the `add_filters` helper
  inside `search_items`, when `ocr=True` add a filter that matches items with a
  truthy `ocr_text`:
  `CAST(json_extract({a}metadata, '$.ocr_text') AS TEXT) <> '' AND json_extract({a}metadata, '$.ocr_text') IS NOT NULL`
  Use the same `{a}` alias pattern as the existing `deleted` filter.

## Invariants (must hold)
- Existing `is:<flag>` behavior unchanged (no flag other than `ocr` flips).
- `build_search_text` for items WITHOUT `ocr_text` is byte-identical before/after
  your change (verify with the existing test suite + the new oracle's
  `test_build_search_text_no_ocr_is_byte_identical_to_absent`).
- Don't edit the test file.

## Done-when
- `K:\Projects\content-hoarder\.venv\Scripts\python.exe -m pytest
   K:/Projects/content-hoarder/tests/test_bakeoff_ch_b3_ocr_search.py -q` exits 0
  (all oracle tests pass).
- The full pre-existing suite still passes.
- The oracle test file's hash is unchanged.
- `git status -s` shows only the 3 in-scope files modified.
