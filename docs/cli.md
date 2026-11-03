# CLI reference

The web app covers most work; every capability also has a command. Mutations are dry-run by default
and need explicit confirmation flags.

| Command | Description |
|---------|-------------|
| `--version` | Print the installed content-hoarder version. |
| `init-db` | Create the local SQLite database + FTS5 search tables. |
| `import <path> [--source ID] [--enrich] [--reconcile [--reconcile-dry-run] [--reconcile-complete]]` | Import supported files/directories through the source registry. Reconciliation marks missing Reddit saves unsaved; use `--reconcile-dry-run` to preview. `--reconcile-complete` disables the truncation guard only for a confirmed complete export. |
| `categorize [--source youtube\|reddit\|firefox\|hackernews] [--topics] [--dry-run] [--all] [--limit N]` | Tag items by heuristics. `--source youtube` → processing areas *listenable* / *watch* / *wotagei* on `metadata.category`; `--topics` (youtube) / `--source reddit\|firefox\|hackernews` → multi-label topic tags (gaming/defense/investing/…) on `metadata.tags` (host + title keywords; `--dry-run` previews accuracy without writing). |
| `enrich [--source ID] [--all] [--archives] [--titles] [--scores] [--gallery-previews] [--limit N]` | Enrich imported metadata, recover archive text/titles, hydrate scores, or recover gallery previews. |
| `scan-media [--status S] [--limit N] [--apply] [--recheck] [--workers N] [--batch N]` | Probe saved Reddit image/gallery items for deleted media and classify them on `metadata.media_status` (`gone` / `salvageable`, recording the salvageable preview URL for the `archive-media` pass). `--apply` writes (+ a `deleted` tag on gone items, surfaced by `is:deleted`); dry-run by default, crash-safe + resumable (skips already-classified unless `--recheck`). |
| `archive-media [--salvageable] [--galleries] [--images] [--twitter] [--videos] [--limit N] [--throttle S] [--max-video-bytes N] [--video-timeout S] [--apply]` | Download supported Reddit/Twitter media into the content-addressed local store. Scope flags select work; default is salvageable and gallery media. Preview only unless `--apply`; uses native ffmpeg for video. |
| `ocr [--limit N] [--apply] [--force] [--lang eng] [--min-confidence 40] [--throttle S]` | OCR local archived images into searchable metadata. Preview by default; apply writes results. Requires Tesseract on PATH. |
| `resolve-redgifs [--limit N] [--redgifs-ok] [--apply]` | Resolve dead Gfycat media URLs against RedGifs. Network and writes are separate explicit gates. |
| `dedup [--by url\|title] [--resolve] [--clear]` | Flag possible duplicates (non-destructive); `--resolve` archives all-but-richest per group (reversible), `--clear` removes the flags. |
| `consolidate [--apply] [--undo]` | Fold a Reddit post / HN story / Firefox tab that links to a YouTube video into one canonical `youtube:<id>` item (companions linked). Re-runnable; dry-run by default; reversible. |
| `migrate-rsm-threads --from RSM_APP_DB` | One-time: copy cached Reddit thread JSON (post + comments) from a reddit-saved-manager `data/app.db` into the local thread cache (source opened read-only). |
| `migrate-firefox-tabs [--apply]` | One-time: promote Firefox YouTube tabs imported before auto-promotion into `youtube:<id>` items and collapse duplicates (dry-run by default; run against a DB copy first). |
| `migrate-note-youtube [--apply]` | One-time: promote Keep/Obsidian notes that contain YouTube links into `youtube:<id>` items and attach the note as a companion (dry-run by default; run against a DB copy first). |
| `reddit-sync [--max-pages N] [--full] [--reconcile [--reconcile-dry-run]] [--enable-auto\|--disable-auto]` | Sync saved Reddit items (default three pages, stop at known items; `--full` defaults to 50 pages). Reconcile is a full-walk census and should be previewed first. |
| `hn-sync --user USER [--max-pages N] [--full] [--throttle S]` | Sync public Hacker News favorites (default five pages; `--full` defaults to 50) and stop at known items unless full. |
| `reddit-unsave [--login --cookie VALUE] [--enable\|--disable] [--drain [--live --yes]\|--trickle] [--status] [--enqueue-existing] [--limit N] [--throttle S]` | Manage the local unsave queue. `--drain` is a dry run unless both live-consent flags are present; `--trickle` is the opted-in bounded network lane. |
| `firefox-token [--generate]` | Show whether an ingest token exists; `--generate` rotates it and prints the one-time token. |
| `reddit-oauth [--login\|--logout]` | Set up / inspect the sanctioned **OAuth** transport (installed-app, no client secret; requests read + history + identity + save scopes; set `REDDIT_OAUTH_CLIENT_ID` first). `--login` is a one-time interactive authorize. Once configured it's preferred over the cookie for reads (hydration, saved-list sync) **and** writes (unsave) — see the [Reddit unsave guide](reddit-unsave.md). |
| `reddit-hydrate [FULLNAME] [--from BDFR_DIR] [--batch [--yes]]` | Cache a saved post's comment thread: one item (OAuth if configured, else cookie), `--from` a local BDFR archive (offline, lossless), or `--batch` the prioritized set (jittered throttle, small cap, resumable; safe-by-default — needs `--yes` to fetch). |
| `reddit-hydrate-titles [--network] [--dry-run] [--limit N]` | Backfill real titles for saved Reddit **comments** that imported as "(untitled)" — the saved row is the comment, so the title is its submission's title. Default fills from already-cached thread JSON (offline); `--network` recovers the rest via PullPush/Arctic-Shift. |
| `reddit-thumbnails [--apply] [--limit N]` | Backfill Reddit thumbnails (esp. `v.redd.it` video posters) from already-cached thread blobs — zero network. Dry-run by default. |
| `serve [--host HOST] [--port PORT] [--tls]` | Start the local web app (default `127.0.0.1:8788`). |
| `stats` | Print item counts by source/kind/status. |
| `surface-stats [--since YYYY-MM-DD] [--json]` | Local-only (no telemetry) triage analytics: decision rates excluding decay sweeps, per-family keep rates with Wilson 95% intervals, hint agreement, triage-score calibration deciles, and estimated LLM cost. Prints a text report; `--json` emits the full object. |
| `demo-events [--dir USERS_DIR] [--json] [--raw]` | Read-only pilot telemetry report from the `demo_events` table (opt-in via `CONTENT_HOARDER_DEMO_ANALYTICS=1`). Without `--dir` it reports the current `CONTENT_HOARDER_DB`; `--dir` summarises every `*.db` in a hosted users directory plus totals. `--json` emits the object; `--raw` dumps events as JSONL. |
| `sources` | List the registered import connectors. |
| `bankruptcy --before YYYY-MM-DD [--source ID] [--dry-run]` | Reversibly bulk-archive inbox items older than a date. |
| `decay --tag T... [--subreddit S...] [--before DATE] [--label swept] [--apply] [--undo]` | Guilt-free bulk decay: archive inbox items by tag/subreddit/age, stamped per wave + reversible (`--undo` selects a wave by `--decayed-after/--decayed-before`). Pull decayed items with the `is:decayed` / `is:swept` search operators. |
| `delete --tag T... [--swept] [--also-unsave] --apply --yes` | **Permanently** delete matching items. Dry-run by default; execution needs both `--apply` and `--yes`, makes an automatic timestamped backup, and appends to `data/delete-audit.jsonl`. |
| `export --out FILE [--format csv\|json] [--tag T...] [--status S] [--source ID] [--subreddit S]` | Export matching items to CSV or JSON. |
| `promote [--status keep] [--limit N] [--dry-run]` | Push eligible items to Karakeep when configured; output reports readiness when it is not configured. |
| `export-obsidian --vault DIR [--status keep]` | Export matching items as Markdown notes. |
| `suggest [--source ID] [--limit N]` | Annotate inbox items with local-LLM keep/skip suggestions. |
| `learn-triage [--apply] [--min-support N] [--alpha F] [--limit N]` | Fit the transparent process-likelihood model and score inbox items. Preview by default. |
| `assist-auto-archive [--source reddit] [--min-skip-rate F] [--min-support N] [--apply]` | Preview high-skip subreddit buckets from the learned model; apply archives through reversible decay. |
| `triage-drift [--apply] [--min-support N] [--alpha F] [--limit N] [--since-processed UTC]` | Report drift in processing outcomes; optionally update scores. |
| `snooze --fullname ITEM... [--until EPOCH_SECONDS\|--window-days N] [--undo --wave N\|--escalate] [--limit N] [--apply --yes]` | Defer inbox items, reverse a snooze wave, or escalate repeatedly snoozed items. Mutations need both confirmation flags. |
| `folder list\|create\|rename\|delete\|evaluate\|assign\|stats` | Manage and evaluate saved query folders. |
| `tag list\|create\|rename\|delete` | Manage the user-tag vocabulary and item stamps. |
| `purge-done [--retention-days N] [--max N] [--apply --yes]` | Preview then permanently purge old done items; apply needs both confirmation flags and writes a backup/audit. |

### Reddit hydration & recovery — worked examples
"Hydration" caches a saved post's full comment thread so the **inline reader** can show it offline.
Reads are low-risk; the app pushes them lower with jittered throttling, 429/Retry-After backoff, a
browser-blending User-Agent, and an optional sanctioned read-only OAuth transport — see [the Reddit unsave guide](reddit-unsave.md).

```bash
bun run src/cli.ts reddit-oauth --login
bun run src/cli.ts reddit-oauth --status

# Hydrate one thread, or import an existing local BDFR archive:
bun run src/cli.ts reddit-hydrate t3_abc123
bun run src/cli.ts reddit-hydrate --from /path/to/bdfr_export

# Preview the bounded batch before opting into network hydration:
bun run src/cli.ts reddit-hydrate --batch
bun run src/cli.ts reddit-hydrate --batch --yes

# Offline cached titles, or opt-in archive-provider title recovery:
bun run src/cli.ts reddit-hydrate-titles
bun run src/cli.ts reddit-hydrate-titles --network

# Recover removed posts and unhydrated saved comments from archive mirrors:
bun run src/cli.ts enrich --source reddit --archives
```

