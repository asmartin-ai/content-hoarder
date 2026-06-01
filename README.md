# content-hoarder

A local-first, offline-capable triage tool for managing saved content across multiple sources.
Built for an ADHD brain that over-saves everything: posts, videos, articles, and notes. The core
thesis is **process and reduce, not just aggregate** — this isn't a prettier hoarding machine; it's
a dedicated workspace to sift through your backlog and actually deal with what you saved.

Status: **Phase 1 (in development)**

## Features
- Unified import from Reddit, YouTube playlists, Hacker News, Obsidian vaults, and Google Keep into
  one local SQLite database (Firefox tabs planned).
- Full-text **and** fuzzy (typo-tolerant) search across everything.
- A triage UI with two modes: a one-at-a-time **swipe/keyboard card** mode and a **list** view with
  bulk keep/archive actions.
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
| `import <path> [--source ID]` | Import from a file or directory; auto-detects the source, or force one with `--source`. |
| `enrich [--source ID] [--all]` | Fetch missing metadata for sparse items (e.g. HN via its API, YouTube via yt-dlp). |
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

## Privacy & data safety
The SQLite database (`data/app.db`), all exports, and `.env` are gitignored. Personal data and API
keys are never committed — only tiny synthetic fixtures live in the repo (for tests).

## License
Personal project — no formal license yet.
