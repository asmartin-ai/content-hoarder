# Open questions for asmartin-ai

Collected while building overnight so you can answer when you're back. None are blocking —
I worked around them and built the connectors so they're ready once you provide the data.

## Data to import (connectors are built and tested with synthetic fixtures)
1. **Reddit** — The connector can read your existing `F:\reddit-saved-manager\data\app.db`
   read-only and fold its ~64k items in. **OK to run it against a *copy* of that DB?** (I'll
   copy first, never touch the original.) It also reads RSM CSV/JSON exports.
2. **YouTube** — To bring in WL2/WL3, run for each playlist:
   `yt-dlp --flat-playlist --dump-single-json "<PLAYLIST_URL>" > wl2.json`
   then `content_hoarder import wl2.json`. Or give me the playlist URLs and I'll run yt-dlp.
   (Reminder: the main "Watch Later" list can't be exported via API — needs a browser-extension
   export, which the connector also accepts as a flat JSON array.)
3. **Hacker News** — Pulling the Materialistic saved DB needs `adb` + your phone (USB debugging):
   `adb pull /data/data/io.github.hidroh.materialistic/databases/ ./hn_db`. Alternatively: your
   HN **username** (I can fetch the public `favorites?id=USER` page) or an exported item-id list.
4. **Google Keep** — Do a **Google Takeout** for Keep (per account), unzip, and point me at the
   `Keep/` folder: `content_hoarder import path/to/Keep`. (gkeepapi is intentionally not used.)

## Preferences (I assumed sensible defaults — tell me if you want changes)
5. **Theme** — assumed a **dark** theme (matching the Reddit tool). OK?
6. **Triage batch size** — assumed **20** items per random triage batch. Good number for you?
7. **Mobile** — you'll set up Tailscale yourself; I'm building the responsive PWA + an in-app
   "Firefox menu → Install" hint. The swipe card has a 30px edge-deadzone + tap buttons so the
   Pixel 6 back-gesture won't fire. Anything else you want on mobile?
8. **Karakeep** — still deferred (bridge stub ships; no action needed unless you decide to adopt it).

## Notes
- Everything is local + offline; no API keys needed for any v1 source.
- The DB lives at `data/app.db` (gitignored). Personal data is never committed.

---

## What I built overnight (2026-06-01)
**Phase 1 (complete, committed):** schema + FTS5 (exact + fuzzy) search; all 5 connectors
(Reddit/YouTube/HN/Obsidian/Keep) + Firefox stub; non-destructive idempotent import pipeline;
Flask web app + CLI; responsive **PWA** with a swipe **triage** card mode (Pixel-6 edge-gesture-safe)
and a browse/list mode with bulk actions; reversible **bankruptcy**. Browser-verified end-to-end.

**Phase 2 (complete, committed):**
- **Obsidian export** — `content_hoarder export-obsidian --vault PATH` writes kept items as Markdown
  (round-trips back through the importer).
- **Local-LLM assist** — optional keep/skip + auto-tag suggestions via your LM Studio endpoint;
  "Ask AI" button on the triage card. **Verified working live against your Devstral model.** Never
  changes status on its own.
- **Offline service worker** + **reversible dedup** (`content_hoarder dedup --dry-run`).

**45 tests passing**, all offline. 7 commits on `main`.

**Reddit import is validated and ready:** I did a read-only schema check of
`F:\reddit-saved-manager\data\app.db` — 64,615 rows, all with fullname/permalink/subreddit/score, so
the connector will import them cleanly (with metadata) once you say go. **I did NOT import anything.**

## Quick decisions for you (no rush)
1. **Reddit import:** OK to run `content_hoarder import "F:\reddit-saved-manager\data\app.db"` against a
   **copy** (I'll copy first)? It will load all ~64.6k items into the inbox.
2. **Theme / triage batch size:** kept defaults (dark theme, 20-item batches) — change if you like.
3. **Dedup aggressiveness:** current dedup only matches *identical normalized URLs* and is reversible.
   Want it looser (e.g., near-duplicate titles) or is exact-URL right?
4. Anything you want reprioritized for the next session.
