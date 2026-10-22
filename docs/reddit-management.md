# Reddit management view (iceboxed)

The former dedicated Reddit workspace is not part of the current UI. `/reddit`
redirects to the main browse page filtered to Reddit. Its API and cached-thread
storage remain in `src/web/`, `src/db.ts`, and `src/reddit_thread.ts`; this
note records the former view and behavior to preserve if it is resumed.

## Former view

- Table/grid browse, subreddit counts and filters, cached thread/comment viewer,
  stats, NSFW blur, and per-item unsave/re-save controls.
- Reddit-only triage linked to the main triage surface.
- Recent-sync-first sorting; Reddit does not provide save timestamps.

## Current architecture

- No schema change: Reddit-specific facts stay in `items.metadata`.
- `reddit_threads` stores cached thread JSON by item fullname, outside metadata.
- `src/web/` serves Reddit API routes and redirects the old `/reddit` page.
  `src/db.ts` owns SQL and row conversions; `src/reddit_thread.ts` parses
  cached thread data.
- The current PWA is under `src/static/`; the former `templates/reddit.html`
  interface is not a current route.

## Migrating from reddit-saved-manager
The 64.6k Reddit items were already imported. To bring over RSM's cached threads:

```bash
bun run src/cli.ts migrate-rsm-threads --from "/path/to/reddit-saved-manager/data/app.db"
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
