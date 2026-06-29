## Epic 7 — More sources & live sync  (`enhancement`, `area:connectors`)
- [ ] **P2 — Import WL3 + Watch Later.** WL3 via the same `yt-dlp --flat-playlist` flow; main Watch
  Later via a browser-extension export (the connector already accepts a flat array).
- [x] ~~**P2 — Google Keep import.**~~ ✅ SHIPPED: `KeepConnector` imports Google Takeout `Keep/`
  directories or individual note JSON files into `keep:<createdTimestampMs>` note items, including
  checklist body rendering, labels, timestamps, color/archive/trash/pin metadata, URL extraction, and
  conservative dispatch tests. User-data work is only the external Takeout export/import run.
  - [x] ~~Dispatch-hazard fix~~ (quad batch 2 winner Kimi K2.6, `9fa3c04` on main): `KeepConnector`
    no longer claims *any* `.json` directory — it now samples for actual Keep-note markers
    (mirrors `RedditConnector._can_import_dir`), so a BDFR/generic json tree falls through to the
    right connector. Directly protected today's savedreddit import.
- [x] ~~**Firefox tabs connector.**~~ Shipped: parses "Export Tabs URLs (Rich format)" .txt
  (title / url / favicon / window / pinned) → `firefox:<url-hash>` items, de-duped across the
  overlapping daily exports. Imported one sample (326 tabs). OneTab / `recovery.jsonlz4` remain future.
- [x] ~~**Firefox YouTube tabs → YouTube items.**~~ Shipped: a tab whose URL is a YouTube video is
  promoted at import to a real `youtube:<vid>` item (host-guarded id extraction, cleaned title,
  thumbnail, `open_in_firefox` marker) so it merges with Watch Later and is enrichable. One-time
  `migrate-firefox-tabs [--apply]` (dry-run default) re-keys rows imported before this and collapses
  duplicates. Of the 326-tab sample, **219 were YouTube** (2 already saved, 217 orphans); browse them
  via the **"📑 Firefox tabs"** filter (`/items?open_in_firefox=1`).
- [x] ~~**P3 — Import the remaining Firefox TabExports (data job).**~~ Done 2026-06-14: backed up the
  live DB first (`data/app.backup-pre-tabexports-20260614-090812.db`) and looped all **163**
  `*_ExportTabsURLs.txt` through `import … --source firefox`. Result: **0 new rows** — the files were
  ALREADY fully imported in a prior session (the "only 1 sample" premise was stale; 2,269 firefox +
  promoted YouTube items already present). Confirmed idempotent + non-destructive (total/saved/non-inbox
  counts unchanged, 0 errors, DB intact). Backup retained.
- [x] ~~**P2 — Re-surface the Firefox-tabs filter (regression).**~~ Shipped (2026-06-17): the v3-native
  **`is:firefox-tab`** search operator (alias `is:firefoxtab`) filters to `metadata.open_in_firefox=1`,
  including the YouTube-promoted tabs that `source:firefox` misses. `search_query.ParsedQuery.open_in_firefox`
  + `web.py` items() wiring + `operators.js` autocomplete hint + spec line; parse test added.
- [x] ~~**P3 — Live Firefox tab integration (optional manual input ramp).**~~ ✅ Shipped 2026-06-29:
  a local, user-triggered tab-ingest path now exists without Mozilla Account auth: pure Firefox tab
  shaping helpers, a token-gated `POST /import/firefox-tabs`, `firefox-token --generate` to configure the
  local bearer token (hash stored in settings), JSON payload validation, idempotent `merge_upsert`, and
  preserved YouTube-tab promotion. This is the lower-friction manual ramp; it is not background scraping.
  Existing Export Tabs URLs `.txt` remains the stable fallback.
  - **Follow-up / research-only:** account-backed Firefox Sync tabs are still deferred. Firefox Sync stores
    encrypted collection records, not a simple readable account API; a true Sync path needs maintained client
    auth + key-derivation + collection-decryption support before any DB work.
- [ ] **P3 — Live Reddit / YouTube API sync.** When API keys arrive, implement `BaseConnector.sync()`
  using the existing `auth_tokens` table.
- [x] ~~**P2 — HN favorites-page auto-sync (Harmonic → `favorites?id=<user>`).**~~ ✅ SHIPPED:
  `hn_sync.py` + `hn-sync --user <name>` fetch the public HN favorites HTML, follow the "More"
  pagination link, insert bare `hackernews:<id>` rows with `metadata.hn_list='saved'`, and stop at a
  JSON high-water mark (`settings.hn_sync_newest`). Network is behind injectable `getf=`; tests cover
  id extraction, pagination, caught-up stops, first-run marks, idempotent reruns, and soft network errors.
  Enrichment remains the existing `enrich --source hackernews` pass. The one-time Harmonic server-side
  confirmation is still a user workflow check, not a code blocker.
- [x] ~~**Differentiate posted / added-in-source / synced dates (UI).**~~ Shipped: the triage card and
  the browse list now label **posted** (`created_utc`), **added in source** (`saved_utc` — shown only
  when a source actually provides a real save timestamp; today HN/Obsidian/Keep do, Reddit/YouTube
  don't), and **synced here** (`first_seen_utc`). Visible inline + full absolute-date tooltip.
- [ ] **P3 — Per-item "added to playlist / Watch Later" date (needs API).** User wants "added to this
  playlist 1 day ago". Source: YouTube Data API `playlistItems.list` → `snippet.publishedAt` (the moment
  an item was added to the playlist) — **API key** for public playlists, **OAuth** for Watch Later.
  `yt-dlp --flat-playlist` does not expose it, so this is gated on `feat/reddit-oauth`-style API work.
  Store it in `saved_utc` (or `metadata.added_to_playlist_utc`) so the existing date display picks it up.
  Note: **Reddit's save-date is genuinely unavailable** — no cookie/OAuth endpoint returns *when* you
  saved an item (`saved.json` gives newest-first *order* only, no timestamp). Don't chase it.
- [ ] **P3 — Needs the API (keyless not possible — except (a), now shipped):** (a) ✅ **inline gallery rendering SHIPPED on v3** (`core/media.js:110` `openGallery` + `browse/main.js:184` dispatch + `🖼 N` badge); was: ~~render **Reddit gallery images** inline — the
  archives keep `is_gallery` but drop `media_metadata`~~ **CORRECTION (2026-06-03 probe):** the archives
  DO return `media_metadata` with full gallery image URLs — inline gallery rendering is keyless-feasible
  via the archive fetch; folded into [`docs/reddit-media-refinement.md`](docs/reddit-media-refinement.md)
  (Epic 4 spec); (b) the true **"date added to Watch Later"** for YouTube (`playlistItems.publishedAt`)
  still needs OAuth. Keyless stopgaps already shipped: galleries relabel to "🖼 Gallery"; sort by
  **playlist position**; score/upvote hydration via the archives (`enrich --source reddit --scores`).
- [x] ~~**P2 — Twitter / X bookmarks as a content source (new connector).**~~ ✅ SHIPPED:
  `TwitterConnector` parses browser-exported JSON/CSV and nested X GraphQL tweet shapes into
  `twitter:<tweet_id>` rows without API calls or DB writes. It captures tweet text, author handle/name,
  canonical permalink, created time, outbound links, quote/reply context, images normalized to
  `?name=orig`, highest-bitrate MP4 video variants, and poster thumbnails; dispatch is conservative and
  fixture-tested. Follow-ups remain optional: local capture userscript/bookmarklet, NSFW policy, and richer
  quote/thread UI.
