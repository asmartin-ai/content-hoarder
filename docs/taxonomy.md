# Taxonomy model — three-system design (Epic 26)

## Rationale

How do categories, tags, and folders relate? After research (B5 capture-friction study, D9
guilt-surface analysis, Epic 21 filing-never-happens finding) and surveying comparable tools
(Karakeep lists, Pocket/Raindrop/Linkwarden collections, Obsidian tags/folders, Anki decks/tags),
the answer is: **they are three separate primitives with one shared display surface.**

Every mature tool keeps a multi-label tag system and a single-select location system as two
different things. Collapsing them would sacrifice cardinality guarantees for no UX gain.

## The three primitives

| Primitive | Cardinality | Stored in | Populated how | Rail facet |
|---|---|---|---|---|
| **Category** | single-select | `metadata.category` | auto (heuristic: duration/channel/title) | yes (via dual-write tag mirror) |
| **Tags** | multi-label | `metadata.tags` (+ `tags_manual` stamp) | auto (subreddit/keyword/channel/host) + manual | yes (`FILTER_TAGS` + user vocab) |
| **Folders** | single-select | `metadata.folder` + `folders` registry | derived from saved queries (`folders.py` evaluate) | yes (future rail) |

### Category (`metadata.category`)

- One value per item: `listenable`, `watch`, `wotagei`, or `unknown` (heuristic give-up).
- Set by heuristic (`categorize.categorize()`) or LLM (`assist/llm.classify()`).
- The **dual-write** in `db.metadata_with_category_tag()` mirrors the category into
  `metadata.tags` so that `tag:listenable` in the browse rail finds both items whose
  category **is** listenable and items manually tagged "listenable".
- This dual-write is the **intended bridge** — not a legacy shim. The `search_items`
  `category=` filter OR-checks `metadata.category` AND the matching tag, so either
  path finds the same items.
- `category_source: 'llm'` is set in metadata when the LLM classifier assigned it.

### Tags (`metadata.tags`)

- Multiple values per item (a Reddit post can be `minecraft + memes`).
- Populated by:
  - **Automated heuristics** (`categorize.py`): subreddit-to-tag map, channel-to-tag map,
    host-to-tag map, keyword fallbacks.
  - **User manual tagging** (`db.set_tags()`): stamped in `metadata.tags_manual` to survive
    re-import and re-tag.
  - **Enrich keywords** (YouTube per-video keywords from the enrich pass): hundreds of
    thousands of one-off values — deliberately NOT filter facets.
- The **filter rail** (`FILTER_TAGS` + `user_tag_vocab`) restricts facet display to ~25
  curated tags + whatever the user has manually applied. This keeps the browse rail small
  despite tens of thousands of raw keywords in storage.

### Folders (`metadata.folder` + `folders` registry — shipped Epic 26 P2)

- One value per item (or null), stored as `metadata.folder` (lowercased).
- Set by **derived rules** (saved queries), not manual save-time filing — research
  (97.55% inbox non-exit rate) proves manual filing doesn't scale.
- A folder = a query definition evaluated dynamically by ``folders.evaluate_folder()``.
  On evaluation, items matching the rule get ``metadata.folder`` assigned; items that
  no longer match (but were previously assigned) get cleared.
- The `folders` registry table (stable id, display name, query_def JSON) supports
  rename/deletion/empty-folder semantics that a pure-tag approach cannot.
- **Registry API** (``db.py``): ``create_folder``, ``list_folders``, ``rename_folder``,
  ``delete_folder``, ``get_folder_by_name``, ``folder_counts``.
- **Evaluation engine** (``folders.py``): ``evaluate_folder(id)``, ``evaluate_all()``,
  ``items_by_folder(name)``. Query_def supports ``source``, ``kind``, ``status``, ``tag``,
  ``subreddit``, ``author``, ``has``, ``q`` filters.
- **CLI** (``content_hoarder folder``): ``list``, ``create``, ``rename``, ``delete``,
  ``evaluate [id]``, ``assign <fullname> [name]``, ``stats``.
- **Web API**: ``GET/POST /folders``, ``PATCH/DELETE /folders/<id>``,
  ``POST /folders/evaluate``, ``GET /folders/stats``, ``PATCH /items/<fn>/folder``.
- Manual item override via ``db.set_item_folder()`` or ``folder assign`` CLI (derived
  folders win on next evaluate).
- **Explicit guardrails** (from B5/D9):
  - Never block saving with a required folder picker.
  - Never show "N unfiled" or per-folder backlog counts (no guilt surface).
  - Folder = curator framing ("here's a slice of your library"), not hoarder framing.

## Why not collapse?

The plausible alternative was to ditch `metadata.category` and encode everything as
namespaced tags (`category:listenable`, `folder:projects`). Rejected because:

1. **Single-select invariant is a standing bug magnet** in a multi-label array — every
   write path (`merge_upsert`, manual edit, LLM retag, folder reassign) would need to
   enforce "at most one `category:*` tag", a check that's trivial on a field and
   error-prone in an array.
2. **Renames** — renaming a folder means rewriting the folder registry name, not scanning
   every item. With tags, you'd need to re-tag every member.
3. **Empty folders** — a derived-from-usage tag can't represent an empty folder. A
   registry can.
4. **Industry pattern** — every mature tool keeps location and labels as separate
   systems. Fighting the pattern adds cognitive load for zero benefit.

## Search behavior

The `search_items` `category=` filter OR-checks:
```sql
json_extract(metadata, '$.category') = ? OR
EXISTS (SELECT 1 FROM json_each(metadata, '$.tags') WHERE value = ?)
```

So `category:listenable` finds items with `metadata.category = "listenable"` AND items
with `"listenable"` in `metadata.tags`. This is the same behavior as `tag:listenable`
for processing-area tags — the two filters converge on the same result set, which is
the point.

`tag:` always searches `metadata.tags` only (via `json_each`), covering both automated
and manual tags.
