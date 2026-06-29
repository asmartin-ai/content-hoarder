## Epic 25 — Reddit access de-risking  (`enhancement`, `area:reddit`)
*Harden cookie-authed Reddit hydration against the (low but real) ban / IP-block risk and move reads to
Reddit's sanctioned lane. **Full risk model + per-feature rationale + as-built notes:
[`docs/reddit-derisking.md`](docs/reddit-derisking.md)** — that doc is the source of truth; details live
there, not here. All 7 features SHIPPED + merged to main 2026-06-16 (`282a0d8`): new `reddit_oauth.py` +
`_http` jitter helpers; +33 offline tests, full suite 454 green; passed a high-effort /code-review.
**OAuth ships DORMANT** — `hydrate_one` prefers it once a refresh token exists; activate once with
`python -m content_hoarder reddit-oauth --login` (cookie stays as the automatic fallback).*

- [x] ~~**F1 — Jitter the throttle.**~~ `_http.jittered_throttle` (uniform `[0.75,1.75]×base`) replaces
  the fixed inter-request `sleep` on hydrate/drain/sync — kills the exact-interval bot fingerprint.
- [x] ~~**F2 — 429/Retry-After + full-jitter backoff on the READ path.**~~ `_http_get` opts into
  `_http.request(retries=4, backoff=1.0, jitter=True)` (`_http.full_jitter_delay`); hydration now honors
  rate-limit signals instead of treating the first 429 as a hard failure. Non-jitter path byte-identical
  (golden test guarded).
- [x] ~~**F3 — Transport-aware User-Agent.**~~ `REDDIT_BROWSER_USER_AGENT` on every cookie path
  (login/sync/drain/resave/hydrate); a compliant `windows:content-hoarder:<ver>` UA on OAuth; the generic
  `USER_AGENT` is retained for archives/youtube/karakeep.
- [x] ~~**F4 — On-demand default; cap/gate bulk backfill.**~~ `reddit_hydrate.DEFAULT_BATCH_LIMIT`
  lowered 100→25 behind the existing dry-run/`--yes` gate; tap-to-hydrate stays the norm.
- [x] ~~**F5 — OAuth read-only path (installed-app, RedReader client id, no secret).**~~ New
  `reddit_oauth.py` (authorize / code-exchange / refresh; refresh token in the DB, NOT the repo;
  `oauth_get` with the F2 backoff) + the `reddit-oauth` CLI; `hydrate_one` prefers OAuth when configured.
  **Live-verified** (a real `oauth.reddit.com` read returned a Listing). Client id in `.env` + a User env
  var; `read` scope only (no `identity`, so the username is omitted from the UA — by design).
- [x] ~~**F6 — Treat mass-unsave (writes) as elevated risk.**~~ `drain` now jittered + an inline
  elevated-risk note; the approve-scope gate is kept (programmatic writes are what bans actually target).
- [x] ~~**F7 — Global rate cap.**~~ `_http.MIN_THROTTLE` (0.6 s) floor on the hydrate/drain/sync
  throttles — never approaches Reddit's 100 QPM authenticated budget, even if misconfigured.
- [ ] **P3 — "Human-mimic" jitter for hydration pacing (learning experiment).** *(User idea
  2026-06-16; explicitly a learning project — Kenja wants to build it himself.)* Replace/augment the
  uniform `_http.jittered_throttle` with a human-shaped delay distribution. **Honest verdict — don't
  expect a real win:** it won't save speed (real browse timing is heavy-tailed/log-normal and *slower*
  on average — it embeds read-pauses a bot doesn't need; for raw speed just lower `--throttle`, OAuth
  has ~4× headroom under 100 QPM), and the anti-detection gain is marginal (uniform already kills the
  exact-interval fingerprint; Reddit isn't distribution-profiling low-volume authenticated reads). The
  value is the *learning*, not the outcome. **Seam:** `jittered_throttle` is one function, called in 3
  places (`reddit_hydrate.hydrate_batch`, `reddit_unsave.drain`, `reddit_sync.sync_saved_cookie`) as
  `sleep(_http.jittered_throttle(throttle))` — swap it or make it pluggable; keep the `_http.MIN_THROTTLE`
  floor and add a cap so a sampled long pause can't stall a batch. **Ladder:** (a) log-normal
  `base*random.lognormvariate(0,0.5)` clamped (~2 lines); (b) two-state burst/pause Markov (short bursts
  + occasional long pause = the real browsing rhythm); (c) empirical "copy me" — log real thread-open
  gaps from the `/reddit/items/<fn>/thread` route into a small table, then sample (caveat: truncate the
  long read-pauses so it stays human-*shaped* without being bot-pointlessly slow).
