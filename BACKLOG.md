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

- [ ] **P1 — Heuristic categorizer (no LLM first).** Add a `category` field/tag
  (`listenable` / `watch` / `wotagei` / `unknown`) derived from rules: duration thresholds
  (`>~30 min` ⇒ listenable, `<~5 min` ⇒ watch), a **channel allowlist** (music/podcast/long-form
  channels), and a **wotagei title-keyword** match (`ヲタ芸`, `wotagei`, `wota`, idol-event terms).
  CLI `categorize` + store on `metadata.category`. *(asmartin-ai wants to test heuristic accuracy before
  adding the LLM.)*
- [ ] **P1 — "Processing areas" = category filters.** Filter the inbox/triage by `category`
  (e.g. a Listenable view, a separate Wotagei area). Reuses the existing filter/sort layer
  (`db.search_items`, the `#status-filter`/sort UI) — add a category facet.
- [ ] **P2 — Local-LLM auto-classify (`assist/llm.py`).** Classify from title + channel
  (listenable/watch/wotagei) with a manual override per item. Only after heuristics are validated.
- [ ] **P3 — Manual re-tagging UI.** A quick category picker on the triage card / list row.

## Epic 2 — YouTube metadata enrich  (`enhancement`, `area:youtube`)
*Motivation: `--flat-playlist` captures duration/channel but NOT category/tags/description, which
the categorizer (Epic 1) wants for accuracy.*

- [ ] **P2 — Per-video enrich pass.** `enrich --source youtube` runs
  `yt-dlp --dump-single-json <id>` to fill `category`, `tags`, `description`, exact `duration`,
  `view_count`. Make it **incremental/resumable** (only items missing the fields) — ~5k videos is
  slow, so batch + checkpoint. Lazy-import yt-dlp; degrade gracefully.

## Epic 3 — Recover deleted / private YouTube titles  (`enhancement`, `area:recovery`)
*Motivation: many WL items show as `[Private video]` / `[Deleted video]` with no title.*

- [ ] **P2 — Deleted-title recovery (opt-in enrich).** For `[Deleted video]` items, query
  **filmot.com** (deleted-video metadata DB) then the **Wayback Machine** as a fallback; store the
  recovered title + mark provenance. Realistic: good for older *deleted* titles, poor for *private*.
  Refs: [filmot.com](https://filmot.com), [mattwright324/youtube-metadata](https://github.com/mattwright324/youtube-metadata),
  [phloof/youtube-recovery-tool](https://github.com/phloof/youtube-recovery-tool).

## Epic 4 — Recover deleted Reddit content  (`enhancement`, `area:recovery`)
*Motivation: many saved posts/comments are now `[removed]`/`[deleted]`.*

- [ ] **P2 — Port the RSM `archival/` package.** Copy
  `F:\reddit-saved-manager\src\reddit_saved_manager\archival\` (PullPush.io + Arctic-Shift providers,
  non-destructive overlay, on-demand + bulk modes) into `content_hoarder/archival/`; run it as an
  enrich step for reddit items whose body is `[removed]`/`[deleted]`. CLI
  `enrich --source reddit --archives`. Refs: [pullpush.io](https://pullpush.io),
  [ArthurHeitmann/arctic_shift](https://github.com/ArthurHeitmann/arctic_shift). (reveddit/removeddit
  are dead / moderator-only.)

## Epic 5 — Inbox redesign follow-ups  (`enhancement`, `area:ui`)
*The incremental redesign shipped bigger cards + list swipe + undo snackbar. Remaining Gmail/Inbox
patterns (ref [team-inbox/inbox-reborn](https://github.com/team-inbox/inbox-reborn)):*

- [ ] **P2 — Sources as top tabs.** Move the source sidebar to Gmail-style category tabs across the
  top. Plain CSS/JS or [cferdinandi/tabby](https://github.com/cferdinandi/tabby) (~2 KB).
- [ ] **P2 — Status as a left sidebar.** Replace the `#status-filter` dropdown with a collapsible
  Gmail-style label sidebar (inbox/keep/archived/done with counts).
- [ ] **P3 — Smooth drag-and-drop to buckets.** Drag cards onto category/status buckets.
  [SortableJS](https://github.com/SortableJS/Sortable) (~20 KB, touch-capable) or
  [html5sortable](https://github.com/lukasoppermann/html5sortable) (~4 KB).
- [ ] **P3 — Consolidate triage swipe onto `swipe.js`.** Refactor `triage.js` to use the shared
  `window.attachSwipe` helper (currently duplicated). Keep the verified behavior.

## Epic 6 — Duplicates v2  (`enhancement`, `area:ui`)
*The first cut was removed: the "duplicate group" naming confused, and placeholder titles created
false positives.*

- [ ] **P3 — Redesign de-duplication.** Clearer language ("possible duplicates"), **exclude
  placeholder titles** (`[deleted]`/`[removed]`/`[Private video]`/`[Deleted video]`) from grouping,
  better review UX. Reuse the prior `find_groups`/`resolve` logic from git history (commit `a724f91`).

## Epic 7 — More sources & live sync  (`enhancement`, `area:connectors`)
- [ ] **P2 — Import WL3 + Watch Later.** WL3 via the same `yt-dlp --flat-playlist` flow; main Watch
  Later via a browser-extension export (the connector already accepts a flat array).
- [ ] **P2 — Google Keep import.** Per-account Takeout → `import path/to/Keep` (connector exists;
  just needs the export).
- [ ] **P3 — Firefox tabs connector.** Build the deferred stub: OneTab / Tab Session Manager exports
  + `recovery.jsonlz4`. Inputs already in `K:\Users\asmartin-ai\Downloads\TabExports`.
- [ ] **P3 — Live Reddit / YouTube API sync.** When API keys arrive, implement `BaseConnector.sync()`
  using the existing `auth_tokens` table.

## Epic 8 — Polish & infra  (`chore`)
- [ ] **P3 — `.gitattributes`** (`* text=auto eol=lf`) to stop CRLF warnings.
- [ ] **P3 — Optional Karakeep bridge** (already a stub) if a stock instance is adopted for a
  forward-capture library.
