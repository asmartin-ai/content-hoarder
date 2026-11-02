# content-hoarder

**A triage tool for your saved-content backlog.** Reddit saves, YouTube playlists, Hacker News
favorites, browser tabs, Obsidian/Keep notes and Twitter/X bookmarks go into one local SQLite
library; then you clear it a few cards at a time — *Done*, *Archive*, *Keep* or *Not now* — with
undo on everything.

It is built for the shape of an ADHD backlog: you over-save, the pile becomes debt, and reading all
of it is never going to happen. So the product is not a prettier hoarding machine. The core thesis
is **process and reduce, not just aggregate**: a five-minute round, a reversible "let this pile go",
and a library that is smaller and calmer when you stop.

Status: local release (source `VERSION` is `1.0.0`; unreleased work ships from `main`). The v3
browse UI, offline PWA shell, Reddit OAuth/sync, inline reader, recovery tooling, media archiving,
Obsidian export and optional local-LLM assist are in. Release notes: [`CHANGELOG.md`](CHANGELOG.md).

## Try it

- **Hosted demo:** <https://demo.khaosapp.tech> — an invite-only pilot. It runs the same app with
  one separate library per tester; ask for an invite link.
- **Local demo, synthetic data:** `./scripts/demo.sh` creates a temp library with 45 invented
  saves and serves it on <http://127.0.0.1:8791/>. Walkthrough and a safety checklist:
  [`docs/DEMO.md`](docs/DEMO.md).

### Local quickstart

Install [Bun](https://bun.sh) 1.4 or newer, then:

```bash
bun install --frozen-lockfile
bun run src/cli.ts --version
bun run src/cli.ts init-db
bun run src/cli.ts import <path>   # a file or directory; detects the source
bun run start                      # http://127.0.0.1:8788
```

The default database path is `data/app.db` under the current working directory. Set
`CONTENT_HOARDER_DB` to use a different path. The CLI loads `.env` from the working directory;
existing shell environment values take precedence.

Native media tools are optional and only needed by their corresponding commands: `ffmpeg` for
video/HLS work, `tesseract` for OCR, and ImageMagick `magick` for image preparation. No server,
scheduler, OAuth flow, sync, or archive operation runs during installation or startup.

### Serve from anywhere

Set `CONTENT_HOARDER_DB` to an explicit database path and run the entry point from this checkout:

```bash
CONTENT_HOARDER_DB=/path/to/app.db bun run /path/to/content-hoarder/src/cli.ts serve
```

The web server binds to `127.0.0.1:8788` by default. Use `--host` only on a trusted private
network; never expose this personal-data application to the public internet.

## What it does

- Unified import from Reddit, YouTube playlists, Hacker News, Obsidian vaults, Google Keep,
  **Firefox tabs**, and browser-exported Twitter/X bookmarks into one local SQLite database.
- Full-text **and** fuzzy (typo-tolerant) search, with discoverable Gmail/Discord-style **operators**
  (`source:`, `tag:`, `status:`, `is:swept`, `has:video`, `before:`, `score:>100`, `"exact"`, `-exclude`)
  surfaced by an autocomplete popover, plus a **shuffle/mix** browse mode that interleaves sources.
- A triage UI with two modes: a one-at-a-time **swipe/keyboard card** mode and a **list** view with
  bulk keep/archive actions, Gmail-style swipe icons, source tabs + a status sidebar, and an undo snackbar.
- **Processing areas:** heuristic categorization of videos into *listenable* / *watch* / *wotagei*
  (no LLM), filterable in the inbox; correct a tag from the triage card.
- **Reddit management view** (`/reddit`): the reddit-saved-manager interface folded in — table/grid
  browse, a subreddit sidebar, a cached thread/comment viewer, NSFW blur, and per-subreddit stats —
  over your unified library; the **Triage** link drops you straight into Reddit-only swipe triage.
- **Content recovery (non-destructive):** restore `[removed]`/`[deleted]` Reddit posts/comments (and
  un-hydrated saved comments) from PullPush/Arctic-Shift, and `[Private/Deleted video]` YouTube titles
  from the Wayback Machine. The in-app **"↻ Recover text from archives"** button (`recover_one`) runs
  the metadata chain per-item only. Deleted reddit media byte recovery through **archive.today** is a
  separate explicit opt-in action/API mode for reddit images whose originals are already 404
  (`media_status='gone'`) — low hit rate, Cloudflare-gated, and never bulk.
- **Duplicate detection:** flag possible duplicates (by URL or title) and reversibly resolve them.
- Per-item status: `inbox` → `keep` / `archived` / `done`, with one-step undo and a reversible
  "content bankruptcy" bulk-archive.
- Responsive, installable **PWA** so you can triage on desktop or phone.
- Runs locally on Bun + TypeScript, with SQLite and native media/network integrations. No Python runtime or yt-dlp dependency.

## Privacy

- **The library is local.** Your items live in one SQLite file (`data/app.db` by default) with
  content-addressed media beside it. Your DB, media, exports, `.env` and NSFW list are gitignored,
  so they are never part of this repository.
- **This repository holds source and invented data.** Everything committed here is code, docs and
  small synthetic fixtures written for tests and demos — no user library, no account exports, no
  credentials.
- **What leaves the machine, and when.** Cards load thumbnails and media from the sites they were
  saved from. Opening a Reddit item in the reader fetches its comment thread (then public archives)
  unless it is cached. Sync, recovery, enrichment, hydration, unsave and promote are separate
  opt-in commands that talk to the services they name; nothing bulk-runs on startup.
  `CONTENT_HOARDER_OFFLINE=1` turns all outbound requests off for demos and tests.
- **AI suggestions are off by default.** With per-library consent, the item's title, source and
  link go to the configured provider to get a hint.
- **Reddit writes need explicit consent.** Unsave-on-done is off by default; the live lane requires
  both `--live` and `--yes`.
- **The hosted demo** stores each tester's library in a separate file on one server, deletes a
  library on request, and records pilot interaction events inside that tester's own library (opt-in
  at deployment; `CONTENT_HOARDER_DEMO_ANALYTICS=1`).

To configure locally, copy `.env.example` → `.env` and (optionally)
`nsfw_rules.example.json` → `nsfw_rules.json`.

Publication policy and the check that runs before a public push:
[`docs/PUBLISH-SAFETY.md`](docs/PUBLISH-SAFETY.md).

## CLI reference

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
| `reddit-oauth [--login\|--logout]` | Set up / inspect the sanctioned **OAuth** transport (installed-app, no client secret; requests read + history + identity + save scopes; set `REDDIT_OAUTH_CLIENT_ID` first). `--login` is a one-time interactive authorize. Once configured it's preferred over the cookie for reads (hydration, saved-list sync) **and** writes (unsave) — see [docs/reddit-derisking.md](docs/reddit-derisking.md). |
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
browser-blending User-Agent, and an optional sanctioned read-only OAuth transport — background and
rationale in [docs/reddit-derisking.md](docs/reddit-derisking.md).

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

## Mobile access

The app is a responsive PWA you can install on **Chrome for Android** (browser menu → *Install app*,
which creates a real standalone WebAPK). Reach it from your phone over a private **Tailscale** tunnel or your
LAN. **Security warning: never expose this personal-data app to the public internet** — no port
forwarding; keep it strictly behind a VPN/Tailscale or a trusted LAN.

### Phone quickstart (Tailscale)
1. On the PC, find your Tailscale IP (`tailscale ip -4`, a `100.x.y.z` address) and start the app
   bound to it: `bun run src/cli.ts serve --host 100.x.y.z` (the web guard already accepts
   tailnet addresses; add real DNS names via `CONTENT_HOARDER_ALLOWED_HOSTS`).
2. On the phone (Tailscale connected), open `http://100.x.y.z:8788/` in Chrome.
3. Install it: Chrome menu (⋮) → **Install app** (a real WebAPK). The PWA opens fullscreen with the
   app icon; the service worker caches the shell, so cold opens are instant. *(Install needs a secure
   context — use the HTTPS `*.ts.net` URL from `tailscale serve`; see [docs/MOBILE_TAILSCALE.md](docs/MOBILE_TAILSCALE.md).)*
4. Notes for gesture navigation: row swipe is touch-only by design; if a fresh deploy looks stale,
   the shell cache updates on the next reload (the SW takes one visit to swap versions).

## Source notes & caveats

- **YouTube "Watch Later" cannot be exported** via the API or Google Takeout. Regular playlists
  (e.g. WL2, WL3) work via `yt-dlp --flat-playlist`; a Watch Later list can only be brought in from a
  manual/browser-extension export.
- **Hacker News**: favorite stories to your HN account (e.g. via the actively-maintained **Harmonic**
  app) and import your public `favorites?id=USER` page — server-side, no phone. *(Legacy: the abandoned
  **Materialistic** app stored saves **locally only**, needing an `adb backup` of its DB; see
  docs/IMPORTING.md.)*
- **Google Keep** is imported from an official **Google Takeout** export (one per account). The
  unofficial `gkeepapi` is intentionally **not** used (ToS / account-lockout risk).
- **Firefox tabs** are imported from the "Export Tabs URLs" extension's `.txt` (Rich format);
  YouTube tabs are promoted to canonical `youtube:<id>` rows.
- **Twitter/X bookmarks** are imported from a browser-side JSON/CSV export, not the paid API;
  rows are keyed as `twitter:<tweet_id>` and retain tweet text, author, permalink, outbound links,
  quote/reply context, and image/video media URLs. Re-importing overlapping daily exports de-dups by URL. Tweets that link to YouTube
  videos can be folded into canonical `youtube:<id>` rows with `consolidate`; imported tweet images
  and videos can be cached locally with `bun run src/cli.ts archive-media --twitter --apply`.

## Project tracking

Active work is tracked in [GitHub Issues](https://github.com/asmartin-ai/content-hoarder/issues).

## License

[MIT](LICENSE).
