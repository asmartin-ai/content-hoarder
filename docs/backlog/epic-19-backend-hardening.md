## Epic 19 — Backend hardening  (`bug`, `area:backend`)
*From the comprehensive review (2026-06-09). **Shipped 2026-06-09** (merge `b2dc1d9`,
`fix/unsave-hardening`, suite 202 green): Claude-owned fixes + local-LLM delegation via the
`delegation/` prompt pack (Devstral/Qwen drafts, Claude review+repair).*

- [x] ~~**P0 — `Retry-After` handling.**~~ Shipped: case-insensitive header lookup; HTTP-date /
  negative values fall back to the exponential delay instead of crashing the drain. *(delegation/01)*
- [x] ~~**P0 — Unsave drain breaks the sync high-water mark.**~~ Shipped: the mark is the newest
  K=25 fullnames (JSON list, legacy single-string still read); any survivor matching = caught-up,
  so a drained newest item no longer freezes the mark. *(Claude)*
- [x] ~~**P0 — Unsave queue retries failures forever.**~~ Shipped: attempts cap 5 → `state='failed'`
  (CASE flip in the failure UPDATE); re-enqueue resets attempts; `failed` count surfaced in CLI +
  `/reddit/unsave/status`. *(delegation/02)*
- [x] ~~**P0 — Transient network failure reported as "cookie expired".**~~ Shipped:
  `RedditNetworkError` for transport/5xx/unparseable; `{}` now means only 401/403. drain/sync report
  `network_error` separately (mark never advances on it); CLI exits non-zero for both. *(delegation/03)*
- [x] ~~**P0 — CSRF/DNS-rebinding guard.**~~ Shipped: `before_request` rejects non-local/private/
  tailnet Hosts and mismatched-Origin state-changing requests; `CONTENT_HOARDER_ALLOWED_HOSTS`
  extends the allowlist. *(Claude)*
- [x] ~~**P1 — Undo asymmetry for a drained Done.**~~ Shipped: the browse `/undo` route attempts the
  live re-save and returns a `warning` when it can't (dead cookie / offline). *(Claude)*
- [x] ~~**P1 — Version the FTS build marker.**~~ Shipped: `_FTS_VERSION=2`; legacy boolean-'1' DBs
  rebuild exactly once on next connect. *(delegation/04)*
- [x] ~~**P1 — Cap the web drain route.**~~ Shipped: default 50/request (clamped 1..500); the
  response's `remaining` lets the UI loop. *(delegation/05)*
- [x] ~~**P1 — Unhandled `int()` 500s.**~~ Shipped via `_int` + max_pages ceiling 200. *(delegation/06)*
- [x] ~~**P1 — `.env` read crashes on non-UTF-8/BOM.**~~ Shipped: `utf-8-sig` + `errors="replace"` +
  OSError guard. *(delegation/07)*
- [x] ~~**P1 — Consolidate undo→re-migrate round-trip.**~~ **Suspected bug NOT real** — three new
  round-trip tests pass against the existing implementation; behavior pinned. *(delegation/08)*
- [x] ~~**P2 — `merge_upsert` tags replace-vs-union asymmetry.**~~ Shipped: guard comment +
  characterization test. *(delegation/09)*
- [x] ~~**P2 — Test-gap fills.**~~ Shipped: `test_rsm_threads.py` (5 tests) + 5 youtube_recover
  failure-path tests. The categorize/missing-rules case was already covered by
  `test_nsfw_disabled_without_rules_file`. *(delegation/10)*
- [x] ~~**P3 — Unify the 4 divergent HTTP timeout/retry helpers**~~ Shipped 2026-06-14 (`bb5b1d8` on
  main — delegated to an Opus subagent): one shared `_http.request(...)` primitive + `retry_after_seconds`
  in new `src/content_hoarder/_http.py`; the 4 helpers (`archival/_http.get_json`, `reddit_unsave._http_get`/
  `_http_post`, `youtube_recover._http_get`, `karakeep._post`) are now thin adapters with identical
  signatures/return-shapes/error-policies; all injection seams preserved; the 6 network test files pass
  unedited + 19 new offline `_http` tests. Behavior-preserving (no live round-trip exercised).

*Bugs migrated 2026-06-20 from the retired `docs/IMPLEMENTATION-HANDOFF-2026-06-17.md` work queue
(B1/B2/B4 — confirmed by code read at write time; verify line numbers before acting):*

- [x] ~~**P2 — Same-second decay-wave UNDO collision (B1).**~~ ✅ Done 2026-06-20 (commit 5e37732): `db.decay` now stamps `metadata.decayed_at` with a UNIQUE monotonic wave id (`_allocate_decay_wave`, mirrors `allocate_saved_order`) instead of bare `now`, so two decays in the same second get distinct stamps and undo reverses exactly one wave. +2 oracle tests. `letgo()` (`resurface.py:152`) decays a cluster
  and stamps `metadata.decayed_at = now` (whole seconds) via `db.decay`; `undo_letgo()` (`resurface.py:166`)
  reverses by a **1-second window** (`db.undecay(decayed_after=decayed_at, decayed_before=decayed_at+1)`),
  selecting rows purely by timestamp (tag/sub deliberately unused, `resurface.py:169`). **Failure:** two "let
  it go" actions on **different** clusters within the same wall-clock second share a `decayed_at`, so UNDO on
  one cluster's toast un-decays **both** — violates the "one independently reversible wave" invariant
  (`db.decay` docstring, `db.py:~1233`). **Fix (anti-gaming):** make the wave id unique per call — preferred:
  `db.decay` allocates a monotonic wave id (mirror `db.allocate_saved_order`) and returns it; `undo_letgo`
  selects on that id, not a time window. Must NOT route through `bulk_set_status` (decay-safety invariant).
  **Acceptance:** `letgo(A)` then `letgo(B)` with a frozen identical `now`, then `undo_letgo(A)` → only A's
  rows return to inbox; B's stay decayed. *Delegation: ✅ qwen single-shot (oracle-shaped).*
- [x] ~~**P2 — Reconcile cap guards on row count, not real truncation (B2).**~~ ✅ Done 2026-06-20 (commit 801f056): added an additive `truncated_by_kind` override to `reconcile_reddit_saves` (True skips, False reconciles even at/above cap) + a `reconcile_complete` opt-in threaded through `import_path` and the `--reconcile-complete` import flag; the legacy row-count inference stays as the fallback so existing callers are unchanged. +3 tests. `db.py:~1040` skips saved-list
  reconciliation when `len(present) >= cap` (~1000), inferring "the listing was truncated" (Reddit caps the
  saved listing ~1000/type). But keying on the parsed count can't distinguish "complete export of exactly
  1000" from "truncated at 1000," so a user with exactly `cap` saved + a complete export silently skips
  reconciliation and genuine unsaves are never detected. **Fails safe** (never an *erroneous* unsave) → low
  urgency. **Fix:** pass an explicit `truncated_by_kind` flag from the sync/import layer (which knows
  `after`-exhaustion vs. a page cap) rather than inferring from the row count. *Delegation: 🟡 borderline,
  GLM (crosses the sync/import seam).*
- [x] ~~**P3 — `/import/prepare` temp-file leak (B4).**~~ ✅ Done 2026-06-20 (commit 7df72fc): an `atexit` hook unlinks every remaining staged temp file on process exit (the TTL sweep only ran on the next /prepare); the in-session TTL sweep stays. +1 test. `/import/prepare` (`web.py:~763`) writes an
  uploaded/yt-dlp temp file and stashes it in `_prepared[token]`; it's only unlinked by `/import/commit`
  (`web.py:~833`) or the 1-hour TTL sweep `_cleanup_prepared` (`web.py:~718`), and the sweep only runs on the
  *next* `/import/prepare`. A preview that's never committed (with no later prepare) lingers up to an hour.
  **Fix:** add cleanup on app teardown or a timer. Low priority given the TTL. *Delegation: 🟡 borderline,
  qwen (oracle ≈ fix size — batch with another web-layer item).*
