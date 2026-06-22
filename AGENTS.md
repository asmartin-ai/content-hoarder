# AGENTS.md — context for AI coding agents working on `content-hoarder`

Read this before editing. It captures the architecture, conventions, and the non-obvious gotchas so
you don't reintroduce known bugs.

## What this is
A local-first, **triage-first** manager for saved content from many sources. Thesis: **process and
reduce, not just aggregate**. Phase 1 = import + search + a usable triage UI. Several Phase-2 items now
ship too: LLM assist (`assist/llm.py`, `suggest` / `categorize --llm`), Obsidian export
(`export-obsidian`), and the optional Karakeep push (`promote`). The offline PWA (service worker +
manifest) already ships.

## Stack & run
- Python 3.12, Flask, SQLite (WAL + FTS5 incl. `trigram`), vanilla JS/HTML/CSS. No npm, no cloud.
- `yt-dlp` is optional (YouTube only, **lazy-imported**). `adb` is an external CLI the user runs.
- Run: `python -m content_hoarder <cmd>`. Full command set (see the README CLI table for flags):
  `init-db`, `import`, `enrich`, `categorize`, `dedup`, `consolidate`, `serve`, `stats`, `sources`,
  `bankruptcy`, `decay`, `delete`, `purge-done`, `scan-media`, `export`, `export-obsidian`, `promote`, `suggest`, `learn-triage`,
  `migrate-rsm-threads`, `migrate-firefox-tabs`, `reddit-sync`, `reddit-unsave`, `reddit-oauth`,
  `reddit-hydrate`, `reddit-hydrate-titles`, `reddit-thumbnails`. Web default `127.0.0.1:8788`.
  (`reddit-hydrate --from <bdfr-dir>` is an offline local-archive thread hydrate; `--batch` is the
  rate-limited, resumable backfill — OAuth-preferred when configured, else the cookie.)
- Tests: `python -m pytest` — all offline, `:memory:` SQLite, tiny synthetic fixtures, **no network**.
- **UI / browser tests** (`tests/ui/`, Playwright): `pip install -e .[ui] && playwright install chromium`,
  then `pytest -m ui`. Real headless Chromium at a **Pixel-6** viewport + **PWA-standalone** emulation,
  against the app served in-process on a free port off a **copy** of the live DB with autosync OFF
  (no live mutation, no scheduler). Excluded from the default run (`addopts -m "not ui"`) so unit/CI stay
  browser-free. **Verify any mobile/PWA UI change here** — it catches what unit tests + the preview tool
  miss (mobile viewport, rAF/transitions, gallery view, top-bar collapse). Add a regression test per UI bug.

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
  templates/     index.html (v3 browse) + triage.html + reddit.html + manifest.webmanifest
  static/core/   v3 ES modules: util, api, toast, render, media, swipe, icons + tokens.css
  static/browse/ v3 browse shell: main.js, render.js, reader.js, operators.js, palette.js + browse.css
  static/        legacy still used by /triage + /reddit: app.css, triage.js, reddit.js/.css, sw.js
                 (the v2 app.js + swipe.js were deleted 2026-06-13)
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
- **reddit**: read `/path/to/reddit-saved-manager/data/app.db` (read-only) or its CSV/JSON/MD export →
  `subreddit/permalink/score/over_18` go to `metadata`; `fullname="reddit:<t3_/t1_id>"`.
- **youtube**: `yt-dlp --flat-playlist --dump-single-json <PLAYLIST_URL>` JSON (top-level
  `_type=playlist`, `entries[]`); also a WL array/NDJSON fallback. `url=https://youtu.be/<id>`,
  thumb `https://i.ytimg.com/vi/<id>/hqdefault.jpg`.
- **hackernews**: `favorites?id=<user>` HTML (Harmonic favorites → HN account; the going-forward path) /
  id list / Materialistic `Materialistic.db` (legacy — a `saved` table on newer Room builds, or `favorite`
  on older, with itemid/url/title/time, via `adb backup` NOT `adb pull`; see docs/IMPORTING.md). DB rows
  carry title+url directly; `enrich` fills score via `hacker-news.firebaseio.com/v0/item/<id>.json`.
- **obsidian**: vault folder walk (skip `.obsidian/`, `.trash/`); YAML frontmatter + md body;
  `source_id` = vault-relative path.
- **keep**: Google Takeout `Keep/` per-note JSON (`title`, `textContent`, `listContent[]`, `labels`,
  `color`, `isArchived/Trashed`, timestamps); `metadata.account` separates accounts. `gkeepapi` is
  rejected.

## Triage UI / mobile
- Target browser: **Chrome on Android (Pixel 6)** (switched from Firefox 2026-06-21). Chrome supports
  manifest + service worker + `display:standalone`, installs the PWA as a **WebAPK** (home-screen icon,
  own task), and **does** fire `beforeinstallprompt` — so a custom "Install" button IS viable (capture
  the event, call `prompt()` on tap) rather than a menu-hint fallback. (Note: the `firefox` *connector*
  — tab imports, `migrate-firefox-tabs`, `firefox_youtube` — is unrelated to the PWA target and stays.)
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
- **Transport:** the sanctioned OAuth `save` scope when configured, else the **session cookie + modhash**
  fallback. Cookie/modhash/username live in the `auth_tokens` row `service='reddit_web'`
  (access_token=cookie, refresh_token=modhash); OAuth tokens live in their own `auth_tokens` row.
  Stdlib `urllib` only.
- **`drain()`** (CLI `reddit-unsave --drain`, the "Sync now" button, or a scheduled task) refreshes the
  modhash once, then POSTs `/api/unsave` ~1/sec with 429 backoff. All network is injectable
  (`post=`/`getf=`/`sleep=`) → tests are offline. A dead cookie → `auth_error` (loud), nothing sent.
- **`is_saved` now means "still in the user's Reddit Saved list"** — flipped `1→0` only after a confirmed
  unsave. **Never gate the unsave on it** (the DB may be stale; unsaving an already-unsaved item is a
  Reddit no-op). `merge_upsert` already preserves `is_saved` across re-imports (gotcha #2).
- Run `reddit-unsave --drain` against a **COPY** of `data/app.db` first (it mutates real Reddit state).

## Reddit management view (`/reddit`) — merged from reddit-saved-manager
The RSM interface folded in over the generic `items` table. Full notes: `docs/reddit-management.md`.
- **No schema change:** Reddit fields stay in `metadata`; `web._reddit_view` flattens them to the flat
  shape `static/reddit.js` expects. `db.search_items` has a `subreddit=` filter + `score`/`subreddit` sorts.
- **`reddit_threads` side table** caches post+comment-tree JSON — deliberately NOT in `metadata` (the
  blobs are large and `metadata` is parsed on every row read). Use `db.get/set_reddit_thread`; parse via
  `reddit_thread.py`.
- **One-time thread migration:** `migrate-rsm-threads --from <RSM app.db>` (`rsm_threads.py`) reads RSM
  read-only and re-keys `t3_x`→`reddit:t3_x`. It writes via db helpers (like `firefox_youtube.migrate`),
  so it's exempt from the "connectors never touch the DB" rule — it is NOT a connector.
- **Routes:** `/reddit` + `/reddit/{items,subreddits,stats,sync}`, `/reddit/items/<fn>/{thread,unsave,undo,hydrate}`,
  and `/reddit/unsave/{status,auth,enable,drain,enqueue-by-tag}` (see `web.py` for the authoritative list).
  Unsave enqueues + optimistically flips `is_saved=0`; undo cancels a still-pending unsave locally or live
  re-saves a drained one (the generic `/items/<fn>/resave` primitive still exists). Frontend =
  `reddit.html`/`reddit.js`/`reddit.css` (reskin of RSM, repointed to `/reddit/*`; OAuth/import/export/archival
  controls dropped via JS null-guards).
- **Auth:** OAuth is built — `reddit_oauth.py` + the `reddit-oauth` CLI (installed-app / RedReader client
  id, no secret; `read history identity save` scopes). It ships dormant and is activated once via
  `reddit-oauth --login`; once configured it's preferred over the cookie for reads (hydration, saved-list
  sync) and writes (unsave). The cookie path (`reddit_sync.py`, the `reddit-sync` CLI, `POST /reddit/sync`;
  needs a `reddit_session` cookie) remains the automatic fallback. See `docs/reddit-derisking.md`.

## Hard rules
- Never commit `*.db`, exports, Takeout dumps, or `.env`. Only synthetic fixtures.
- Never expose the web app to the public internet (Tailscale/LAN only).
- Keep tests offline and deterministic.
