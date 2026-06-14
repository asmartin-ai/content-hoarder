# Spec 01 — Model B multi-value search

> ✅ **SHIPPED 2026-06-14** — `b92fe63` on `main` (bakeoff Batch-4: glm-5p1). Dossier kept for history.

BACKLOG: Epic 12 #335 (`docs/search-boolean-research.md` = approved design; `docs/search-operators-spec.md`).
Branch: `feat/search-model-b`. Touches: `search_query.py`, `db.py`, `tests/test_search_query.py`,
possibly `web.py`.

## Goal

Make the single-valued operators **`source / kind / status / subreddit / has`** support
**comma/pipe = OR** (`source:reddit,youtube`) and **same-key-repeat = OR**
(`source:reddit source:youtube`). `tag:` is unchanged (comma=OR / repeat=AND). **No boolean grammar**;
bare `AND`/`OR` stay free text (documented non-feature).

## Acceptance criteria

- `parse("source:reddit,youtube").source == ["reddit","youtube"]` (comma=OR).
- `parse("source:reddit source:youtube").source == ["reddit","youtube"]` (repeat=OR, deduped, order-preserved).
- Same for `kind`, `status`, `subreddit`, `has` (pipe `|` also splits).
- A single value still works: `parse("source:reddit").source == ["reddit"]` (now a 1-element list).
- Absent operator → `None` (NOT `[]`) so web.py precedence checks keep working (see Gotchas).
- `has:video,image` filters items that are reddit_video **OR** image; `has:video,bogus` keeps `video`,
  drops `bogus`; `has:bogus` degrades the whole token to free text.
- `subreddit:` matching stays case-insensitive after the change.
- `source:` multi-value does NOT override the forced `reddit` scope on `/reddit`.
- Full `tag:` semantics unchanged; existing suite green.

## Implementation

### `search_query.py`
- **Dataclass (`:22-49`):** change `source,kind,status,subreddit` (`:26-29`) and `has` (`:40`) from
  `str | None` to `list[str] | None` (keep `None` as the "absent" sentinel; `frozen=True` so build
  lists before constructing).
- **Parse loop:** replace the scalar assignment block (`:184-199`) and the `has` block (`:229-237`)
  with per-key `list[str]` accumulators. Reuse the tag split idiom `re.split(r"[,|]", val)` (`:201`)
  and `_dedupe_preserve_order` (`:98-103`). Keep per-part normalization: `.lower()` for
  source/kind/status; as-typed for subreddit; `.lower()` + `{video,image,gallery}` member-validation
  for `has` (drop invalid parts; degrade token only if NO part is valid).
- After the loop, collapse each accumulator to a deduped list or `None` if empty.

### `db.py` — `search_items` + `add_filters` (`:488-608`)
- Change param types `source/kind/status/subreddit/has_media` to accept a list.
- Convert each `= ?` filter to an `IN (...)` group. Mirror the tags OR template (`:553-559`):
  - source/kind/status (`:524-532`): `f"{a}source IN ({ph})"`, `params.extend(source)`.
  - subreddit (`:578-580`): `f"json_extract({a}metadata,'$.subreddit') COLLATE NOCASE IN ({ph})"`
    — **collation on the left operand** (the one tricky bit; default `IN` would become case-sensitive).
  - has_media (`:566-571`): apply the `video→reddit_video` rewrite **per element**
    (`mt_list = [{"video":"reddit_video"}.get(x,x) for x in has_media]`), then `IN ({ph})`.
- `add_filters` is alias-agnostic and called in both FTS (`:635`) and no-FTS (`:657`) paths — one edit covers both.

### `web.py` (only if needed)
- 3 call sites merge dropdown vs operator: `:128-133`, `:186-192`, `:442-444`. They use
  `parsed.X if parsed.X is not None else (a.get("X") or None)`. Keeping the **absent sentinel = `None`**
  (not `[]`) preserves these. `/reddit` forces `source="reddit"` (`:441`) — confirm a `source:` list
  still cannot override it. `has_media=parsed.has` bridge (`:138,197,451`) now flows a list — fine.

## Tests (`tests/test_search_query.py`)
- Update scalar assertions to lists: `test_parse_basic_operators_and_leftover_text` (`:10-14`),
  `test_parse_normalizes_source_kind_status_value_case` (`:17-23`), `test_parse_is_decayed_and_swept`
  (`:70`). Grep `.source ==`, `.kind ==`, `.status ==`, `.subreddit ==`, `.has ==`.
- Add: comma-OR, repeat-OR (deduped), pipe split, `has:` multi-value + member-validation degrade.
- Mirror `test_parse_tags_or_and_and` (`:50-57`).
- **No DB-level search test exists** — add a small `tests/` case exercising `search_items` with a
  multi-value filter (seed 2 sources, assert both returned) so the SQL `IN`/COLLATE change is covered.

## Gotchas / decisions (pre-decided)
- Absent sentinel = `None`, present = non-empty list. (Keeps web.py precedence.)
- subreddit `COLLATE NOCASE IN (...)`: collation on the left operand; add a test that
  `subreddit:holoLive` matches a `HoloLive` item.
- `has:` rewrite is per-element; member-validate per part.
- Items have exactly one source, so `source:` repeat=OR is the only sensible semantics (repeat=AND
  would be empty) — this is why Model B is correct.
- Do NOT add a `kind` alias layer; not required.

## Out of scope
Negated operators (`-source:`), boolean grammar/parens, `tag:` changes.
