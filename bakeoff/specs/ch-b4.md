# CH-B4 delegation spec — User-tag rename-in-vocabulary

## Role & tier
You are the EXECUTOR for one bounded task handed down by a T1-frontier orchestrator.
Do exactly the task; do not re-scope, refactor beyond it, or touch unrelated files.

## Environment
- User: Kenja. OS: Windows.
- CWD / repo root: K:\Projects\content-hoarder
- Python exe: K:\Projects\content-hoarder\.venv\Scripts\python.exe
- pytest path args: forward slashes (K:/Projects/content-hoarder/tests/test_bakeoff_ch_b4_rename_user_tag.py).

## Edit format (NON-NEGOTIABLE)
- Use --edit-format diff.

## Goal
Make `tests/test_bakeoff_ch_b4_rename_user_tag.py` pass without modifying the test file.

The oracle pins this contract:
- `db.rename_user_tag(conn, old, new)` renames a user-entered tag across every
  item that carries it in `metadata.tags_manual`.
- Items whose `metadata.tags_manual` contains `old` MUST end up with `new` in
  their `tags_manual` (and in the displayed `metadata.tags` union).
- Items whose `metadata.tags_auto` (the heuristic stamp) contains `old` MUST
  be left untouched — `rename_user_tag` rewrites the HUMAN stamp only. The
  auto-stamped `old` survives the rename. (No item had `old` in `tags_manual`
  → return 0, no mutation.)
- After the rename, the trigram FTS index over `search_text` MUST reflect the
  new tag (searching the new tag finds the renamed item). This means
  `search_text` must be rebuilt (the new tag must be present in `metadata.tags`
  so that `build_search_text` folds it in), AND the trigram FTS table must be
  rebuilt. The codebase has a known gotcha: external-content FTS5 must be
  backfilled with `INSERT INTO tbl(tbl) VALUES('rebuild')` (NOT
  `INSERT … SELECT`). Look at how `db.set_category` or other DB helpers handle
  trigram rebuilds after metadata changes — mirror that pattern.
- The return value MUST be the count of items whose `tags_manual` actually
  contained `old`.
- Calling `rename_user_tag` with an `old` tag that no item carries MUST return
  0 and MUST NOT mutate any item.

## Files in scope (the ONLY files you may edit)
- `src/content_hoarder/db.py`

## Approach (suggested)
1. Add a new function `rename_user_tag(conn, old, new)` in `db.py`.
2. SELECT all items where `json_extract(metadata, '$.tags_manual')` contains
   `old`. Use `json_each`:
   `SELECT fullname, metadata FROM items WHERE EXISTS (SELECT 1 FROM json_each(metadata, '$.tags_manual') WHERE value = ?)`.
3. For each matching row:
   - `md = parse_metadata(metadata)`.
   - Replace `old` with `new` in `md["tags_manual"]` (preserving order; one
     swap per occurrence).
   - Replace `old` with `new` in `md["tags"]` (the displayed union) ONLY if
     `old` is not also present in `md.get("tags_auto", [])` (preserve the auto
     stamp — if the auto stamp has `old`, the displayed union keeps `old` too).
     Actually: the displayed `tags` union must reflect the rename for the
     manual portion. The simplest correct approach: rebuild `tags` as the
     de-duplicated union of `tags_manual` (after rename) and `tags_auto` (unchanged).
     This preserves the auto-stamp while making the manual rename visible.
   - Update `metadata` JSON column with the new blob.
   - Recompute `search_text` via `models.build_search_text` (use the existing
     row dict + new metadata). Update the `search_text` column.
4. After all rows are updated, rebuild the trigram FTS:
   `INSERT INTO items_trgm(items_trgm) VALUES('rebuild')`.
   (Look at the existing `db._rebuild_trgm_fts` or similar helper if it exists,
   or use the raw `INSERT INTO <ftstable>(<ftstable>) VALUES('rebuild')` form
   — this is the canonical SQLite FTS5 external-content rebuild command. The
   `items_trgm` table is the trigram FTS over `search_text`.)
5. Return the count of mutated rows.
6. Non-existent `old` tag → the SELECT returns 0 rows → return 0, no mutation,
   no FTS rebuild (or a no-op rebuild — either is fine, but a 0-row path that
   skips the rebuild is cleaner).

## Invariants (must hold)
- The auto stamp (`tags_auto`) is NEVER rewritten by this function.
- `tags_manual` is the only stamp changed.
- The `tags` (displayed union) is rebuilt to reflect the rename.
- The trigram FTS reflects the rename (searching the new tag finds the renamed item).
- Non-existent `old` returns 0 and mutates nothing.
- Don't edit the test file.

## Done-when
- `K:\Projects\content-hoarder\.venv\Scripts\python.exe -m pytest
   K:/Projects/content-hoarder/tests/test_bakeoff_ch_b4_rename_user_tag.py -q` exits 0
  (all 5 oracle tests pass).
- The full pre-existing suite still passes.
- The oracle test file's hash is unchanged.
- `git status -s` shows ONLY `src/content_hoarder/db.py` modified.
