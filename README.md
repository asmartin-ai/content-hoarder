# content-hoarder

A local-first, offline-capable triage tool for managing saved content across multiple sources.
Built for an ADHD brain that over-saves everything: posts, videos, articles, and notes. The core
thesis is **process and reduce, not just aggregate** — this isn't a prettier hoarding machine; it's
a dedicated workspace to sift through your backlog and actually deal with what you saved.

Status: **Phase 2 (in active development)** — Phase 1 (import + search + a usable triage UI) is complete;
Phase-2 items shipped include the v3 browse UI, LLM assist, Obsidian export, Reddit OAuth + sync, and the
inline reader. The offline PWA already ships.

## Features
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
- Runs entirely locally. Minimal dependencies (Flask + SQLite); `yt-dlp` and a local LLM are optional.

## Quickstart
```bash
python -m venv .venv
# Windows:        .venv\Scripts\activate
# macOS/Linux:    source .venv/bin/activate
pip install -r requirements.txt
pip install -e .
python -m content_hoarder init-db
python -m content_hoarder import <path>     # a file or a directory (auto-detects the source)
python -m content_hoarder serve             # then open http://127.0.0.1:8788
```

### Serve from anywhere (no `cd`)
The DB path defaults to `data/app.db` *relative to the current directory*, so to launch from any
folder without `cd`-ing in, point `CONTENT_HOARDER_DB` at an absolute path and call the venv's
Python directly. One line to paste (PowerShell):
```powershell
$env:CONTENT_HOARDER_DB="K:\Projects\content-hoarder\data\app.db"; & "K:\Projects\content-hoarder\.venv\Scripts\python.exe" -m content_hoarder serve
```
Append `--host 100.x.y.z` to bind your Tailscale IP for phone access. (cmd.exe equivalent:
`set "CONTENT_HOARDER_DB=K:\Projects\content-hoarder\data\app.db" && "K:\Projects\content-hoarder\.venv\Scripts\python.exe" -m content_hoarder serve`.)

## CLI commands
| Command | Description |
|---------|-------------|
| `init-db` | Create the local SQLite database + FTS5 search tables. |
| `import <path> [--source ID]` | Import a file/dir; auto-detects the source (Reddit DB/CSV/JSON, YouTube yt-dlp JSON, HN DB/txt, Obsidian/Keep folders, Firefox "Export Tabs URLs" .txt, Twitter/X bookmark JSON/CSV), or force with `--source`. |
| `categorize [--source youtube\|reddit\|firefox\|hackernews] [--topics] [--dry-run] [--all] [--limit N]` | Tag items by heuristics. `--source youtube` → processing areas *listenable* / *watch* / *wotagei* on `metadata.category`; `--topics` (youtube) / `--source reddit\|firefox\|hackernews` → multi-label topic tags (gaming/defense/investing/…) on `metadata.tags` (host + title keywords; `--dry-run` previews accuracy without writing). |
| `enrich [--source ID] [--all] [--limit N]` | Fill sparse items. `--source youtube` adds per-video duration/views/categories (yt-dlp); `--source reddit --archives` recovers removed/un-hydrated items (PullPush + Arctic-Shift); `--source youtube --titles` recovers deleted titles (Wayback). |
| `scan-media [--status S] [--limit N] [--apply] [--recheck] [--workers N] [--batch N]` | Probe saved Reddit image/gallery items for deleted media and classify them on `metadata.media_status` (`gone` / `salvageable`, recording the salvageable preview URL for the `archive-media` pass). `--apply` writes (+ a `deleted` tag on gone items, surfaced by `is:deleted`); dry-run by default, crash-safe + resumable (skips already-classified unless `--recheck`). |
| `archive-media [--salvageable] [--galleries] [--images] [--twitter] [--videos] [--limit N] [--throttle S] [--max-video-bytes N] [--video-timeout S] [--apply]` | **Hoard the bytes:** download + store saved Reddit and Twitter/X media locally (content-addressed under `data/media/`, served same-origin via `/media/<blob>` so the PWA survives remote deletion). Scopes, cheap→bulk: `--salvageable` (rescue still-live previews of already-deleted posts — run first), `--galleries`, `--images` (the bulk `i.redd.it` set, ~15 GB+), `--twitter` (imported `pbs.twimg.com` images and `video.twimg.com` MP4s), `--videos` (explicit opt-in for v.redd.it; requires `yt-dlp` and a muxable audio+video result). Dry-run by default; resumable (skips already-archived); per-item commit. ⚠️ `data/media/` is gitignored and **not** in DB backups — back it up separately. |
| `resolve-redgifs [--limit N] [--redgifs-ok] [--apply]` | Resolve dead Gfycat media URLs against RedGifs. Safe by default: without `--redgifs-ok` it only counts candidates and does no network; without `--apply` it previews metadata-only rewrites without writing. |
| `dedup [--by url\|title] [--resolve] [--clear]` | Flag possible duplicates (non-destructive); `--resolve` archives all-but-richest per group (reversible), `--clear` removes the flags. |
| `consolidate [--apply] [--undo]` | Fold a Reddit post / HN story / Firefox tab that links to a YouTube video into one canonical `youtube:<id>` item (companions linked). Re-runnable; dry-run by default; reversible. |
| `migrate-rsm-threads --from RSM_APP_DB` | One-time: copy cached Reddit thread JSON (post + comments) from a reddit-saved-manager `data/app.db` into the local thread cache (source opened read-only). |
| `migrate-firefox-tabs [--apply]` | One-time: promote Firefox YouTube tabs imported before auto-promotion into `youtube:<id>` items and collapse duplicates (dry-run by default; run against a DB copy first). |
| `migrate-note-youtube [--apply]` | One-time: promote Keep/Obsidian notes that contain YouTube links into `youtube:<id>` items and attach the note as a companion (dry-run by default; run against a DB copy first). |
| `reddit-sync` | Pull new saved Reddit items (newest-first, stop-on-overlap). Prefers the OAuth `history` scope when configured, else the `reddit_session` cookie (set it with `reddit-unsave --login`). |
| `reddit-unsave [--enable\|--disable] [--drain [--live --yes]] [--limit N]` | Unsave-on-Done: enqueue (gated, off by default) + drain the queue to Reddit. **`--drain` is a DRY RUN by default** (lists the scope, sends nothing); add `--live --yes` to execute — it MUTATES your real Reddit Saved list (reversible via re-save), is jittered + rate-limited with 429 backoff, prefers the sanctioned OAuth `save` scope when configured (else the cookie), and appends every unsave to `data/unsave-audit.jsonl`. |
| `reddit-oauth [--login\|--logout]` | Set up / inspect the sanctioned **OAuth** transport (installed-app, no client secret; requests read + history + identity + save scopes; set `REDDIT_OAUTH_CLIENT_ID` first). `--login` is a one-time interactive authorize. Once configured it's preferred over the cookie for reads (hydration, saved-list sync) **and** writes (unsave) — see [docs/reddit-derisking.md](docs/reddit-derisking.md). |
| `reddit-hydrate [FULLNAME] [--from BDFR_DIR] [--batch [--yes]]` | Cache a saved post's comment thread: one item (OAuth if configured, else cookie), `--from` a local BDFR archive (offline, lossless), or `--batch` the prioritized set (jittered throttle, small cap, resumable; safe-by-default — needs `--yes` to fetch). |
| `reddit-hydrate-titles [--network] [--dry-run] [--limit N]` | Backfill real titles for saved Reddit **comments** that imported as "(untitled)" — the saved row is the comment, so the title is its submission's title. Default fills from already-cached thread JSON (offline); `--network` recovers the rest via PullPush/Arctic-Shift. |
| `reddit-thumbnails [--apply] [--limit N]` | Backfill Reddit thumbnails (esp. `v.redd.it` video posters) from already-cached thread blobs — zero network. Dry-run by default. |
| `serve [--host HOST]` | Start the local web app (default host `127.0.0.1`, port `8788`). |
| `stats` | Print counts by source/kind/status, inbox size, and processed-this-week. |
| `sources` | List the available source connectors. |
| `bankruptcy --before YYYY-MM-DD [--source ID] [--dry-run]` | Reversibly bulk-archive inbox items older than a date. |
| `decay --tag T... [--subreddit S...] [--before DATE] [--label swept] [--apply] [--undo]` | Guilt-free bulk decay: archive inbox items by tag/subreddit/age, stamped per wave + reversible (`--undo` selects a wave by `--decayed-after/--decayed-before`). Pull decayed items with the `is:decayed` / `is:swept` search operators. |
| `delete --tag T... [--swept] [--also-unsave] --apply --yes` | **Permanently** delete matching items. Dry-run by default; execution needs both `--apply` and `--yes`, makes an automatic timestamped backup, and appends to `data/delete-audit.jsonl`. |
| `export --out FILE [--format csv\|json] [--tag T...] [--status S]` | Dump matching items to CSV/JSON (permalink-oriented, for re-saving elsewhere). Same filters live at `GET /export`. |
| `promote [--status keep] [--dry-run]` | (Opt-in) push items you've marked **keep** to a stock Karakeep instance via its API. |
| `export-obsidian --vault DIR [--status keep]` | Write items (default: `keep`) to an Obsidian vault as Markdown notes. |
| `suggest [--source ID] [--limit N]` | Annotate inbox items with local-LLM keep/skip suggestions (optional; Phase 2 assist). |
| `learn-triage [--apply] [--min-support N] [--alpha F] [--limit N]` | Fit the transparent likely-to-process model from triage history and score inbox items (`metadata.triage_score` + why; "smart" batches use it). Dry-run by default. |

### Reddit hydration & recovery — worked examples
"Hydration" caches a saved post's full comment thread so the **inline reader** can show it offline.
Reads are low-risk; the app pushes them lower with jittered throttling, 429/Retry-After backoff, a
browser-blending User-Agent, and an optional sanctioned read-only OAuth transport — background and
rationale in [docs/reddit-derisking.md](docs/reddit-derisking.md).

```bash
# (Optional, recommended) one-time: switch hydration onto the sanctioned read-only OAuth lane.
# Set REDDIT_OAUTH_CLIENT_ID in .env first (see .env.example), then authorize interactively:
python -m content_hoarder reddit-oauth --login      # paste the redirected URL back when prompted
python -m content_hoarder reddit-oauth --status      # confirm it's configured (else cookie is used)

# Hydrate one thread on demand (OAuth if configured, else the reddit_session cookie):
python -m content_hoarder reddit-hydrate t3_abc123

# Hydrate offline from a local BDFR archive — lossless, no network, no account exposure:
python -m content_hoarder reddit-hydrate --from "K:\path\to\bdfr_export"

# Bulk-hydrate the prioritized backlog. Safe-by-default: a bare --batch is a dry-run preview;
# add --yes to actually fetch (jittered throttle, small cap (25), resumable):
python -m content_hoarder reddit-hydrate --batch              # preview what would be fetched
python -m content_hoarder reddit-hydrate --batch --yes        # fetch for real

# Backfill real titles for saved Reddit COMMENTS that imported as "(untitled)":
python -m content_hoarder reddit-hydrate-titles               # offline: fill from cached threads
python -m content_hoarder reddit-hydrate-titles --network     # recover the rest via PullPush/Arctic

# Recover [removed]/[deleted] Reddit posts & un-hydrated saved comments from archive mirrors:
python -m content_hoarder enrich --source reddit --archives
```

## Mobile access
The app is a responsive PWA you can install on **Chrome for Android** (browser menu → *Install app*,
which creates a real standalone WebAPK). Reach it from your phone over a private **Tailscale** tunnel or your
LAN. **Security warning: never expose this personal-data app to the public internet** — no port
forwarding; keep it strictly behind a VPN/Tailscale or a trusted LAN.

### Phone quickstart (Tailscale)
1. On the PC, find your Tailscale IP (`tailscale ip -4`, a `100.x.y.z` address) and start the app
   bound to it: `python -m content_hoarder serve --host 100.x.y.z` (the web guard already accepts
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
  and videos can be cached locally with `python -m content_hoarder archive-media --twitter --apply`.

## Privacy & data safety
The SQLite database (`data/app.db`), all exports, `.env`, and `nsfw_rules.json` are gitignored.
Personal data and API keys are never committed — only tiny synthetic fixtures live in the repo (for
tests). To configure locally, copy `.env.example` → `.env` and (optionally) `nsfw_rules.example.json`
→ `nsfw_rules.json`.

## License
[MIT](LICENSE).
