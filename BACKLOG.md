# content-hoarder — feature backlog

Deferred ideas, grouped into epics. Each checkbox item is written to drop straight into a GitHub
issue (title = the bold line; body = the notes under it). Priorities: **P1** soon · **P2** next ·
**P3** someday. Suggested labels in `(…)`.

> When the repo is on GitHub: create the epics as Milestones (or `epic:*` labels) and paste each
> item as an issue. Templates live in `.github/ISSUE_TEMPLATE/`.

---

## Epic 1 — Content categorization: listenable / watch / wotagei  (`enhancement`, `area:youtube`)
*Motivation: many Watch-Later videos are "listenable" (music, podcasts, long-form discussion à la
Isaac Arthur / Perun) and can be processed passively; wotagei (ヲタ芸) should be handled in its own
area. Goal: tag videos so they can be filtered into dedicated "processing areas".*

- [x] ~~**Heuristic categorizer (no LLM first).**~~ Shipped: `categorize.py` + CLI `categorize`
  (`listenable`/`watch`/`wotagei`/`unknown` from duration ≥30min, a channel allowlist, and a wotagei
  title-keyword), stored on `metadata.category`. First run on WL2: listenable 626 / watch 1315 /
  wotagei 3 / unknown 3054 — re-tune the allowlist + thresholds in `categorize.py`.
- [x] ~~**"Processing areas" = category filters.**~~ Shipped: a category facet on `db.search_items`
  + `/items?category=` + the `#category` selector in the browse topbar.
- [x] ~~**Local-LLM auto-classify (`assist/llm.py`).**~~ Shipped: `llm.classify`/`classify_source`
  classify into listenable/watch/wotagei/unknown via the injectable `_chat`, stored on
  `metadata.category` + `category_source='llm'`; CLI `categorize --llm [--source --limit --all]`.
  By default re-classifies the `NULL`/`unknown` tail (preserves confident heuristic/manual categories);
  `--all` re-does every item. Offline tests inject `chat=`. Manual override remains `POST /items/<fn>/category`.
- [x] ~~**P3 — Widen wotagei detection vocabulary.**~~ Shipped (trio/quad batch 2 winner GLM-5.1,
  `b6baa07` on main): `_WOTAGEI_RE` now also matches `otagei`/`打ち師`/`サイリウムダンス`/
  `ペンライトダンス`/`cyalume` (word-boundaried for precision; bare penlight/サイリウム excluded).
  Further idol-event/performer/channel terms can still be appended as the user supplies them.
- [x] ~~**Manual re-tagging UI.**~~ Shipped: a category chip-row on the triage card (youtube items)
  + `POST /items/<fn>/category` (validated, non-destructive). List-row picker left out to avoid
  clutter — triage is the focused single-item view.

## Epic 2 — YouTube metadata enrich  (`enhancement`, `area:youtube`)
*Motivation: `--flat-playlist` captures duration/channel but NOT category/tags/description, which
the categorizer (Epic 1) wants for accuracy.*

- [x] ~~**Per-video enrich pass.**~~ Shipped: `YouTubeConnector.enrich()` runs
  `yt-dlp --dump-single-json` per video to fill exact `duration`/`view_count`/`yt_categories`/`tags`/
  `description`/`channel`; `enrich --source youtube [--limit N]`, resumable via `hydrated_at`, lazy
  yt-dlp, unavailable videos stamped. (Full ~5k run deferred — slow; chunk with `--limit`.)

## Epic 3 — Recover deleted / private YouTube titles  (`enhancement`, `area:recovery`)
*Motivation: many WL items show as `[Private video]` / `[Deleted video]` with no title.*

- [x] ~~**Deleted-title recovery (opt-in enrich).**~~ Shipped: `youtube_recover.py` queries the
  **Wayback Machine** (availability API → snapshot → og:title) for `[Private/Deleted video]` items via
  `enrich --source youtube --titles [--limit N]`; non-destructive, resumable (`metadata.wayback_tried`),
  records `title_source`. Live sample recovered 1/3 (good for once-public *deleted*, nil for *private*,
  as expected). **filmot.com** is a future provider (needs an API key) — the HTTP fetcher is injectable.
  Refs: [filmot.com](https://filmot.com), [phloof/youtube-recovery-tool](https://github.com/phloof/youtube-recovery-tool).

## Epic 4 — Recover deleted Reddit content  (`enhancement`, `area:recovery`)
*Motivation: many saved posts/comments are now `[removed]`/`[deleted]`.*

- [x] ~~**Port the RSM `archival/` package.**~~ Shipped: `content_hoarder/archival/` (PullPush.io +
  Arctic-Shift, stdlib-only, non-destructive overlay, resumable via `hydrated_at`) behind
  `enrich --source reddit --archives [--limit N] [--all]`. Targets `[removed]`/`[deleted]` items and
  un-hydrated comment bodies. Refs: [pullpush.io](https://pullpush.io),
  [ArthurHeitmann/arctic_shift](https://github.com/ArthurHeitmann/arctic_shift).
- [x] ~~**On-demand single-item recovery in the UI.**~~ Shipped: `archival.recover_one()` +
  `POST /items/<fn>/recover` + a "↻ Recover" button on `[removed]`/`[deleted]` reddit cards that
  patches the title/body in place (throttle off).
- [x] ~~**P3 — Refine media metadata from the same fetch.**~~ Shipped: the archive fetch
  (`enrich --source reddit --scores`) now extracts `post_hint`/`is_video`/`is_gallery`/`media`/`preview`/
  `thumbnail` and splits the catch-all `reddit_media` bucket (~85% of reddit items) into precise
  `image`/`reddit_video`/`gallery` with real thumbnails + `media_url`; `media_type` overrides the
  URL-heuristic value non-destructively, videos keep a navigable permalink. Spec + as-built notes:
  [`docs/reddit-media-refinement.md`](docs/reddit-media-refinement.md).
- [x] ~~**Inline gallery image arrays (from `media_metadata`).**~~ Shipped: the archive fetch now
  extracts ordered full-size gallery URLs (`providers._gallery` from `gallery_data` + `media_metadata`)
  into `metadata.gallery`; the browse media-modal renders them as an inline stacked lightbox
  (`openGallery` in `app.js`, routed via a `data-gallery` attribute). Populated for all gallery items
  on the next `enrich --source reddit --scores` pass. (Triage-card inline gallery still TODO.)
- [~] **P1 — Hoard the BYTES, not just the link: local media archiving.** ✅ **Infra + the big images pass DONE** (Epic 4: `media_store.py` blob store + `archive-media`/`scan-media` CLI + same-origin `/media/<blob>` route + prefer-local frontend, on main). **Live run 2026-06-22:** `scan-media` classified deletions (2,394 `gone`, 32 salvaged); galleries + salvageable archived; the bulk **images** pass archived **22,052 blobs (98.9% ok, 249 already-deleted)** → **`data/media/` = 32,506 blobs / 18 GB**, **25,706 items now carry a local copy** that survives remote deletion (frontend already prefers it + falls back on 404). **Remaining:** (a) `v.redd.it` **videos** (7,012 — phase 4, not started); (b) the deleted/non-image **tail** (~627, mostly unrecoverable → see the archive.today / RedGifs / RepostSleuth recovery items above); (c) **at-save-time** archiving for *new* saves (catch deletions early). ⚠️ **`data/media/` is the ONLY copy** — gitignored, NOT in the metadata-only DB backups → **needs a separate backup.** *(User-requested 2026-06-20; images pass run 2026-06-22.)*
  **Problem (core to the "hoarder" mission):** we store *URLs*, not media. When reddit deletes an image the
  app shows reddit's "if you're looking for an image, it was probably deleted" placeholder and it's gone for
  good — confirmed 2026-06-20 on `reddit:t3_1u69n0s` (r/196 "rule"): `i.redd.it/9pxkje0ife7h1.jpeg` → 404
  (1048-byte placeholder), **every** `preview.redd.it` size also 404, PullPush has no record, Arctic-Shift has
  only metadata + the now-dead preview URLs, and the Wayback Machine never captured the bytes (only
  post-deletion redirects). Our DB backups are **metadata-only**, so they can't restore it either. The bytes
  were never on our disk. **Feature — an opt-in media-archiving pass** that downloads + stores the actual
  bytes for saved items so deletions are survivable:
  - **What to archive (phase order):** (1) reddit images (`i.redd.it`, direct image `url`/`media_url`), (2)
    gallery images (`metadata.gallery[*]`), (3) video posters/thumbnails; (4) *maybe later* full videos
    (`v.redd.it` DASH — large, separate opt-in). YouTube keeps its remote thumbnails (rarely deleted).
  - **Storage:** files on disk under e.g. `data/media/<sha256>.<ext>` (content-addressed → free dedup across
    reposts), NOT DB blobs (keeps the 500 MB DB lean + backups fast). Track in a `media_blobs` table or
    `metadata.archived_media` (original_url → local hash, bytes, mime, fetched_utc). Mind volume: tens of
    thousands of images = multi-GB; add a size cap / per-run `--limit` / skip-if-present (resumable, mirrors
    the enrich passes). `data/media/` must be gitignored.
  - **Serving + the SW win:** serve archived bytes from a **same-origin** route (`/media/<hash>` or
    `/media?url=<orig>`). Today the service worker **can't** cache reddit media because it skips cross-origin
    (`sw.js:40`); a same-origin media route flips that — the SW (and HTTP cache) will cache it, so the PWA
    works offline and survives remote deletion. Frontend (`core/media.js` `thumb()`/`imageUrl()` +
    `openGallery`/reader) prefers the local archived copy when present, and **falls back to it when the remote
    404s** (an `onerror` swap to `/media/<hash>`). This also unblocks Epic 12's OCR (needs local image bytes).
  - **When:** an `archive-media` CLI pass (enrich-style: dry-run, `--limit`, `--source`, resumable) the user
    runs over the backlog; later optionally at save/sync time for *new* saves (catch deletions early — the
    whole point). Keep it opt-in + throttled (respect the reddit de-risking rate floors).
  - **Recovery of EXISTING deleted items (partial, do first):** for items whose `i.redd.it` is already 404,
    `preview.redd.it` *sometimes* outlives the original — a recovery sub-pass can try the archive's preview
    URLs and Wayback, and archive whatever still resolves. Won't save `t3_1u69n0s` (all dead) but will save
    the subset caught in the preview-survival window. Scope it by first counting saved image items whose
    `i.redd.it` now 404s and how many have a still-live `preview.redd.it`.
  Relates to Epic 4 (recovery), Epic 12 P3 (OCR needs bytes), Epic 8 (infra/storage), and the SW
  cross-origin note in `sw.js`. Sizable — sequence: storage model + `/media` route + `archive-media` pass
  first; the remote-404→local fallback in the frontend second; full-video archiving last.

- [ ] **P2 — `archive.today` (archive.ph) as a recovery provider.** *(Research 2026-06-22.)* Add a
  best-effort recovery source alongside the existing Wayback path in `archival/`. `archive.today` runs a
  **different crawler** than the Wayback Machine (it's the single most-used link archiver — ~44% share vs
  Wayback's ~29%) and stores **text + inlined images**, so it frequently holds snapshots Wayback missed —
  widening coverage on the already-dead set (`media_status='gone'`, ~2,394 items today). Per-URL, on-demand:
  query `archive.ph/newest/<original_url>` (or the timemap), parse the snapshot for the og:image / inlined
  media, and if the bytes resolve, store them via `media_store` like the rescue sub-pass. **Wire it into the
  existing `recover_one()` / "↻ Recover" path** (Epic 4), NOT a bulk pass — `archive.today` is Cloudflare-gated,
  rate-limited, and has no bulk API, so it's a low-volume, per-item, last-resort lookup. Fetcher stays
  injectable for offline tests. Relates to Epic 4 P1 (hoard the bytes) + the Wayback provider in
  `archival/providers.py`. Refs: [archive.today](https://archive.today).
- [ ] **P2 — RedGifs resolver for the ~1,090 dead Gfycat links.** *(Research 2026-06-22.)* Gfycat shut down
  **2023-09-01** (all bytes deleted), so the **1,090** `gfycat.com` `media_url` items in the corpus are dead —
  but Gfycat's **NSFW** content migrated to **RedGifs under the same id** (lowercase→CamelCase, e.g.
  `lazyfatcat` → `LazyFatCat`), and RedGifs has a real **v2 API** + a temporary-token auth flow. A `redgifs`
  resolver: extract the Gfycat id from the dead URL, resolve it on RedGifs (`/v2/gifs/<id>`), and if it
  resolves, rewrite `media_url`/`media_type` to the live RedGifs media (and optionally archive the bytes per
  Epic 4 P1). Bounded, concrete set; **SFW Gfycat is mostly just gone** (try Wayback only). Mind: RedGifs is
  NSFW-domain — gate behind the same opt-in as the `nsfw_*` tooling. Old `gfycat.com` NSFW links also redirect
  via `gifdeliverynetwork.com` → RedGifs. Relates to Epic 4 (recovery) + Epic 9 (NSFW handling). Refs:
  [redgifs API docs](https://redgifs.readthedocs.io/en/stable/migrating.html),
  [gallery-dl #874](https://github.com/mikf/gallery-dl/issues/874).
- [ ] **P3 — RepostSleuth reverse-image-hash recovery (spike).** *(Research 2026-06-22.)* Novel recovery angle
  for **already-deleted** images: even when the original `i.redd.it` is 404, a still-**live repost** of the same
  image elsewhere on Reddit can be found via perceptual-hash lookup against RepostSleuth's index (undocumented
  API at `repostsleuth.com`; the bot u/repostsleuthbot is the public face). For a `gone` item we can query by the
  original Reddit **submission id / url** (which RepostSleuth indexed before deletion) and, if it returns a live
  duplicate post, pull *that* post's still-live image and archive the bytes. **Spike first** — the API is
  undocumented + may have broken with Reddit's API changes, hashing is JPEG-compression-sensitive, and it only
  helps images popular enough to have been reposted — so validate hit-rate on a sample of `gone` items before
  building a provider. High upside for memes / popular images; nil for one-off personal uploads. Relates to
  Epic 4 (recovery) + Epic 6 (dedup already hashes). Refs:
  [RedditRepostSleuth (GitHub)](https://github.com/barrycarey/RedditRepostSleuth).

## Epic 5 — Inbox redesign follow-ups  (`enhancement`, `area:ui`)
*Shipped: bigger cards + list swipe + undo snackbar; **sources as top tabs**; **status as a left
sidebar** (with counts) + mobile hamburger drawer; **Gmail-style swipe-reveal icons** (trash/keep);
import modal; Keep/Archive/Done legend. Remaining patterns (ref
[team-inbox/inbox-reborn](https://github.com/team-inbox/inbox-reborn)):*

- [x] ~~**Sources as top tabs.**~~ Shipped (`#source-tabs`).
- [x] ~~**Status as a left sidebar.**~~ Shipped (`#status-nav` + mobile drawer).
- [x] ~~**Triage card parity.**~~ Shipped: Tinder-style swipe stamps + an inline Reddit click-to-load
  embed on the triage card.
- [ ] **P3 — Smooth drag-and-drop to buckets.** Drag cards onto category/status buckets.
  [SortableJS](https://github.com/SortableJS/Sortable) (~20 KB, touch-capable) or
  [html5sortable](https://github.com/lukasoppermann/html5sortable) (~4 KB).
- [ ] **P3 — Consolidate triage swipe onto `swipe.js`.** Refactor `triage.js` to use the shared
  `window.attachSwipe` helper (now also drives the list's icon reveal). Keep the verified behavior.
- [x] ~~**Cross-filtered counts.**~~ Shipped: `/stats?source=` + `/sources?status=` cross-filter the
  sidebar status counts and the source-tab counts (the tab list stays stable at 0).

- [x] ~~**Card-view text clipping.**~~ Fixed in the v2 row pass: card is now card-head + adaptive
  hero + a bottom tag/action row (no fixed crop, no title overlap).
- [ ] **P2 — Categories in the sidebar / as a tag type.** Move the category facet into the left rail
  (like status + tags); consider modeling "processing areas" as a reserved tag namespace so one filter
  UI covers both. Touches `categorize.py` buckets + the rail + `search_items`.
  **→ folded into Epic 26 (tag & category taxonomy reorganization, 2026-06-17).**
- [ ] **P3 — Zoom into the image / gallery modal.** Scroll/pinch-to-zoom (+ pan) in the media lightbox
  and gallery viewer (`openImage`/`openGallery` in `app.js`).
- [ ] **P2 — Rework the keyboard controls.** *(User-requested 2026-06-08.)* The current map (browse
  J/K · S/E/Y · X; triage S/E/Y) needs a redesigned, more ergonomic one-hand scheme — propose a new
  mapping for review. (The `?` cheatsheet already ships.)
- [x] ~~**P2 — Share button on items.**~~ ✅ SHIPPED 2026-06-22 (browser-verified): Web-Share with clipboard fallback, sharing the **source permalink** — `shareItem()` in `core/render.js` (navigator.share on mobile; clipboard + "Link copied" toast on desktop; reuses `itemUrl()` per source). On the row/card action cluster (`browse/render.js` actsHtml, `data-share`; hidden on touch ROWS where swipe owns the acts, shown on cards) + the reader header (`#reader-share`). Tabler share icon, SW v63. *(User-requested 2026-06-17.)* Orig scope: Add a Share affordance to the item
  (row/card + reader). **Open scope:** native Web Share API (`navigator.share` — works on the mobile PWA,
  falls back to clipboard on desktop) vs. a plain "copy permalink" button; and decide *what* is shared — the
  source permalink (reddit/HN/youtube/firefox URL) vs. a deep-link back into content-hoarder. Lean
  Web-Share-with-clipboard-fallback so it works on the Pixel-6 target.
- [ ] **P2 — Defer/Skip as a first-class triage action.** ⏳ **Skip half ✅ SHIPPED** (triage-skip: a no-decision "pass / show next" via button + Space, on main); the **timed Defer/Snooze** half (`metadata.snoozed_until`) is still pending. *(User-requested 2026-06-19.)* A "decide later"
  action available everywhere triage happens (triage card + browse row + reader), not just a swipe gesture —
  surfaced as a button + keyboard key alongside Keep/Archive/Done, and reversible like the other actions.
  **Two distinct behaviors to decide between (or ship both):** (a) **Skip** = a no-decision "pass, show me the
  next" that just advances within the current batch without changing status or persisting anything; (b)
  **Defer/Snooze** = a *timed* deferral that hides the item from triage batches for a window
  (`metadata.snoozed_until`) then quietly resurfaces it. Honors the project guardrails: friction-asymmetry
  (defer is priced above Done/Archive, never the cheapest gesture), no guilt mechanics (no "snoozed 3×!"
  badges), and after N defers an item flows into the Epic 21 guilt-free decay path. **Unify with — don't
  duplicate —** the Epic 20 P2 "4-way swipe: Snooze on the unassigned long-left" item (that's the *gesture*
  binding of this same action) and the Epic 21 snooze-decay escalation. Relates to Epic 5 keyboard rework +
  Epic 10 (a skipped/deferred item is a weak training signal — decide whether it counts).

## Epic 6 — Duplicates v2  (`enhancement`, `area:ui`)
*The first cut was removed: the "duplicate group" naming confused, and placeholder titles created
false positives.*

- [x] ~~**Redesign de-duplication (v2).**~~ Shipped: `dedup.py` non-destructive flag + reversible
  resolve via CLI `dedup [--by url|title] [--resolve] [--clear]`. **Excludes placeholder titles**
  (`[removed]`/`[deleted]`/`[Private video]`/`[Deleted video]`); URL grouping **keeps the query string**
  (a real-data scan caught the old code collapsing every `youtube.com/watch?v=…` into one group).
- [ ] **P3 — Duplicates review UI.** A clear "possible duplicates" surface (group cards → keep one,
  archive the rest) built on `dedup.find_groups`. The prior modal was removed for confusing UX —
  rebuild minimally; the CLI already does the work non-destructively.

## Epic 7 — More sources & live sync  (`enhancement`, `area:connectors`)
- [ ] **P2 — Import WL3 + Watch Later.** WL3 via the same `yt-dlp --flat-playlist` flow; main Watch
  Later via a browser-extension export (the connector already accepts a flat array).
- [ ] **P2 — Google Keep import.** Per-account Takeout → `import path/to/Keep` (connector exists;
  just needs the export).
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
- [ ] **P3 — Live Firefox tab integration (optional manual input ramp).** *(User idea 2026-06-17.)*
  Today Firefox tabs enter only via the manual "Export Tabs URLs (Rich format)" .txt → `import --source
  firefox` flow. Add an *optional*, lower-friction way to push the **currently-open tabs** into
  content-hoarder on demand — explicitly a **manual ramp** (user-triggered, not background scraping).
  Candidate shapes to investigate (none chosen): (a) a tiny WebExtension with a "Send tabs to
  content-hoarder" button that POSTs the active window's tabs to a local ingest endpoint
  (`POST /import/firefox-tabs` → reuse the firefox connector's parser + YouTube-promotion); (b) read the
  live `sessionstore`/`recovery.jsonlz4` on demand (no extension, but format-fragile — already noted as
  "future" on the connector); (c) a bookmarklet/native-messaging bridge. Reuses the existing
  `firefox:<url-hash>` shaping, de-dup, and `open_in_firefox` flag (browse via `is:firefox-tab`). Keep it
  opt-in and manual — no always-on capture (the project's zero-new-friction guardrail).
- [ ] **P3 — Live Reddit / YouTube API sync.** When API keys arrive, implement `BaseConnector.sync()`
  using the existing `auth_tokens` table.
- [ ] **P2 — HN favorites-page auto-sync (Harmonic → `favorites?id=<user>`).** *(User-requested 2026-06-17;
  path DECIDED 2026-06-22 — user retired Materialistic, migrated HN browsing to **Harmonic**.)* **Build the
  `favorites?id=<user>` scraper** as the keyless, server-side, scheduled HN sync — the HN analogue of the
  Reddit auto-sync. Background:
  - **Why this is now the path:** Materialistic's "save" was **local-only** (never hit the HN account → needed
    a per-device `adb backup`). **Harmonic favorites stories to the HN account server-side**, so they appear on
    the **public** `news.ycombinator.com/favorites?id=<user>` page — pullable from the server with no phone.
    *(One-time CONFIRM still pending: Harmonic's README/Play listing group "favorites" under account actions
    alongside vote/comment/submit/see-upvoted, which strongly implies server-side, but verify empirically —
    favorite one story, then check the favorites URL. HN's API is read-only, so favoriting is a website action.)*
  - **Build:** fetch `favorites?id=<user>` paginated via `&p=N` (plain HTML; the connector's existing
    `item?id=`/`athing` parsers already read it) → upsert as `hackernews` items → `enrich()` hydrates
    title/score/author + og:image. Incremental (stop at a high-water mark like reddit saved-sync) and
    schedulable (mirror `reddit_sync.SyncScheduler` / `auto_sync`). Needs only the user's **HN username** (the
    page is public — no cookie). Add a `hn-sync` CLI + a settings field for the username.
  - **Note:** favorites ≠ Materialistic-local "saved", but that's now moot — the user's workflow IS favoriting
    in Harmonic going forward. `/upvoted?id=<user>` (needs a login cookie) covers upvotes, a separate optional
    list. The `adb backup` Materialistic path is **legacy/reference** (see `docs/IMPORTING.md`); all old saves
    already imported.
  Mirror the reddit saved-sync shape (`reddit-oauth` / `connectors/reddit.py`, Epic 9). Refs:
  [Harmonic](https://github.com/SimonHalvdansson/Harmonic-HN), [hnrss favorites feed](https://hnrss.org/),
  [reactual/hacker-news-favorites-api](https://github.com/reactual/hacker-news-favorites-api).
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
- [ ] **P2 — Twitter / X bookmarks as a content source (new connector).** *(User-requested 2026-06-22;
  preliminary research done.)* Ingest the user's **X bookmarks** as `twitter:<tweet_id>` items. **Ingest path =
  browser export, NOT the API** (mirrors the Firefox-tabs connector — keyless, manual ramp):
  - **Why not the official API:** the bookmarks endpoint (`GET /2/users/{id}/bookmarks`, OAuth2 user-context +
    `bookmark.read`) is **paid-only since 2026-02-06** (no free tier; pay-per-use "owned reads" at $0.001/resource,
    legacy Basic $200 / Pro $5000 for existing subs only) **and hard-capped at ~800 bookmarks**. Wrong fit for a
    keyless, complete-archive tool.
  - **Why not the data-archive export:** X's official "download your data" archive **does not include bookmarks**
    at all (it has your own *posted* tweets + `tweets_media/`, likes, DMs — not bookmarks). So the GDPR-export
    trick used for Reddit doesn't apply here.
  - **The fit — browser-side export:** tools like the open-source **`twitter-web-exporter`** (prinsss; a userscript
    that installs a network interceptor and captures the X web app's own **GraphQL** bookmark responses as you
    scroll) export **all** bookmarks to **JSON/CSV**, keyless, client-side, bypassing the 800 cap. Plan: user runs
    such an export → drop the JSON into `import --source twitter` → a new connector parses it into
    `twitter:<tweet_id>` items. (Later optional: our own minimal userscript/bookmarklet that POSTs to a local
    `/import/x-bookmarks` endpoint, like the proposed live-Firefox-tabs ramp.)
  - **Item shape:** `twitter:<tweet_id>`; fields = author handle/display name, text, `created_utc`, permalink
    (`x.com/<user>/status/<id>`), and media URLs (`pbs.twimg.com` images — use `?name=orig` for full res;
    `video.twimg.com` for video). De-dup by tweet id. **No bookmark timestamp** is exposed by the web export
    (GraphQL gives a sort/order index, not a saved-at time) — same situation as Reddit saved; synthesize order,
    don't fake a date (reuse `db.allocate_saved_order`).
  - **Hoard the bytes (ties to Epic 4 P1):** `pbs.twimg.com` / `video.twimg.com` media is **purged within days of
    a tweet's deletion**, so X media is as ephemeral as Reddit's — fold tweet media into the `archive-media` pass
    (another durable-while-live CDN; archive proactively at import/sync, don't rely on post-hoc recovery).
  - **Open:** quote-tweet / thread context (the web export may flatten these); NSFW handling (reuse the `nsfw_*`
    opt-in); whether to promote tweet-embedded YouTube links into `youtube:` items (Epic 11 pattern).
  Relates to Epic 7 (connectors), Epic 4 P1 (media bytes), Epic 11 (cross-source promotion). Refs:
  [twitter-web-exporter (GitHub)](https://github.com/prinsss/twitter-web-exporter),
  [X API pricing 2026](https://api.sorsa.io/blog/twitter-api-pricing-2026),
  [X Get Bookmarks docs](https://docs.x.com/x-api/users/get-bookmarks).

## Epic 8 — Polish & infra  (`chore`)
- [x] ~~**`.gitattributes`**~~ Shipped (`* text=auto eol=lf` + binary excludes) — stops CRLF warnings.
- [ ] **P3 — Optional Karakeep bridge** (already a stub) if a stock instance is adopted for a
  forward-capture library.

- [ ] **P2 — Redesign the app icon.** New mark: a backwards "E" forming an "H" (hoarder). Replace
  `static/icon.svg` + the 192/512 PNGs + the manifest; keep the teal-on-`#0f1115` tile.
- [ ] **P3 — 60fps UI.** Audit list/scroll/swipe for jank (avoid layout thrash, prefer transforms /
  `will-change`, throttle handlers); target smooth 60fps on the Pixel-6 target.
- [x] ~~**P3 — README mobile quickstart.**~~ Shipped (overnight 2026-06-10): step-by-step
  Tailscale quickstart in README "Mobile access"; CLI table updated with decay / delete /
  export / learn-triage.
- [ ] **P2 — Predictive prefetch cache for the top of each sort.** *(User-requested 2026-06-17.)* Warm a
  small cache so switching sort/source is instant instead of a fresh fetch. Prefetch the **first ~10 items
  per source** for the **top** of each sort: **newest**, **oldest**, **SHUFFLE·MIX** (shipped, Epic 10), and
  **shuffle-likely** (the smart/likely-done sort — gated on `feat/triage-score` integration, Epic 10). User
  note: *"don't be too lazy"* — a real per-source × per-sort predictive warm, not a single-page cache.
  **Open design:** where the cache lives (in-page prefetch vs. a server-warmed slice / ETag), invalidation on
  new sync/decay, and a memory bound. Relates to the Epic 8 P3 "60fps UI" lane.
- [x] ~~**P2 — More aggressive preload of content + comments (smoother UX).**~~ ✅ SHIPPED 2026-06-22 (browser-verified): on reader-open, `preloadNext()` (`browse/main.js`) warms the **next reddit item's comment thread** (background GET `/reddit/items/<fn>/thread` lazily hydrates server-side → next open is instant) + primes its media image. Bounded + rate-safe: ONE thread fetch per open, de-duped (`_preloaded`), abortable (`AbortController`), reddit-only, small look-ahead. **Deferred:** broader feed-scroll warming (held back for reddit rate limits — revisit if the reader still feels laggy). *(User-requested 2026-06-20.)* Orig: Keep
  lazy-loading, but warm a bit ahead: pre-fetch images/media just below the fold and **pre-hydrate the reddit
  thread (post + comments)** for the item(s) most likely to be opened next, so the reader feels instant. Bound it
  (small look-ahead, cancel on fast scroll) to avoid wasted fetches / throttle hits. Extends the "Predictive
  prefetch cache" item above; touches the reader hydrate path (`browse/reader.js` `load()` + `/reddit/items/<fn>/thread`)
  and the feed media lazy-load.
- [ ] **P3 — Trial GLM-5.2 as a design bakeoff arm (gated by the frontend-design skill + visual review).**
  *(User idea 2026-06-19.)* GLM already wins several of our *code* bakeoff arms (5.1/5p2); the research says
  **design is GLM-5.2's standout strength** — #1 on **Design Arena** (Elo ~1360, blind human-preference design
  tasks, ahead of Claude Fable 5 / GPT-5.5), #2 on **Code Arena: Frontend** (+29 over Claude Opus 4.7
  Thinking), and **94.8 vs 77.3** (Claude Opus 4.6) on **Design2Code** for the GLM-5V vision variant — and it's
  open-weights + multimodal (screenshot→code). **Trial scope:** hand it (a) a *greenfield/exploratory* design
  task (where it's strongest) and (b) a "build this from a screenshot/Figma" task (Design2Code), **both
  constrained by the `frontend-design` skill** so it respects the v3 tokens/design language, and **run through
  the normal human design-approval gate** (design can't be oracle-tested like code — visual review IS the
  oracle). **Caveats to watch:** benchmark wins are *greenfield aesthetics*, NOT adherence to our locked design
  system — the within-an-existing-system polish tasks (Epic 13 P3 CSS) are the harder taste-consistency test
  before trusting it broadly; and 5.2 launched with thin official benchmark tables, so trust our own bakeoff
  results over the marketing. Good first real targets: the screenshot-driven items (Epic 15 inline-media,
  the mobile-nav redesign). Relates to Epic 23 (design-language) + the `frontend-design` skill.

## Epic 9 — Reddit merge follow-ups  (`enhancement`, `area:reddit`)
*The reddit-saved-manager interface is merged in as the `/reddit` view (see
[`docs/reddit-management.md`](docs/reddit-management.md)). Remaining work absorbed from the old project:*

- [~] **P2 — Reddit auto-categorization** (migrated from RSM's "inbox + autotagging" backlog).
  **Backend shipped:** `categorize.py` now multi-label tags reddit items into `metadata.tags`
  (a post can be `minecraft` + `memes`), keyless heuristics = subreddit map + conservative
  subreddit/title keyword fallback. Buckets: `nsfw_erotic`, `nsfw_other`, `vtubers`, `coding`,
  `japan`, `anime`, `memes`, `minecraft`, `defense`, `science`, `tips`. CLI `categorize --source
  reddit [--dry-run]` (dry-run previews counts + samples, no writes). Validated on the real corpus:
  ~43% tagged after a top-150 subreddit-map expansion, good precision (body-keyword matching dropped).
  **Remaining:** (a) **more coverage** — ~57% still untagged; much of it is **gaming** (no bucket by
  choice) + general/discussion subs (AskReddit, worldnews, …) + the long tail of ~2,900 subs;
  (b) ~~NSFW split~~ **done** — `over_18` is too sparse to rely on, so NSFW is subreddit-driven via a
  user-curated allowlist loaded from a **gitignored local config** (`nsfw_rules.json`; see
  `nsfw_rules.example.json`): `nsfw_erotic`, `nsfw_talk`, `nsfw_other`; the SFW `*Porn` aesthetic
  network is excluded. Purpose: let the user **export + unsave** the erotic set.
  (c) ~~tags UI~~ **done** — `tag=` filter dropdown (data-driven, volume-sorted with counts) on the
  Reddit view **and** the browse view, plus tag chips rendered on Reddit rows/cards, browse rows, and
  the triage card.
  (d) optional local-LLM assist for the untagged tail (Epic 1 pattern).
- [~] **P2 — Export + remove the `nsfw_erotic` set.** Goal: pull the erotic-tagged items out of the
  Saved list (to migrate to a separate account). (a) ~~**Export by tag**~~ **done** (overnight
  2026-06-10): `GET /export` (CSV/JSON, same q/operator filters as `/items` — the old reddit-view
  export link pointed at a route that never survived the RSM merge; it now carries the view's
  live filters) + `export --tag X --out file` CLI; permalink-oriented records. (b)
  **Bulk-unsave by tag** — enqueue every `nsfw_erotic` item into the existing `reddit_unsave` queue
  (`db.enqueue_unsave`) and drain it (cookie path) to remove them from Reddit Saved. Reversible until
  drained; surface a count + confirm step before draining. Consider `nsfw_talk` as a separate optional
  target.
- [x] ~~**P2 — Cookie incremental sync**~~ Shipped + live-validated: `reddit_sync.py` GETs
  `/user/<name>/saved.json` with the `reddit_session` cookie (works keyless; ~100/page, ~0.5s/req),
  walks newest-first, and stops at a high-water mark (`settings.reddit_sync_newest`) — O(new) per sync.
  `POST /reddit/sync` + a "Sync newest" button + `reddit-sync [--full] [--max-pages N]` CLI. Pulled the
  244 items saved since the RSM export.
- [x] ~~**Post-review hardening**~~ (`/code-review` follow-ups, 2026-06-06): fixed the high-water mark
  advancing on a `max_pages` truncation (silent data gap); Reddit-view **Unsave** now optimistically
  flips `is_saved` and **Undo** (`POST /reddit/items/<fn>/undo`) cancels a still-pending unsave locally
  (no spurious live re-save) and surfaces a genuine re-save failure; dropped a redundant per-item
  `get_item` in the sync loop + dead `updateCounts`/`filterSource`/`thumbnail`/`gallery`.
- [x] ~~**P3 — Port RSM's richer importers.**~~ Shipped (2026-06-12, trio head-to-head batch 1,
  merge `8df9880`): **GDPR data-export ZIP** (`_from_gdpr_zip`, saved_posts/saved_comments
  members, root or nested — winner GLM-5.1) + **BDFR single-JSON** (single-dict shape through
  `child_to_item`) + **recursive directory walk** (`can_import`/`import_file` on dirs, strict
  reddit head-sniff so Keep Takeout dirs still dispatch to Keep — winner DeepSeek V4). 17 new tests.
- [ ] **P3 — Duplicates review UI** (also Epic 6 P3). Title-dedup flagged ~5.2k loose matches across ~1.8k
  groups on the real corpus — too many to auto-resolve; needs the group-review surface before resolving.
- [x] ~~**P3 — OAuth go-live.**~~ ✅ COMPLETE 2026-06-16 (PR #2). READ half shipped via Epic 25 (F5);
  then the WRITE half: OAuth grant widened to the full RedReader scope set (`read history identity
  save` — Reddit grants scopes per-authorize-request, so the public installed-app id needs no Reddit
  API key); saved-list **sync** + **unsave/resave writes** routed through `oauth.reddit.com` (cookie
  fallback); bulk drain money-action-gated (`--live --yes` + `data/unsave-audit.jsonl`); async unsave
  **trickle** (in-app idle debounce + `reddit-unsave --trickle` for scheduled jobs). ⚠️ write path
  offline-tested only — live-verify before relying.

- [x] ~~**P3 — Reddit comments sort option in the inbox.**~~ Shipped (2026-06-12, trio batch 1,
  winner GLM-5.1): best/top/new on the inline thread view — sibling-group sort (top = score,
  new = created_utc, best = cached order), `?sort=` validated at the route, `#thread-sort`
  select persisted to localStorage. 7 tests.
- [x] ~~**P2 — Surface "sort by top upvoted" in the reader (re-requested).**~~ ✅ Done 2026-06-20 (Task A, `frontend-staging`): best/top/new `<select>` in the reader thread header wired to the existing `?sort`; persists in `localStorage`. *(User-requested 2026-06-19.)*
  The user wants comment sorting **other than best — by top up-voted**. The backend + an inbox-thread
  `#thread-sort` select already ship this (best/top/new, **top = score**, item above) — so this is a **surface +
  verify** task, not new sort logic. The inline **`browse/reader.js`** thread (the mobile reader path) appears
  to have **no sort control**, so on mobile you're stuck on `best`. Add the best/top/new selector to the reader
  thread header (reuse the validated `?sort=`/`renderThread` sibling-group sort + the persisted preference) and
  confirm **top** orders siblings by `score` desc. Verify on the Pixel-6/Firefox target.
- [x] ~~**P2 — Extend tagging beyond Reddit (YouTube, etc.).**~~ Shipped (2026-06-12, trio
  batch 1, winner Kimi K2.6): `youtube_tags()` (16-channel seed map + title-keyword fallback
  into existing buckets) + `tag_youtube_source()` (dry-run/retry, preserves processing tags,
  drops enrich keyword noise, never touches `metadata.category`) + `categorize --topics` CLI.
  Note: `merge_upsert`'s category mirror re-appends the processing tag at the END of
  `metadata.tags` on every write — on-disk order is `[topic..., processing]`. Seed maps are
  deliberately conservative — extend `_YOUTUBE_CHANNEL_TAGS`/`_YOUTUBE_KEYWORD_TAGS` with
  corpus-confirmed channels next.
- [x] ~~**P2 — Add incremental "Sync newest" to the main browse view.**~~ ✅ Done 2026-06-20 (commit 88eb6f2): added to the browse settings sheet COLLECTION group — POSTs /reddit/sync, toasts the result, refreshes feed/counts/rail/pulse. *(User-requested 2026-06-08.)* The
  working `POST /reddit/sync` button lives only in `/reddit` (`reddit.html` `#btn-sync`); surface it in the
  main browse header/tools too.
- [x] ~~**P2 — Disambiguate the "Sync now" label.**~~ ✅ Done 2026-06-20 (Task D): triage's `#ru-sync-triage` relabelled "Unsave queued (N)" + title; browse had no such button (the `#ru-sync` ref was stale). The browse/triage "Sync now" buttons (`#ru-sync`,
  `#ru-sync-triage`) actually **drain the unsave queue** (`/reddit/unsave/drain`), not sync — and are
  grayed out when nothing is pending, which reads as "broken / not implemented." Relabel (e.g.
  "Unsave queued (N)" / "Drain") so it doesn't collide with incremental "Sync newest".
- [x] ~~**P2 — Extend tagging to Firefox tabs + Hacker News.**~~ ✅ Shipped 2026-06-17 (F14 bakeoff,
  GLM-5.1/Aider Arm B + review fixes). `firefox_tags()` / `hackernews_tags()` in `categorize.py` (shared
  `_browser_bucket_tags()` core: host map + word-bounded title keywords), the new **`investing`** bucket
  (added to `REDDIT_TAGS`/`FILTER_TAGS`), and pipeline wiring `tag_browser_source()` exposed via
  `categorize --source firefox|hackernews [--dry-run] [--all]`. Never touches `metadata.category`. Live
  dry-run preview: firefox 60/2269 tagged (gaming 55 / investing 3 / defense 2), HN 163/9042 (investing 127 /
  gaming 27 / defense 9). 18 tests (10 oracle + 8 wiring). **Open:** run `--apply` on the live DB is a
  user-gated data op (review the dry-run first); the bloomberg/cnbc host map over-tags general business
  stories as `investing` — tighten the seed maps if precision proves too loose. Relates to Epic 26 (taxonomy).

## Epic 10 — Learned triage: suggest what to process next  (`enhancement`, `area:triage`)
*Motivation: triage decisions aren't random — the things I mark **done** share signals (source,
subreddit/channel, kind, age, media type, title keywords). The app should learn from my own history
and surface what I'm most likely to act on, instead of a flat random batch.*

- [~] **P2 — Learn a "likely-done" score from triage history — BUILT, parked on
  `feat/triage-score` (user decision 2026-06-11: integrate + test after the Epic 20 UI
  work).** `triage_score.py` — transparent per-feature processed-rate model (composite
  source/kind, subreddit, channel, media type, category, age buckets; Laplace-smoothed,
  min-support 20; **decay-stamped rows excluded from training**; title tokens deferred).
  `learn-triage` CLI (dry-run default) writes `metadata.triage_score` + top-3 `triage_why`.
  Rehearsed on the live-corpus copy (82k scored in 23s; model card at
  `data\rehearsal-decay\TRIAGE-SCORE-REPORT.md`); the first rehearsal caught source/kind
  double-counting — fixed via the composite `sk:` feature. The work was reverted off
  `feat/inbox-decay` (revert `9e2604f`) so this branch merges without it; **to integrate
  later: revert the revert on a fresh branch off main** (or merge `feat/triage-score`,
  which snapshots the pre-revert state).
- [~] **P2 — "Smart triage" mode (recency + likely-done interleave)** — same status:
  built (`get_random_batch(mode="smart")` + `/random?mode=smart`), parked on
  `feat/triage-score`. The triage-card UI toggle is an Epic 20 Stage-C item.
- [ ] **P3 — Feedback loop.** Re-fit the score periodically (or after every N triage actions) so it
  tracks drift in what I care about; optionally fold in the local-LLM keep/skip suggestion
  (`assist/llm.py`) and the heuristic category (`categorize.py`) as additional features.
- [ ] **P3 — Per-source / per-subreddit "auto-archive likely-skip" assist.** Where the learned
  skip-rate for a bucket (e.g. a subreddit) is very high, offer a one-click reversible bulk-archive
  (built on `db.bankruptcy`-style ops) so low-value buckets clear fast.

- [x] ~~**P2 — Shuffle / mixed-content mode.**~~ ✅ Shipped 2026-06-13: a "SHUFFLE · MIX" sort that
  interleaves sources round-robin (`db._order_clause` window fn: nth-of-each-source then source —
  deterministic, so infinite-scroll pages don't dup/skip, unlike RANDOM()). +3 tests; preview-verified
  (sources interleave hackernews/reddit/youtube…). Orig: interleaves a *mix* of sources
  and categories (not grouped) for variety; complements smart-triage above.
- [x] **P2 — Default "All" view sorted by "easy to triage".** ✅ SHIPPED 2026-06-22 (origin/main): per-tab sort memory — the All tab defaults to `smart:desc` (the learned triage-score, degrades to recency until trained). Use the learned likely-done score (this
  epic) to order the default All view so quick wins surface first, instead of recency/random.
- Note: the user's "analytics/learning → triage suggestion" idea (collect activity offline, batch-
  process, suggest) is exactly this epic — folded here.

## Epic 11 — Cross-source consolidation: condense duplicates into YouTube items  (`enhancement`, `area:dedup`)
*The same thing is often saved across sources: a YouTube video, a Reddit post linking to it, an HN
comment thread about it, and a Firefox tab of any of those. Today they're separate items. Condense
them into one canonical item — **YouTube takes precedence over every other source** — that links out
to its companion discussion threads.*

- [x] ~~**P2 — Consolidate matched items into a canonical YouTube item.**~~ Shipped: `consolidate.py`
  (`plan`/`migrate`/`unconsolidate`, re-runnable, non-destructive, reversible) folds a Reddit post / HN
  story / Firefox tab that points at a YouTube video into one `youtube:<id>` row — appends a de-duped
  `metadata.companions = [{source, kind, permalink|url, fullname}]` record and stamps
  `consolidated_into` on the folded row. CLI `consolidate [--apply] [--undo]` (dry-run default);
  `search_items(include_consolidated=False)` hides folded companions from the main list (per-source
  `/reddit` opts in). Live DB dry-run: 8 foldable, 128 skipped (no local youtube row).
- [x] ~~**Card affordances.**~~ Shipped: the canonical YouTube row (all three browse densities) and the
  triage card show a `💬` "discussion exists" lead + per-companion **click-through links** (Reddit
  comments / HN thread), labelled by source and opening in a new tab. The companion record now resolves
  the *discussion* URL — a reddit permalink or the **HN thread** (`item?id=…` from the story id), never
  the matched video link. Verified in-browser against a consolidated copy of the live DB.
- [x] ~~**Promote link-only videos into YouTube items.**~~ Shipped: when a Reddit post / HN story links
  to a YouTube video with **no** local `youtube:<id>` row, `migrate()` now **promotes** the link into a
  new keyless `youtube:<id>` item (derived `i.ytimg.com` thumbnail, provisional title from the post with
  the HN `[video]` marker stripped + `title_source='companion'`, `promoted_by='consolidate'`), inheriting
  the post's triage status/processed-time, then folds the post in as a companion chip. The point of such a
  post is to watch the video, so the video becomes the canonical item. `undo` deletes the promoted rows
  (full round-trip). A later `enrich --source youtube` fills exact titles. Live DB: 128 promoted.
- [x] ~~**Constraint — never fetch (saved-only relaxed → promote).**~~ Still never goes online: the
  promoted row is built from the video id alone (mirrors `firefox_youtube.py` tab promotion). The earlier
  saved-only rule (skip any video with no local `youtube:<id>` row) was relaxed per user decision in favor
  of promotion (above).
- [x] ~~**Precedence + matching.**~~ Honored: match key = canonical YouTube video id (`firefox.youtube_id`)
  from any source's link; YouTube is always the survivor. Firefox-tab→YouTube is still promoted at import
  (`firefox_youtube.py`); Reddit link-post→YouTube and HN story→YouTube fold here.
- [ ] **P2 — Promote standalone YouTube-link notes (Keep + Obsidian) → YouTube items.** *(User-requested
  2026-06-19.)* Extend the link→video promotion to **Keep notes** and **Obsidian markdown files** whose body
  **is essentially just a YouTube link** (no real surrounding prose). Treat them like the Firefox-tab
  promotion: fold into a canonical `youtube:<id>` item (create a keyless one if none exists, `promoted_by`),
  keeping the note as a reversible companion. **Decisions (user 2026-06-19):** standalone → promote; runs
  **both at import** (like `firefox_youtube.py`) **and** re-runnably via the reversible `consolidate` pass
  (dry-run + `--undo`). **Connector prerequisites (URL extraction):**
  - **Obsidian** scans **nothing** in the body today — `url` comes only from frontmatter (`obsidian.py:116`);
    add body-URL extraction.
  - **Keep** captures only the **first** URL (`keep.py:90`); capture all, so a non-first YouTube link is seen.
  - Handle markdown link forms (`[text](url)`, `![](url)` embeds) + bare URLs; normalize via
    `connectors.firefox.youtube_id` (`youtu.be`/`shorts`/`watch?v=`).
  - **Standalone-vs-document heuristic** (shared with the Epic 15 note-reader items): after stripping the
    YouTube URL(s) + the title, is there meaningful remaining body text? Below a threshold → standalone
    (promote); otherwise it's a **document** → hand off to the note-with-video reader (Epic 15), do NOT
    convert (the note text is the irreplaceable thing). **Open: the exact threshold** — pick after sampling
    real notes. A note with **multiple** YouTube links is never "standalone" (→ Epic 15 multi-video reader).
  Relates to Epic 7 (connectors) + Epic 15 (note reader).

## Epic 12 — Search operators in the search bar  (`enhancement`, `area:search`)
*Mimic Gmail / Discord / Google search-operator syntax in the main search bar so power queries don't
need separate filter controls.*

- [x] ~~**P2 — Parse `key:value` operators alongside free text.**~~ Shipped (`feat/search-operators`,
  merged): `search_query.py` parses `source:`/`kind:`/`status:`/`subreddit:`/`tag:`/`is:saved`/`is:nsfw`/
  `before:`/`after:`/`score:>N`, quoted `"exact"`, and `-negation` into `db.search_items` filters on both
  `/items` and `/reddit`; unknown/malformed operators degrade to free text. Case-normalized values;
  negation honored even with no positive term.
- [x] ~~**Tag operator semantics.**~~ Shipped: repeated `tag:` = AND (`tags_all`), `tag:a,b`/`tag:a|b` =
  OR; `search_items` gained the AND mode.
- [x] ~~**P2 — Operator suggestions / autocomplete (Gmail/Discord-style).**~~ ✅ Shipped 2026-06-13
  (`static/browse/operators.js`): the `#oppop` popover now gives context-aware suggestions — typing
  suggests operator KEYS, and after `key:` it suggests VALUES (`source:` → the 6 sources;
  status:/kind:/is:/has: static lists; `tag:` pulls the curated tag list). Keyboard-navigable (↑/↓ +
  Enter/Tab, Esc), mouse too, and applied operators render as removable ✕ chips. Vocabulary mirrors
  `search_query.py`. Preview-verified end-to-end. *(User-requested.)*
- [x] **P2 — Cross-source / boolean queries — Model B → SHIPPED 2026-06-14 (`b92fe63`).** Research done
  (`docs/search-boolean-research.md` in repo @ main): user approved **Model B** — comma/pipe
  multi-value (`source:reddit,youtube`) + same-key-repeat=OR on single-valued keys
  (source/kind/status/subreddit/has); `tag:` keeps comma=OR / repeat=AND; bare `AND`/`OR` stay
  free text (documented non-feature); NO boolean grammar. Build in flight: trio/quad batch 2
  spec `search-multivalue` (2026-06-12).
  **SHIPPED 2026-06-14 (`b92fe63` on main — bakeoff Batch-4, glm-5p1's diff):** the
  `source/kind/status/subreddit/has` comma=OR + same-key-repeat=OR half is now LIVE — `ParsedQuery`
  fields are `str | list[str] | None`, `db.search_items` emits `IN (…)` (subreddit keeps COLLATE NOCASE,
  `has_media` maps each member), and every existing single-value query is byte-for-byte unchanged. The
  `tag:` half was already live. **Model B complete.**
- [x] ~~**P2 — `has:` media-type operator.**~~ Shipped (overnight 2026-06-10): `has:video`
  (= `reddit_video`) / `has:image` / `has:gallery` on browse + `/reddit`; unknown values
  degrade to free text.
- [x] ~~**P2 — Fuzzy-by-default; `"quotes"` for exact.**~~ Shipped (overnight 2026-06-10,
  user-approved): bare terms fuzzy (trgm), quoted phrases exact (FTS), checkbox repurposed
  to **Exact** (`?exact=1`) on both views; sw.js shell cache v13. Caveat kept: a query
  mixing bare + quoted terms takes the exact path entirely (documented degrade).
- [x] ~~**P2 — Bare `r/<sub>` as subreddit shorthand.**~~ ✅ Shipped 2026-06-17 (F9 bakeoff). A standalone
  `^r/<sub>$` token in `search_query.parse` now maps to the subreddit filter, equivalent to
  `subreddit:<sub>` (matched COLLATE NOCASE downstream). Resolved as an **alias** — `subreddit:` is
  unchanged, not deprecated. Anchored to a standalone token so reddit URLs / mid-text `r/…` aren't captured.
  5 tests. **Still open (deferred):** `u/<user>` → author shorthand, and the operator-rename pass (Icebox below).
- [x] ~~**P3 — `Exact` checkbox shouldn't close the operator suggestions popover.**~~ ✅ Done 2026-06-20 (Task C): `scheduleClose` now re-checks `document.activeElement` when the timer fires (clicking the in-popover checkbox blurs the input with a null `relatedTarget`). *(User-reported
  2026-06-17.)* Clicking the **Exact-only** checkbox in the search bar dismisses the `#oppop` suggestions. The
  toggle shouldn't blur/close the popover — keep suggestions open so the user can keep building the query.
  Touches `operators.js` (popover open/close on focus/blur) + the exact-checkbox handler.
- [ ] **P3 — Image text search via OCR.** *(User-requested 2026-06-17.)* Make text *inside* images
  searchable — screenshots, infographics, memes with captions, slide/diagram images — so a bare query
  matches words that only appear in the picture, not the title/body. Two halves:
  - **OCR enrich pass** (the real work): a new opt-in pass (e.g. `enrich --source <s> --ocr` or a dedicated
    `ocr` CLI) that runs OCR over an item's image(s), stores the extracted text on `metadata.ocr_text`, and
    stamps an `ocr_at` timestamp so it's skip-if-present + resumable (mirror the existing enrich/recovery
    passes: `--limit`, dry-run, chunked). Covers reddit image/gallery posts, HN/firefox link previews, and
    any item with a stored image; gallery items OCR each frame. **Open: engine** — Tesseract via
    `pytesseract` (needs the Tesseract binary on PATH; no cloud, fits the local-first rule) vs. a local
    vision model over the `local-llm-bridge` (the user has the GPU for it; better on stylized/meme text) —
    pick after a small accuracy spot-check. **Open: image bytes source** — reuse already-cached
    thumbnails/media where present (offline, cheap) vs. fetch full-res on demand (network, rate-limited like
    the other recovery passes). Mind volume (thousands of images) and junk output (threshold on confidence;
    skip tiny/again-decorative images).
  - **Search wiring** (small): fold `metadata.ocr_text` into the item's `search_text` / `items_fts` (so the
    existing fuzzy+FTS path finds it with zero new query syntax — see `db.build_search_text` +
    `items_fts` triggers), and optionally add a `has:text` / `is:ocr` operator to filter to items that have
    OCR'd text. Keep OCR text out of the visible card (search-only) unless the user wants a "text found in
    image" affordance.
  Relates to Epic 4 (media/recovery enrich passes) and Epic 2 (enrich infra). Sizable — sequence the engine
  spot-check + enrich pass first, the FTS/operator wiring second.

### Icebox — operator naming *(Epic 12)*
- [ ] **P3 — Revisit operator names for intuitiveness (Icebox).** *(User idea 2026-06-17.)* The current
  vocabulary (`source:`/`kind:`/`status:`/`subreddit:`/`tag:`/`is:`/`has:`/`before:`/`after:`/`score:`) should
  be revisited for names that read more intuitively. Pairs with the bare-`r/` shorthand above. Gather the
  rename list before touching `search_query.py` + `operators.js` (keep old names as aliases for a transition).
  Reactivate when the user has a concrete naming preference.

## Epic 13 — UI bugs & quick fixes  (`bug`, `area:ui`)
*Discrete defects surfaced during the redesign; several are fixed in the v2 design pass (marked).*

- [x] ~~**P2 — "Hide NSFW" not working.**~~ ✅ Done 2026-06-20 (commit 54e270e): root cause was a criteria mismatch — the UI blurs on `over_18` but the backend `hide_nsfw` only filtered `nsfw_*` TAGS (71 over_18-untagged rows leaked). Aligned both include/exclude paths to (tag OR over_18). The settings toggle was already wired. *(User-reported 2026-06-20.)* The hide-NSFW control doesn't actually hide
  NSFW content. Likely the toggle isn't wired to the `safe=1` / `hide_nsfw` query path (`web.py`), or the setting
  isn't persisted/applied on load. **Fix + verify** end-to-end. This is the bug report that the unbuilt "NSFW toggle
  in settings" item (Epic 15 below) is non-functional — reconcile the two.
- [x] ~~**P2 — Re-apply NSFW blur when you click off a revealed post.**~~ ✅ Done 2026-06-20 (commit 4413f18):
  reveal now toggles the `.nsfw` class only (the veil node is kept and hidden via CSS, not deleted), so it's
  reversible; closing the reader or lightbox opened for an item re-adds `.nsfw` to its feed thumbnail. `reblur(fn)`
  in `main.js` (idempotent, no-op for non-NSFW) wired to a new `initReader({onClose})` (fires on every close path)
  + `createLightbox({onClose})` (tracks the opened item via `lastMediaFn`); `browse.css` `.veil` positioned
  regardless of `.nsfw`, hidden via `:not(.nsfw)`. Verified on mobile preview (reader + lightbox close both
  re-blur); 590 tests. *(User-reported 2026-06-20.)*
- [x] ~~**P2 — Video thumbnail not loading on some posts.**~~ ✅ Investigated + fixed 2026-06-20 (commit ff78721).
  *(User-reported 2026-06-20.)* **Root cause was NOT a missing thumbnail on the repro.** The repro (`reddit:t3_1u62v1i`
  "Diamond Thighs") has a valid `external-preview.redd.it` thumbnail that loads (HTTP 200) and renders correctly in
  list, card, AND reader — likely fixed by an enrich backfill since the report. **Real bug found:** card density
  (`pinCard` in `browse/render.js`) rendered **no media tile at all** for a poster-less video/gallery
  (`screen = t ? … : ""`), whereas the list (`monitorHtml`) and reader (`mediaTileHtml`) both fall back to a
  glyph-only play tile. Fixed: `pinCard` now emits a `.screen.noimg` glyph tile for poster-less video/gallery
  (+ `browse.css` full-width centered-glyph styling). SW v35→v36. Verified on mobile preview (full-width tappable
  🖼/🎬 tile); 590 tests. **Data finding (separate, not fixable):** 528 reddit video items (364 inbox) have no
  thumbnail and **none is recoverable** — 0 from cached threads (`reddit-thumbnails` dry-run), and a PullPush +
  live-OAuth sample returned `thumbnail:"default"` with no `preview` images (Reddit never generated a poster for
  these v.redd.it posts). The glyph tile is the correct terminal rendering for them.
- [ ] **P3 — Research + mimic reddit-app thumbnail cropping.** *(User-requested 2026-06-20.)* Survey how the major
  Reddit apps (Apollo, RedReader, Boost, Sync, official, Relay) crop/frame post thumbnails (aspect ratio, fill vs
  fit, focal-point/top anchoring, portrait handling) and adopt the best fit for our card/list densities. Builds on
  the T4 cover work (`browse.css` `.pin .screen` / `.monitor`). Output: a short comparison + a concrete sizing
  proposal before touching CSS.
- [x] ~~**P2 — Album/gallery lightbox loads extremely slowly.**~~ ✅ Done 2026-06-20 (commits 4f24df1 + dbcb433 + 1afbe5f): both fixes shipped — (b) the lightbox lazy-loads (only the in-view image fetches, via IntersectionObserver) and (a) sized ~1080px pre-signed `gallery_preview` variants now drive the feed card poster + lightbox (full original on tap), keyed off the `media_metadata` `p` ladder. Backfilled 1,730/1,738 galleries (`enrich --source reddit --gallery-previews`; 8 have no archived `p` data → graceful fallback to the original). *(User-reported 2026-06-20.)* Opening a reddit
  gallery in the lightbox is very slow (noticed on mobile data, but the cause is structural, not just the link).
  **Root cause:** `archival.providers._gallery` stores only the **full-resolution source** URLs
  (`media_metadata[*].s.u`, often 2000px+/multi-MB each), and `core/media.js` `openGallery` renders **all** of them
  at once (`<img loading="lazy">` in one stacked modal) — so a multi-image album pulls several full-size originals
  simultaneously. The 2026-06-20 card-poster change compounds it on the feed (the card now uses `gallery[0]` at full
  res). **Fix directions:** (a) **store + serve sized variants** — `media_metadata` also carries a pre-signed `p`
  resolution array (108/216/320/640/960/1080px); persist those (or a chosen ~1080px variant) and have the lightbox
  load the sized image first, fetching the full-res `s.u` only on tap/zoom; pre-signed `p` URLs sidestep the
  preview.redd.it signature problem. (b) **progressive load** — render only the first image immediately, defer the
  rest until scrolled into view (confirm the modal actually lazy-loads; in a stacked modal they may all sit near the
  viewport), with explicit width/height (or a tiny blurhash/low-res placeholder) to avoid layout jank +
  `decoding="async"`. (c) **card poster** — use a sized preview variant for the `gallery[0]` card thumbnail instead
  of the full-res source (revisit `thumb()` density logic, `core/media.js`). Relates to Epic 4 (gallery metadata /
  `_gallery`), Epic 1 P1 media-archiving (a locally-archived copy could be downscaled), and Epic 8 perf
  (predictive prefetch / 60fps). Quick win first: (a) for the lightbox is the highest-leverage.
- [x] ~~**P3 — Mobile "go to top" button.**~~ ✅ Done 2026-06-20 (commit 595e08f): rAF-throttled, mobile-only floating ↑ that clears the dock + safe-area and smooth-scrolls to top. *(User-requested 2026-06-20.)* A floating scroll-to-top affordance on
  mobile that appears after scrolling down the feed and jumps back to the top. Respect the dock / bottom-sheet
  layout + safe-area insets; reuse existing tokens/motion. Touches `browse/main.js` (scroll listener) + `browse.css`.
- [ ] **P3 — Ask GLM what looks better for Log-view title wrapping/cutoff.** *(User-requested 2026-06-20.)* In the
  **log** density, get a design opinion (GLM, via the frontend-design skill) on title **wrapping vs. ellipsis
  cutoff** — current is a 2-line clamp at `--fs-md`. Compare options (clamp lines, fade-out, single-line ellipsis,
  wrap-all) and pick. Relates to the shipped row-title shrink + the Epic 8 GLM-5.2 design-trial item.
- [ ] **P2 — Video not fetching properly.** *(User-reported 2026-06-19 — needs a repro.)* The report is terse:
  a video isn't fetching/loading correctly. **Source + repro item TBD** — get a specific permalink from the user
  before chasing it. Likely suspects to check once a repro is in hand: the `v.redd.it` media path — archive
  fetch populating `metadata.media_url`/`is_video` (`providers`, Epic 4), the HLS manifest derivation in
  `core/media.js` `openVideo` (`/HLSPlaylist.m3u8` + vendored `hls.min.js`), and the reader/lightbox video tile
  (`browse/reader.js` + `core/media.js`). Could also be YouTube enrich (`yt-dlp --dump-single-json`) failing to
  fetch. Pin down which source/post first.
- [x] ~~**P2 — Inline-video tap-autoplay no-ops on Chrome/Android (hls.js race).**~~ ✅ Fixed 2026-06-20
  (`frontend-staging`). *(Found 2026-06-20, review of the inline-video reader `c8c49a3`.)* In `browse/reader.js` the
  media-tile tap called `video.play()` **synchronously** right after `mountVideo()`, but for the **hls.js** path
  (Chrome/Android, no native HLS) the source wasn't attached yet (`loadHls().then(...)` → `h.attachMedia(video)`), so the
  eager `play()` no-op'd. **Fix:** `mountVideo` now takes an `{ autoplay }` option and calls `play()` at the point each
  path's source is actually ready — inside the hls.js `.then()` after `attachMedia`, and after `src` on the
  native-HLS/direct paths (`core/media.js`); the reader passes `autoplay:true` instead of calling `play()` itself.
  Predicate + autoplay path unit-verified against the live module; full Chrome/Android E2E not reproducible (no v.redd.it
  items in the live DB, desktop Chromium).
- [x] ~~**P2 — External-video Reddit post → dead inline `<video src=item.url>` (no lightbox fallback).**~~ ✅ Fixed
  2026-06-20 (`frontend-staging`). *(Found 2026-06-20, same review.)* `mediaType()` classifies YouTube and other
  external-video URLs as `cls:"video"` (`core/media.js:64,66`), so the reader's media-tile tap routed them through the
  inline `<video>` path, setting `video.src = item.url` — a dead player for a non-playable web page. **Fix:** the reader
  video branch now mounts an inline `<video>` only for **directly playable** sources (`hlsManifestUrl(srcUrl)` truthy, i.e.
  v.redd.it/HLS, or `.mp4|.webm|.mov`); YouTube / gfycat / redgifs / other external-video items fall through to
  `onMedia` → `openMediaFor` (lightbox, else open-original in a new tab). Verified the playability predicate against
  representative URLs. Relates to Epic 11 (YouTube promotion) + Epic 15.
- [x] ~~**P3 — Color accents on the Inbox / Keep / Archived / Done / All tabs.**~~ ✅ Already shipped in the
  v3 status-nav (`browse.css:119-131`): `.folder`/`.spill[data-status=…]` carry `--tab:var(--status-keep/-archive/-done)`
  with active-state tinting; Inbox = `--accent`. **Updated 2026-06-20 (Task F):** "All" was neutral `--text-muted`
  (not distinct when active) → now `--text-body` (solid neutral, no clashing 5th hue). *(User-requested 2026-06-17.)*
- [x] ~~**P3 — Stretch the thumbnail to the preview-box width (browse "log"/comfortable density).**~~ ✅ Already
  satisfied by the v3 comfortable-density rework (`browse.css:344,350`): the fixed 128×76 `.monitor` box +
  `.items.density-comfortable .monitor img{object-fit:cover}` fill the slot width. *(User-requested 2026-06-17.)*
- [x] ~~**P3 — Shrink the row title in the ledger + log views.**~~ ✅ Done 2026-06-20 (`frontend-staging`).
  *(User-requested 2026-06-20.)* The list-row titles read too large. **Was (desktop):** log/comfortable **18.88px**
  (`--fs-lg`); ledger/compact **15.52px** (`--fs-md`). **Now:** log → **`--fs-md`** (15.52px, ~18% smaller),
  ledger → **`--fs-sm`** (13.6px, ~12% smaller) — token-reuse, keeps the density hierarchy ledger < log < card.
  Changed base `.title` (used by ledger) + `.items.density-comfortable .title`, and dropped the now-redundant mobile
  override (comfortable was already `--fs-md` there). Card/Pinboard title (`.pin h3`) unchanged. Verified both
  rendered sizes in the preview.
- [ ] **P2 — Album/gallery thumbnail doesn't load (e.g. r/TankPorn M1A1 Abrams).** *(User-reported
  2026-06-17.)* Repro item:
  `reddit.com/r/TankPorn/comments/1u3tphi/ukrainian_m1a1_aim_abrams_with_anti_drone_cages/` — the gallery card
  shows no thumbnail. Likely the archive fetch didn't populate `metadata.gallery`/`thumbnail` for this item
  (or the thumb URL 404s). Check the gallery extraction (`providers._gallery`, Epic 4) for this post + the
  thumbnail fallback when `media_metadata` is missing. Verify against the live row before fixing.
  **Re-reported 2026-06-19 (same post):** the user also reports it **doesn't render properly** in the reader
  (beyond the missing thumbnail) — but suspects it **may already be fixed** since. **Double-check the live row
  first:** confirm whether the gallery now renders/opens correctly, and only then chase (a) the still-missing
  card thumbnail and (b) any remaining render glitch. May already be partly resolved by the shipped gallery
  lightbox (Epic 13 P1 / Epic 4 inline-gallery).
- [x] ~~**P3 — Pinboard portrait images anchored top-left (visual polish).**~~ ✅ Fixed 2026-06-20
  (`frontend-staging`). *(User-reported 2026-06-17; **cover** chosen by the user 2026-06-20.)* In the **card /
  "Pinboard"** density, portrait (tall) images showed pillarbox gutters in the column. **Real root cause (found
  2026-06-20 via preview geometry):** the `max-height:430px` was on the **`<img>`** with `width:100%` and no
  explicit height, so when a tall image hit the cap the browser **shrank the element's width too** (to preserve
  aspect) — e.g. 242×430 inside a ~345px single-column card, leaving side gutters. `object-fit` is irrelevant here
  (the element box was already aspect-correct), so the first attempt (flip to `object-fit:cover`) was a **no-op**.
  **Fix:** move the cap to the **container** — `.pin .screen{max-height:430px;overflow:hidden}` and drop
  `max-height` from the img (kept `object-fit:cover`/`object-position:center top`). The image now holds full column
  width; tall images crop their overflow at the top, short/landscape show fully. **Only visible in single-column
  (wide cards);** at 2-column widths nothing reaches the cap. **Trade-off:** very tall images crop rather than
  shrink-to-fit (reverses the v3 contain decision) — user-accepted. Verified computed styles applied; geometry
  diagnosed on real rows (live re-capture flaky this session — remote thumbnail load).
- [x] ~~**P2 — `Ctrl+Y` redo (mirror `Ctrl+Z` undo).**~~ ✅ Done 2026-06-20 (Task E): single-level redo (`lastUndone`, replays the last undone act, mirrors the single-level snackbar undo); bound Ctrl+Z/bare-z → undo, Ctrl+Y/Ctrl+Shift+Z/bare-y → redo; modifier chords now stop falling through to single-key actions. *(User-requested 2026-06-17.)* Undo exists (per-item +
  bulk snackbar, `api.bulkUndo`); add a **redo** that replays the last undone action. Needs a small undo/redo
  **stack** (not just the single last-action snackbar). Bind `Ctrl+Z` → undo / `Ctrl+Y` (+ `Ctrl+Shift+Z`) →
  redo — confirm `Ctrl+Z` is actually keyboard-bound today, not snackbar-only. Relates to the Epic 5 keyboard
  rework.
- [x] ~~**P3 — Reader subreddit label clips descenders (`r/gaming` → the "g" tail is cut off).**~~ ✅ Shipped
  (`b9c0bf0`): relaxed the `.rd-sub` line-height so descenders clear, keeping the one-line ellipsis truncation. *(User-reported
  2026-06-20.)* In the inline reader header the subreddit chip (`browse/reader.js:117` → `.rd-sub`,
  `browse/browse.css:717`) uses `line-height: 1` (`font:var(--fw-semibold) var(--fs-sm)/1 …`) together with
  `overflow:hidden` for the single-line ellipsis, so the em-box is ~cap-height and **descenders (g/j/p/q/y) are
  clipped at the bottom**. Fix: relax the line-height (e.g. `/1.3`) and/or add a hair of vertical breathing room
  so descenders clear, keeping the one-line ellipsis truncation. Styling only (`browse.css`). Verify on the
  Pixel-6/Firefox target.
- [x] ~~**P2 — Rework the comfortable density layout.**~~ ✅ Shipped on v3 (2026-06-13 audit): `.items.density-comfortable .item-fg` is locked to `height:100px` (browse.css:290) with the thumb constrained to the fixed monitor box; adaptive height is cards-only. Orig: **User spec (2026-06-08):** positioning is good,
  but make **every comfortable row a uniform fixed height (~100px)** — adaptive/dynamic height should
  apply to **cards density only**. Constrain the thumbnail within that fixed height (`object-fit: cover`)
  and keep the action slot aligned. Touches `app.css` `.items.density-comfortable`.
- [x] ~~**P2 — Tag-chip overload on enriched YouTube cards.**~~ ✅ Shipped on v3 (2026-06-13 audit): `core/render.js` `tagChips` is curated-first (`opts.curated`), capped (`max=3`) with a "+M more" expander on cards and a static "+N" on fixed-height rows — strategy (c) hybrid. `metadata.tags` untouched (FTS intact). Orig: Enriched YouTube videos render a wall of
  tag chips (e.g. the "I made a Self-Soldering Circuit" card shows ~25: `arduino`, `atmega`, `avr`,
  `circuit design`, `diy reflow`, `high voltage`, …). **Root cause:** the per-item chip renderers
  (`tagChips` in `static/app.js` *and* `static/triage.js`) print the raw `metadata.tags` array
  unfiltered, and the `enrich --source youtube` pass dumps every yt-dlp keyword into `metadata.tags`
  (~28,950 unique across the corpus). The sidebar rail already sidesteps this by restricting to the
  curated `categorize.FILTER_TAGS` (~15) via `db.tag_counts` — but the cards don't. **Investigate +
  decide a display strategy**, e.g.: (a) on cards, show only curated `FILTER_TAGS` chips (expose the
  vocabulary to the frontend, mirroring the rail) and drop raw keywords from the visible set; (b) cap to
  N chips with a "+M more" expander; (c) a hybrid — curated first, then a few keywords behind the
  expander. Keep all keywords in `metadata.tags` for FTS/search (non-destructive); this is display-only.
  Touches `tagChips` (app.js + triage.js), the card/`.tag-chips` CSS, and possibly a `FILTER_TAGS`
  endpoint/payload. Relates to Epic 9 (tagging) and the FILTER_TAGS perf work in the round-2 handoff.
- [x] ~~**Card-view text clipping / title overlap.**~~ Fixed by the v2 card (adaptive hero + bottom
  action row). (Also noted in Epic 5.)
- [x] ~~**P1 — Reddit videos & galleries broken — GATE G1 APPROVED (2026-06-12).**~~ ✅ **Shipped on
  v3 (verified by code audit 2026-06-13).** The design (`docs/reddit-media-rendering.md`) was
  implemented during the v3 build: `core/media.js` (`mediaType`, `imageUrl` recognizing `media_url`,
  `createLightbox` with `openImage`/`openGallery`/`openVideo`/`openMedia`, Esc + backdrop close) +
  `browse/main.js` `openMediaFor` dispatch (gallery → stacked lightbox, video+`media_url` → native
  `<video>`, image → lightbox, else permalink → redditmedia iframe fallback) + `browse/render.js`
  monitor/screen slots with gallery/video badges and `data-media` hooks. No Reddit iframe for playable
  media. **Remaining (deferred, documented §4.3):** the HLS/DASH **audio** tier for `v.redd.it` — a bare
  `<video src=media_url>` plays the video-only stream without audio on browsers lacking native HLS;
  the doc's "ship (c/a), revisit after a week" upgrade. Needs a real-browser audio check + possibly
  feature-detected HLS. Tracked as Epic 13 P2 ▸ "reddit_video audio" below.
- [x] ~~**P2 — reddit_video audio (HLS/DASH) — follow-up to the shipped media pass.**~~ Shipped: the
  stored `media_url` is the bare `https://v.redd.it/<id>` (audio-less / non-playable), so `openVideo`
  now derives the HLS manifest (`/HLSPlaylist.m3u8`, muxed audio+video) and plays it via native HLS
  where supported, else a lazy-loaded **vendored hls.js** (`static/vendor/hls.min.js`, full build —
  the light build omits the separate-audio rendition v.redd.it uses). `mediaType()` gained a
  `metadata.media_url`-based branch so reddit videos (whose `url` is the permalink) route to the player
  instead of the iframe, and the comfortable-density monitor now shows a play tile for thumbnail-less
  videos. Verified in-browser: both native-HLS and hls.js paths decode audio+video.
- [x] ~~**P2 — Card density visual rework.**~~ ✅ v3: card density ("Pinboard") uses natural height — `.pin .screen img{width:100%;object-fit:contain;max-height:430px}` (`browse.css:335`), no forced 16:9 `cover` crop, so tall text-screenshots render fully. Orig: The cards layout is structurally correct but reads poorly.
  **Root cause (from screenshot, 2026-06-08):** many Reddit posts are **tall text-screenshots** (e.g.
  r/BlueskySkeets) and the fixed **16:9 `object-fit:cover` hero crops the text off** — "image difficult
  to look at." First-pass tweaks applied for review (hero `max-height` 280→200px, `object-position: top`,
  trimmed head/main padding); if still bad, do a full rework — likely needs **per-aspect media handling**
  (don't force 16:9 on portrait/text images) and overlaps the Epic 13 P1 Reddit-media pass. User may
  provide a Figma layout. Touches `app.css` `.items.density-card` + `mediaSlotHtml` in `app.js`.
- [x] ~~**P2 — Compact density visual cleanup.**~~ ✅ v3: NSFW marker is an inline `.nsfw-tag` pill prepended to the meta line (`render.js:43`, `browse.css:265`) — no absolute overlay, so no collision with the byline. Orig: Compact rows are mostly fine, but the **NSFW label
  collides with the meta line** (screenshot): the "NSFW" text + teal pill overlap the byline so "posted …"
  is truncated/clipped (looks like a doubled "NSFV/NSFW"). Fix the NSFW marker placement in compact +
  general spacing polish.
- [x] ~~**P2 — Three-dot ⋯ visual menu shouldn't auto-close on change.**~~ ✅ SUPERSEDED (user-confirmed 2026-06-12): the v3 settings sheet (Epic 14) stays open across density/theme/loading changes and replaces the v2 `#visual-menu-pop` (which no v3 template loads). No ⋯ menu built. Orig: Changing a setting
  (density/theme/focus) closes `#visual-menu-pop`; keep it open so several can be toggled without
  reopening.
- [x] ~~**P2 — Tag chips only render in card view.**~~ Shipped on v3 (parallel session 2026-06-12,
  `feat/ui-polish-sweep`, verified 19/19 headless): `core/render.js` `tagChips` gained an
  `{expand:false}` mode wired into `logRow` (comfortable) + `ledgerRow` (compact); curated-first,
  capped, static "+N", display-only.
  > **Epic 13 polish-sweep audit (same session):** these P2s were verified ALREADY-SHIPPED on v3 —
  > **bulk Undo, bulk-bar no-shift, bulk button colors, NSFW blurred-thumb width, row-click-scope,
  > side-gutter scroll** (detail in `docs/parallel-run-2026-06-12.md`). The "three-dot
  > ⋯ menu stays open" item is **superseded by the settings menu** (Epic 14) — closed, no ⋯ menu
  > built (user-confirmed). Tick these on your next BACKLOG pass if you concur with the audit.
- [x] ~~**P2 — NSFW blurred thumbnail renders too wide (comfortable/list).**~~ ✅ v3: blur is constrained to the fixed monitor/screen thumb box (`browse.css:306-308`), with a veil overlay. The over-18 blurred thumb
  expands to ~40% of the row width with a centered "NSFW" overlay (screenshot) instead of the normal
  thumbnail box; constrain it to the standard thumb width/aspect. Likely shares a root with the
  comfortable-density fixed-height/thumbnail sizing above.
- [x] ~~**P2 — Bulk-action Undo missing.**~~ ✅ v3: `api.bulkUndo` (core/api.js) replays the prior statuses; wired into the bulk path (main.js:223) with a snackbar. Orig: Group-select → Keep/Archive/Done shows no Undo (the per-item
  Undo toast doesn't fire for bulk), so a bulk action can't be reversed. Wire Undo for `/bulk/status`.
- [x] ~~**P2 — Bulk bar shifts the list down when it appears.**~~ ✅ v3: `.opsbar` is a `position:fixed` overlay (browse.css:386), so selecting a row no longer pushes the list. Orig: Selecting a row makes the bulk bar push the
  whole list down, so the cursor is no longer over the originally-selected row (bad on desktop). Overlay
  the bulk bar or reserve its space so the list doesn't jump.
- [x] ~~**P2 — Bulk Keep/Archive/Done buttons not color-coded.**~~ ✅ v3: opbtn `.k/.a/.d` use the `--status-keep/-archive/-done` tokens (index.html:126-128). Orig: Color-code them to match the triage/row
  semantic colors.
- [x] ~~**P2 — Move processed items back to Inbox.**~~ ✅ v3: per-item "IN" button (`data-act="inbox"`, render.js:27) + bulk "X → INBOX" (index.html:129) + the `x` keyboard shortcut; toast "Back in the inbox." Orig: Kept/Archived/Done items need a reversible action to
  return them to `inbox` — per-item and as a bulk action.
- [x] ~~**P2 — Row click should open only on the title/link, not the whole row body.**~~ ✅ v3 (Playwright-audited 2026-06-12): opens only via the title `<a>` / media slot; body + meta clicks open nothing; avatar toggles select. Orig: Refine the `#items`
  delegated handler so a body click doesn't open the item — only the title/link does (avatar/checkbox
  still toggles select).
- [x] ~~**P2 — Esc doesn't close the Reddit video/thread modal.**~~ ✅ v3: `createLightbox` (core/media.js:88-90) has Esc + backdrop/`[data-media-close]` close built in, and clears the body to stop playback. Orig: `Esc` (and backdrop click) should close
  it like the other modals.
- [x] ~~**P3 — Reposition / iconify the Sort control.**~~ ✅ v3: moved OUT of the rail into the top shelf bar (`index.html:77-89`) — satisfies the "…or move it out of the rail" half. (Still a `<select>`, not an icon; iconify deferred if ever wanted.) Orig: Replace the sort dropdown with a sort icon or move
  it out of the rail.
- [x] ~~**P2 — Scroll the list from the side gutters too.**~~ ✅ v3: a `document` `wheel` handler forwards gutter scroll to the list (main.js:612, "13:385"). Orig: With the Gmail-style independent scroll, only
  the content column captures the mouse wheel — hovering the blank space beside it does nothing. Make the
  whole main pane (incl. side gutters) drive the content scroll (move `overflow-y` to a wider wrapper or
  widen the scroll region) so the wheel works anywhere in the main area, not just over the list. *(User
  note 2026-06-08.)*
- [x] ~~**Reddit "Sync newest" button cut off.**~~ Fixed (v2 pass): the header now wraps. The reddit header crowds at some widths (the new
  theme toggle); fix `header-right` wrapping/spacing in `reddit.css`.
- [x] ~~**Dropdowns clip into the search bar.**~~ Fixed (v2 pass): the tag filter moved to the sidebar and the topnav wraps. At some window widths the topbar selects overlap the
  search field and become unclickable; fix `.topbar` wrap/stacking in `app.css`.
- [x] ~~**Group-select only via the checkbox/avatar.**~~ Fixed (v2 pass): a row-body click opens the item; only the avatar toggles selection. A whole-row click should open the item; only
  the avatar/checkbox should toggle selection (tighten the `#items` delegated handler).
- [x] ~~**Triage done/Undo chip overlaps the Keep button.**~~ Fixed (v2 pass): the toast is lifted above the fixed action bar. Reposition the undo chip / action bar
  so they don't collide.
- [x] ~~**"Open on reddit" preview URL is malformed.**~~ Fixed (v2 pass): Reddit permalinks are normalized to absolute www.reddit.com URLs. It builds a relative `/r/…` path (resolving
  to `127.0.0.1:8788/r/…`); render Reddit permalinks as absolute `https://www.reddit.com/…`.

## Epic 14 — Settings menu  (`enhancement`, `area:ui`)
*A single settings cog consolidating preferences that are currently scattered or absent.*

*Epic 14 effectively complete on `feat/frontend-v3` (parallel session 2026-06-12, verified 27/27
headless). The gear + settings sheet (theme / density / loading / daily-goal) shipped earlier; the
parallel session added the missing **Stats** panel (`#statsheet`, GET /stats) into the menu.*
- [x] ~~**P2 — Settings cog + panel.**~~ Shipped on v3 (gear → `#settings` sheet, Esc/scrim close).
- [x] ~~**P2 — View density in settings**~~ (compact / cozy / cards) — in the settings sheet, persisted.
- [x] ~~**P2 — Light/dark theme toggle in settings**~~ — `theme.js` toggle surfaced in the sheet.
- [x] ~~**P2 — Infinite scroll by default; Focus mode batches.**~~ Shipped: load-on-scroll default,
  Focus mode batches; LOADING control lives in the settings sheet.
- [ ] **P3 — Focus mode wider on desktop.** Desktop Focus mode should use a wider content column.
- [x] ~~**P3 — "Swipe only on mobile" → now a decision (see Epic 16).**~~ ✅ v3: implemented — `swipe.js:37` ignores mouse pointers, `attachSwipe` is touch-only by default (no toggle). Orig: Inbox swipe is mobile/touch-only by
  default, not a toggle.
- [x] ~~**P3 — Hide the Stats button under settings.**~~ ✅ v3: Stats is the `#statsheet` panel inside the settings menu (GET /stats), per the 2026-06-12 parallel session. De-cluttered.
- [x] ~~**P2 — NSFW toggle in settings (hide/show NSFW posts AND nsfw_* tags).**~~ ✅ Done 2026-06-20 (commits 82ab283 + 54e270e): the toggle already existed + persisted (state.safe → ?safe=1); completed it — the rail/drawer/autocomplete drop the nsfw_* facets while off (refreshRail on toggle), and the Epic 13 P2 over_18 fix makes the posts actually hide. *(User-requested
  2026-06-17.)* A persisted toggle in the settings sheet that, when OFF (default), hides NSFW content
  everywhere: the feed already supports it via the `safe=1` query param (`web.py` `hide_nsfw`), so wire
  the toggle to that; AND hide the NSFW tag facets (`nsfw_erotic`, `nsfw_other`, `nsfw_talk`) from the
  sidebar tag rail so they're not even listed while NSFW is off. When ON, show NSFW posts (blur-on-tap
  reveal already exists, Epic 16) and surface the nsfw_* tags. Mirror the `is:nsfw` operator semantics
  (Epic 12) and the curated NSFW tag set from `nsfw_rules.json` (Epic 9). Persist like density/theme.

## Epic 15 — Reddit / HN as-app navigation  (`enhancement`, `area:reddit`)
*Make saved items behave like the native apps when tapped.*

- [x] ~~**P2 — Tap subreddit → open the subreddit; tap user → open the user page.**~~ Shipped (design-v2
  round 2; user-verified): meta-line `r/<sub>` / `by <author>` link to Reddit (new tab) without triggering
  row open/select.
- [x] ~~**P2 — Reddit image-link → open the comments thread, not the raw image URL.**~~ Shipped (PR #4):
  a reddit item whose media classifies as an image routes the tap to the in-app reader (image + thread).
- [x] ~~**P2 — Hacker News item → open the HN discussion thread, not the linked article.**~~ Shipped
  (user-verified).
- [x] ~~**P2 — Hacker News author → open the HN user profile** (`news.ycombinator.com/user?id=<author>`),
  mirroring the Reddit user link.~~ Shipped (PR #3).
- [x] ~~**P2 — HN: chip to open the linked article/story URL directly.**~~ Shipped: an "Article ↗" pill
  in the meta line links to `item.url` (omitted on Ask/Show-HN self-posts, where the title already opens
  the discussion).
- [x] ~~**P3 — (Optional) Fetch article thumbnails for HN items.**~~ Shipped: `HNConnector.enrich()` now
  fetches the linked article's og:image into `metadata.og_image` (best-effort, idempotent, gated like
  other enrich passes); `thumb()` renders it in the HN monitor slot.
- [x] ~~**P2 — Reddit video → open the in-app reader (video + comments), not the bare lightbox.**~~
  Shipped (2026-06-17): extends the image→reader routing to v.redd.it video; the reader's media tile
  plays the HLS stream (Epic 13 P2), with poster backfill (sync/lazy/offline `reddit-thumbnails`).
- [x] ~~**P2 — Markdown formatting in the reader's comment + post bodies.**~~ ✅ Done 2026-06-20 (commit 250e1d1): `core/markdown.js` `renderMarkdown()` — a safe subset (links, bold/italic, > quotes, ul/ol, inline + fenced code, bare URLs), XSS-safe by escaping first and gating every href through safeUrl; one renderer drives both the post self-text and comments. +11 node-backed tests. *(User-requested 2026-06-17.)*
  The inline reader currently renders comment/self-text as **plain escaped text** (`reader.js`
  `renderThread` → `helpers.esc(c.body)`; `paragraphs()` only splits on blank lines). Reddit bodies are
  **markdown** — links, **bold**/*italic*, `>` quotes, lists, code, and bare URLs (incl. **giphy** +
  external links). Render a safe subset to HTML (escape first, then linkify + apply markdown; no raw
  HTML injection — XSS-safe). Reuse one renderer for both the post self-text and comments. Keep it pure
  so it stays node-testable like the other reader helpers.
- [x] ~~**P2 — Comment-thread UX: tap-to-collapse, author links, auto-collapse dead threads.**~~ ✅ SHIPPED
  2026-06-22 (`browse/reader.js` + `browse.css`, sw.js v58→v59). *(User-requested 2026-06-22.)* (1) **Tap the
  comment byline** (`.rd-cby`) to collapse/expand the thread — a big tap target alongside the `−`/`+` button;
  ignores taps on the author link, and the body stays non-toggling (links/images/selection work). (2) **Author
  `u/name` → a link** to the Reddit profile (`noopener noreferrer nofollow`; `[deleted]` stays a plain span).
  (3) **Auto-collapse fully-dead threads** on load — pure `deadThreadCollapseSet()` collapses a deleted comment
  only when it HAS replies AND its whole subtree is deleted, so a live reply under a deleted parent stays
  visible. +5 node tests; verified live (author link, dead-subtree collapse, collapsed shows "N replies").
- [~] **P3 — Inline media playback inside the reader's comment thread.** *(User idea 2026-06-17.)*
  ✅ **IMAGES SHIPPED 2026-06-22** (user-requested directly, ahead of the RES screenshots): `core/markdown.js`
  now renders `![alt](url)`, bare image URLs, AND Reddit's native `![img](media-id)` (resolved server-side
  from `media_metadata` — `reddit_thread._resolve_media`, passed through on each comment + the post selftext)
  as inline `<img>`, tap → lightbox. **Host-allowlisted** (Reddit + imgur + giphy; others → safe link) with
  `referrerpolicy=no-referrer` + lazy-load; XSS-safe-by-construction (escape-first, no event attrs). +15 tests
  (6 server + 9 node), full suite 647 green, verified live. sw.js →v58.
  ⏳ **STILL OPEN:** (a) **video in comments** — `v.redd.it`/gfycat/redgifs/streamable → the HLS/`<video>`
  path; (b) the RES-informed refinements — a **tap/expander gate** so a comment with many images doesn't
  auto-load a wall, and **NSFW reveal** on inline comment media (currently images render directly). Analyze
  the RES screenshots + repo (inline-expando / media-host modules) when tackling these.
  **When tackling this:** the user will provide Reddit Enhancement Suite (RES) UI screenshots as a
  design reference — analyze them AND the RES repo (https://github.com/honestbleeps/Reddit-Enhancement-Suite,
  esp. its inline-expando / media-host modules) for how RES inlines comment media, then adapt the
  patterns that fit our reader. Don't start until the screenshots are in hand.
- [x] ~~**P2 — Thumbnail tap = quick media peek (lightbox); title/body opens the thread.**~~ ✅ SHIPPED
  2026-06-22 (browser-verified): in `browse/main.js` the `[data-media]` tap now always calls `openMediaFor`
  (plain media — image lightbox / video player / gallery viewer); the reddit-image/video → reader
  interception (added 2026-06-17, `107665b`) was reverted. Title/body tap still opens the reader. The
  lightbox already registers with the overlay coordinator (`core/media.js` `pushOverlay`), so OS/back closes
  it and returns to the feed (verified). SW v66. *(User-requested 2026-06-17.)* (HN article thumbnails: they
  use the title-`<a>` route, not `[data-media]`, so they're unaffected.)
- [ ] **P2 — Video plays inline in the reader (no lightbox).** *(User-requested 2026-06-17.)* In
  `section#reader` a video currently opens the lightbox; play it **inline in the reader's media tile** instead
  (reuse the HLS/`<video>` path from `core/media.js`). The lightbox stays for the browse-list peek (above);
  this is reader-only.
- [x] ~~**P3 — Reposition the reader's media preview (takes too much vertical space at top).**~~ ✅ Done 2026-06-20 (Task B): capped `.rd-media img` to 42vh and inline video to 52vh (was 58/70vh; kept `contain`, tap still opens the full lightbox). *(User-requested
  2026-06-17.)* In `section#reader` the post-media tile dominates the top of the view; shrink/reposition it so
  the post + thread are reachable with less scrolling (cap its height, or make it a collapsible/cover-fit
  tile). Reader layout only.
- [x] ~~**P3 — Reader triage buttons show their hotkey shortcuts.**~~ ✅ Shipped (`4ff7126`): Keep/Archive/Done
  buttons display their keys and the reader-scoped F/A/D keys are wired (capture-phase, triages the reader's own
  item). *(User-requested 2026-06-17.)* Relates to the Epic 5 keyboard rework.
- [ ] **P2 — Note-with-video reader (Keep/Obsidian): play the video where the comments go.** *(User-requested
  2026-06-19.)* When a note has **real content AND a single YouTube link**, do NOT promote/convert it (Epic 11
  leaves these alone) — the note text is the irreplaceable thing. Instead keep it as a `keep:`/`obsidian:`
  item and open it in the inline reader **exactly like the Reddit comment reader**: the **YouTube video plays
  at the top** (where the post media sits) and **the note's own content renders below, where the comment thread
  would be**. Needs: (a) the video id(s) extracted onto the note (`metadata.youtube_ids`, the same extraction
  the Epic 11 heuristic uses); (b) a note mode in `reader.js` — embed the YouTube player (iframe) up top, render
  the note body below (**Obsidian** = markdown, reuse the reader-markdown renderer above; **Keep** = text +
  checklist); (c) Epic 15 tap-routing so a note-with-video opens this reader. Builds on the inline reader +
  `core/media.js`. Relates to Epic 11 (id extraction) + the reader-markdown item above.
- [ ] **P3 — Multi-video note reader: embed several YouTube videos from one note.** *(User idea 2026-06-19.)*
  A note containing **multiple YouTube links** is a collection, not a single video — never promote it to one
  video item. Build a reader view that **embeds all of the note's YouTube videos** (a playlist/grid of players)
  alongside the note content. **Open scope:** layout (stacked players vs. a list with one active player),
  lazy-load the iframes (don't auto-load a wall of embeds), and reuse the Epic 11 `metadata.youtube_ids`
  extraction. Builds on the note-with-video reader above.
- [ ] **P2 — Edit note bodies as raw markdown, in the reader.** *(User-requested 2026-06-19.)* Let the reader
  edit a note's body as **raw markdown** (a textarea + rendered live preview reusing the reader's markdown
  renderer above) — **reuse the reader view**, not a separate editor surface. Backend: a `POST /items/<fn>/body`
  endpoint updating `body` + rebuilding `search_text`/FTS (precedented by `/recover` + `/category`), re-deriving
  Obsidian inline `#tags` + `[[wikilinks]]`. **Re-import durability (the crux — `merge_upsert` overlays the
  incoming body, db.py:417):** stamp `metadata.body_edited_at` and skip the body overlay for dirty rows so a
  later vault/Takeout re-import can't clobber the edit; for **Obsidian** optionally also write the edit back to
  the `.md` on disk (needs the absolute vault root persisted — today only the vault *name* + a relative
  `source_id` are stored, obsidian.py:118/131). **Keep** edits are DB-only (Takeout is a dead export, no live
  target) and its body is plain text + a structured `listContent` checklist, so Keep editing is
  plain-text/checklist, not markdown. Scope note: this nudges content-hoarder from triage/consumption toward
  authoring — the alternative for rich editing is deep-linking out to Obsidian (`obsidian://`). Relates to
  Epic 11 (note items) + the reader-markdown renderer.

- [x] ~~**P2 — Highlight the OP's comments in the reader thread.**~~ ✅ Shipped (`a91b20e`): OP comments now
  carry an accent left-border / tinted background, not just the inline badge. *(User-requested 2026-06-19.)* On a Reddit
  thread the comments written by the **original poster** should stand out visually. A bare **"OP" badge already
  renders** (`browse/reader.js:50`, guarded by `helpers.opAuthor` derived at reader.js:156) — this asks for
  actual **highlighting** of those comments (e.g. an accent left-border / tinted background on the OP comment
  block, mirroring the `r/<sub>`-app convention), not just the inline tag. Styling on the `.rd-op` comment
  (`.rd-c` carrying the OP author) in `reddit.css`; the `opAuthor` plumbing is already in place so no new data
  is needed.

### Icebox — true WYSIWYG markdown editing *(Epic 15)*
- [ ] **Icebox — Obsidian-grade WYSIWYG (type-and-see-formatting) note editing.** *(Deferred 2026-06-19.)*
  Live-preview rich editing rather than the raw-markdown textarea above. **High effort + fidelity risk:** the
  no-build-step constraint means vendoring a CodeMirror/ProseMirror-class editor; markdown↔rich-text
  round-tripping loses fidelity; and Obsidian's superset (`[[wikilinks]]`, `![[embeds]]`, callouts,
  frontmatter, Dataview) gets corrupted by a generic WYSIWYG. Reactivate only if raw-markdown editing proves
  insufficient — otherwise prefer deep-linking out to Obsidian for rich editing.

## Epic 16 — Mobile UX  (`enhancement`, `area:mobile`)
*Make the PWA feel native on the phone (Chrome / Pixel-6 target; switched from Firefox 2026-06-21).
Absorbs "make the Reddit view more mobile-friendly".*

- [x] ~~**P2 — Swipe haptics are too strong — reduce them.**~~ ✅ SHIPPED 2026-06-22 (`haptics.js` +
  `core/swipe.js`, sw.js v54→v55). *(User-reported 2026-06-22.)* Commit patterns softened ~45%
  (archived 18→10, done 10→6, keep [10,30,10]→single 5, inbox 8→4, skip 6→3, milestone shortened, undo 8→4)
  AND the compounding `swipe.js` stage-2 threshold pulse 8→3 — a long swipe fired TWO buzzes (threshold +
  commit), which read as "too strong." Friction-asymmetry hierarchy kept.
- [x] ~~**P2 — Tag-add box clips into the bottom bar on mobile when idle (not fully hidden).**~~ ✅ SHIPPED
  2026-06-22 (`browse.css`, sw.js v56→v57). *(User-reported 2026-06-22.)* Root cause: `.tagpop`'s base
  `display:flex` overrode the `[hidden]` UA `display:none`, so `close()` (`pop.hidden=true`) left an EMPTY
  sheet pinned at `bottom:0` clipping into the bottom bar. Fix = one rule `.tagpop[hidden]{display:none}`
  (higher specificity). Verified: hidden→`display:none` in every state (incl. `.sheet` still applied — the
  exact tap-away-after-use case), shown→`flex`.
- [~] **P2 — Back on the reader/triage view should return to the inbox, not exit the app.** *(User-
  reported 2026-06-22.)* ✅ **Reader + overlays SHIPPED** 2026-06-22 via the shared `core/overlaynav.js`
  back-button coordinator (one history entry + one `popstate` over a stack; OS-back closes only the top
  overlay — verified live: reader closes + stays on app, lightbox-over-reader nesting closes LIFO).
  ⏳ **STILL OPEN — the triage PAGE-as-entry case:** when `/triage` is the *first* PWA history entry
  (launched/refreshed directly onto it), back exits because there's nothing below it. Normal nav
  (inbox → TRIAGE link) already returns to the inbox. Needs a page-level guard: if `/triage` is the
  entry (no same-origin referrer / `history.length<=1`), push a sentinel so back routes to `/` instead
  of exiting — coordinated with the overlay coordinator (overlay-back takes precedence). Verify on Pixel-6/Chrome.
- [x] ~~**P2 — Back from the lightbox/gallery should return to the inbox, not exit the app.**~~ ✅ SHIPPED
  2026-06-22 (`core/overlaynav.js` + `core/media.js` createLightbox + triage.js inline lightbox, sw.js
  v55→v56). *(User-reported 2026-06-22.)* Both lightboxes register with the shared coordinator on open;
  OS-back closes the overlay and lands on the feed instead of exiting the PWA. Browse path verified live
  (open pushed history, back closed it, stayed on app); triage wired identically + page boots clean.
- [x] ~~**P1 — Swipe must not trigger horizontal page scroll.**~~ ✅ v3: `body{overflow-x:clip}` (`browse.css:15`) + `swipe.js:27` `touchAction="pan-y"` (transform-only drag + edge-zone guard) — a row swipe can't side-scroll the page. Orig: Lock the layout to the device width
  (fixed viewport, `overflow-x` containment) so swiping a row doesn't side-scroll the page.
- [x] ~~**P2 — NSFW blur in the inbox/triage**~~ ✅ v3: over-18 media blurred in the browse list (`render.js:13/62` veil + `browse.css:318` `filter:blur(16px)`), reveal-on-tap. Orig: adopt the Reddit view's blur for over-18 media.
- [ ] **P2 — Tap thumbnail opens the view modal; long-press enters group-select.** ✅ tap-opens-modal SHIPPED on v3 (`main.js:161-180` delegated `[data-media]` → `openMediaFor`); ⏳ the **long-press → group-select** half is still unbuilt (`swipe.js` has no long-press; select is via the avatar `[data-select]` button). Box stays open for that half. Orig: Today a thumbnail
  tap on mobile doesn't open the modal.
- [ ] **P3 — ICEBOX: Swipe physics feel.** *(Iceboxed 2026-06-22 — user: "right now it's fine.")* The
  current swipe is a little stiff; could add momentum/spring + better thresholds for a smoother feel.
  Reactivate if the swipe starts to feel laggy/stiff in real use.
- [ ] **P3 — Mobile-friendly scrollbar** (Nova-Launcher-style fast-scroll handle).
- [ ] **P3 — Visual rework of the collapsing top bar.** *(User-requested 2026-06-22.)* The shrink-on-scroll
  shipped and works (Relay-style: scroll down → `.console.compact` collapses the search row + TODAY counter;
  expands at the top / on scroll-up — `browse/main.js` scroll handler + `.compact` rules in `browse.css`), but
  it wants a **visual polish pass**. Open ideas: smoother/spring collapse easing; decide what stays vs. hides
  when compact (shrink the brand? a slim always-tappable search affordance instead of fully hiding it? what the
  status pills do); a subtle elevation/shadow once scrolled; tune the down/up thresholds + add hysteresis so it
  doesn't flicker on tiny scrolls. Keep it inside the Fable design language (reuse tokens, don't invent a new
  paradigm — see preserve-fable-design). Pairs well with the Epic 23 design-language / GLM design-bakeoff lanes.
- [x] ~~**P2 — Inbox swipe = mobile/touch only.**~~ ✅ v3: `swipe.js:37` ignores `pointerType==="mouse"` unless `{mouse:true}`; `main.js` `attachSwipe` passes no `mouse` flag → desktop uses buttons, touch swipes. *(User decision 2026-06-08.)* Orig: Disable row-swipe on the
  inbox on desktop (desktop uses the action buttons/hover); keep swipe for touch only.
- [ ] **P3 — Swipe-only interactions on mobile.** Per the v2 decision the action icons stay visible on
  touch; optionally offer a swipe-only mode (no inline icons) for a cleaner mobile row.
- [ ] **P3 — Make the Reddit view mobile-friendly** (the `/reddit` table/grid is desktop-first).
- [x] ~~**P1 — Closing the reader must stop playing media (back-gesture keeps the video running).**~~ ✅ Fixed
  2026-06-20 (local, `frontend-staging`). *(User-reported 2026-06-19.)* On mobile, pressing **back** on the online
  embedded reader view left the video playing — audio bled after the feed was back on screen. `closeReader`
  (`browse/reader.js`) only removed the `.show` class + the `reader-lock`; the eager `videoTeardown()` was a
  **no-op** for direct + native-HLS playback (`mountVideo` returns `destroy:null` there, `core/media.js:123,132`)
  and the `<video>` element was never paused. **Fix:** added a `stopInlineVideo()` helper (tracks the mounted
  `videoEl`, runs HLS teardown, then `pause()` + `removeAttribute("src")` + `load()` and removes the `.rd-video-wrap`)
  called from `closeReader`. Since **all** close paths funnel through `closeReader` — close-button, popstate/back,
  Esc, the F/A/D reader keys, and swipe-right — every exit now silences playback. DOM-API sequence verified in the
  preview engine; full inline-video E2E not exercisable (no v.redd.it items in the live DB).
- [x] ~~**P2 — Maintain the feed scroll position after opening + closing the reader.**~~ ✅ Done 2026-06-20 (commit 29cb122): capture `window.scrollY` on openReader BEFORE the reader-lock (overflow:hidden resets it), restore it on closeReader after unlocking — covers every close path (button/Esc/popstate/swipe/F-A-D). *(User-requested
  2026-06-19.)* On mobile, opening the reader and returning loses your place in the list — the feed jumps back
  to the top instead of restoring where you were. Likely the `reader-lock` overflow toggle on `documentElement`
  (reader.js:195/207) resets the underlying scroll. Capture the feed `scrollTop` on `openReader` and restore it
  on `closeReader` (incl. the popstate/back path), or lock the body without discarding its scroll offset
  (position-fixed-with-saved-top pattern). Verify on the Pixel-6/Firefox target.

### Icebox — non-Chromium standalone install (GeckoView wrapper) *(Epic 16)*
- [ ] **P3 — ICEBOX: ship content-hoarder as a Gecko-rendered standalone Android app.** *(Researched +
  decision 2026-06-19.)* Goal: a real standalone app on the Pixel **without a Chromium engine** (user
  prefers Firefox/no-Chrome). **Findings:** Firefox Android can't make a true install (no WebAPK; "Add app
  to Home screen" = shortcut-class with the URL bar). WebAPK minting is Chromium+Google-Play-Services only,
  so every turnkey route (TWA/Bubblewrap, WebView wrappers like Hermit/Native Alpha) is Chromium. The only
  Gecko paths are: **(a)** a **custom GeckoView wrapper** — a ~50-line Java Android app bundling Mozilla's
  official GeckoView that loads the `.ts.net` URL full-screen (smallest trust surface = you + Mozilla; cost =
  *you* own quarterly engine-security rebuilds); **(b)** **Nira** (GeckoView browser w/ one-tap PWA install)
  — vetted **alpha / solo-dev / sideload-only / no community track record**, so NOT trusted for years of
  personal data; **(c)** a full **native Kotlin/Compose** rewrite — rejected (forks the web UI you actively
  maintain → permanent dual upkeep). A scaffold plan for (a) was drafted (Java, "minimal+", reuses
  `static/icon-512.png` + `#0f1115`/`#f2a97e` theme; GeckoView needs **no** assetlinks/Digital-Asset-Links).
  **Reactivation condition:** revisit as an **experimental separate branch or new repo** if the user tires of
  the current project / wants an Android side-project — NOT as in-place work here. **For now:** use the
  Chromium **WebAPK via Chrome "Install app"** (the only mainstream path; auto-updates its engine). See
  [[inline-reddit-reader]] (prior "Firefox is the culprit" note) and [[content-hoarder]].
- [ ] **P3 — Explore Cromite (or similar adblock Chromium fork) as the PWA host browser.** *(User idea
  2026-06-22.)* Chrome-for-Android can't run ad-blocking extensions, so the reader's "Open original ↗"
  + any embedded web/reddit content carries ads. **Cromite** (maintained Bromite successor — de-Googled
  Chromium fork with **built-in adblock** + anti-fingerprinting) can mint a real **WebAPK** (standalone PWA
  install, same as Chrome) AND block ads engine-side — getting BOTH the standalone-install goal and adblock
  WITHOUT a Chromium-engine extension or the GeckoView custom-wrapper maintenance burden. This likely
  **supersedes** the GeckoView icebox above (Cromite = the Chromium-adblock path; GeckoView = the
  no-Chromium path). Evaluate: (a) does Cromite's "Install app"/WebAPK flow work for our `.ts.net` PWA;
  (b) trust + maintenance (FOSS, active releases; sideload APK + auto-update via Obtainium/its own channel);
  (c) adblock efficacy on the reader's embedded reddit content. Alternatives to weigh: Brave (Chromium +
  adblock, Google-adjacent), Mull/Vanadium, or an in-app blocklist if we ever render remote pages ourselves.
- [ ] **P3 — Explore Chrome Custom Tabs (+ Trusted Web Activity).** *(User idea 2026-06-22.)* Chrome Custom
  Tabs (CCT) is Android's native "embed a real Chrome tab inside an app" surface — faster than a cold browser
  launch, themeable (match the app bar), shares the user's Chrome session/cookies, and has a back-arrow that
  returns to the app. Two angles for content-hoarder:
  - **(a) In-app link opening.** Today the reader's "Open original ↗" + external source links bounce out to
    the full browser and lose the app. If content-hoarder ever runs inside a native shell, those links could
    open in a Custom Tab — stay-in-app feel without us rendering remote pages ourselves. *(Pure-PWA caveat: a
    plain installed PWA can't invoke CCT directly — that's a native API; it needs a wrapper. So this is mostly
    relevant once (b) exists.)*
  - **(b) TWA packaging — the bigger reason.** A **Trusted Web Activity** is the official Google path to ship a
    PWA as a real installable/Play-Store Android app, and **a TWA is literally a full-screen, chrome-less Custom
    Tab** around your PWA. Tooling: **Bubblewrap** / **PWABuilder** generate the APK from the manifest. This is
    a **third native-packaging option** alongside the Cromite-WebAPK and GeckoView iceboxes above — TWA = the
    Google-blessed Chromium path (uses the user's installed Chrome/Cromite engine, so adblock only if that
    engine has it).
  - **Open questions:** does a TWA verify against our **Tailscale `.ts.net` origin** (TWA needs Digital Asset
    Links — host `/.well-known/assetlinks.json` on the Flask app + a signed APK; the cert SHA must match) when
    the origin is only reachable on the tailnet; offline behavior (TWA falls back to a Chrome error page, not
    our SW shell, if the origin is unreachable — vs a WebAPK which is friendlier); and whether CCT's lack of
    engine-adblock makes Cromite-WebAPK still preferable for the ad concern. Relates to the Cromite + GeckoView
    items above and `docs/MOBILE_TAILSCALE.md`. Refs: Android Custom Tabs, Bubblewrap, PWABuilder.
- [ ] **P3 — ICEBOX: watch the Web Haptics API (amplitude/intensity haptics for the PWA).** *(Researched
  2026-06-22.)* Our haptics are capped by `navigator.vibrate()` being **duration-only** — no amplitude knob
  (Android's `VibrationEffect` amplitude exists natively but is **not** bridged to the web), so "stronger"
  can only mean "longer," which is why tuning firmness is a tradeoff against crispness. **The fix in flight is
  the Web Haptics API** (WICG incubation + Microsoft-Edge explainer, with Chromium interest — a BlinkOn 21
  talk): semantic effects (`hint`/`edge`/`tick`/`align`) **with optional intensity `0.0–1.0`** = real
  amplitude, declarative (`@haptic` CSS) or imperative. **ICEBOXED because it's not shipped** (incubation, no
  browser support yet) — nothing to build now; **adopt once it lands in Chrome** (our PWA host) and replace the
  raw `vibrate(ms)` calls in `haptics.js`/`core/swipe.js` with intensity-aware effects. **The only way to get
  amplitude *before* it ships is a native shell** (TWA/Capacitor + a native haptics plugin, e.g. Capacitor
  `ImpactStyle.Light/Medium/Heavy`) — see the Chrome Custom Tabs / TWA item above; Web Haptics is the
  no-native-wrapper path to the same payoff. Refs: [WICG/web-haptics](https://github.com/WICG/web-haptics),
  [Edge explainer](https://microsoftedge.github.io/MSEdgeExplainers/Haptics/explainer.html).

### Icebox — remote-wake / always-on hosting *(Epic 16)*
- [ ] **P3 — ICEBOX: remotely "turn on" the server from the phone.** *(Researched 2026-06-20.)* Problem: the
  app is a **single Flask process + a SQLite file** (`content_hoarder serve`, `data/app.db`) on the home PC,
  reached from the Pixel over Tailscale (`docs/MOBILE_TAILSCALE.md`). When the PC is off/asleep the inbox is
  unreachable, so the user asked how to remotely command it on. **Two distinct layers:** **(B) host on, app not
  running** — the easy half: don't remote-start it, run `serve` as an **auto-restarting managed service**
  (Windows: NSSM / Task Scheduler "at startup"; Linux: a `systemd` unit with `Restart=always`); `tailscale serve
  --bg` already persists the HTTPS front across reboots, so the app is up whenever the host is. **(A) host
  powered off/asleep** — the hard half, with the key gotcha that **you can't wake a sleeping PC *through*
  Tailscale** (its tailscaled sleeps too → it drops off the tailnet; Wake-on-LAN is a layer-2 LAN broadcast,
  not routable over the WireGuard mesh). Every option therefore needs an **always-on device on the home LAN**:
  options ranked — (1) **move the app to an always-on low-power host** (Raspberry Pi / NAS / mini-PC) so there's
  nothing to wake — *recommended, collapses both layers*; (2) just keep the PC always-on; (3) **WoL via a LAN
  relay** — an always-on tailnet+LAN box (Pi/NAS/Tailscale-capable router) exposes an authed "wake" endpoint
  (`wakeonlan <MAC>`) the phone hits over Tailscale; needs BIOS WoL + NIC "wake on magic packet" + **Fast Startup
  disabled** on Windows, reliable from sleep/hibernate, flaky from full-off; (4) **local-control smart plug**
  (Tasmota/ESPHome) + BIOS "restore on AC power" — works from full-off but is a hard power-cycle. **Security
  (app holds years of personal data):** keep the wake trigger **tailnet-only + authenticated** (Tailscale ACLs;
  the magic packet itself is unauthenticated, so lock the thing that fires it), **never `tailscale funnel`** / no
  port-forward, and **local-only** (not cloud) smart plugs. **Reactivation condition:** revisit if the user
  wants the app off the big PC (host on a Pi/NAS — the recommended path) or specifically needs WoL because the
  content must live on the Windows box (browser-cookie/Takeout pipeline). For now the PC stays on / started
  manually. See [[content-hoarder]] and `docs/MOBILE_TAILSCALE.md`.

## Epic 17 — Unify the Reddit and Inbox/Triage surfaces  (`enhancement`, `area:ui`)
- [ ] **P2 — One unified surface.** Fold the dedicated `/reddit` view's capabilities (subreddit rail,
  table/grid, thread viewer) into the main inbox + triage so there aren't two UIs to maintain. Large;
  sequence after the settings + mobile work.

## Epic 18 — Custom YouTube view  (`enhancement`, `area:youtube`)
- [ ] **P3 — A YouTube-specific surface.** A view tuned for video triage (duration, channel grouping,
  watch/listen processing-areas, playlist order), analogous to the `/reddit` view.

## Epic 19 — Backend hardening  (`bug`, `area:backend`)
*From the comprehensive review (2026-06-09). **Shipped 2026-06-09** (merge `b2dc1d9`,
`fix/unsave-hardening`, suite 202 green): Claude-owned fixes + local-LLM delegation via the
`delegation/` prompt pack (Devstral/Qwen drafts, Claude review+repair).*

- [x] ~~**P0 — `Retry-After` handling.**~~ Shipped: case-insensitive header lookup; HTTP-date /
  negative values fall back to the exponential delay instead of crashing the drain. *(delegation/01)*
- [x] ~~**P0 — Unsave drain breaks the sync high-water mark.**~~ Shipped: the mark is the newest
  K=25 fullnames (JSON list, legacy single-string still read); any survivor matching = caught-up,
  so a drained newest item no longer freezes the mark. *(Claude)*
- [x] ~~**P0 — Unsave queue retries failures forever.**~~ Shipped: attempts cap 5 → `state='failed'`
  (CASE flip in the failure UPDATE); re-enqueue resets attempts; `failed` count surfaced in CLI +
  `/reddit/unsave/status`. *(delegation/02)*
- [x] ~~**P0 — Transient network failure reported as "cookie expired".**~~ Shipped:
  `RedditNetworkError` for transport/5xx/unparseable; `{}` now means only 401/403. drain/sync report
  `network_error` separately (mark never advances on it); CLI exits non-zero for both. *(delegation/03)*
- [x] ~~**P0 — CSRF/DNS-rebinding guard.**~~ Shipped: `before_request` rejects non-local/private/
  tailnet Hosts and mismatched-Origin state-changing requests; `CONTENT_HOARDER_ALLOWED_HOSTS`
  extends the allowlist. *(Claude)*
- [x] ~~**P1 — Undo asymmetry for a drained Done.**~~ Shipped: the browse `/undo` route attempts the
  live re-save and returns a `warning` when it can't (dead cookie / offline). *(Claude)*
- [x] ~~**P1 — Version the FTS build marker.**~~ Shipped: `_FTS_VERSION=2`; legacy boolean-'1' DBs
  rebuild exactly once on next connect. *(delegation/04)*
- [x] ~~**P1 — Cap the web drain route.**~~ Shipped: default 50/request (clamped 1..500); the
  response's `remaining` lets the UI loop. *(delegation/05)*
- [x] ~~**P1 — Unhandled `int()` 500s.**~~ Shipped via `_int` + max_pages ceiling 200. *(delegation/06)*
- [x] ~~**P1 — `.env` read crashes on non-UTF-8/BOM.**~~ Shipped: `utf-8-sig` + `errors="replace"` +
  OSError guard. *(delegation/07)*
- [x] ~~**P1 — Consolidate undo→re-migrate round-trip.**~~ **Suspected bug NOT real** — three new
  round-trip tests pass against the existing implementation; behavior pinned. *(delegation/08)*
- [x] ~~**P2 — `merge_upsert` tags replace-vs-union asymmetry.**~~ Shipped: guard comment +
  characterization test. *(delegation/09)*
- [x] ~~**P2 — Test-gap fills.**~~ Shipped: `test_rsm_threads.py` (5 tests) + 5 youtube_recover
  failure-path tests. The categorize/missing-rules case was already covered by
  `test_nsfw_disabled_without_rules_file`. *(delegation/10)*
- [x] ~~**P3 — Unify the 4 divergent HTTP timeout/retry helpers**~~ Shipped 2026-06-14 (`bb5b1d8` on
  main — delegated to an Opus subagent): one shared `_http.request(...)` primitive + `retry_after_seconds`
  in new `src/content_hoarder/_http.py`; the 4 helpers (`archival/_http.get_json`, `reddit_unsave._http_get`/
  `_http_post`, `youtube_recover._http_get`, `karakeep._post`) are now thin adapters with identical
  signatures/return-shapes/error-policies; all injection seams preserved; the 6 network test files pass
  unedited + 19 new offline `_http` tests. Behavior-preserving (no live round-trip exercised).

*Bugs migrated 2026-06-20 from the retired `docs/IMPLEMENTATION-HANDOFF-2026-06-17.md` work queue
(B1/B2/B4 — confirmed by code read at write time; verify line numbers before acting):*

- [x] ~~**P2 — Same-second decay-wave UNDO collision (B1).**~~ ✅ Done 2026-06-20 (commit 5e37732): `db.decay` now stamps `metadata.decayed_at` with a UNIQUE monotonic wave id (`_allocate_decay_wave`, mirrors `allocate_saved_order`) instead of bare `now`, so two decays in the same second get distinct stamps and undo reverses exactly one wave. +2 oracle tests. `letgo()` (`resurface.py:152`) decays a cluster
  and stamps `metadata.decayed_at = now` (whole seconds) via `db.decay`; `undo_letgo()` (`resurface.py:166`)
  reverses by a **1-second window** (`db.undecay(decayed_after=decayed_at, decayed_before=decayed_at+1)`),
  selecting rows purely by timestamp (tag/sub deliberately unused, `resurface.py:169`). **Failure:** two "let
  it go" actions on **different** clusters within the same wall-clock second share a `decayed_at`, so UNDO on
  one cluster's toast un-decays **both** — violates the "one independently reversible wave" invariant
  (`db.decay` docstring, `db.py:~1233`). **Fix (anti-gaming):** make the wave id unique per call — preferred:
  `db.decay` allocates a monotonic wave id (mirror `db.allocate_saved_order`) and returns it; `undo_letgo`
  selects on that id, not a time window. Must NOT route through `bulk_set_status` (decay-safety invariant).
  **Acceptance:** `letgo(A)` then `letgo(B)` with a frozen identical `now`, then `undo_letgo(A)` → only A's
  rows return to inbox; B's stay decayed. *Delegation: ✅ qwen single-shot (oracle-shaped).*
- [x] ~~**P2 — Reconcile cap guards on row count, not real truncation (B2).**~~ ✅ Done 2026-06-20 (commit 801f056): added an additive `truncated_by_kind` override to `reconcile_reddit_saves` (True skips, False reconciles even at/above cap) + a `reconcile_complete` opt-in threaded through `import_path` and the `--reconcile-complete` import flag; the legacy row-count inference stays as the fallback so existing callers are unchanged. +3 tests. `db.py:~1040` skips saved-list
  reconciliation when `len(present) >= cap` (~1000), inferring "the listing was truncated" (Reddit caps the
  saved listing ~1000/type). But keying on the parsed count can't distinguish "complete export of exactly
  1000" from "truncated at 1000," so a user with exactly `cap` saved + a complete export silently skips
  reconciliation and genuine unsaves are never detected. **Fails safe** (never an *erroneous* unsave) → low
  urgency. **Fix:** pass an explicit `truncated_by_kind` flag from the sync/import layer (which knows
  `after`-exhaustion vs. a page cap) rather than inferring from the row count. *Delegation: 🟡 borderline,
  GLM (crosses the sync/import seam).*
- [x] ~~**P3 — `/import/prepare` temp-file leak (B4).**~~ ✅ Done 2026-06-20 (commit 7df72fc): an `atexit` hook unlinks every remaining staged temp file on process exit (the TTL sweep only ran on the next /prepare); the in-session TTL sweep stays. +1 test. `/import/prepare` (`web.py:~763`) writes an
  uploaded/yt-dlp temp file and stashes it in `_prepared[token]`; it's only unlinked by `/import/commit`
  (`web.py:~833`) or the 1-hour TTL sweep `_cleanup_prepared` (`web.py:~718`), and the sweep only runs on the
  *next* `/import/prepare`. A preview that's never committed (with no later prepare) lingers up to an hour.
  **Fix:** add cleanup on app teardown or a timer. Low priority given the TTL. *Delegation: 🟡 borderline,
  qwen (oracle ≈ fix size — batch with another web-layer item).*

## Epic 20 — Frontend v3 overhaul  (`enhancement`, `area:ui`)
*Decision (2026-06-09): full overhaul on `feat/frontend-v3` — vanilla JS, no build step, mobile
fluidity first-class. Plan: shared `static/core/` layer (util/api/toast/render/media — kills the
~250-line helper triplication across app.js/reddit.js/triage.js), tokens v3 seeded from
`design-ref/`, page-by-page rewrite (browse → triage → reddit) behind a design-approval gate.
**Absorbs** (don't fix twice): the Epic 13 density/NSFW/bulk-bar/Esc/tag-chip items, Epic 14
infinite-scroll/focus-batches, Epic 16 swipe items, Epic 5 keyboard rework, the toast undo-button
listener leak (app.js:75, triage.js:413), reddit.css hardcoded colors → tokens, dead CSS
(`.item-age`, `.source-badge`), sw.js versioned cache + `/reddit` added to the PWA shell.*

*Gate-1 outcome (2026-06-09): "Log Book II" locked — `design-ref/v3-explorations/05-log-book-2.html`
is the Stage C spec; tokens v3 + `static/core/` shipped (commit b20e977).*

*ADHD round LOCKED (2026-06-11): the Stage C spec is now **05 + `06-adhd-round.html`** — twelve
approved additions (win pebbles w/ optional daily goal, no raw backlog counts → "· N new" slice,
dateline greeting, resurfacing card per the locked one-pager, surprise-me + dice, operator-discovery
popover, active-filter chips, consume-cost pills, smart sort w/ "why" [build waits on
feat/triage-score], Focus batch strip → PAGE CLEARED stamp → empty state, live row-clear + undo +
two-stage Keep swipe ≈90/170px, quiet decay line; ☾ resting-soon markers deferred — need a
server-side flag). Mockups are gitignored; the additions list also lives in the explorations
README + plan file. New backend in scope: `GET /pulse` (new_today/cleared_today/swept_recent) and
`GET /resurface` + dismiss/letgo POSTs per `docs/resurfacing-card-design.md`. Items below are
build-tracking now, not open design questions:*

- [x] ~~**P2 — Two-stage swipe actions (mobile).**~~ ✅ v3: `core/swipe.js` `commit2`/`onRightLong` (commit2≈170px) wired in `browse/main.js` (commit 80, commit2 170, onRightLong→keep). Sync-style short/long thresholds per direction:
  short → = Archive, **long → = Keep** (the extra travel is deliberate friction — a "hoarder
  tax" that fits the reduce-the-backlog thesis), short ← = Done, long-left unassigned. Underlay
  color+icon swap at the second threshold + a haptic pulse (`navigator.vibrate`); long-press
  stays = select. **Design locked 2026-06-11** (06-adhd-round.html, thresholds ≈90px/≈170px,
  demoed working); build in Stage C.
- [ ] **P2 — 4-way swipe: Snooze on the unassigned long-left (+ snooze-decay).** *(User idea
  2026-06-12.)* The locked two-stage map leaves long-← unassigned — claim it for **Snooze**:
  "I don't want to decide right now" as a first-class gesture, killing decision fatigue without
  the guilt of skipping. Sketch (design rides the Stage C gate): snooze hides the item from
  triage batches for a window (e.g. `metadata.snoozed_until`, ~7d); **repeated snoozes are
  themselves a decision** — after N snoozes (~3) the item flows into the Epic 21 guilt-free
  decay path (auto-archive + stamp, reversible, no badge/no "snoozed 3 times!" guilt copy).
  Friction-asymmetry note: snooze *defers* rather than preserves — price it above
  Done/Archive but below Keep; never the cheapest gesture in reach. Open questions: window
  length/escalation curve, quiet resurface marker vs silent return, overlap with the deferred
  ☾ resting-soon markers (both want the same server-side flag).
- [ ] **P2 — 4-DIRECTIONAL triage: add the vertical axis (↑ = thread, ↓ = skip-for-later).** *(User
  idea 2026-06-22.)* The two-stage map above claims the horizontal axis (←/→ = Done/Archive/Keep, long-←
  = Snooze); add the **vertical** axis so triage is genuinely 4-directional:
  - **Swipe ↑ → open the comments thread** (the inline reader/thread view). First open lazy-hydrates via
    `reddit_hydrate.hydrate_if_missing` (Epic 24) — ties straight into the hydration work. Read-without-
    deciding: the card stays in the deck after closing the reader.
  - **Swipe ↓ → skip the item for later** (no-decision pass / show next). This is the *gesture binding* of
    the already-shipped **Skip** (triage-skip, on main) — wire the existing action, do NOT add a new one.
    Decide vs the Epic 16 P2 timed Defer/Snooze and the long-← Snooze above: ↓ maps to the cheap
    no-decision Skip, NOT the timed snooze, to keep the two gestures distinct.
  Touches `core/swipe.js` (today `touchAction="pan-y"`, horizontal-only — needs a vertical axis +
  thresholds that don't fight list scroll, and a direction-lock so a diagonal drag resolves to one axis)
  + `triage.js`. **Unify with — don't duplicate —** the long-← Snooze item and the Epic 16 Skip/Defer
  item; this is the gesture layer over those existing actions.
- [ ] **P2 — Triage visual rework (design bakeoff, probably GLM).** *(User idea 2026-06-22.)* A fresh
  visual pass on the triage card/deck — hand it to a design bakeoff arm (GLM, per the Epic 20 P3 GLM-5.2
  design-arm trial). Pair with the 4-directional gesture item above: the new ↑/↓ affordances need visual
  hinting (edge cues / peek). Scope + lock the design via the `frontend-design` skill + visual review
  before any build.
- [x] ~~**P2 — Command palette v1.**~~ Shipped (2026-06-11, the bakeoff's T3 winner —
  GLM-5.1's sample + review fixes): `static/browse/palette.js` (ES module, fuzzy
  subsequence match with strict-prefix > word-boundary > scattered tiers, arrows wrap,
  Enter runs, Escape exits, listbox/option ARIA), commands for pages/theme/density/sort.
  `>` flips the search bar to command mode; placeholder now advertises it. Deferred to a
  v2: status-view switching, bulk ops on selection (need the selection model exposed).
- [x] ~~**P2 — Filter-state visibility (simple now).**~~ ✅ v3: active source/tag chips (`#fchips`) built from `state.source`/`state.tags` (main.js:440). Active source/tag chips with ✕ + "clear
  all" rendered in the sheet shelf next to the result count; define the algebra (single-select
  source, multi-select tags) and keep it visible. **Design locked 2026-06-11** (06, demoed);
  build in Stage C. **P3 — advanced later:** palette-driven filter builder, saved filters,
  tag search inside the rail.

*PKMS-research additions (2026-06-10 handoff; see Epic 21 for context). These ride the same
Stage C design gate:*

- [x] ~~**P2 — No backlog counts in v3 (research-mandated).**~~ ✅ v3: the pulse shows "· N new" + win pebbles, never raw totals (`state.pulse` = new_today/cleared_today/swept_recent). No raw inbox/All totals anywhere —
  backlog counts read as failure and drive abandonment (97.55% of items never leave inbox; the
  number can only be demoralizing). Sidebar shows curated slices instead; audit the Stats modal
  + progress copy for guilt framing (never re-open/read-% as health, no "you haven't…");
  finishable batch progress only ("3 of 7"), never streaks/points/leaderboards.
  **Design locked 2026-06-11** (06: `Inbox · N new` slice, Archived count dropped, win
  pebbles w/ optional goal); build in Stage C via `GET /pulse`.
- [x] ~~**P2 — Resurfacing card: "Still interested in X?".**~~ ✅ v3: the ambient slot renders "Still interested in <em>X</em>?" + Not-now/Let-it-go, fetching GET /resurface (main.js:301-350, locked-design `resurface.py`). Machine-initiated, phrased as a
  curious question, never a count badge or red dot (recognition beats recall for ADHD). v1
  candidates need no LLM: cluster = curated knowledge tag (`tips`/`coding`/`science`) × old
  saves; never `memes`/`vtubers` (identity content isn't a task). Dismiss = silent decay + a
  no-renag window. **Design LOCKED 2026-06-11** — one-pager
  [`docs/resurfacing-card-design.md`](docs/resurfacing-card-design.md) (all 4 questions
  decided) + card rendered verbatim in 06; build = `resurface.py` + `GET /resurface` +
  dismiss/letgo POSTs in Stage C (triage_score ranking term degrades to dormancy-only
  until feat/triage-score integrates).
- [x] ~~**P2 — "Surprise me" card.**~~ ✅ SHIPPED on v3 2026-06-13: `surprise()` (`browse/main.js:358`) pulls `/random?n=1` into the ambient slot ("DEALT AT RANDOM — NO STRINGS"); ⚄ dice button (`main.js:378`, `render.js:196`). No count/streak. Orig: One bounded random old save on demand — converts the
  rediscovery-joy that sustains the save habit into a deliberate retention loop. Rides
  `db.get_random_batch` (check n=1 / cross-status support). No count, no streak.
  **Design locked 2026-06-11** (06: same ambient slot, never both cards, + ⚄ dice for
  user-pulled); build in Stage C.
- [ ] **P3 — "Surprise me" card: render media + open → reader.** *(User-requested 2026-06-17.)* The
  surprise-me ambient card needs better rendering: when the dealt item **has an image**, render the image on
  the card (not just title/meta); and its **"Open" action should route into `section#reader`** (the same
  in-app reader a normal post open uses), not an external tab or bare lightbox. Builds on `surprise()`
  (`browse/main.js:358`) + the Epic 15 reader routing.

*Code-quality / dead-code cleanup migrated 2026-06-20 from the retired
`docs/IMPLEMENTATION-HANDOFF-2026-06-17.md` work queue (I1–I4). The v3 `static/core/` layer was created to
kill exactly this duplication; the two non-module legacy pages (`/triage`, `/reddit`) still carry copies:*

- [x] ~~**P2 — Dead duplicate `icons.js` + offline cache gap (I1).**~~ ✅ Done 2026-06-20 (`frontend-staging`,
  systematic-mode rework) via the cleaner (b) end-state. The interim (a) fix (`a35242e`, caching `/static/icons.js`)
  was superseded: `/triage` now loads `triage.js` as an **ES module** importing `chIcon`/`fillIcons` from
  `core/icons.js`, the `<script src="/static/icons.js">` tag is gone, and **`static/icons.js` is deleted**.
  Discovery during the rework: `static/icons.js` was NOT dead — it was the **generator source** for `core/icons.js`
  (`scripts/_gen_core_icons.py`); per user decision the one-shot generator was **retired** too, so `core/icons.js`
  is now the single hand-maintained icon source (header updated). `sw.js` shell → v33: dropped `/static/icons.js`,
  added `/static/core/icons.js` (so `/triage` icons render offline). **Verified:** `/static/icons.js` 404s,
  `/triage` action icons + dynamic stamps render via `core/icons.js`, no console errors.
- [x] ~~**P2 — Helper duplication on the legacy pages (I2).**~~ ✅ Done 2026-06-20 (`frontend-staging`). Converted
  `triage.js` + `reddit.js` to **ES modules**: triage imports `esc`/`safeUrl`/`isTypingTarget`/`ago` from
  `core/util.js` and `getJSON` (as `fetchJSON`) from `core/api.js`; reddit imports `esc`. Local copies removed →
  one source of truth. Both files were already IIFE-wrapped (leaked no globals), and reddit's `window.doUnsave`/
  `doUndo`/`openThread` (inline-onclick targets) are explicit `window.` assignments that survive module conversion —
  **verified** by clicking a real onclick row (detail panel opened). Note: the B0a single-quote `esc` divergence was
  already fixed in both files before this (now byte-identical), so the dedup is behavior-neutral except triage's
  relative-time now matches the browse view (`ago`: `"42s"` vs the old `"now"` for <1min items).
- [ ] **P3 — Unused `app.css` selectors (I3) — defer.** `app.css` (~2100 lines, consumed only by the legacy
  `/triage` page) has many unreferenced selectors (e.g. `.ai-*` suggest-UI classes), but confidence on
  individual selectors is medium. Defer to a triage redesign; don't bulk-delete without per-selector usage
  checks.
- [x] ~~**P3 — Document the two token files (I4) — doc-only.**~~ ✅ Shipped (`1ff18bf`): each token file now
  carries a header comment noting which pages consume it — `static/tokens.css` (legacy dark/teal, used by
  `/triage` + `/reddit`) and `static/core/tokens.css` (v3 "Log Book" apricot, used by browse) — to prevent a
  future "looks duplicated, delete one" mistake. Both are live and intentional; unify only when the legacy pages
  are redesigned.

## Epic 21 — ADHD-research adoption: guilt-free decay  (`enhancement`, `area:triage`)
*From the PKMS research handoff (2026-06-10; evidence in
`K:\Projects\PKMS\vault\resources\research\`, esp. `17-hoarder-mining.md`): 97.55% of 84,250
items never left `inbox` in the app's lifetime; ~80% of the hoard is entertainment; saving is
the only proven-durable behavior. Direction: promote-on-demand (search/All/Archived already
reach every status — nothing is ever lost) + guilt-free bulk decay; per-item review of the
backlog will never happen and the design stops pretending it will. **Decisions locked
2026-06-10:** decay = auto-archive + `metadata.decayed_at` stamp (no schema change); one-shot
supervised backfill, rolling automation iceboxed; gaming buckets added, subdivided.
**Guardrails:** zero new capture friction; no guilt mechanics anywhere (no streaks / overdue
counters / red badges / "you haven't…" copy); everything reversible behind dry-run + backup;
the word "bankruptcy" stays CLI-only, never UI copy.*

- [x] ~~**P1 — Tag/subreddit-aware decay (extend `bankruptcy`).**~~ Shipped (2026-06-10,
  `feat/inbox-decay`): `db.decay`/`db.undecay` + the `decay` CLI (dry-run default, `--apply`,
  `--undo` with `--decayed-after/--decayed-before` wave windows). Stamps
  `metadata.decayed_at` (one stamp per call = one reversible wave); direct UPDATE like
  bankruptcy — never `bulk_set_status`, so a mass decay can never enqueue live Reddit
  unsaves (pinned by test). 14 new tests incl. merge_upsert stamp survival.
  **Round 2 (user review):** `--label swept` writes `metadata.decay_label` so the initial
  pass stays distinguishable from deliberate archives AND future rolling decay; new search
  operators `is:decayed` (any wave) + `is:swept` (the labeled pass) on browse + `/reddit`;
  any manual status transition (per-item ↩, set_status, bulk) strips the decay marks, so a
  rescued item never reappears in `is:swept`. A label is a metadata key, NOT a tag —
  tags get wholesale-replaced by categorize retags.
- [x] ~~**P1 — Gaming buckets in `categorize.py`, subdivided.**~~ Shipped (2026-06-10):
  `esports` (LoL/OW/CS/R6/Valorant subs, 2,116 items on the live corpus) + casual `gaming`
  (2,239) + modded-MC subs joined `minecraft` per user decision; `gamedev` → `coding`.
  Plus an untagged-tail coverage expansion (~45 conservative mappings: anime fandoms,
  screenshot-humor subs, military, spacex/engineeringporn, learnpython/linux/hacking).
  All corpus-confirmed via read-only inventory; rail/chips pick the tags up automatically.
- [x] ~~**P1 — `ephemeral` bucket: time-limited promos/sales/events.**~~ Shipped
  (2026-06-10): deal subreddits (gamedeals, buildapcsales, freegamefindings,
  frugalmalefashion, freebies — ephemeral-ONLY, no gaming co-tag, so only the age-gated
  wave touches them) + conservative title keywords (`giveaway` with a dead-giveaway idiom
  guard, `N% off`, `humble bundle`, …; never bare `free`/`sale`/`event`). 203 items on the
  live corpus (197 subreddit-path, 6 keyword-path); precision samples in the rehearsal report.
- [x] ~~**P1 — One-shot supervised "swept" backfill.**~~ ✅ APPLIED LIVE 2026-06-11 (user signed off): **21,610 items** carry `decay_label='swept'` in `data/app.db` (re-verified 2026-06-13); reddit inbox 82,190→60,580. Backup `data/app.backup-20260611-1340.db`. Rehearsal detail below kept for the record:
  Policy per user review 2026-06-10: wave 1 = `memes/gaming/esports` older than ~90 days;
  wave 2 = `ephemeral` older than ~60 days; both labeled `swept`. Rehearsal passed on a
  live-DB copy: **21,615 items would decay (33.3% of reddit inbox)** — wave 1 21,414 +
  wave 2 201; every item carries `decay_label='swept'`; NSFW preserved; apply==dry; full
  undecay round trip clean. `tinder`/`comics` removed from memes per user decision.
  ⏱ ~15 min supervised. ▶ read `data\rehearsal-decay\DECAY-REHEARSAL-REPORT.md` (tables,
  ephemeral precision samples, exact live command block incl. `--backup-live`). ✓ live block
  executed; `is:swept` pulls the pass; the freebies round-trip recipe is clean. Note: "age"
  = `created_utc` (content age) — Reddit exposes no save timestamps.
- [ ] **P2 — Future decay waves for the remaining entertainment buckets.** `anime` (5.9k),
  `vtubers` (2.8k), `minecraft` (2.2k), `defense` (5.8k — includes aviation + Ukraine-war
  subs; review before sweeping) stay tagged in the inbox. Each is one command when ready:
  `decay --tag <bucket> --before <date> --label swept [--apply]`. **`japan` is excluded** —
  user decision 2026-06-11: it's a resurfacing cluster (see
  [`docs/resurfacing-card-design.md`](docs/resurfacing-card-design.md)), not decay material.
- [x] ~~**P3 — Hard-delete pathway for triaged ephemeral items.**~~ Shipped (overnight
  2026-06-10, user-approved with unsave coupling): `delete` CLI — dry-run is the
  confirmation surface; execution needs BOTH `--apply` and `--yes`; automatic timestamped
  pre-delete backup + `data/delete-audit.jsonl`; `--max` blast-radius cap (default 5000);
  `--also-unsave` enqueues into the unsave queue BEFORE rows vanish, and without it stale
  pending queue rows are purged so a later drain can't unsave a local-only delete. Deletes
  the `reddit_threads` cache rows too. 8 tests.
- [~] **P2 — Done items auto-delete after a retention window (Gmail-trash style).** ✅ CLI half done 2026-06-20 (commit 08ad3d6): the `purge-done` command wraps `db.purge_done` in the money-action safety shape (dry-run default, `--apply` + `--yes` gate, auto pre-purge backup, `delete-audit.jsonl` with victim fullnames, `--max` blast cap, `--retention-days` to set the window). +2 tests. **STILL OPEN:** the settings-sheet control for the retention window (needs your visual review) + an optional scheduled-sweep entrypoint. *(User-requested
  2026-06-17.)* **DB primitive SHIPPED 2026-06-18 (F15 bakeoff, glm-5p2 arm + review fixes):**
  `db.purge_done(conn, *, now, apply, max_rows)` permanently purges `status='done'` items older than
  setting `done_retention_days` (default 30), aging from `processed_utc` (NULL excluded). Direct-delete —
  never routes through `bulk_set_status`/`enqueue_unsave`, so a purge **cannot enqueue a Reddit unsave**
  (mirrors the decay invariant, oracle-pinned); cleans pending `reddit_unsave` + `reddit_threads` rows;
  `max_rows` blast cap. 8 tests. **REMAINING (the user-facing half):** a CLI / scheduled-sweep entrypoint
  wrapping it in the `delete` CLI's **auto-backup + `delete-audit.jsonl` + confirmation gate**, and a
  **settings UI** for the window. `processed_utc` confirmed as the Done-transition timestamp (no schema
  change needed). Builds on the P3 hard-delete pathway above + the decay machinery.
- [ ] **P3 — Rolling decay automation (Icebox).** Reactivate after the backfill proves out and
  ~a month of new saves accumulates.
- [ ] **P3 — PKMS promote-pipeline export wrapper (Icebox).** The read path already exists
  (`db.get_reddit_thread`, db.py:834; 672 threads cached); build the thread-JSON→markdown
  export only when PKMS Phase 3 starts. Don't build capture/promote here before then.
  Related open question (PKMS side, Kenja decides later): whether the PKMS mobile `/capture`
  endpoint lives inside this Flask app (same tailnet host) or as a sibling service.
  **UI surface (user idea 2026-06-17):** the eventual trigger is a per-item **"Move to PKMS" button** in
  content-hoarder — deferred with this item (don't build the button before the promote pipeline exists).
- [ ] **P3 — LLM identity-vs-actionable classifier (Icebox).** v1 approximates it with tag
  buckets (memes/vtubers = identity; tips/coding/science = actionable); reactivate when the
  resurfacing card (Epic 20) needs better candidates. Reuses the Epic 1/10 local-LLM lane.
- [ ] **P3 — Content-based ephemeral detection (Icebox).** Event posts whose time-limited
  nature isn't visible from subreddit/title (announcement bodies, "ends Sunday" buried in
  text) need body analysis — local-LLM lane once the GPU is back in service. The subreddit +
  title-keyword v1 above covers the high-precision bulk first.

## Epic 22 — Triage as a separate app: the engagement deck  (`research`, `area:triage`)
*User idea (2026-06-12): spin triage out into its own app that hooks into the content-hoarder
DB, so OTHER card types can be laced into the triage stream to keep engagement up — first
candidate: **Anki flashcards** interleaved between content cards. Triage becomes one
swipe-stream for "things needing a small decision," and the variety itself is the
engagement mechanic.*

- [ ] **P3 — Architecture research FIRST (decision gate).** Decide the shape before any build:
  (a) same Flask app, pluggable card sources behind the existing `/random` batch endpoint
  (cheapest, no new process); (b) sibling service reading `app.db` directly (SQLite
  cross-process write coordination needed — triage writes statuses); (c) fully separate app
  consuming an HTTP API the hoarder exposes (cleanest seam, most work). Overlaps the open
  PKMS sibling-service question (Epic 21 icebox) — answer them together. Note the tension
  with Epic 17 (unify surfaces): that unification targeted browse+reddit; triage spinning
  OUT can coexist, but decide deliberately. Sketch the card-source interface while deciding:
  a card = `{id, source_app, render(), actions[], on_action()}` — content items, Anki due
  cards, and the Epic 20 resurfacing/surprise-me cards would all implement it.
- [ ] **P3 — Anki interleave prototype (after the architecture gate).** AnkiConnect
  (localhost:8765 JSON-RPC, requires desktop Anki running) exposes due cards + answering;
  interleave N content cards : 1 due flashcard. Swipe maps to Again/Good at minimum. Offline
  Anki = the lane simply doesn't appear (no error state, no guilt).

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

## Epic 23 — ADHD design-language bridge (shared with PKMS)  (`chore`, `area:design`)
*User idea (2026-06-12): the ADHD-friendly design knowledge accumulating here — friction
asymmetry, guilt-free decay, no backlog counts, recognition-over-recall resurfacing, win
pebbles, startable/closable task shaping — should be shareable so PKMS (K:\Projects\PKMS)
pulls from one source instead of re-deriving it.*

- [x] ~~**P3 — Decide the sharing shape, then extract.**~~ **DONE 2026-06-12 (decided +
  extracted from the PKMS session, user-directed as the PKMS pre-Phase-4 prerequisite).**
  Shape = option (b): standalone repo **`K:\Projects\adhd-design-language`**
  (`DESIGN-LANGUAGE.md` + README). Ownership/sync model: that repo is the single source
  of truth for the shared *behavioral* principles; both projects reference it **by
  absolute path, never copy**; sessions in either project may edit + commit there;
  evidence stays in the PKMS research corpus; project-specific applications (visual
  tokens, gesture maps, copy strings) stay local — this repo's frontend-design skill
  keeps its v2/v3 token system and now points at the shared repo for the behavioral
  layer. Distilled from: PKMS 10-synthesis + closed decision gates, this skill's
  friction-asymmetry principle, and the Epic 20/21 guardrails.

## Epic 25 — Reddit access de-risking  (`enhancement`, `area:reddit`)
*Harden cookie-authed Reddit hydration against the (low but real) ban / IP-block risk and move reads to
Reddit's sanctioned lane. **Full risk model + per-feature rationale + as-built notes:
[`docs/reddit-derisking.md`](docs/reddit-derisking.md)** — that doc is the source of truth; details live
there, not here. All 7 features SHIPPED + merged to main 2026-06-16 (`282a0d8`): new `reddit_oauth.py` +
`_http` jitter helpers; +33 offline tests, full suite 454 green; passed a high-effort /code-review.
**OAuth ships DORMANT** — `hydrate_one` prefers it once a refresh token exists; activate once with
`python -m content_hoarder reddit-oauth --login` (cookie stays as the automatic fallback).*

- [x] ~~**F1 — Jitter the throttle.**~~ `_http.jittered_throttle` (uniform `[0.75,1.75]×base`) replaces
  the fixed inter-request `sleep` on hydrate/drain/sync — kills the exact-interval bot fingerprint.
- [x] ~~**F2 — 429/Retry-After + full-jitter backoff on the READ path.**~~ `_http_get` opts into
  `_http.request(retries=4, backoff=1.0, jitter=True)` (`_http.full_jitter_delay`); hydration now honors
  rate-limit signals instead of treating the first 429 as a hard failure. Non-jitter path byte-identical
  (golden test guarded).
- [x] ~~**F3 — Transport-aware User-Agent.**~~ `REDDIT_BROWSER_USER_AGENT` on every cookie path
  (login/sync/drain/resave/hydrate); a compliant `windows:content-hoarder:<ver>` UA on OAuth; the generic
  `USER_AGENT` is retained for archives/youtube/karakeep.
- [x] ~~**F4 — On-demand default; cap/gate bulk backfill.**~~ `reddit_hydrate.DEFAULT_BATCH_LIMIT`
  lowered 100→25 behind the existing dry-run/`--yes` gate; tap-to-hydrate stays the norm.
- [x] ~~**F5 — OAuth read-only path (installed-app, RedReader client id, no secret).**~~ New
  `reddit_oauth.py` (authorize / code-exchange / refresh; refresh token in the DB, NOT the repo;
  `oauth_get` with the F2 backoff) + the `reddit-oauth` CLI; `hydrate_one` prefers OAuth when configured.
  **Live-verified** (a real `oauth.reddit.com` read returned a Listing). Client id in `.env` + a User env
  var; `read` scope only (no `identity`, so the username is omitted from the UA — by design).
- [x] ~~**F6 — Treat mass-unsave (writes) as elevated risk.**~~ `drain` now jittered + an inline
  elevated-risk note; the approve-scope gate is kept (programmatic writes are what bans actually target).
- [x] ~~**F7 — Global rate cap.**~~ `_http.MIN_THROTTLE` (0.6 s) floor on the hydrate/drain/sync
  throttles — never approaches Reddit's 100 QPM authenticated budget, even if misconfigured.
- [ ] **P3 — "Human-mimic" jitter for hydration pacing (learning experiment).** *(User idea
  2026-06-16; explicitly a learning project — Kenja wants to build it himself.)* Replace/augment the
  uniform `_http.jittered_throttle` with a human-shaped delay distribution. **Honest verdict — don't
  expect a real win:** it won't save speed (real browse timing is heavy-tailed/log-normal and *slower*
  on average — it embeds read-pauses a bot doesn't need; for raw speed just lower `--throttle`, OAuth
  has ~4× headroom under 100 QPM), and the anti-detection gain is marginal (uniform already kills the
  exact-interval fingerprint; Reddit isn't distribution-profiling low-volume authenticated reads). The
  value is the *learning*, not the outcome. **Seam:** `jittered_throttle` is one function, called in 3
  places (`reddit_hydrate.hydrate_batch`, `reddit_unsave.drain`, `reddit_sync.sync_saved_cookie`) as
  `sleep(_http.jittered_throttle(throttle))` — swap it or make it pluggable; keep the `_http.MIN_THROTTLE`
  floor and add a cap so a sampled long pause can't stall a batch. **Ladder:** (a) log-normal
  `base*random.lognormvariate(0,0.5)` clamped (~2 lines); (b) two-state burst/pause Markov (short bursts
  + occasional long pause = the real browsing rhythm); (c) empirical "copy me" — log real thread-open
  gaps from the `/reddit/items/<fn>/thread` route into a small table, then sample (caveat: truncate the
  long read-pauses so it stays human-*shaped* without being bot-pointlessly slow).

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
- [ ] **P2 — Overall categories↔tags model reorg (decision gate first).** *(User direction 2026-06-17.)*
  Decide + implement the unified taxonomy: whether the processing **categories** (listenable/watch/wotagei)
  become a reserved **tag namespace** (one filter UI + one rail covers both — Epic 5 P2's idea), how
  parent/child relationships are stored (a static parent→children map vs. a real hierarchy on `metadata`), and
  how `categorize.py`'s buckets map onto the parents above. **Sketch the model before** refactoring
  `categorize.py` + `search_items` + the rail. Large — sequence the two visual-grouping items above as the
  near-term wins, this reorg as the structural follow-up.
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
- [ ] **P2 — Rule-based + AI-based tagging and new-tag suggestions.** *(User-requested 2026-06-19.)* Two
  engines feeding the tag set, plus a **suggestion** surface. **Rule-based** largely exists — `categorize.py`'s
  subreddit/host maps + word-bounded title keywords — so expose it as **user-editable rules** (add a
  subreddit→tag / keyword→tag mapping from the UI, persisted like the gitignored `nsfw_rules.json` precedent)
  rather than code-only seed maps. **AI-based** builds on the local-LLM classify path (Epic 1 / Epic 9(d)): run
  it over the untagged tail to **propose** tags. Crucially, both should be able to **suggest *new* tags** (not
  just pick from the fixed vocabulary) — the LLM/clustering proposes a candidate tag + items, and the user
  **accepts/renames/rejects** it into the user-tag vocabulary (item above). Keep suggestions **non-destructive
  + reviewable** (a queue/inbox of proposed tags, never auto-applied). Sequence after the manual-tagging
  primitive; relates to Epic 9 (tagging) + Epic 1 (LLM classify).
- [ ] **P2 — Create folders when saving posts.** *(User-requested 2026-06-19.)* Let the user **create a folder**
  (and file the item into it) **at save time**, introducing a **folder** primitive alongside categories + tags.
  **Decision gate (fold into the model reorg above):** are folders just a **reserved single-select tag
  namespace** (one item lives in one folder, reuse the tag rail + filters) or a **separate first-class field** on
  the item (`metadata.folder`)? Single-select + user-creatable distinguishes them from the multi-label tags.
  Scope: a folder picker/creator in the save/import flow (and likely a move-to-folder action post-hoc), folders
  in the left rail as a filter, persistence that survives re-import, and how folders coexist with the
  parent/child tag grouping. Sketch the model with the taxonomy reorg before building.
