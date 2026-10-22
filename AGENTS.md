# AGENTS.md — context for AI coding agents working on `content-hoarder`

Read this before editing. It captures the architecture, conventions, and the non-obvious gotchas so
you don't reintroduce known bugs.

## What this is
A local-first, **triage-first** manager for saved content from many sources. Thesis: **process and
reduce, not just aggregate**. Phase 1 = import + search + triage UI; Phase 2 ships LLM assist
(`suggest` / `categorize --llm`), Obsidian export (`export-obsidian`), Karakeep push (`promote`), and
the **recovery arc**: `scan-media` (detect deleted media) → `archive-media` (hoard bytes locally) →
`enrich --archives` (recover `[removed]`/`[deleted]` text from PullPush/Arctic-Shift) → per-item
**"↻ Recover"** (`recover_one`, also tries archive.today for media bytes when `media_status='gone'`).
Offline PWA (service worker + manifest) ships.

- Bun + TypeScript 7, SQLite via `bun:sqlite`, Zod validation, HTML/CSS and static ES modules. Local-first; no Node backend or web framework.
- Media archival, scans, YouTube recovery use native TypeScript/HTTP/ffmpeg integrations; do not add a Python sidecar or yt-dlp dependency.
- Run: `bun run src/cli.ts <cmd>` (or `bun run start -- <cmd>`). Full command set + flags: see the README CLI table. Web default `127.0.0.1:8788`.
- Install: `bun install --frozen-lockfile`. Checks: `bun run check` (typecheck, lint, format check, offline Bun tests).
- Tests use synthetic data, temporary/in-memory SQLite, and loopback fixtures; keep them offline and deterministic. Never contact live sync/unsave/archive/publish services or write to the user's database.
- Browser/PWA acceptance uses a synthetic database copy and local server. Never point browser smoke tests at the user's database or enable autosync.

## Layout
```
src/
  models.ts       Zod-validated metadata, raw database rows, item construction
  db.ts           schema, atomic migration, FTS5, merge_upsert, search, triage and audit data
  pipeline.ts     connector dispatch -> import -> merge/enrich; owns import writes
  config.ts       environment + .env configuration
  cli.ts          full command dispatch
  web.ts          public entry re-exporting the HTTP server
  web/            server.ts lifecycle, routes.ts route table, handlers/, http/guard/static/state
  sync/           scheduler.ts autosync tick lifecycle and interval settings
  search_query.ts operator parser (source:/tag:/status:/is:/has:/before:/score:> etc.)
  categorize.ts / dedup.ts / resurface.ts / triage_score.ts / tag_suggest.ts
  consolidate.ts / folders.ts / note_youtube.ts
  archival/       providers.ts, service.ts and shared _http transport
  media_scan.ts / media_archive.ts / media_store.ts / youtube_recover.ts
  connectors/     base.ts, registry.ts and Reddit/YouTube/HN/Twitter/Obsidian/Keep/Firefox sources
  reddit_*.ts     sync, OAuth, unsave, hydration, threads and trickle
  hn_sync.ts / hn_thread.ts / rsm_threads.ts / firefox_tabs.ts / firefox_youtube.ts
  export.ts       CSV/JSON, Obsidian export, Karakeep and PKMS promotion
  assist/llm.ts   optional local-LLM suggestions
  static/         PWA shell and browse ES modules
tests/            offline Bun tests
scripts/          operational scripts (inspect before changing runtime assumptions)
```
**Source-badge icon contract:** a source's avatar glyph flows `core/icons.js` (`D` map of inline-SVG
strings, served by `chIcon(name)`) → `core/render.js` `CH_SOURCES[source] = { icon?, glyph?, token }`
→ `browse/render.js glyph(item)`, which honors `m.icon` (full SVG) → `m.glyph` (1-char) → `source[0]`.
**Never `esc()` the `glyph()` output** — `chIcon` returns trusted HTML and glyph chars are safe;
escaping turns `<svg>` into visible text.

## Data model (one generic `items` table)
PK `fullname = "<source>:<source_id>"` (namespaces every source — no cross-source collisions).
Columns: `source, source_id, kind, title, body, url, author, created_utc, saved_utc, is_saved,
first_seen_utc, last_seen_utc, hydrated_at, status, processed_utc, status_prev, search_text,
metadata (JSON), raw_json`. Source-specific fields (subreddit, channel, score, labels, …) go in the
`metadata` JSON blob — **adding a source needs no schema change**.
Triage: `status ∈ {inbox, keep, archived, done}` (default `inbox`); `processed_utc` set when it leaves
inbox; `status_prev` enables one-step undo.

## NON-OBVIOUS GOTCHAS — do not reintroduce
1. **External-content FTS5 must be backfilled with `INSERT INTO tbl(tbl) VALUES('rebuild')`**, NEVER
   `INSERT … SELECT` (the latter produces an index that returns no MATCH rows). Emptiness is NOT
   detectable by row count (an external-content FTS mirrors the content table on a plain SELECT), so
   gate the one-time build behind a `settings` marker (`fts_built`).
2. **merge_upsert is non-destructive.** On re-import, overlay only *non-empty* incoming fields,
   shallow-merge `metadata`, and **never** overwrite user/triage state
   (`status`, `processed_utc`, `status_prev`, `is_saved`, `metadata.karakeep_id`) or move
   `first_seen_utc` forward. This is what makes multi-source merges + re-imports idempotent.
3. **Connectors never touch the DB.** `importFile()` parses into validated `RawItem` values. `pipeline.ts` owns import writes; keep connector parsing independently testable.
4. **Do not add unnecessary runtime dependencies.** Keep provider-specific parsing and native video/ffmpeg integrations isolated so `init-db` and search do not depend on network tools.
5. HTTP uses the shared transport in `_http.ts`; do not add a second networking convention without a concrete need.
6. **When inspecting `items.metadata` from SQLite, select the full column and parse it with `JSON.parse()`** — never truncate it; late keys (such as galleries and media fields) can be lost.
7. **The recovery chain has two shapes, not one.** `src/archival/providers.ts` has two
   `ArchiveProvider` subclasses (PullPush, Arctic-Shift) that are keyed by Reddit id and return
   recovered text/metadata. `src/archival/service.ts` runs those as the recovery chain. The
   archive.today media provider is URL-keyed, parses HTML, and stores recovered bytes in the
   content-addressed media store; it remains a separate post-chain step and runs only for an item
   whose media is already marked `gone`. It is per-item, never part of bulk recovery. Providers
   treat errors as misses; tests inject transports and byte fetchers rather than contacting services.
8. **Reddit video metadata is `media_type` + `media_url` (often `v.redd.it/...`), not
   `metadata.reddit_video.fallback_url`.** Accept both shapes when deciding which URLs to archive.
9. **Reddit thread cache keys are per-item fullname.** Posts land under `reddit:t3_<id>`; hydrating a
   saved comment stores under `reddit:t1_<id>` unless dual-written. Comment opens must fall back to
   the submission `t3_` key from `metadata.permalink` (see #74 / `reddit_hydrate.submission_fullname`).


## Connector authoring checklist

1. Implement `BaseConnector`; set `id` (== `items.source`), `label`, and `badgeColor`.
2. `canImport(path)` must be a cheap sniff (extension, filename, or directory marker).
3. `importFile(path)` returns validated `RawItem[]`; connectors do not write to SQLite.
4. Optional `enrich(items)` fills sparse rows and tolerates per-item provider failures.
5. Register the connector in `connectors/registry.ts`.
6. Add offline Bun tests with small synthetic fixtures.

## Per-source inputs
Per-source format details (reddit DB/CSV/JSON/MD, youtube `--flat-playlist --dump-single-json` JSON,
HN favorites HTML / Materialistic `Materialistic.db`, obsidian vault walk, Google Keep Takeout JSON)
live in **`docs/IMPORTING.md`**. One gotcha worth keeping here: Materialistic `Materialistic.db` comes
via `adb backup`, **not** `adb pull`.

## Triage UI / mobile
- Target: **Chrome on Android (OnePlus 15)**. Chrome fires `beforeinstallprompt`, so a custom "Install"
  button is viable (capture the event, call `prompt()` on tap) rather than a menu-hint fallback.
  (The `firefox` *connector* — tab imports, `migrate-firefox-tabs`, `firefox_youtube` — is unrelated.)
- **Android gesture-nav conflict:** horizontal swipe must NOT trigger system back. Use a ~30px
  `pointerdown` edge **deadzone**, inset the card ~40px from screen edges
  (`margin: max(env(safe-area-inset-*) + 40px, 40px)`, `<meta viewport … viewport-fit=cover>`),
  `touch-action: pan-y`, commit threshold ~80px, and **always** provide Keep/Archive/Done tap buttons.
  Swipe = pointer events + CSS transforms (no library). K / A / D keyboard shortcuts on desktop.
- **Gallery lightbox = stacked images, NEVER a reddit iframe.** Populated `metadata.gallery[]` →
  `core/media.js openGallery` stacks plain `<img>`s in a `flex-direction:column` `.media-gallery`.
  **Empty/missing `gallery[]`** → a clean placeholder ("Gallery images unavailable (not archived).")
  + "Open on Reddit ↗" link (via `lightbox.openHtml(...)` in `browse/main.js openMediaFor`) — not a
  degraded embed. The iframe fallback
  (`openMedia(permalink)`) is for non-gallery permalink items only.
- Desktop inline action cluster is F/A/D (+IN off-inbox) only; Share lives in the right-click row menu
  (mobile hides `.acts` via `@media(hover:none)` → long-press).

## Reddit unsave-on-Done (`reddit_unsave.ts`)
Marking a reddit item **Done** can also unsave it from the user's Reddit *Saved* list. Off by default,
gated on the `settings` flag `reddit_unsave_on_done`. Full design (decoupled queue, transport, drain):
**`docs/reddit-unsave.md`**. Load-bearing: **`is_saved` means "still in the user's Reddit Saved list"**
— flipped `1→0` only after a confirmed unsave. **Never gate the unsave on it** (the DB may be stale;
unsaving an already-unsaved item is a Reddit no-op). `merge_upsert` preserves `is_saved` across
re-imports (gotcha #2). Run `reddit-unsave --drain` against a **COPY** of `data/app.db` first (it
mutates real Reddit state).

## Reddit management view (`/reddit`)
The RSM view folds over the generic `items` table (no schema change — Reddit fields live in
`metadata`, flattened by `web._reddit_view`). **Full notes: `docs/reddit-management.md`.** Two
invariants worth keeping in-reach: (1) thread trees live in the `reddit_threads` side table, *not*
`metadata` (blobs are large, parsed every row read); (2) `migrate-rsm-threads` and `firefox_youtube`
write via db helpers → exempt from "connectors never touch the DB" (they are NOT connectors).
See `docs/reddit-management.md` + `docs/reddit-derisking.md` before resuming Reddit work.

## Hard rules
- Never commit `*.db`, exports, Takeout dumps, or `.env`. Only synthetic fixtures.
- Never expose the web app to the public internet (Tailscale/LAN only).
- Keep tests offline and deterministic.
