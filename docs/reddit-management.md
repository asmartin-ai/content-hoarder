# Reddit management view

The dedicated Reddit workspace at **`/reddit`** — the reddit-saved-manager (RSM) interface folded
into content-hoarder. It runs over the same `items` table as everything else (no separate app, no
separate DB); Reddit-specific fields live in each item's `metadata` blob and are flattened by the
`/reddit/*` adapter into the shape the UI expects.

## What it gives you
- **Table / grid browse** of your Reddit items, with full-text + fuzzy search.
- **Subreddit sidebar** (counts, filterable) — click to scope the list to one subreddit.
- **Thread / comment viewer** — opens the cached post + comment tree in a detail panel.
- **Stats** modal: by kind, by triage status, top subreddits, NSFW count, by-year.
- **NSFW blur** with click-to-reveal.
- One-click **unsave** (enqueues for the Reddit unsave drain) and **re-save** (undo).
- The header **Triage** link opens `/triage?source=reddit` — one-click Reddit-only swipe triage.

## Architecture (how it maps onto content-hoarder)
- **No schema change.** `subreddit/score/over_18/permalink/media_*` stay in `items.metadata`; the
  adapter (`web._reddit_view`) flattens them. `db.search_items` gained a `subreddit=` filter and
  `score`/`subreddit` sort keys.
- **`reddit_threads` side table** (`fullname` PK, `thread_json`, `hydrated_at`) holds the post+comment
  trees, kept *out* of `metadata` so search stays cheap. Read/written via `db.get_reddit_thread` /
  `db.set_reddit_thread`; parsed by `reddit_thread.py`.
- **Routes** (`web.py`): `GET /reddit` (page), `/reddit/items`, `/reddit/subreddits`, `/reddit/stats`,
  `/reddit/items/<fn>/thread`, `POST /reddit/items/<fn>/unsave`. Undo reuses `/items/<fn>/resave`.
- **Frontend**: `templates/reddit.html` + `static/reddit.js` + `static/reddit.css`, reskinned from RSM
  to content-hoarder's palette.

## Migrating from reddit-saved-manager
The 64.6k Reddit items were already imported. To bring over RSM's cached threads:

```bash
python -m content_hoarder migrate-rsm-threads --from "K:\Projects\reddit-saved-manager\data\app.db"
```

Reads the RSM DB read-only and copies non-empty `thread_json` into `reddit_threads`, re-keyed
`t3_x` → `reddit:t3_x`. Idempotent. Re-run `import <RSM app.db>` first if you have newer saves, then
`dedup` (URL dedup is safe + reversible; title dedup is looser — review before resolving).

## Syncing new saves
content-hoarder has **no Reddit API key**, so live OAuth sync is parked on the unmerged
`feat/reddit-oauth` branch (dead code until a key arrives). The default is a **cookie-based
incremental sync** — implemented in `reddit_sync.py`, exposed as the `reddit-sync` CLI and a
**"Sync newest"** button on `/reddit`:

- It GETs `https://www.reddit.com/user/<username>/saved.json` with your `reddit_session` cookie
  (set once via `reddit-unsave --login --cookie "<value>"` — shared with the unsave queue),
  **newest-first**, and **stops as soon as a page yields no new items** (`max_pages`, default 3;
  `--full` raises it to 50 for a deep catch-up). A routine sync therefore touches only the new
  saves — seconds, not an 11-minute full re-pull.
- **Live validation (Phase 0) is still pending a cookie:** we must confirm `saved.json` actually
  returns the listing with just the session cookie (not a login wall) and measure the rate. If it
  doesn't, the keyless fallback is importing a Reddit **GDPR data-export ZIP** (complete saved list,
  no scraping; porting RSM's ZIP/BDFR importers is a backlog item).

## Cookie expiry
`reddit_session` cookies expire every few days — same re-paste UX as the existing unsave feature
(`reddit-unsave --login --cookie "<value>"`). A dead cookie surfaces a clear auth-error state.
