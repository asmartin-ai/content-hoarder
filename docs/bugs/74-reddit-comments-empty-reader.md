# #74 — Reddit comments not showing in inbox reader

**Status: DIAGNOSED 2026-07-12** (no code fix in this packet).  
GitHub: https://github.com/asmartin-ai/content-hoarder/issues/74

## Confirmed symptoms (live DB, read-only)

| Metric | Value |
|---|---|
| Reddit inbox items | ~42,893 |
| Inbox **comments** (`kind=comment`) | ~6,426 |
| Cached threads (`reddit_threads`) | 1,612 total (1,501 `t3_`, **111 `t1_`**) |
| Auth present | yes (`reddit_oauth` + `reddit_web` for Atresdeltor) |

Opening a saved **comment** (`reddit:t1_…`) with no pre-cached thread still often lands on:

- `"No comments on this post."` when `cached: false` + empty `comments[]`, or  
- `"Couldn't load the Reddit thread"` when hydrate fails.

Card snippet (`item.body`) is fine — the bug is the **reader thread pane**, not the card.

## Root causes (two layers)

### 1. Misleading empty state (UX / signal loss) — primary user-visible bug

`GET /reddit/items/<fullname>/thread` always returns a body for existing items. On cache miss:

```json
{ "cached": false, "post": {}, "comments": [], "item_kind": "comment", ... }
```

Lazy hydrate runs in the same request (`hydrate_if_missing`) and attaches `hydrate_status`
(`auth_missing` | `hydrated` | `network_error` | …), but:

- `reader.js` `applyThread` / `renderComments` treats **zero comments** as  
  **"No comments on this post."** — which is true for empty threads **and** for  
  “we never loaded anything.”
- When `cached: false`, reader may POST `/hydrate` then re-GET; on failure it uses  
  `failState()` (“Couldn’t load…”) without distinguishing **auth_missing** vs network.
- `hydrate_status` from the first GET is **not** mapped to a dedicated chip/message  
  for `auth_missing` / `unavailable`.

So the UI lies: it looks like the post has no replies.

### 2. Cache key = item fullname (architecture) — comments vs posts

- Threads are stored under the **requested item’s fullname**  
  (`db.set_reddit_thread(conn, fullname, …)` in `hydrate_one`).
- Posts cache as `reddit:t3_<id>`; comments as `reddit:t1_<id>` when hydrated that way.
- **0 of first 500 inbox comments** had a matching **post** thread row  
  (`reddit:t3_<submission>` extracted from `metadata.permalink`), so comment opens  
  almost never reuse a post-level cache even if that post was hydrated elsewhere.
- Comment permalinks **are** present on sample rows  
  (`/r/…/comments/<submission>/…/<comment>/`) — so `no_permalink` is **not** the common case.

Hydrate URL is built from the comment permalink + `/.json`, which is correct for Reddit  
(returns the submission listing + comment tree). When OAuth/cookie works, hydrate succeeds  
(issue body already verified `t1_cqod05n` → 34 comments).

### 3. Auth path nuance

Issue text assumed “no cookie” as the default. On **this** machine OAuth **is** configured.  
The empty-state bug still matters whenever:

- hydrate is slow/fails,  
- `nofetch=1`,  
- negative cache `hydrate_failed_at` / `unavailable`,  
- or token refresh glitches.

So fix #1 is still required even with OAuth present.

## Not the cause

- Comments missing from the **inbox list** — they appear; ~6.4k in inbox.  
- Card body empty — body renders on the triage/browse card.  
- FTS / search filtering out comments.

## Recommended fix packets

### P0 — Honest empty / fail states (S, no schema)

In `browse/reader.js` (and optionally the JSON shape from `get_thread`):

1. If `cached === false` and `comments.length === 0`:
   - Show **"Thread not loaded yet"** (not “No comments on this post”).
2. Map `hydrate_status`:
   - `auth_missing` / `auth_expired` → “Sign in to Reddit to load this thread” + link to  
     `docs` / settings / `reddit-oauth --login` hint.
   - `network_error` → retry affordance.
   - `unavailable` → “Couldn’t find this thread (may be deleted).”
3. Only show **"No comments on this post."** when `cached === true` and comments empty.

Tests: static/string guards or a tiny pure helper `threadEmptyMessage(res) -> string`.

### P1 — Share cache by submission id (M)

- When hydrating a **comment**, also key (or dual-write) the blob under  
  `reddit:t3_<submission_id>` parsed from permalink.
- On `get_thread` for a comment: fall back to post fullname cache if comment key misses.
- Benefit: opening any comment under a once-hydrated post is instant; fewer Reddit calls.

### P2 — Seed reader from the saved comment (S)

Even before network: show the **saved comment body** as a highlighted node in the thread  
pane so the sheet never feels empty while hydrate runs.

## Repro (API)

```bash
# cache-only miss shape
curl -s "http://127.0.0.1:8788/reddit/items/reddit:t1_<id>/thread?nofetch=1" | jq .
# expect: cached=false, comments=[]
```

## Out of scope for diagnosis

- Implementing P0–P2 (separate PR).  
- Bulk pre-hydration of all comment threads (rate-limit heavy; don’t).

## Done-when for a fix PR

- [ ] Cached-false empty state never says “No comments on this post.”
- [ ] auth_missing surfaces an actionable message
- [ ] Offline test or static guard for the message helper
- [ ] Optional: comment open reuses `t3_` cache when present
