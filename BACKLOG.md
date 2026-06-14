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
- [ ] **P2 — Local-LLM auto-classify (`assist/llm.py`).** Classify from title + channel
  (listenable/watch/wotagei) with a manual override per item. Only after heuristics are validated.
  *(WIP exists on the unmerged `feat/llm-auto-classify` branch — review + merge or rebase.)*
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
- [ ] **P3 — Zoom into the image / gallery modal.** Scroll/pinch-to-zoom (+ pan) in the media lightbox
  and gallery viewer (`openImage`/`openGallery` in `app.js`).
- [ ] **P2 — Rework the keyboard controls.** *(User-requested 2026-06-08.)* The current map (browse
  J/K · S/E/Y · X; triage S/E/Y) needs a redesigned, more ergonomic one-hand scheme — propose a new
  mapping for review. (The `?` cheatsheet already ships.)

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
- [ ] **P2 — Re-surface the Firefox-tabs filter (regression).** The **"📑 Firefox tabs"**
  (`open_in_firefox=1`) filter referenced above has **no UI control** in the v2 layout — it was lost in
  the redesign (no `open_in_firefox` toggle in `app.js`/`index.html`). Re-add a way to filter to
  open-in-Firefox items (incl. the YouTube-promoted tabs); the Firefox **source tab** only filters by
  source, not this finer flag.
- [ ] **P3 — Live Reddit / YouTube API sync.** When API keys arrive, implement `BaseConnector.sync()`
  using the existing `auth_tokens` table.
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
- [ ] **P3 — OAuth go-live.** When a Reddit API key arrives, (re)build OAuth sync + live
  thread fetch + OAuth save/unsave; prefer OAuth over the cookie path when configured. *(The old
  `feat/reddit-oauth` branch is gone — this is a rebuild, not a merge.)*

- [x] ~~**P3 — Reddit comments sort option in the inbox.**~~ Shipped (2026-06-12, trio batch 1,
  winner GLM-5.1): best/top/new on the inline thread view — sibling-group sort (top = score,
  new = created_utc, best = cached order), `?sort=` validated at the route, `#thread-sort`
  select persisted to localStorage. 7 tests.
- [x] ~~**P2 — Extend tagging beyond Reddit (YouTube, etc.).**~~ Shipped (2026-06-12, trio
  batch 1, winner Kimi K2.6): `youtube_tags()` (16-channel seed map + title-keyword fallback
  into existing buckets) + `tag_youtube_source()` (dry-run/retry, preserves processing tags,
  drops enrich keyword noise, never touches `metadata.category`) + `categorize --topics` CLI.
  Note: `merge_upsert`'s category mirror re-appends the processing tag at the END of
  `metadata.tags` on every write — on-disk order is `[topic..., processing]`. Seed maps are
  deliberately conservative — extend `_YOUTUBE_CHANNEL_TAGS`/`_YOUTUBE_KEYWORD_TAGS` with
  corpus-confirmed channels next.
- [ ] **P2 — Add incremental "Sync newest" to the main browse view.** *(User-requested 2026-06-08.)* The
  working `POST /reddit/sync` button lives only in `/reddit` (`reddit.html` `#btn-sync`); surface it in the
  main browse header/tools too.
- [ ] **P2 — Disambiguate the "Sync now" label.** The browse/triage "Sync now" buttons (`#ru-sync`,
  `#ru-sync-triage`) actually **drain the unsave queue** (`/reddit/unsave/drain`), not sync — and are
  grayed out when nothing is pending, which reads as "broken / not implemented." Relabel (e.g.
  "Unsave queued (N)" / "Drain") so it doesn't collide with incremental "Sync newest".

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
- [ ] **P2 — Default "All" view sorted by "easy to triage".** Use the learned likely-done score (this
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

## Epic 13 — UI bugs & quick fixes  (`bug`, `area:ui`)
*Discrete defects surfaced during the redesign; several are fixed in the v2 design pass (marked).*

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
- [ ] **P2 — reddit_video audio (HLS/DASH) — follow-up to the shipped media pass.** `openVideo` sets
  `<video src=media_url>`; `v.redd.it` separates audio into a DASH/HLS track, so audio is silent where
  native HLS isn't supported (Chrome/Firefox). Per `docs/reddit-media-rendering.md` §4.3: feature-detect
  `canPlayType('application/vnd.apple.mpegurl')`, prefer the HLS manifest when supported, keep the MP4
  fallback otherwise; revisit hls.js only if real use demands it. Verify audio on a real device first.
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

## Epic 15 — Reddit / HN as-app navigation  (`enhancement`, `area:reddit`)
*Make saved items behave like the native apps when tapped.*

- [x] ~~**P2 — Tap subreddit → open the subreddit; tap user → open the user page.**~~ Shipped (design-v2
  round 2; user-verified): meta-line `r/<sub>` / `by <author>` link to Reddit (new tab) without triggering
  row open/select.
- [ ] **P2 — Reddit image-link → open the comments thread, not the raw image URL.** (Open.)
- [x] ~~**P2 — Hacker News item → open the HN discussion thread, not the linked article.**~~ Shipped
  (user-verified).
- [ ] **P2 — Hacker News author → open the HN user profile** (`news.ycombinator.com/user?id=<author>`),
  mirroring the Reddit user link.
- [ ] **P2 — HN: chip to open the linked article/story URL directly.** The item opens the discussion, so
  add a separate chip for the external article link.
- [ ] **P3 — (Optional) Fetch article thumbnails for HN items.** Show a preview image on HN rows/cards
  via an OG-image fetch/enrich pass (gate like other enrich passes). *(User: "optional epic".)*

## Epic 16 — Mobile UX  (`enhancement`, `area:mobile`)
*Make the PWA feel native on the phone (Firefox / Pixel-6 target). Absorbs "make the Reddit view more
mobile-friendly".*

- [x] ~~**P1 — Swipe must not trigger horizontal page scroll.**~~ ✅ v3: `body{overflow-x:clip}` (`browse.css:15`) + `swipe.js:27` `touchAction="pan-y"` (transform-only drag + edge-zone guard) — a row swipe can't side-scroll the page. Orig: Lock the layout to the device width
  (fixed viewport, `overflow-x` containment) so swiping a row doesn't side-scroll the page.
- [x] ~~**P2 — NSFW blur in the inbox/triage**~~ ✅ v3: over-18 media blurred in the browse list (`render.js:13/62` veil + `browse.css:318` `filter:blur(16px)`), reveal-on-tap. Orig: adopt the Reddit view's blur for over-18 media.
- [ ] **P2 — Tap thumbnail opens the view modal; long-press enters group-select.** ✅ tap-opens-modal SHIPPED on v3 (`main.js:161-180` delegated `[data-media]` → `openMediaFor`); ⏳ the **long-press → group-select** half is still unbuilt (`swipe.js` has no long-press; select is via the avatar `[data-select]` button). Box stays open for that half. Orig: Today a thumbnail
  tap on mobile doesn't open the modal.
- [ ] **P2 — Swipe physics feel.** The current swipe is a little stiff; add momentum/spring + better
  thresholds for a smoother feel.
- [ ] **P3 — Mobile-friendly scrollbar** (Nova-Launcher-style fast-scroll handle).
- [x] ~~**P2 — Inbox swipe = mobile/touch only.**~~ ✅ v3: `swipe.js:37` ignores `pointerType==="mouse"` unless `{mouse:true}`; `main.js` `attachSwipe` passes no `mouse` flag → desktop uses buttons, touch swipes. *(User decision 2026-06-08.)* Orig: Disable row-swipe on the
  inbox on desktop (desktop uses the action buttons/hover); keep swipe for touch only.
- [ ] **P3 — Swipe-only interactions on mobile.** Per the v2 decision the action icons stay visible on
  touch; optionally offer a swipe-only mode (no inline icons) for a cleaner mobile row.
- [ ] **P3 — Make the Reddit view mobile-friendly** (the `/reddit` table/grid is desktop-first).

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
- [ ] **P3 — Rolling decay automation (Icebox).** Reactivate after the backfill proves out and
  ~a month of new saves accumulates.
- [ ] **P3 — PKMS promote-pipeline export wrapper (Icebox).** The read path already exists
  (`db.get_reddit_thread`, db.py:834; 672 threads cached); build the thread-JSON→markdown
  export only when PKMS Phase 3 starts. Don't build capture/promote here before then.
  Related open question (PKMS side, Kenja decides later): whether the PKMS mobile `/capture`
  endpoint lives inside this Flask app (same tailnet host) or as a sibling service.
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
