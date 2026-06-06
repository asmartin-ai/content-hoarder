# content-hoarder

A local-first, offline-capable triage tool for managing saved content across multiple sources.
Built for an ADHD brain that over-saves everything: posts, videos, articles, and notes. The core
thesis is **process and reduce, not just aggregate** — this isn't a prettier hoarding machine; it's
a dedicated workspace to sift through your backlog and actually deal with what you saved.

Status: **Phase 1 (in development)**

## Features
- Unified import from Reddit, YouTube playlists, Hacker News, Obsidian vaults, Google Keep, and
  **Firefox tabs** into one local SQLite database.
- Full-text **and** fuzzy (typo-tolerant) search across everything.
- A triage UI with two modes: a one-at-a-time **swipe/keyboard card** mode and a **list** view with
  bulk keep/archive actions, Gmail-style swipe icons, source tabs + a status sidebar, and an undo snackbar.
- **Processing areas:** heuristic categorization of videos into *listenable* / *watch* / *wotagei*
  (no LLM), filterable in the inbox; correct a tag from the triage card.
- **Reddit management view** (`/reddit`): the reddit-saved-manager interface folded in — table/grid
  browse, a subreddit sidebar, a cached thread/comment viewer, NSFW blur, and per-subreddit stats —
  over your unified library; the **Triage** link drops you straight into Reddit-only swipe triage.
- **Content recovery (non-destructive):** restore `[removed]`/`[deleted]` Reddit posts/comments (and
  un-hydrated saved comments) from PullPush/Arctic-Shift, and `[Private/Deleted video]` YouTube titles
  from the Wayback Machine.
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

## CLI commands
| Command | Description |
|---------|-------------|
| `init-db` | Create the local SQLite database + FTS5 search tables. |
| `import <path> [--source ID]` | Import a file/dir; auto-detects the source (Reddit DB/CSV/JSON, YouTube yt-dlp JSON, HN DB/txt, Obsidian/Keep folders, Firefox "Export Tabs URLs" .txt), or force with `--source`. |
| `categorize [--source youtube] [--all] [--limit N]` | Tag items *listenable* / *watch* / *wotagei* by heuristics (duration, channel allowlist, title keyword); stored on `metadata.category`. |
| `enrich [--source ID] [--all] [--limit N]` | Fill sparse items. `--source youtube` adds per-video duration/views/categories (yt-dlp); `--source reddit --archives` recovers removed/un-hydrated items (PullPush + Arctic-Shift); `--source youtube --titles` recovers deleted titles (Wayback). |
| `dedup [--by url\|title] [--resolve] [--clear]` | Flag possible duplicates (non-destructive); `--resolve` archives all-but-richest per group (reversible), `--clear` removes the flags. |
| `migrate-rsm-threads --from RSM_APP_DB` | One-time: copy cached Reddit thread JSON (post + comments) from a reddit-saved-manager `data/app.db` into the local thread cache (source opened read-only). |
| `serve [--host HOST]` | Start the local web app (default host `127.0.0.1`, port `8788`). |
| `stats` | Print counts by source/kind/status, inbox size, and processed-this-week. |
| `sources` | List the available source connectors. |
| `bankruptcy --before YYYY-MM-DD [--source ID] [--dry-run]` | Reversibly bulk-archive inbox items older than a date. |
| `promote [--status keep] [--dry-run]` | (Opt-in) push items you've marked **keep** to a stock Karakeep instance via its API. |

## Mobile access
The app is a responsive PWA you can install via **Add to Home Screen** (on Firefox for Android, use
the browser menu → *Install*). Reach it from your phone over a private **Tailscale** tunnel or your
LAN. **Security warning: never expose this personal-data app to the public internet** — no port
forwarding; keep it strictly behind a VPN/Tailscale or a trusted LAN.

## Source notes & caveats
- **YouTube "Watch Later" cannot be exported** via the API or Google Takeout. Regular playlists
  (e.g. WL2, WL3) work via `yt-dlp --flat-playlist`; a Watch Later list can only be brought in from a
  manual/browser-extension export.
- **Hacker News** (Materialistic app) saved items need `adb` to pull the app's local database — or
  import a plain item-ID list or your `favorites?id=USER` HTML.
- **Google Keep** is imported from an official **Google Takeout** export (one per account). The
  unofficial `gkeepapi` is intentionally **not** used (ToS / account-lockout risk).
- **Firefox tabs** are imported from the "Export Tabs URLs" extension's `.txt` (Rich format);
  re-importing the overlapping daily exports de-dups by URL.

## Privacy & data safety
The SQLite database (`data/app.db`), all exports, `.env`, and `nsfw_rules.json` are gitignored.
Personal data and API keys are never committed — only tiny synthetic fixtures live in the repo (for
tests). To configure locally, copy `.env.example` → `.env` and (optionally) `nsfw_rules.example.json`
→ `nsfw_rules.json`.

## License
[MIT](LICENSE).
