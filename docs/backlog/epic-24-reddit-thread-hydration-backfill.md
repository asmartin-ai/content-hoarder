## Epic 24 — Reddit thread hydration backfill (promote enabler for PKMS)  (`feature`, `area:reddit`)
*From the PKMS session (2026-06-12): `pkms promote` renders saved threads from this DB into
vault reading notes but can only offer hydrated ones — 672 of 55,444. Full feasibility:
`docs/thread-hydration-feasibility.md`. Key facts: NOTHING hydrates today (the RSM migration
was the only writer; the /reddit "Recover" state is a stub); the `reddit_session` cookie path
is validated and returns the exact listing shape `reddit_threads` stores; the promote-priority
slice is the **8,495 posts with non-empty body** (selftext), ~5h resumable batch, ~200–400 MB.*

- [x] **P2 — `reddit-hydrate` CLI + endpoint — SHIPPED: single + `--batch` + `--from`.** Quad batch 2
  winner MiniMax M3 (`cde5b01` on main, + CLI fix `e353da8`): `reddit_hydrate.hydrate_one()`
  fetches `<permalink>.json` via the cookie → `db.set_reddit_thread`; `reddit-hydrate <fullname>`
  CLI + `POST /reddit/items/<fn>/hydrate` endpoint, with status taxonomy (not_found/no_permalink/
  auth_missing/auth_expired/network_error/bad_shape/hydrated). **`--batch` SHIPPED 2026-06-13
  (`f3e6d7d`):** `priority_unhydrated()` (inbox selftext posts w/ permalink, newest-saved first —
  7,335 live) + `hydrate_batch()` — rate-limited (`--throttle` 2s), resumable with no ledger
  (hydrated rows drop out of the priority query), STOPS on a dead cookie, `--dry-run` scope listing
  (zero network). The CLI **approval gate shipped** too: `--batch` is safe-by-default (lists scope)
  and requires `--yes` to actually hit Reddit (double-gate like hard-delete). 7 offline tests; NOT yet
  run against Reddit. **Still open:** the approval gate in the *web* thread viewer + wiring the Recover
  stub there. Skip identity/meme content — don't hydrate all 55k (design language §5).
  - [x] ~~**P3 — `reddit-hydrate --from <bdfr-dir>` (local-archive hydrate).**~~ ✅ SHIPPED 2026-06-13
    (`7140c04` + hardening `30fa648`). `bdfr_to_listing()` converts each BDFR submission to the
    `[post-listing, comments-listing]` blob; `hydrate_from_archive()` walks the dir (offline, no
    cookie), `--limit`/`--include-orphans`/`--overwrite`. **Comment permalink is SYNTHESIZED**
    (`/r/<sub>/comments/<sid>/_/<cid>/`) so the conversion is lossless (not "permalink absent"). **Key
    finding when run:** the archive (now at `F:\Backups\content-hoarder\savedreddit-bdfr-2026-06-12`,
    672 files) was ALREADY fully hydrated in the DB — and the RSM blobs are RICHER (real slugged
    comment permalinks). So `--from` defaults to **skip-already-hydrated** (a first run degraded 565
    blobs before this guard; reverted from backup). Net: the DB supersedes the archive. **The archive
    was DELETED 2026-06-13** (112 MB) after verifying 672/672 fullnames are in `reddit_threads`.
    15 offline tests.
- [x] ~~**P3 — Archive fallback for deleted threads.**~~ Shipped 2026-06-14 (`254cb91` on main —
  bakeoff Batch-4, qwen3p7-plus's diff). A live-fetch HTTP 404 now raises `RedditNotFoundError` →
  `hydrate_one_from_archive` assembles `[post, comments]` from the providers (Arctic-preferred for real
  permalinks), rebuilds the comment tree from flat `parent_id` adjacency (orphans at root, missing
  permalinks synthesized), marks the post `_archive_sourced` (surfaced by `parse_thread`), and the web
  hydrate route maps `"archived"` → 200. Existing cache is never clobbered. Offline-tested (no live 404 round-trip yet).
- [ ] **P3 — port note for Epic 22:** AnkiConnect's default `localhost:8765` collides with
  PKMS's capture service (now live on 8765) — whichever lands second picks a new port.

### Icebox — comment storage evolution *(decision 2026-06-12: KEEP the blob model for now)*
Current: whole thread stored as one JSON blob in `reddit_threads.thread_json`, in a sibling
table (does NOT bloat `items`; loaded only when a thread is opened). This fits the local,
read-mostly, read-whole-thread access pattern. Revisit only when a concrete need below appears
— reactivation condition in parens.
- [x] ~~**Near-term cheap lever: gzip the blob.**~~ ✅ SHIPPED: `db.py:1213` `gzip.compress` on write / `:1200` `gzip.decompress` on read (a bytes-guard keeps legacy uncompressed rows readable), same `thread_json` column, no schema change. Orig: `thread_json` compresses ~5–10× (JSON, SQLite
  stores none compressed). gzip on write / gunzip on read, no schema change. (Reactivate if the
  hydrated DB size becomes a concern — feasibility doc est. ~200–400 MB uncompressed for 8.5k
  threads → ~30–60 MB gzipped.)
- [ ] **Lean middle option: normalize to a `comments` table.** One row per comment with only the
  UI fields (`thread_fullname, parent_id, author, body, score, created_utc, depth`) — smaller than
  the blob AND queryable; tree via adjacency list (`parent_id`). (Reactivate when you want
  sort-in-SQL instead of in-Python, or single-comment writes.)
- [ ] **Advanced: comment search + pagination.** FTS over comment bodies; paginate the few
  multi-thousand-comment monster threads instead of loading the whole tree. Builds on the lean
  table (+ optional materialized-path/closure table for subtree queries). (Reactivate when comment
  search is actually wanted or a giant thread causes a real UX/memory problem.)
