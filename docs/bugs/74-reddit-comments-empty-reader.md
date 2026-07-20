# #74 — Reddit comments not showing in inbox reader

**Status: FIXED on `fix/74-comment-reader-empty` (2026-07-12; review-fix 2026-07-19).**  
GitHub: https://github.com/asmartin-ai/content-hoarder/issues/74  
PR: https://github.com/asmartin-ai/content-hoarder/pull/76

## Confirmed symptoms (live DB, read-only)

| Metric | Value |
|---|---|
| Reddit inbox items | ~42,893 |
| Inbox **comments** (`kind=comment`) | ~6,426 |
| Cached threads | ~1,612 (mostly `t3_`, few `t1_`) |

Opening a saved **comment** (`reddit:t1_…`) with no pre-cached thread often landed on **"No comments on this post."** or a generic load failure. Card snippet (`item.body`) was fine — the bug was the **reader thread pane**.

## Root causes

1. **Misleading empty state:** cache miss `{cached:false, comments:[]}` used the same copy as a truly empty thread.
2. **Cache key = item fullname:** posts as `t3_`, comments as `t1_`; comment opens rarely reused a post-level hydrate.
3. **`hydrate_status` not surfaced** for `auth_missing` / network / unavailable.

## Fix shipped

| Packet | Change |
|---|---|
| **P0** | `threadEmptyMessage()` + reader wiring — never "No comments on this post" when `cached === false`; auth/network/unavailable/not_found copy + Open original |
| **P1** | Dual-write hydrate under comment + `reddit:t3_<sid>` from permalink; `get_thread` / `hydrate_if_missing` fall back to the post key and mirror |
| **P2** | Seed "Your saved comment" while loading — **only when no comments are rendered** (review fix: the seed is a loading-state placeholder, not a post-load persistent pane; the saved comment is already the first entry in the loaded tree) |

### Files
- `src/content_hoarder/reddit_hydrate.py` — `submission_fullname`, `_cache_thread_blob`, `hydrate_if_missing` fallback
- `src/content_hoarder/reddit_thread.py` — `get_thread` submission fallback (docstring notes a TODO to factor the mirror into a caller-side helper once dual-key logic consolidates with `hydrate_if_missing`)
- `src/content_hoarder/static/browse/reader.js` — empty messages, seed-with-loading-only, load path
- `src/content_hoarder/static/browse/browse.css` — `.rd-cmtseed*`
- Cache **v120** (rebased onto main's v124 in the merge)

### Tests
`tests/test_issue_74_comment_thread.py` (8 tests) — dual-key cache, hydrate dual-write, honest empty copy (node), `not_found` distinct from cache-miss, `renderComments` skips seed when comments present (P2 regression guard), collapse handlers pass `res` to `renderComments`.

## Known follow-ups (not blocking)

- **Dual-key fallback is duplicated** between `reddit_thread.get_thread` and `reddit_hydrate.hydrate_if_missing`. A future refactor should extract a shared helper. (Tracked as TODO in `reddit_thread.py` docstring.)
- **`get_thread` issues a commit-on-mirror.** The historical contract says "pure cache reader — no network here"; the mirror write violates that. No current API route mixes open DML with a `get_thread` call, so it is latent, not live. (Tracked in `reddit_thread.py` docstring.)

## Optional follow-ups

- Scroll-to / highlight saved comment inside a full loaded tree.
- Bulk dual-key backfill for existing rows.
