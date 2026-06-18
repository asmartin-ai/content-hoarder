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
- **Sort** dropdown defaults to **Recently synced** (`first_seen_utc` desc) — the closest proxy to
  newest-saved-first, since Reddit exposes no save timestamp (saved items are ingested newest-first,
  so sync order tracks save order for incrementally-synced items; the legacy bulk import shares one
  timestamp). Other options: Recently posted, Top score, Subreddit A–Z, Title A–Z. Table column
  headers still sort and stay in sync with the dropdown.

## Architecture (how it maps onto content-hoarder)
- **No schema change.** `subreddit/score/over_18/permalink/media_*` stay in `items.metadata`; the
  adapter (`web._reddit_view`) flattens them. `db.search_items` gained a `subreddit=` filter and
  `score`/`subreddit` sort keys.
- **`reddit_threads` side table** (`fullname` PK, `thread_json`, `hydrated_at`) holds the post+comment
  trees, kept *out* of `metadata` so search stays cheap. Read/written via `db.get_reddit_thread` /
  `db.set_reddit_thread`; parsed by `reddit_thread.py`.
- **Routes** (`web.py`): `GET /reddit` (page), `/reddit/items`, `/reddit/subreddits`, `/reddit/stats`,
  `/reddit/items/<fn>/thread`, `POST /reddit/items/<fn>/unsave` (enqueues + optimistically flips
  `is_saved=0`), `POST /reddit/items/<fn>/undo` (cancels a still-pending unsave locally, or live
  re-saves one already drained to Reddit). Plus `POST /reddit/sync`, `/reddit/items/<fn>/hydrate`, and
  the `/reddit/unsave/{status,auth,enable,drain,enqueue-by-tag}` family (see `web.py` for the full list).
- **Frontend**: `templates/reddit.html` + `static/reddit.js` + `static/reddit.css`, reskinned from RSM
  to content-hoarder's palette.

## Migrating from reddit-saved-manager
The 64.6k Reddit items were already imported. To bring over RSM's cached threads:

```bash
python -m content_hoarder migrate-rsm-threads --from "/path/to/reddit-saved-manager/data/app.db"
```

Reads the RSM DB read-only and copies non-empty `thread_json` into `reddit_threads`, re-keyed
`t3_x` → `reddit:t3_x`. Idempotent. Re-run `import <RSM app.db>` first if you have newer saves, then
`dedup` (URL dedup is safe + reversible; title dedup is looser — review before resolving).

## Syncing new saves
Live sync is built on two transports. The sanctioned **OAuth** lane (installed-app / RedReader client
id, no API key needed; `reddit_oauth.py`) is preferred for the saved-list pull when configured; the
default fallback is a **cookie-based incremental sync** — implemented in `reddit_sync.py`, exposed as
the `reddit-sync` CLI and a **"Sync newest"** button on `/reddit`:

- It GETs `https://www.reddit.com/user/<username>/saved.json` with your `reddit_session` cookie
  (set once via `reddit-unsave --login --cookie "<value>"` — shared with the unsave queue),
  **newest-first**, walking pages until it re-reaches the **high-water mark** (the newest fullname
  from the last sync, stored in `settings['reddit_sync_newest']`) or hits `max_pages` (default 3;
  `--full` raises it to 50 for a deep catch-up). A routine sync therefore touches only the new
  saves — seconds, not an 11-minute full re-pull.
- The mark **only advances when the run reached a real boundary** (re-hit the old mark, a fully-known
  page, or the end of the list) — **never on a `max_pages` truncation**, which would otherwise skip
  the items below the cutoff forever. The first sync (no mark yet) sets the baseline; if you have a
  large backlog of new saves, run `reddit-sync --full` once for a thorough first catch-up.
- **Live validation (Phase 0) passed:** `saved.json` returns the full listing with just the session
  cookie (100/page, ~0.5s/req), no login wall. The keyless fallback if it ever breaks is importing a
  Reddit **GDPR data-export ZIP** (complete saved list, no scraping; porting RSM's ZIP/BDFR importers
  is a backlog item).

> **Note — sync is additive / one-way.** Sync only *pulls newly-saved items in*; it does **not** detect
> items you **unsaved elsewhere** (reddit.com or the Reddit app). `is_saved` flips to `0` only when
> *content-hoarder itself* unsaves (the Done→drain queue, or the Reddit-view Unsave button), and
> `merge_upsert` preserves `is_saved` on every re-sync — so an externally-unsaved post keeps showing as
> saved here indefinitely. Reflecting external unsaves would need a separate **reconcile** pass that walks
> the *entire* saved list and flips local `is_saved=1` rows no longer present (O(whole list) — keyless but
> expensive, so a manual/periodic action). Not built; recorded here so the drift is understood.

## Cookie expiry
`reddit_session` cookies expire every few days — same re-paste UX as the existing unsave feature
(`reddit-unsave --login --cookie "<value>"`). A dead cookie surfaces a clear auth-error state.
