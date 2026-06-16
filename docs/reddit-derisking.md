# Reddit fetch de-risking — plan & rationale

> Status: **implemented** (2026-06-16). All 7 features below are built + unit-tested offline (see
> "Implementation notes" after the table). Captures why we hardened the app's Reddit access, the
> risk model, and the concrete features. For future sessions: this is the source of truth for "is
> the cookie safe / what are we doing about it."

## Why this exists

The app fetches Reddit thread data ("hydration") to power the inline reader. Concern raised by the
user (2026-06-16): with Reddit cracking down on bots, **is using my logged-in `reddit_session`
cookie for automated hydration going to get my account banned or my IP blocked?**

Context that prompted it:
- **2026-05-30: Reddit 403'd the *anonymous* `.json` endpoints** — killed fxreddit / vxreddit /
  RDX and unauthenticated RSS bridges. (Our app is *authenticated* via cookie, so it still works —
  proven: threads hydrate live.)
- **2025-12: Reddit stopped issuing new free API keys** — you can no longer register your own
  OAuth app for free, which is why reusing an existing *installed-app* client ID (e.g. RedReader's,
  which is public in its source, no client secret) with your own account is the pragmatic OAuth path.

## Risk model (what actually gets accounts actioned)

Reddit's automated enforcement targets **posting / spam / write behavior** — rapid posting, repeated
link-dropping, vote manipulation, new-account high-volume bursts, ban-evasion, VPN/datacenter exit
nodes. Ranked exposure for *our* usage:

| Action type | Risk | Notes |
|---|---|---|
| **Read-only, on-demand hydration** (tap a thread → 1 GET) | **Low** | Looks like a logged-in user browsing. Lowest-signal profile. |
| Bulk read backfill (mass-hydrate thousands) | Medium | The bot-shaped pattern — volume + regular timing draws attention. |
| **Writes** (mass-unsave drain — `reddit_unsave`) | **Higher** | Programmatic writes are what bans target. Treat as elevated. |
| Fixed-interval automation (exact 2.0s throttle) | Adds signal | Perfectly regular timing is a fingerprint; humans jitter. |
| Script-y User-Agent / flagged VPN IP | Adds signal | Browser-UA + residential IP blend in. |

**Most likely failure modes (in order):** (1) cookie invalidation → just re-login; (2) temporary
IP rate-limit / 429s → recoverable, and a *warning shot* that precedes any account action;
(3) account action → real but the unlikely tail for low-volume read-only personal use.

**Bottom line:** current usage (on-demand reads, home IP, own account) is low-risk. The de-risking
below pushes it lower and makes the auth durable + sanctioned.

## As-built state (2026-06-16, verified against code)

- **Auth:** session cookie. `get_auth(conn)` returns `{"session_cookie": row["access_token"], …}`
  (`reddit_unsave.py:109`) — note the storage column is generically named **`access_token`**, so the
  schema is already OAuth-ready. Hydration: `reddit_hydrate.hydrate_one` → `GET <permalink>/.json?raw_json=1`
  with `Cookie: reddit_session=…` (`reddit_unsave._http_get:45`).
- **User-Agent:** `"content-hoarder/0.1 (local personal use)"` (`config.py:21` `_DEFAULTS["USER_AGENT"]`)
  — a *script* string, neither a real browser (for cookie blending) nor a Reddit-compliant OAuth UA.
- **Throttle:** `hydrate_batch(throttle=2.0)` uses a **fixed** `sleep(2.0)` between requests
  (`reddit_hydrate.py:365`); stops on auth errors; courteous but perfectly regular (no jitter).
- **On-demand:** reader tap → single `GET …/thread` then hydrate-on-miss → 1–2 GETs. Low volume.
- **429 handling:** the **write** path already backs off — `_http_post` returns status+headers so a
  429's `Retry-After` is honored via `_retry_after_seconds`/`_send_with_retry` (`reddit_unsave.py:184`),
  and 403 halts the drain. The **read** path (`_http_get`, used by hydration) does **NOT** — a 429
  just becomes `RedditNetworkError` and the batch counts it as a generic network error (no backoff,
  no Retry-After pause).
- **Writes:** mass-unsave drain (`reddit_unsave`) writes to Reddit via the cookie; already has
  Retry-After + 403-halt + an "approve the scope first" gate.

## De-risking features to add

| # | Feature | Why | Where | Effort | Status |
|---|---|---|---|---|---|
| 1 | **Jitter the throttle** (randomize ~1.5–4s instead of fixed 2.0s) | Kills the exact-interval fingerprint | `reddit_hydrate.hydrate_batch` (and any archival throttle) | S | ✅ |
| 2 | **429/Retry-After + full-jitter backoff on the READ path** | Hydration ignores rate-limit signals today; should honor `Retry-After` + exponentially back off like the write path. See Timing spec §B. | `reddit_unsave._http_get` + `hydrate_one`/`hydrate_batch` callers; reuse `_retry_after_seconds` | S–M | ✅ |
| 3 | **Realistic User-Agent per transport** | Cookie path → a real **browser** UA blends in; OAuth path → a Reddit-**compliant** descriptive UA (`platform:appid:version (by /u/user)`) is required. Current generic string fits neither. | `config.py` `USER_AGENT` (+ transport-aware selection) | S | ✅ |
| 4 | **On-demand only; cap/gate bulk backfill** | Bulk hydration over the cookie is the risky pattern; keep lazy tap-to-hydrate as the default, require an explicit gate + small caps for any batch | `hydrate_batch` caller policy; reader stays on-demand | S | ✅ |
| 5 | **OAuth read-only path (installed-app, RedReader client ID)** | The *sanctioned* + *durable* + *lower-risk* auth; replaces/augments the cookie. Read-only scope (`read`), no posting scopes. Token + client ID in **`.env` (never the repo)**. Hit `oauth.reddit.com`. Slots into the existing `get_auth`/`set_auth` abstraction (`access_token` column already fits). | new `reddit_oauth.py`; `get_auth` returns a bearer token; `_http_get` sends `Authorization: bearer …` to `oauth.reddit.com` | M | ✅ |
| 6 | **Treat mass-unsave (writes) as elevated risk** | Writes carry the real ban risk; add jitter + smaller default batch + keep the approve-scope gate; document the elevated risk inline | `reddit_unsave` drain | S | ✅ |
| 7 | **Global rate cap** (stay well under 100 QPM; conservative on cookie) | Don't approach Reddit's authenticated budget; pace all requests | shared `_http`/pacing | S | ✅ |

### Implementation notes (as-built 2026-06-16)
Where the build diverged from the sketch, and why:
- **Refresh token lives in the DB, not `.env`.** Only the *client id* is config (`.env` /
  `REDDIT_OAUTH_CLIENT_ID` env var). The refresh + (cached) access token are stored in
  `auth_tokens` (`service='reddit_oauth'`, the existing `access_token`/`refresh_token` columns) —
  consistent with the cookie auth abstraction, and it lets the short-lived access token carry an
  expiry (`updated_utc` = mint time; refreshed ~5 min before the 1 h TTL). The DB is gitignored.
- **Redirect URI is configurable** (`REDDIT_OAUTH_REDIRECT_URI`), defaulting to RedReader's
  registered `redreader://rr_oauth_redir` — it must pair with the client id. The browser can't open
  that custom scheme, so `reddit-oauth --login` has the user paste the redirected URL back and reads
  the `code` out of it (state-validated).
- **OAuth ships DORMANT.** `hydrate_one` prefers OAuth only when `reddit_oauth.is_configured` (a
  refresh token exists) *and* no `getf` was injected; until the one-time `reddit-oauth --login` it's
  the cookie path byte-for-byte. The cookie stays as the automatic fallback if a refresh fails.
- **Browser UA** = `REDDIT_BROWSER_USER_AGENT` (a Firefox default; override with your real UA for
  the best blend) on every cookie path (login/sync/drain/resave/hydrate). The generic `USER_AGENT`
  still serves archives/youtube/karakeep. OAuth uses a compliant `windows:content-hoarder:<ver>
  (by /u/<user>)` UA built from the authed username.
- **Backoff reuse:** both the read path (`_http_get`) and the OAuth path (`oauth_get`) opt into
  `_http.request(retries=4, backoff=1.0, jitter=True)` — Retry-After honored exactly, else full
  jitter (`_http.full_jitter_delay`). The pre-existing non-jitter retry stays byte-identical
  (golden test guarded).
- **Global rate cap** = `_http.MIN_THROTTLE` (0.6 s) floor applied to the drain / sync / hydrate
  inter-request throttles, which are themselves jittered via `_http.jittered_throttle`.
- **Bulk cap** = `reddit_hydrate.DEFAULT_BATCH_LIMIT` (25, down from 100); the dry-run/`--yes` gate
  is unchanged.

### OAuth path — design sketch (feature 5)
- **App type:** "installed app" (mobile/desktop, *no client secret*). Reuse a public installed-app
  `client_id` (RedReader's, from its open source) — fine for personal single-user use; **gray area in
  Reddit's API terms** (it's their registered app), so: personal use only, never redistribute, keep
  the token local.
- **Flow:** one-time user OAuth (`https://www.reddit.com/api/v1/authorize` with `duration=permanent`,
  `scope=read`) → exchange code for an access + **refresh** token → store refresh token in `.env`
  (`REDDIT_OAUTH_REFRESH_TOKEN`, `REDDIT_OAUTH_CLIENT_ID`). Refresh on expiry.
- **Requests:** `Authorization: bearer <token>` against `https://oauth.reddit.com/…` (same data shape
  as `.json`, incl. `media.reddit_video` + `preview` — see the inline-reader video work). Compliant
  descriptive User-Agent required.
- **Why safer:** operating inside Reddit's sanctioned programmatic-access lane (published 100 QPM
  budget) instead of scripting a logged-in browser session (against ToS regardless of volume).

## Timing spec (tuned 2026-06-16, cross-checked vs PRAW + AWS)

Two **distinct** mechanisms — don't conflate them:

**§A — Steady-state throttle (feature #1): politeness pacing between hydration requests.**
- We are **far under** Reddit's budget (authenticated OAuth = 100 QPM ≈ 1 req / 0.6s; we do a handful,
  human-paced). So the goal is **not** throughput — it's breaking the *exact-interval fingerprint*.
- Replace the fixed `sleep(2.0)` with a jittered delay: **`random.uniform(1.5, 3.5)` s** (base 2.0
  ±~45%). Any ±25–50% jitter works; the point is that no two gaps are identical.
- PRAW's gold-standard is **header-driven**: read `X-Ratelimit-Remaining` / `X-Ratelimit-Reset` and
  slow as remaining→0. Overkill for single-user, but if those headers are present, honoring them is a
  cheap correct upgrade (and the natural behavior once on OAuth).

**§B — Backoff on 429 / 5xx (feature #2): the read path has none today.**
- If the response carries **`Retry-After`, honor it exactly** (authoritative). This already exists on
  the WRITE path (`_retry_after_seconds` / `_send_with_retry`) — reuse it for reads.
- Otherwise use **exponential backoff with FULL JITTER** (AWS's recommended default — lowest upstream
  load, avoids thundering-herd): `delay = random.uniform(0, min(cap, base * 2**attempt))` with
  `base≈1s`, `cap≈60s`; give up after ~4–5 attempts and surface a clean "rate-limited, try later."
- **Full jitter > decorrelated jitter** here: we optimize for being polite to Reddit (server load),
  not for minimizing our own completion time.

## Sequencing (recommended)
1. **Quick wins first** (low risk, high signal-reduction): #1 jitter, #2 read-path 429 backoff,
   #3 browser UA for the cookie path, #6 unsave hardening. All S.
2. **Then** #4 bulk-gate policy + #7 rate cap.
3. **Then** #5 OAuth — do it before scaling read volume, or as soon as the cookie proves flaky.
   Once OAuth read is in, it becomes the default hydration transport and #3 flips to the compliant
   OAuth UA.

## Sources (consulted 2026-06-16)
- [HN — Reddit blocks JSON API access (read-only apps unusable)](https://news.ycombinator.com/item?id=48329557)
- [Reddit's API Is Officially Dead in 2026 (Medium, Jun 2026)](https://medium.com/@alex_79882/reddits-api-is-officially-dead-in-2026-here-s-what-i-use-instead-f88ee5b809c8)
- [fxreddit issue #158 — stopped working 29/5/26](https://github.com/MinnDevelopment/fxreddit/issues/158)
- [Reddit Shadowban guide 2026 — triggers & prevention (AuditSocials)](https://www.auditsocials.com/blog/reddit-ban-suspension-policy-2026-shadowban-appeal-guide)
- [Reddit API limits, rules & restrictions (Postiz)](https://postiz.com/blog/reddit-api-limits-rules-and-posting-restrictions-explained)
- [Reddit replaces shadowbans with account suspensions (TechCrunch)](https://techcrunch.com/?p=1236872)
- [PRAW — running multiple instances / dynamic header-based rate limiting](https://github.com/praw-dev/praw/blob/v6.5.1/docs/getting_started/multiple_instances.rst)
- [AWS Architecture Blog — Exponential Backoff and Jitter (full vs decorrelated)](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/)
- [Reddit API rate-limit workarounds 2026 (PainOnSocial)](https://painonsocial.com/blog/reddit-api-rate-limits-workaround)

## Changelog
- 2026-06-16 — doc created; risk model + as-built state + 7-feature plan. Nothing built yet.
- 2026-06-16 — tuned the timing spec (§A steady-state jitter, §B full-jitter backoff) cross-checked
  against PRAW (header-driven pacing, 100 QPM) and the AWS backoff/jitter guidance.
- 2026-06-16 — **implemented all 7 features** (new `reddit_oauth.py` + `_http` jitter helpers +
  cookie-path UA/throttle changes + `reddit-oauth` CLI). +32 offline unit tests; full suite 453
  passed. See "Implementation notes" for as-built decisions. OAuth ships dormant pending a one-time
  `reddit-oauth --login`.
