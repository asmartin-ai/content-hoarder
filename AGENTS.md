# AGENTS.md — context for AI coding agents working on `content-hoarder`

Read this before editing. It captures the architecture, conventions, and the non-obvious gotchas so
you don't reintroduce known bugs.

## What this is
A local-first, **triage-first** manager for saved content from many sources. Thesis: **process and
reduce, not just aggregate**. Phase 1 = import + search + a usable triage UI. Phase 2 = polish (swipe
animations, offline PWA, metrics, LLM assist, Obsidian export, optional Karakeep push).

## Stack & run
- Python 3.12, Flask, SQLite (WAL + FTS5 incl. `trigram`), vanilla JS/HTML/CSS. No npm, no cloud.
- `yt-dlp` is optional (YouTube only, **lazy-imported**). `adb` is an external CLI the user runs.
- Run: `python -m content_hoarder <cmd>` (`init-db`, `import`, `enrich`, `serve`, `stats`, `sources`,
  `bankruptcy`, `promote`). Web default `127.0.0.1:8788`.
- Tests: `python -m pytest` — all offline, `:memory:` SQLite, tiny synthetic fixtures, **no network**.

## Layout
```
src/content_hoarder/
  config.py     env + .env loader (shell wins; no python-dotenv)
  db.py         schema, FTS5, merge_upsert, search, status/undo/bulk, stats   <-- core
  models.py     new_item()/build_search_text() — the ONLY place items are shaped
  pipeline.py   dispatch -> import_file -> merge_upsert -> enrich; SOLE owner of DB writes
  enrich.py     select sparse rows, call connector.enrich, merge results
  web.py        Flask factory + routes
  cli.py        argparse command dispatch
  connectors/   base.py (BaseConnector ABC + registry); one module per source
  bridge/       karakeep.py (opt-in push of 'keep' items; no-op when unconfigured)
  assist/       llm.py (optional local-LLM suggestions; Phase 2)
  templates/ static/   index.html + triage.html + app.* + triage.* + manifest.webmanifest
```

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
3. **Connectors never touch the DB.** `import_file()` only parses and *yields* normalized dicts (built
   via `models.new_item`). `pipeline.py` owns all writes. Keep it that way — it's why connectors are
   unit-testable with no DB.
4. **Lazy-import heavy/optional deps** (e.g. `import yt_dlp` *inside* the function). A missing optional
   dep must break only its one connector, never `init-db`/`serve`/search.
5. **HTTP is stdlib `urllib`** (HN Firebase, Karakeep push). No `requests`/`httpx`.

## Connector authoring checklist
1. Subclass `BaseConnector`; set `id` (== `items.source`), `label`, `badge_color`.
2. `can_import(path)` = a cheap sniff (extension / filename / dir marker).
3. `import_file(path)` yields `models.new_item(...)` dicts. DB-free.
4. Optional `enrich(items)` to fill sparse rows from an API (stdlib urllib; tolerate per-item failure).
5. Register the instance in `connectors/__init__.py` (`REGISTRY`).
6. Add `tests/test_connector_<id>.py` + a tiny fixture under `fixtures/<id>/`.

## Per-source inputs (v1)
- **reddit**: read `K:\Projects\reddit-saved-manager\data\app.db` (read-only) or its CSV/JSON/MD export →
  `subreddit/permalink/score/over_18` go to `metadata`; `fullname="reddit:<t3_/t1_id>"`.
- **youtube**: `yt-dlp --flat-playlist --dump-single-json <PLAYLIST_URL>` JSON (top-level
  `_type=playlist`, `entries[]`); also a WL array/NDJSON fallback. `url=https://youtu.be/<id>`,
  thumb `https://i.ytimg.com/vi/<id>/hqdefault.jpg`.
- **hackernews**: Materialistic `Materialistic.db` (a `favorite` table with itemid/url/title/time —
  obtained via `adb backup`, NOT `adb pull`; see docs/IMPORTING.md) / id list / `favorites?id=` HTML.
  DB rows carry title+url directly; `enrich` fills score via `hacker-news.firebaseio.com/v0/item/<id>.json`.
- **obsidian**: vault folder walk (skip `.obsidian/`, `.trash/`); YAML frontmatter + md body;
  `source_id` = vault-relative path.
- **keep**: Google Takeout `Keep/` per-note JSON (`title`, `textContent`, `listContent[]`, `labels`,
  `color`, `isArchived/Trashed`, timestamps); `metadata.account` separates accounts. `gkeepapi` is
  rejected.

## Triage UI / mobile
- Target browser: **Firefox on Android (Pixel 6)**. Firefox supports manifest + service worker +
  `display:standalone` but **NOT** `beforeinstallprompt` — do not build a custom install button; show
  a "Firefox menu → Install" hint.
- **Android gesture-nav conflict:** horizontal swipe must NOT trigger system back. Use a ~30px
  `pointerdown` edge **deadzone**, inset the card ~40px from screen edges
  (`margin: max(env(safe-area-inset-*) + 40px, 40px)`, `<meta viewport … viewport-fit=cover>`),
  `touch-action: pan-y`, commit threshold ~80px, and **always** provide Keep/Archive/Done tap buttons.
- Swipe = pointer events + CSS transforms (no library). K / A / D keyboard shortcuts on desktop.

## Working with the local LLM (when an agent delegates codegen)
Qwen3.6 reliably (a) drops `await` on async calls and (b) starves answers with small `max_tokens`.
After any delegated code: grep for un-awaited async calls and `python -m py_compile` the file. Prefer
the Devstral model for pure codegen. Most of this codebase is **synchronous**, so prefer plain
functions over async.

## Reddit unsave-on-Done (`reddit_unsave.py`)
Marking a reddit item **Done** can also unsave it from the user's Reddit *Saved* list. Design:
- **Decoupled queue, drained on demand.** `db.set_status`/`bulk_set_status` enqueue a row into the
  `reddit_unsave` table (gated on the `settings` flag `reddit_unsave_on_done`, **off by default**);
  `undo_status` dequeues a still-`pending` row. The local Done stays instant and never blocks on Reddit.
- **Transport: session cookie + modhash** (no OAuth). Cookie/modhash/username live in the `auth_tokens`
  row `service='reddit_web'` (access_token=cookie, refresh_token=modhash). Stdlib `urllib` only.
- **`drain()`** (CLI `reddit-unsave --drain`, the "Sync now" button, or a scheduled task) refreshes the
  modhash once, then POSTs `/api/unsave` ~1/sec with 429 backoff. All network is injectable
  (`post=`/`getf=`/`sleep=`) → tests are offline. A dead cookie → `auth_error` (loud), nothing sent.
- **`is_saved` now means "still in the user's Reddit Saved list"** — flipped `1→0` only after a confirmed
  unsave. **Never gate the unsave on it** (the DB may be stale; unsaving an already-unsaved item is a
  Reddit no-op). `merge_upsert` already preserves `is_saved` across re-imports (gotcha #2).
- Run `reddit-unsave --drain` against a **COPY** of `data/app.db` first (it mutates real Reddit state).

## Hard rules
- Never commit `*.db`, exports, Takeout dumps, or `.env`. Only synthetic fixtures.
- Never expose the web app to the public internet (Tailscale/LAN only).
- Keep tests offline and deterministic.
