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

## Stack & run
- Python 3.12, Flask, SQLite (WAL + FTS5 incl. `trigram`), vanilla JS/HTML/CSS. No npm, no cloud.
- `yt-dlp` optional (YouTube only, **lazy-imported**); `adb` is an external CLI the user runs.
- Run: `python -m content_hoarder <cmd>`. Full command set + flags: see the README CLI table.
  Web default `127.0.0.1:8788`. (`reddit-hydrate --from <bdfr-dir>` = offline local-archive hydrate;
  `--batch` = rate-limited resumable backfill — OAuth-preferred when configured, else the cookie.)
- Tests: `python -m pytest` — all offline, `:memory:` SQLite, synthetic fixtures, **no network**.
- **UI / browser tests** (`tests/ui/`, Playwright): `pip install -e .[ui] && playwright install chromium`,
  then `pytest -m ui`. Real headless Chromium at a **Pixel-6** viewport + **PWA-standalone** emulation,
  against the app served in-process off a **copy** of the live DB with autosync OFF (no live mutation,
  no scheduler). Excluded from the default run (`addopts -m "not ui"`). **Verify any mobile/PWA UI
  change here** — it catches what unit tests + the preview tool miss. Add a regression test per UI bug.
  If `playwright install chromium` is blocked by local TLS/corporate certs, system Chrome can run the
  suite with `pytest -m ui --browser-channel chrome`. If `data/app.db` is absent in a sandbox, point
  `CONTENT_HOARDER_DB` at a temporary synthetic DB with enough rows for the smoke tests; never commit it.

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
  archival/     recovery chain: providers.py (PullPush, Arctic-Shift, **archive.today**) +
                 service.py (recover bulk / recover_one per-item) + _http.py (shared urllib transport)
  media_scan.py probe saved Reddit media for deletions -> metadata.media_status (gone/salvageable)
  media_archive.py hoard the bytes: download + store via media_store (content-addressed, /media/<blob>)
  media_store.py content-addressed blob store under data/media/ (dedup, served same-origin)
  youtube_recover.py deleted YouTube title recovery via Wayback Machine
  hn_thread.py   HN comment-thread viewer backend — Algolia fetch + parse into the reddit_thread
                 render shape, cached in the (source-agnostic) reddit_threads table; served by
                 GET /hackernews/items/<fn>/thread. Backend-only (no thread-render UI yet).
  search_query.py the operator parser (source:/tag:/status:/is:/has:/before:/score:> etc.)
  categorize.py heuristic tagger (processing areas + multi-label topics) backing `categorize`
  consolidate.py fold reddit-post/HN-story/firefox-tab -> youtube:<id> (`consolidate`)
  dedup.py      duplicate detection + reversible resolve (`dedup`)
  export.py     CSV/JSON + Obsidian export + Karakeep promote (`export`, `export-obsidian`, `promote`)
  resurface.py  decay/snooze resurfacing logic (`decay`, `bankruptcy`)
  triage_score.py the transparent likely-to-process model (`learn-triage`)
  _http.py      shared stdlib urllib request helper (HN, Karakeep, archival — no requests/httpx)
  connectors/   base.py (BaseConnector ABC + registry); one module per source
  bridge/       karakeep.py (opt-in push of 'keep' items; no-op when unconfigured)
  assist/       llm.py (optional local-LLM suggestions; Phase 2)
  reddit_*.py   reddit_unsave / reddit_sync / reddit_oauth / reddit_thread / reddit_hydrate / reddit_trickle / rsm_threads
  firefox_youtube.py tab->youtube promotion + migrate-firefox-tabs (exempt from "connectors never touch DB")
  templates/     index.html (v3 browse) + triage.html + reddit.html + manifest.webmanifest
  static/core/   v3 ES modules: util, api, toast, render, media, swipe, icons + tokens.css
  static/browse/ v3 browse shell: main.js, render.js, reader.js, operators.js, palette.js + browse.css
  static/        legacy still used by /triage + /reddit: app.css, triage.js, reddit.js/.css, sw.js
scripts/        standalone harnesses: recover_archive_today (archive.today live-smoke probe),
                 rehearse_decay / rehearse_triage_score (dry-run previews), serve_branch_verify /
                 serve_browse_test (local-serve smoke helpers)
```
**Source-badge icon contract:** a source's avatar glyph flows `core/icons.js` (`D` map of inline-SVG
strings, served by `chIcon(name)`) → `core/render.js` `CH_SOURCES[source] = { icon?, glyph?, token }`
→ `browse/render.js glyph(item)`, which honors `m.icon` (full SVG) → `m.glyph` (1-char) → `source[0]`.
**Never `esc()` the `glyph()` output** — `chIcon` returns trusted HTML and glyph chars are safe;
escaping turns `<svg>` into visible text. The triage (`triage.js`) + reddit views have their own markup
and don't use `glyph()`.

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
6. **When inspecting `items.metadata` from sqlite, `SELECT` the full column and `json.loads()` it** —
   never `substr(metadata,1,N)`. JSON keys sort alphabetically, so a 400-char truncation hides late
   keys (e.g. `gallery`, `media_type` sit after `author`/`body`) and makes a populated row look empty.
7. **The recovery chain has two shapes, not one.** `archival/providers.py` holds both:
   - `ArchiveProvider` subclasses (PullPush, Arctic-Shift) are **reddit-id-keyed + JSON +
     metadata-only** — `recover_one()` loops them by *bare base36 id* and takes the first that
     returns `meaningful=True` (a real title/body).
   - `ArchiveTodayProvider` is **URL-keyed + HTML + media-bytes** — it does NOT subclass
     `ArchiveProvider` (that contract can't express "look up by original URL, parse HTML, return
     image bytes"). It's wired into `recover_one()` as an explicit **post-chain step**
     (`_try_archive_today`) that runs *only when `media_status='gone'`* after PullPush/Arctic — it
     fetches `archive.ph/newest/<original_url>`, extracts `og:image` + inlined `<img>`s, and stores
     bytes via `media_store` (→ `metadata.archived_media` + `media_status='recovered_archive_today'`).
     Don't try to fold it into the id-keyed loop; its inputs and outputs are a different shape.
   Both are loud-fail tolerant: a provider raising/403ing is a soft miss, never a crash. Fetcher +
   byte-fetcher are injectable → `tests/test_archive_today.py` is fully offline. Per-item only
   (archive.today is Cloudflare-gated, ~2s throttle, no bulk API) — never wire it into a bulk pass.
8. **Reddit video metadata is `media_type` + `media_url` (often `v.redd.it/...`), not `metadata.reddit_video.fallback_url`.** Spec 11-era docs assumed a nested `reddit_video` blob; live rows frequently only have `media_type=reddit_video` and a bare `media_url`. `media_archive._video_evidence_urls` already accepts both shapes.
9. **Reddit thread cache keys are per-item fullname.** Posts land under `reddit:t3_<id>`; hydrating a saved comment stores under `reddit:t1_<id>` unless dual-written. Comment opens must fall back to the submission `t3_` key from `metadata.permalink` (see #74 / `reddit_hydrate.submission_fullname`).


## Connector authoring checklist
1. Subclass `BaseConnector`; set `id` (== `items.source`), `label`, `badge_color`.
2. `can_import(path)` = a cheap sniff (extension / filename / dir marker).
3. `import_file(path)` yields `models.new_item(...)` dicts. DB-free.
4. Optional `enrich(items)` to fill sparse rows from an API (stdlib urllib; tolerate per-item failure).
5. Register the instance in `connectors/__init__.py` (`REGISTRY`).
6. Add `tests/test_connector_<id>.py` + a tiny fixture under `fixtures/<id>/`.

## Per-source inputs
Per-source format details (reddit DB/CSV/JSON/MD, youtube `--flat-playlist --dump-single-json` JSON,
HN favorites HTML / Materialistic `Materialistic.db`, obsidian vault walk, Google Keep Takeout JSON)
live in **`docs/IMPORTING.md`**. One gotcha worth keeping here: Materialistic `Materialistic.db` comes
via `adb backup`, **not** `adb pull`.

## Triage UI / mobile
- Target: **Chrome on Android (Pixel 6)**. Chrome fires `beforeinstallprompt`, so a custom "Install"
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
  + "Open on Reddit ↗" link (via `lightbox.openHtml(...)` in `browse/main.js openMediaFor` and the
  `data-gallery-embed` gate in `triage.js .rd-preview-lg`) — not a degraded embed. The iframe fallback
  (`openMedia(permalink)`) is for non-gallery permalink items only.
- Desktop inline action cluster is F/A/D (+IN off-inbox) only; Share lives in the right-click row menu
  (mobile hides `.acts` via `@media(hover:none)` → long-press).

## Working with the local LLM (when an agent delegates codegen)
Qwen3.6 reliably (a) drops `await` on async calls and (b) starves answers with small `max_tokens`.
After any delegated code: grep for un-awaited async calls and `python -m py_compile` the file. Prefer
the Devstral model for pure codegen. Most of this codebase is **synchronous**, so prefer plain
functions over async.

## Reddit unsave-on-Done (`reddit_unsave.py`)
Marking a reddit item **Done** can also unsave it from the user's Reddit *Saved* list. Off by default,
gated on the `settings` flag `reddit_unsave_on_done`. Full design (decoupled queue, transport, drain):
**`docs/reddit-unsave.md`**. Load-bearing: **`is_saved` means "still in the user's Reddit Saved list"**
— flipped `1→0` only after a confirmed unsave. **Never gate the unsave on it** (the DB may be stale;
unsaving an already-unsaved item is a Reddit no-op). `merge_upsert` preserves `is_saved` across
re-imports (gotcha #2). Run `reddit-unsave --drain` against a **COPY** of `data/app.db` first (it
mutates real Reddit state).

## Reddit management view (`/reddit`) — *iceboxed*
The RSM view folds over the generic `items` table (no schema change — Reddit fields live in
`metadata`, flattened by `web._reddit_view`). **Full notes: `docs/reddit-management.md`.** Two
invariants worth keeping in-reach: (1) thread trees live in the `reddit_threads` side table, *not*
`metadata` (blobs are large, parsed every row read); (2) `migrate-rsm-threads` and `firefox_youtube`
write via db helpers → exempt from "connectors never touch the DB" (they are NOT connectors).
Active work paused; see `docs/reddit-management.md` + `docs/reddit-derisking.md` before resuming.

## Hard rules
- Never commit `*.db`, exports, Takeout dumps, or `.env`. Only synthetic fixtures.
- Never expose the web app to the public internet (Tailscale/LAN only).
- Keep tests offline and deterministic.
