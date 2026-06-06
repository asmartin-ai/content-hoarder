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

## Syncing new saves (status: pending a cookie)
content-hoarder has **no Reddit API key**, so live OAuth sync is parked on the unmerged
`feat/reddit-oauth` branch (dead code until a key arrives). The default sync path is **cookie-based
and incremental** — but it is gated behind a feasibility spike that needs your `reddit_session`
cookie:

- **Spike (Phase 0):** confirm `https://www.reddit.com/user/<name>/saved.json` returns your saved
  listing with just the session cookie, and measure page size / rate limits.
- If viable, sync fetches **newest-first and stops on overlap** (a configurable `max_pages`, default a
  few hundred newest), so a normal sync is seconds — not an 11-minute full re-pull.
- **Keyless full backfill fallback:** import a Reddit **GDPR data-export ZIP** (the complete saved
  list, no scraping). Porting RSM's ZIP/BDFR importers is a backlog item.

## Cookie expiry
`reddit_session` cookies expire every few days — same re-paste UX as the existing unsave feature
(`reddit-unsave --login --cookie "<value>"`). A dead cookie surfaces a clear auth-error state.
