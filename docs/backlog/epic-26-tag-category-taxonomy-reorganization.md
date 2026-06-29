## Epic 26 — Tag & category taxonomy reorganization  (`enhancement`, `area:tags`)
*User direction (2026-06-17): an overall reorganization of how **categories** and **tags** are modeled and
surfaced. Today categories (`metadata.category`: listenable/watch/wotagei) and tags (`metadata.tags`: the
multi-label buckets) are two separate systems with overlapping rail UI. Unify the model and give the rail a
parent→child structure. Overlaps + absorbs Epic 5 P2 (categories in the sidebar / as a reserved tag
namespace) and builds on Epic 9 (tagging).*

- [x] **P2 — Parent/child tag grouping in the rail (visual).** ✅ SHIPPED 2026-06-22 (origin/main): `categorize.TAG_GROUPS` served via `/tags`; rail nests facets under parent headers, parent-click OR-selects present children (some/all/none), ungrouped/user tags → a "More" group. *(User-requested 2026-06-17.)* Group the flat
  tag list under **parent tags** (e.g. **Humorous**, **Educational**, **Trivial**, **Gaming**) with the
  sub-tags **indented** under their parent. Selecting a parent **highlights + selects all of its sub-tags**
  (OR-filter across the children). Scope per user: **visual grouping** — the underlying tags stay flat for
  FTS/search; this is rail UX + a parent→children map. Touches the sidebar rail + `db.tag_counts` /
  `categorize.FILTER_TAGS`.
- [x] **P2 — Source-aware tag rail.** ✅ SHIPPED 2026-06-22 (origin/main): `refreshRail` passes the active source to `/tags`+`/categories`, so picking a source narrows the rail to that source's present tags (empty groups auto-hide). *(User idea 2026-06-17.)* The tag rail should **adapt to the active
  source**. Tags aren't source-exclusive, but most cluster to one source in practice (defense/anime → reddit;
  channel topics → youtube). When a source tab is active, surface the tags actually present for that source
  (volume-sorted) instead of the global vocabulary. Reuses the cross-filtered-counts pattern
  (`/sources?status=` style, Epic 5). Open question: how to treat shared/cross-source tags (always show vs.
  fold under an "all sources" group).
- [x] **P2 — Overall categories↔tags model reorg (decision gate first).** *(Done 2026-06-26.)* Decision (Q1,
  resolved 2026-06-26): three-system model — categories stay first-class (`metadata.category`), tags remain
  multi-label (`metadata.tags`), folders are a separate first-class field (`metadata.folder` + `folders`
  registry). The category→tag dual-write in `db.set_category` is documented as the **intended bridge** (not a
  legacy shim). Taxonomy reference doc: `docs/taxonomy.md`. Categories not collapsed — single-select invariant
  in a multi-label array would be a standing bug magnet with zero UX gain.
- [x] **P2 — Manual tagging + user-created tags.** *(User-requested 2026-06-19.)* Today tags are applied
  **only by the pipeline** (`categorize.py` heuristics + the optional LLM pass) from a **fixed curated
  vocabulary** (`REDDIT_TAGS`/`FILTER_TAGS`). Let the user **manually tag any item** from the UI **and create a
  new tag on the fly** when none fits. Needs: a tag editor on the item (triage card + reader + browse row — a
  chip-add/remove affordance, precedented by the `POST /items/<fn>/category` chip-row); a `POST /items/<fn>/tags`
  endpoint that mutates `metadata.tags` non-destructively + rebuilds `search_text`/FTS; and a place for
  **user-defined tags** to live so they (i) appear in the rail/filters alongside the curated set and (ii)
  **survive re-import** (`merge_upsert` overlays — stamp manual tags like the Epic 15 body-edit `*_edited_at`
  pattern so a re-sync can't clobber them). Decide where user tags are stored (a `user_tags` table / a settings
  list vs. inline on `metadata`) as part of the model reorg above. **✅ Core SHIPPED 2026-06-22** (origin/main):
  editor on all three surfaces + `POST /items/<fn>/tags` (stamps `tags_manual`, survives re-import) + the rail
  registry (`db.user_tag_vocab`, derived **inline from `tags_manual`** — no table — unioned into `db.tag_counts`
  so user tags render under the rail's "More" group). Remaining trade-offs split to the P3 below.
- [ ] **P3 — User-tag table: pre-create empty tags + rename-in-vocabulary.** *(Follow-up to the shipped registry,
  2026-06-22.)* The registry derives the vocabulary from `metadata.tags_manual`, so a tag exists exactly while it
  is applied to ≥1 item — two things derive-from-usage cannot do, both needing a real `user_tags` table (or a
  settings list): (a) **create an empty tag** ahead of applying it (a 0-item tag has nowhere to live); (b)
  **rename a user tag** across the vocabulary in one action (today a rename = re-tag every item and the old name
  vanishes everywhere; a `user_tags` row carrying a stable id + display name lets one UPDATE rewrite
  `metadata.tags`/`tags_manual` in bulk). Also unlocks delete-from-vocab and per-tag colour/order. Decide
  table-vs-inline once, alongside folders, in the Epic 26 model reorg.
- [x] **P2 — Rule-based + AI-based tagging and new-tag suggestions.** *(Shipped 2026-06-26, commit 44570ce.)*
  Tag suggestion queue (`tag_suggest.py`): three suggestion sources (rule-based, discovery of untagged
  subreddits/domains, LLM), persistent `tag_suggestions` table, CLI (`categorize --suggest/--review/
  --accept/--reject`), web API (`/tag-suggestions`), 28 tests. Suggestions stay non-destructive + reviewable
  (pending queue, accepted on demand). User-editable rules and AI classify over the untagged tail remain as
  future integration points (the suggestion queue is the infrastructure they feed into).
- [ ] **P3 — Audit Reddit coverage for `ai_ml` tagging.** *(Mobile test 2026-06-29.)* User noticed there
  may be no `ai_ml` tagged Reddit items. Confirm whether the curated taxonomy actually includes `ai_ml` for
  Reddit (vs HN/Firefox/browser buckets), inspect current counts by source, and either add conservative
  subreddit/title/domain rules for Reddit AI/ML communities or document why the existing `coding`/`science`
  buckets intentionally absorb them. Use dry-run samples before applying.
- [x] **P2 — Folder primitive alongside categories + tags.** *(Shipped 2026-06-26, commit 44570ce.)* Decision
  (Q1, resolved 2026-06-26): folders = first-class `metadata.folder` field + `folders` registry table, derived
  from saved queries (not save-time filing — per B5/Epic 21 constraint). `folders.py` evaluation engine:
  `evaluate_folder(id)` runs the saved query and assigns/clears `metadata.folder`. Query filters: source, kind,
  status, tag, subreddit, author, has, q. CLI: `content_hoarder folder {list,create,rename,delete,evaluate,
  assign,stats}`. Web API: `GET/POST /folders`, `PATCH/DELETE /folders/<id>`, `POST /folders/evaluate`.
  Registry supports rename-in-place and empty folders (no P3 user_tags table needed for folder vocabs).
  24 tests. Taxonomy model documented in `docs/taxonomy.md`.
