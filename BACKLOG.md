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
- [x] ~~**Firefox tabs connector.**~~ Shipped: parses "Export Tabs URLs (Rich format)" .txt
  (title / url / favicon / window / pinned) → `firefox:<url-hash>` items, de-duped across the
  overlapping daily exports. Imported one sample (326 tabs). OneTab / `recovery.jsonlz4` remain future.
- [x] ~~**Firefox YouTube tabs → YouTube items.**~~ Shipped: a tab whose URL is a YouTube video is
  promoted at import to a real `youtube:<vid>` item (host-guarded id extraction, cleaned title,
  thumbnail, `open_in_firefox` marker) so it merges with Watch Later and is enrichable. One-time
  `migrate-firefox-tabs [--apply]` (dry-run default) re-keys rows imported before this and collapses
  duplicates. Of the 326-tab sample, **219 were YouTube** (2 already saved, 217 orphans); browse them
  via the **"📑 Firefox tabs"** filter (`/items?open_in_firefox=1`).
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
- [ ] **P3 — Needs the API (keyless not possible):** (a) ~~render **Reddit gallery images** inline — the
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
  (b) ~~NSFW split~~ **done** — `over_18` is near-useless (53 items), so NSFW is subreddit-driven via a
  user-curated allowlist: `nsfw_erotic` (1,025 items / 65 subs), `nsfw_talk` (sex/RoleReversal/
  LetGirlsHaveFun, 384), `nsfw_other` (over_18 residual, 52); SFW `*Porn` aesthetic network excluded.
  Purpose: let the user **export + unsave** the erotic set (possibly migrate to another account).
  (c) **tags UI** — source-aware triage
  chips + an index/Reddit-view tag filter (today the index dropdown is YouTube `category` only);
  (d) optional local-LLM assist for the untagged tail (Epic 1 pattern).
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
- [ ] **P3 — Port RSM's richer importers.** Reddit **GDPR data-export ZIP** (keyless full saved-list
  backfill — the canonical fallback if cookie sync is unviable), **BDFR JSON**, and recursive directory walk.
- [ ] **P3 — Duplicates review UI** (also Epic 6 P3). Title-dedup flagged ~5.2k loose matches across ~1.8k
  groups on the real corpus — too many to auto-resolve; needs the group-review surface before resolving.
- [ ] **P3 — OAuth go-live.** When a Reddit API key arrives, merge `feat/reddit-oauth` (OAuth sync + live
  thread fetch + OAuth save/unsave); prefer OAuth over the cookie path when configured.

## Epic 10 — Learned triage: suggest what to process next  (`enhancement`, `area:triage`)
*Motivation: triage decisions aren't random — the things I mark **done** share signals (source,
subreddit/channel, kind, age, media type, title keywords). The app should learn from my own history
and surface what I'm most likely to act on, instead of a flat random batch.*

- [ ] **P2 — Learn a "likely-done" score from triage history.** Train a lightweight, local,
  explainable model on each item's features (`source`, `metadata.subreddit`/`channel`, `kind`,
  `media_type`, `category`, age buckets, title tokens) against the outcome (`status`:
  done/keep/archived vs still inbox). Start with a transparent baseline — per-feature done-rate
  (naive-Bayes / logistic regression over hashed tokens) computed from existing `items` rows — so it
  needs **no new data**, just `processed_utc IS NOT NULL` history. Store the score on
  `metadata.triage_score` (recompute via a `learn-triage` CLI command); fully offline (no API).
  Surface a "why" (top contributing features) so suggestions stay trustworthy.
- [ ] **P2 — "Smart triage" mode that mixes recency + likely-done.** A new triage batch mode that
  interleaves **recent** items (newest `created_utc`/`first_seen_utc`) with **high likely-done-score**
  items, instead of pure `ORDER BY RANDOM()`. Expose as `/random?mode=smart` (+ a toggle on the triage
  card menu); e.g. take top-K by score, top-K by recency, shuffle the union, with a configurable mix
  ratio. Reuses `db.get_random_batch` (extend with a `mode=` param).
- [ ] **P3 — Feedback loop.** Re-fit the score periodically (or after every N triage actions) so it
  tracks drift in what I care about; optionally fold in the local-LLM keep/skip suggestion
  (`assist/llm.py`) and the heuristic category (`categorize.py`) as additional features.
- [ ] **P3 — Per-source / per-subreddit "auto-archive likely-skip" assist.** Where the learned
  skip-rate for a bucket (e.g. a subreddit) is very high, offer a one-click reversible bulk-archive
  (built on `db.bankruptcy`-style ops) so low-value buckets clear fast.

## Epic 11 — Cross-source consolidation: condense duplicates into YouTube items  (`enhancement`, `area:dedup`)
*The same thing is often saved across sources: a YouTube video, a Reddit post linking to it, an HN
comment thread about it, and a Firefox tab of any of those. Today they're separate items. Condense
them into one canonical item — **YouTube takes precedence over every other source** — that links out
to its companion discussion threads.*

- [ ] **P2 — Consolidate matched items into a canonical YouTube item.** A re-runnable script that
  detects when a Reddit post / HN story / Firefox tab points at a YouTube video (extract the video id
  from the item's `url` / link target) and folds them into one `youtube:<id>` item. The companions
  survive only as links on the canonical item — e.g.
  `metadata.companions = [{source, kind, permalink/url, fullname}]` — not as separate cards.
  Non-destructive + **reversible** (retain the originals' fullnames so it can be undone).
- [ ] **Card affordances.** On the YouTube card show **click-through links** to the companion Reddit
  comments / HN thread, plus a small **icon/badge** signalling that an accompanying discussion exists,
  so it's identifiable at a glance.
- [ ] **Constraint — saved-only, never fetch.** Only consolidate threads **already saved**. Do NOT go
  online to find or fetch a Reddit/HN thread for a video that doesn't have one saved — explicitly out
  of scope.
- [ ] **Precedence + matching.** YouTube > all. Match key = canonical YouTube video id from any
  source's link. Cases: Firefox-tab→YouTube (already promoted at import via `firefox_youtube.py`),
  Reddit link-post→YouTube, HN story-url→YouTube. (The standalone "📑 Firefox tabs" filter button was
  removed — that import-time promotion still happens; this feature subsumes the rest.)

## Epic 12 — Search operators in the search bar  (`enhancement`, `area:search`)
*Mimic Gmail / Discord / Google search-operator syntax in the main search bar so power queries don't
need separate filter controls.*

- [ ] **P2 — Parse `key:value` operators alongside free text.** e.g. `source:youtube`,
  `subreddit:hololive`, `kind:post`, `tag:minecraft`, `status:inbox`, `is:saved`/`is:nsfw`,
  `before:2024-01-01`/`after:…`, `score:>100`, quoted `"exact phrase"`, and negation `-term`.
  Translate them into the existing `search_items` filters so the bar drives the same query layer the
  dropdowns do today, keeping the FTS path for the remaining free text. Grammar modelled on
  Gmail/Discord/Google; chips/autocomplete are a later polish.
