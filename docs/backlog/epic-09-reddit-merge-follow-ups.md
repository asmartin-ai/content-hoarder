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
  - Tag landscape snapshot (2026-06-29 after HN/Firefox precision pass): browser/HN heuristics are
    deliberately precision-biased. Firefox applied 494/2,269 auto-tagged rows; HN applied 1,189/9,374.
    Programmatic tags are now stamped in `metadata.tags_auto`; human/editor tags remain stamped in
    `metadata.tags_manual`; `metadata.tags` is the displayed/searchable union. This keeps future sorting
    able to distinguish human vs heuristic tags.
- [x] ~~**P2 — Export + remove the `nsfw_erotic` set.**~~ ✅ Feature path shipped; live account action
  not run by this doc pass. (a) **Export by tag** shipped (overnight 2026-06-10): `GET /export` and
  `export --tag X --out file` use the same filters as `/items`, permalink-oriented. (b) **Bulk-unsave by
  tag** shipped/hardened 2026-06-29: `db.preview_unsave_by_tag` / `enqueue_unsave_by_tag` plus the
  `/reddit/unsave/enqueue-by-tag` route queue locally only, default to preview, require explicit
  `apply:true, yes:true`, and never flip `is_saved` for bulk rows until drain succeeds. The web drain route
  now mirrors CLI safety: default dry-run preview; live Reddit mutation requires `live:true` plus
  `confirm:true`/`yes:true`, keeps caps, leaves the existing audit trail, and never auto-drains after tag
  queueing. Consider `nsfw_talk` as a separate optional target; run any real drain only after reviewing the
  preview and with the existing live confirmation gate.
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
- [x] ~~**P3 — Duplicates review UI**~~ ✅ SHIPPED 2026-06-26 under Epic 6: Settings → Duplicates
  opens `#dupesheet`, backed by `/duplicates`, `/duplicates/resolve`, and `/duplicates/undo`, with By URL /
  By Title grouping, per-group "Archive others", and undo snackbar.
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
  GLM-5.1/Aider Arm B + review fixes), then precision-expanded/applied 2026-06-29. `firefox_tags()` /
  `hackernews_tags()` in `categorize.py` share `_browser_bucket_tags()` (host map + conservative,
  word-bounded title keywords), with curated buckets including `investing`, `ai_ml`, `web_dev`,
  `self_hosted`, `linux`, `startups`, `crypto`, and `productivity`. `tag_browser_source()` is exposed via
  `categorize --source firefox|hackernews [--dry-run] [--all]`, never touches `metadata.category`, and now
  writes programmatic provenance to `metadata.tags_auto` while preserving human `metadata.tags_manual`.
  Precision pass removed broad `ycombinator.com`→`startups`, Bloomberg/CNBC/WSJ host-only `investing`,
  bare `steam`, generic `earnings`/`investing`, bare `claude`, raw `html`/`css`, and payment-footer
  `bitcoin` false positives. Live apply after a local DB backup:
  Firefox 494/2,269 rows auto-tagged; HN 1,189/9,374 rows auto-tagged; verified `tags_auto`/`tags_manual`
  are subsets of displayed `metadata.tags`. Relates to Epic 26 (taxonomy).
