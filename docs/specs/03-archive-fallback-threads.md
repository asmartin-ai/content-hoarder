# Spec 03 — Archive fallback for deleted Reddit threads

BACKLOG: Epic 24 #749. Branch: `feat/archive-fallback`. Touches: `reddit_hydrate.py`,
`reddit_unsave.py` (404 signal), `archival/providers.py`, `reddit_thread.py`, `tests/`.

## Goal

When the live cookie fetch of a thread returns **HTTP 404** (deleted/removed), assemble a best-effort
`[post, comments]` listing from the integrated archival providers (**prefer Arctic-Shift** — it returns
real comment permalinks; PullPush omits them), store it via `set_reddit_thread`, and mark it
archive-sourced. Must be fully offline-testable.

## Acceptance criteria

- A true 404 on `hydrate_one` triggers an archive assembly (not on timeouts/5xx — those stay `network_error`).
- The assembled blob matches the consumed shape: `[ {kind:Listing,data:{children:[{kind:t3,data:post}]}},
  {kind:Listing,data:{children:[t1 nodes]}} ]`, with each comment node
  `{kind:t1,data:{author,body,score,permalink,created_utc,replies}}` (`replies` = nested Listing or `""`).
- Comment tree is rebuilt from the flat archive list via `parent_id` adjacency; orphans attach at root
  (not dropped). Missing permalinks (PullPush) are synthesized `/r/<sub>/comments/<sid>/_/<cid>/`.
- The thread is marked archive-sourced and `parse_thread` can surface that marker.
- `hydrate_one` returns a distinct status `"archived"`; web route maps it to 200.
- Existing cached thread is NOT overwritten (fallback only runs when there's no cache — the live one is gone).
- Offline tests cover: 404→archive path, tree reassembly, permalink synthesis, Arctic-preferred ordering.

## Implementation (with pre-decided decision gates)

### 1. Make 404 distinct — `reddit_unsave._http_get` (`:60-63`)
Today 404 → generic `RedditNetworkError("HTTP 404")`. Add `class RedditNotFoundError(RedditNetworkError)`
and raise it on `e.code == 404`. **Decision:** subclass so every existing `except RedditNetworkError`
still catches it (no blast radius) while `hydrate_one` can catch the subclass first. Do NOT reuse the
`{}`/401-403 path (shared auth signal).

### 2. Hook the fallback — `reddit_hydrate.hydrate_one` (`:61-72`)
Wrap the `getf(...)` call: `except RedditNotFoundError:` → call a new
`hydrate_one_from_archive(conn, fullname, *, providers=None)` and return `{"status":"archived",...}`.
Keep `RedditNetworkError` → `network_error` as-is.

### 3. New assembler — `reddit_hydrate.hydrate_one_from_archive`
- `providers = providers or default_providers(user_agent, throttle=False, order=("arctic","pullpush"))`
  — **override** the default `("pullpush","arctic")` (providers.py:220) to prefer Arctic.
- Fetch the post: `fetch_posts([_bare_id(fullname)])`; fetch comments: `search_comments(fullname, limit=200)`.
- **Preserve `id` + `parent_id`** on comments: `_norm_comment` (providers.py:119-128) currently DROPS
  `parent_id` and hardcodes `depth:0`. Add a thread-mode normalizer (or extend it) that keeps `id`/`parent_id`.
  *(Verify `parent_id` exists in a real/fixture Arctic + PullPush comment record before relying on it —
  api-mapping-validation.)*
- Reassemble: build `children_by_parent` keyed on `parent_id`; the root's children have
  `parent_id == "t3_<sid>"`; recurse to nest `replies`. Reuse `_bdfr_comment_to_child` /
  `bdfr_to_listing` (reddit_hydrate.py:97-147) — they already emit the exact node shape + synthesize
  the slugless permalink (`:106-109`).
- Write: `db.set_reddit_thread(conn, fullname, json.dumps(listing))` (it gzips internally — pass a str).

### 4. Archive marker — **Decision: in-blob, no migration**
The `reddit_threads` table has no metadata column (db.py:92-96). Store the marker inside the post `t3`
data dict, e.g. `post["_archive_sourced"] = True`, and add one line to `parse_thread`
(reddit_thread.py:57-66) to surface `archived = pd.get("_archive_sourced", False)` in its return.
(Cleaner alternative — a `reddit_threads.source` column — is a later option; avoid the migration risk overnight.)

### 5. Web route — `POST /reddit/items/<fullname>/hydrate` (web.py:287-303)
Add a status→HTTP mapping: `"archived"` → 200 (today only `network_error`→502 is handled).

## Tests (`tests/test_archival.py` pattern)
- Mirror `_fake_json` (`:20-25`) — branch on URL; add the `/comments/search` (Arctic) and
  `/search/comment` (PullPush) URLs, returning records WITH `id`/`parent_id`.
- New test: inject a `getf` that raises `RedditNotFoundError` + providers backed by `_fake_json`;
  assert `hydrate_one` returns `"archived"`, the stored blob parses via `parse_thread`, the tree nests
  correctly, and a PullPush record with no permalink gets a synthesized one.
- Find + mirror the existing `bdfr_to_listing` / `hydrate_from_archive` shape tests in `tests/`.

## Gotchas
- Gate strictly on HTTP 404 — a 5xx/timeout must NOT replace a live thread with a thinner archive copy.
- `search_comments` may be capped at `limit` — orphan comments (parent not fetched) attach at root.
- `parent_id` carries `t1_`/`t3_` prefixes — match accordingly.
- `set_reddit_thread` wants a **str** (gzips internally); never pass pre-compressed bytes.
- Keep everything injectable: `hydrate_one`'s `getf=` for the 404, the assembler's `providers=` for archives.
- Complements the existing `recover_one` path (web.py:278-285), which overlays post text onto the
  *items* row but builds no thread.
