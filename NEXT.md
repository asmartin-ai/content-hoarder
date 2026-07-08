# NEXT.md — content-hoarder session focus

`main` is ahead of `origin/main`. Not pushed (user-gated per §7).
Suite: **1008 passing** (baseline unchanged; the 4 CH-B* bakeoff oracles stay RED on main by design — they're turned green on per-run `delegated/run-*` branches).

## Just done (2026-07-05 session, content-hoarder bakeoff)
- **Phase 0 + Phase 1 + Phase 2 bakeoff COMPLETE.** 80 runs across 4 hard-oracle
  tasks × 10 models × 2 runs. Total executor spend $0.43 (ZenMux PAYG, promo
  pricing). Full verdict in `bakeoff/RESULTS.md`; raw data in `bakeoff/results.csv`.
- **T3 (Flash tier) WINNER: `minimax/minimax-m3`** — best quality-to-cost
  (q2c=347) at 88% pass / $0.0025 per pass. Reliability picks: `deepseek-v4-flash`,
  `qwen3.7-plus`, `qwen3.6-flash` (all 100% pass at ~$0.005/pass).
- **Pro tier verdict: NOT worth ~3× cost for this workload.** Only `qwen3.7-max`
  (100% pass, $0.014/pass) beats the T3 winner on pass rate — at 5.6× the cost
  for a 12-point gain. `deepseek-v4-pro` (62%) and `kimi-k2.7-code` (50%) are
  *worse* than minimax-m3. `glm-5.2` is unusable headless (25% pass — the M5
  thinking-tokens bug).
- **Oracle bug fixed mid-bakeoff:** CH-B7's `_model` helper had a variable-
  shadowing bug (`{k: [n, k, rate] for k, (n, k, rate) in ...}` — the dict key
  was overwritten by the tuple's processed-count). Fixed in commit `066047d`
  before the final batch; all 8 CH-B7 runs used the fixed oracle.
- **Driver tooling shipped:** `scripts/bakeoff_arm.py` (per-run driver with
  4-check verification + CSV row) + `scripts/bakeoff_batch.py` (batch runner,
  idempotent, commits results.csv after each row). Per-task delegation specs
  in `bakeoff/specs/`. Run branches preserved under `delegated/run-*` for review.

## Just done (2026-07-04 session, P3.5 legacy retirement)
- **P3.5 MERGED into main** (spec 12 §2 — final packet of the W3 unify-one-surface
  cycle). The `/triage` and `/reddit` **page** routes are retired:
  - Both now return **302** redirects (`/triage` → `/?deck=1`, `/reddit` →
    `/?source=reddit`) so existing bookmarks survive.
  - JSON endpoints (`/reddit/items*`, `/reddit/subreddits`, `/reddit/stats`,
    `/reddit/unsave/*`) are untouched — they are first-class v3 APIs.
  - Deleted: `templates/{triage,reddit}.html`, `static/{triage,reddit}.js`,
    `static/{reddit,app,tokens}.css`, and the obsolete
    `scripts/wp2_t29_css_audit.py` (one-off app.css audit).
  - KEPT `static/haptics.js` (deck mode uses it) and `static/core/tokens.css`
    (what `index.html` actually loads).
  - `sw.js CACHE` `ch-shell-v116` → `ch-shell-v117` (SHELL pruned of the
    deleted entries + the `/triage` and `/reddit` nav URLs).
  - `browse/main.js APP_VERSION` v116 → v117 in lockstep.
  - `index.html` TRIAGE buttons now point straight at `/?deck=1`.
  - Tests: +`test_legacy_triage_and_reddit_pages_redirect_to_v3`,
    −`test_reddit_page_renders`, sw.js expectations refreshed. Net 0 →
    1008 still green.

## Next 1-3 actions (in order)
1. **Review the bakeoff run branches** for the winning models — spot-check
   minimax-m3's CH-B4 fix (the highest-quality diff I saw; correctly uses
   the canonical FTS5 rebuild + preserves `tags_auto`) and deepseek-v4-flash's
   CH-B1 fix. Cherry-pick any that should land on `main`.
2. **Real-device Pixel-6 QA** of deck mode + subreddit facet + the redirects
   (visit `/triage` and `/reddit` from an old bookmark to confirm the 302
   lands on the right v3 surface). Playwright UI suite is current; run it
   on a machine with `pip install -e .[ui] && playwright install chromium`
   before sign-off.
3. **Push to a PRIVATE repo** (user requested). Currently `origin` =
   `asmartin-ai/content-hoarder` is PUBLIC. Plan: create a private remote,
   push there; clean up public/private split per the cleanup plan.

## Open decisions (need user)
- Pick the private remote target + scope (full history vs. source-only orphan).
- Pick `<DEST>` drive for media mirror (spec 10).
- Pick representative item + auth posture for video smoke (spec 11).
- Real-device Pixel-6 QA pass for the mobile changes (issues #35-#48) +
  P3.1 deck gestures, P3.3 subreddit facet, and P3.5 redirects.
- Adopt the bakeoff winner (`minimax/minimax-m3` for cost, `deepseek-v4-flash`
  for reliability) as the default `aider-delegate` lane for future delegations?

## Icebox
- #72 Life-OS fixtures — real T1, needs Life-OS contract work; defer.
- P2.1/P2.2 engagement Phase 1 — depends on user flipping
  `learn-triage --apply` (their switch, deferred once already).
- Live media/archive/unsave runs — all user-gated (§7).
- PKMS cross-substrate bakeoff check — run the same model comparison on the
  PKMS substrate to confirm the routing table (per bakeoff plan §3).
- **iPhone installability (planned feature).** Make the app installable by a
  friend on **iOS Safari** (not just Android Chrome). iOS caveats: no
  `beforeinstallprompt`, no custom Install button (our `index.html` Install
  flow is Chrome/Android-specific), and standalone PWA support is partial
  (viewport/hide-safari-UI works via manifest, but no install prompt). Likely
  path: (a) ensure manifest + `apple-mobile-web-app-*` meta + same-origin
  served for offline; (b) document the "Add to Home Screen" flow; (c) evaluate
  a lightweight hosted instance vs. local LAN (Tailscale) since iOS needs a
  reachable URL — iOS cannot install from `localhost`/`127.0.0.1`. Scoping
  deferred until after P3.5 QA + the private-repo cleanup.
