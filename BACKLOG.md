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
- [x] ~~**Firefox tabs connector.**~~ Shipped: parses "Export Tabs URLs (Rich format)" .txt
  (title / url / favicon / window / pinned) → `firefox:<url-hash>` items, de-duped across the
  overlapping daily exports. Imported one sample (326 tabs). OneTab / `recovery.jsonlz4` remain future.
- [x] ~~**Firefox YouTube tabs → YouTube items.**~~ Shipped: a tab whose URL is a YouTube video is
  promoted at import to a real `youtube:<vid>` item (host-guarded id extraction, cleaned title,
  thumbnail, `open_in_firefox` marker) so it merges with Watch Later and is enrichable. One-time
  `migrate-firefox-tabs [--apply]` (dry-run default) re-keys rows imported before this and collapses
  duplicates. Of the 326-tab sample, **219 were YouTube** (2 already saved, 217 orphans); browse them
  via the **"📑 Firefox tabs"** filter (`/items?open_in_firefox=1`).
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

- [ ] **P2 — Redesign the app icon.** New mark: a backwards "E" forming an "H" (hoarder). Replace
  `static/icon.svg` + the 192/512 PNGs + the manifest; keep the teal-on-`#0f1115` tile.
- [ ] **P3 — 60fps UI.** Audit list/scroll/swipe for jank (avoid layout thrash, prefer transforms /
  `will-change`, throttle handlers); target smooth 60fps on the Pixel-6 target.
- [ ] **P3 — README mobile quickstart.** Document running the PWA on a phone over Tailscale
  (`serve --host <tailscale-ip>`, install-to-home-screen, safe-area / edge-gesture notes).

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
- [ ] **P2 — Export + remove the `nsfw_erotic` set.** Goal: pull the erotic-tagged items out of the
  Saved list (to migrate to a separate account). (a) **Export by tag** — dump `nsfw_erotic` items
  (permalink/url/title → CSV/JSON) so they can be re-saved elsewhere; generalize the existing
  `/export` + `export` CLI with a `tag=` filter (the `tag=` search filter already exists). (b)
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
- [ ] **P3 — Port RSM's richer importers.** Reddit **GDPR data-export ZIP** (keyless full saved-list
  backfill — the canonical fallback if cookie sync is unviable), **BDFR JSON**, and recursive directory walk.
- [ ] **P3 — Duplicates review UI** (also Epic 6 P3). Title-dedup flagged ~5.2k loose matches across ~1.8k
  groups on the real corpus — too many to auto-resolve; needs the group-review surface before resolving.
- [ ] **P3 — OAuth go-live.** When a Reddit API key arrives, merge `feat/reddit-oauth` (OAuth sync + live
  thread fetch + OAuth save/unsave); prefer OAuth over the cookie path when configured.

- [ ] **P3 — Reddit comments sort option in the inbox.** Pick a comment sort (best/top/new) when
  opening a Reddit thread inline.
- [ ] **P2 — Extend tagging beyond Reddit (YouTube, etc.).** The multi-label tag system (this epic /
  `categorize.py`) is reddit-only today; apply tags to YouTube videos (channel/title heuristics) so the
  tag filter spans sources.
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

- [ ] **P2 — Shuffle / mixed-content mode.** A triage/browse mode that interleaves a *mix* of sources
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
- [ ] **P2 — Operator suggestions / autocomplete (Gmail/Discord-style).** *(User-requested.)* The
  operators work but are invisible — add a discovery affordance: suggest keys + values as you type (e.g.
  after `source:` list the sources), and render applied operators as chips. No surface today.
- [ ] **P2 — Cross-source / boolean queries (research first).** `source:reddit AND source:youtube`
  doesn't work — an item has one source, and bare `AND` is treated as free text. Decide the model:
  multi-value `source:a,b` (OR) vs. a real boolean grammar (AND/OR/grouping). **User to research how
  Gmail / Discord / GitHub-search handle multi-value + boolean before designing.**
- [ ] **P2 — `has:` media-type operator.** `has:video` / `has:image` / `has:gallery` filtering on
  `media_type`. Pairs with the media-handling pass (Epic 13).
- [ ] **P2 — Fuzzy-by-default; `"quotes"` for exact.** *(User-requested — prioritize.)* Flip the default
  so bare free-text is **fuzzy** without the `#fuzzy` checkbox, and a `"quoted phrase"` opts out →
  **exact**. Wire into `search_items` (default `fuzzy=True` for bare terms; quoted spans = exact); drop or
  repurpose `#fuzzy` as an "exact" override. Mind the FTS-vs-fuzzy path when both appear in one query.

## Epic 13 — UI bugs & quick fixes  (`bug`, `area:ui`)
*Discrete defects surfaced during the redesign; several are fixed in the v2 design pass (marked).*

- [ ] **P2 — Rework the comfortable density layout.** **User spec (2026-06-08):** positioning is good,
  but make **every comfortable row a uniform fixed height (~100px)** — adaptive/dynamic height should
  apply to **cards density only**. Constrain the thumbnail within that fixed height (`object-fit: cover`)
  and keep the action slot aligned. Touches `app.css` `.items.density-comfortable`.
- [ ] **P2 — Tag-chip overload on enriched YouTube cards.** Enriched YouTube videos render a wall of
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
- [ ] **P1 — Reddit videos & galleries broken.** Video/gallery items don't play / render correctly in
  the inbox; audit `media_type` handling + the preview/lightbox path (`mediaSlotHtml` / `openMedia` /
  `openGallery`) against real Reddit data. **Direction (2026-06-08): avoid the Reddit iframe** — render
  galleries/video with native embeds from the archived `media`/`gallery` metadata instead. Study how
  Reddit Enhancement Suite + old.reddit present media. Bigger than a quick fix — a media-handling pass.
- [ ] **P2 — Card density visual rework.** The cards layout is structurally correct but reads poorly.
  **Root cause (from screenshot, 2026-06-08):** many Reddit posts are **tall text-screenshots** (e.g.
  r/BlueskySkeets) and the fixed **16:9 `object-fit:cover` hero crops the text off** — "image difficult
  to look at." First-pass tweaks applied for review (hero `max-height` 280→200px, `object-position: top`,
  trimmed head/main padding); if still bad, do a full rework — likely needs **per-aspect media handling**
  (don't force 16:9 on portrait/text images) and overlaps the Epic 13 P1 Reddit-media pass. User may
  provide a Figma layout. Touches `app.css` `.items.density-card` + `mediaSlotHtml` in `app.js`.
- [ ] **P2 — Compact density visual cleanup.** Compact rows are mostly fine, but the **NSFW label
  collides with the meta line** (screenshot): the "NSFW" text + teal pill overlap the byline so "posted …"
  is truncated/clipped (looks like a doubled "NSFV/NSFW"). Fix the NSFW marker placement in compact +
  general spacing polish.
- [ ] **P2 — Three-dot ⋯ visual menu shouldn't auto-close on change.** Changing a setting
  (density/theme/focus) closes `#visual-menu-pop`; keep it open so several can be toggled without
  reopening.
- [ ] **P2 — Tag chips only render in card view.** `tagChips` shows on cards but not on compact/
  comfortable rows; render across all densities (subject to the tag-chip-overload fix above). `app.js`.
- [ ] **P2 — NSFW blurred thumbnail renders too wide (comfortable/list).** The over-18 blurred thumb
  expands to ~40% of the row width with a centered "NSFW" overlay (screenshot) instead of the normal
  thumbnail box; constrain it to the standard thumb width/aspect. Likely shares a root with the
  comfortable-density fixed-height/thumbnail sizing above.
- [ ] **P2 — Bulk-action Undo missing.** Group-select → Keep/Archive/Done shows no Undo (the per-item
  Undo toast doesn't fire for bulk), so a bulk action can't be reversed. Wire Undo for `/bulk/status`.
- [ ] **P2 — Bulk bar shifts the list down when it appears.** Selecting a row makes the bulk bar push the
  whole list down, so the cursor is no longer over the originally-selected row (bad on desktop). Overlay
  the bulk bar or reserve its space so the list doesn't jump.
- [ ] **P2 — Bulk Keep/Archive/Done buttons not color-coded.** Color-code them to match the triage/row
  semantic colors.
- [ ] **P2 — Move processed items back to Inbox.** Kept/Archived/Done items need a reversible action to
  return them to `inbox` — per-item and as a bulk action.
- [ ] **P2 — Row click should open only on the title/link, not the whole row body.** Refine the `#items`
  delegated handler so a body click doesn't open the item — only the title/link does (avatar/checkbox
  still toggles select).
- [ ] **P2 — Esc doesn't close the Reddit video/thread modal.** `Esc` (and backdrop click) should close
  it like the other modals.
- [ ] **P3 — Reposition / iconify the Sort control.** Replace the sort dropdown with a sort icon or move
  it out of the rail.
- [ ] **P2 — Scroll the list from the side gutters too.** With the Gmail-style independent scroll, only
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

- [ ] **P2 — Settings cog + panel.** A gear in the header opening a settings sheet.
- [ ] **P2 — View density in settings** (compact / cozy / cards) — surface the existing density toggle.
- [ ] **P2 — Light/dark theme toggle in settings** — surface the existing `theme.js` toggle.
- [ ] **P2 — Infinite scroll by default; Focus mode batches.** *(User decision 2026-06-08.)* Make all
  lists **load-on-scroll** (drop the "Show more" button) EXCEPT **Focus mode**, which restricts to
  deliberate **batches** (the old `BATCH=25` becomes the Focus batch size). Supersedes the batch-vs-scroll
  toggle.
- [ ] **P3 — Focus mode wider on desktop.** Desktop Focus mode should use a wider content column.
- [ ] **P3 — "Swipe only on mobile" → now a decision (see Epic 16).** Inbox swipe is mobile/touch-only by
  default, not a toggle.
- [ ] **P3 — Hide the Stats button under settings.** Move Stats into the settings menu to de-clutter.

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

- [ ] **P1 — Swipe must not trigger horizontal page scroll.** Lock the layout to the device width
  (fixed viewport, `overflow-x` containment) so swiping a row doesn't side-scroll the page.
- [ ] **P2 — NSFW blur in the inbox/triage** — adopt the Reddit view's blur for over-18 media.
- [ ] **P2 — Tap thumbnail opens the view modal; long-press enters group-select.** Today a thumbnail
  tap on mobile doesn't open the modal.
- [ ] **P2 — Swipe physics feel.** The current swipe is a little stiff; add momentum/spring + better
  thresholds for a smoother feel.
- [ ] **P3 — Mobile-friendly scrollbar** (Nova-Launcher-style fast-scroll handle).
- [ ] **P2 — Inbox swipe = mobile/touch only.** *(User decision 2026-06-08.)* Disable row-swipe on the
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
