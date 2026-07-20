# #70 — User-tag table: empty tags + rename vocabulary

**Status: INVESTIGATED 2026-07-12 (not implemented).**

## Current
- Vocab = distinct `metadata.tags_manual` (`user_tag_vocab`).
- Rename across items: `db.rename_user_tag` already exists.
- Empty tags impossible (no row without an item stamp).

## Recommended
New `user_tags(name PK, created_utc)` table; vocab = table UNION tags_manual;
create empty = INSERT; rename = table + `rename_user_tag`.

## Size
M — schema + API + rail. Offline-testable. Needs explicit implement go-ahead.
