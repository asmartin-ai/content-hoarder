# NEXT.md — content-hoarder session focus

`main` pushed to both remotes. Suite: **1036 unit + 65 UI = 1101 passing.** (2026-07-12)

## Just done (2026-07-12 session, iOS PWA installability)
- **Spec 13 IMPLEMENTED** on `feat/ios-pwa` branch. 7 files changed:
  - `templates/index.html`: 5 Apple/mobile meta tags (`apple-mobile-web-app-capable`,
    `status-bar-style=black-translucent`, `apple-mobile-web-app-title=Hoarder`,
    `apple-touch-icon` link) + theme-color fix (`#101216` → `#0f1115`).
  - `static/apple-touch-icon.png`: 180×180 icon generated from `icon.svg`.
  - `web.py`: new `/sw.js` route with `Service-Worker-Allowed: /` header (fixes
    the root-scope SW bug that prevented offline nav fallback on ALL platforms).
  - `static/browse/main.js`: SW registration moved to `/sw.js` with
    `{scope: "/"}`; APP_VERSION v118 → v119.
  - `static/sw.js`: CACHE v118 → v119; `apple-touch-icon.png` added to SHELL.
  - `cli.py` + `config.py`: `--tls` flag + `CONTENT_HOARDER_TLS` env var for
    mkcert-backed HTTPS serving (required for iOS PWA install).
  - `tests/test_pwa_meta.py` (+79 lines, new), `tests/test_service_worker.py`
    (+3 tests), `tests/test_subreddit_facet.py` (version bump fix).
  9 spec-13 oracle tests all green. Full suite: 1036 unit + 65 UI passing.
- **iPhone setup:** `mkcert -install && mkcert -cert-file cert.pem -key-file key.pem
  0.0.0.0 localhost <tailscale-ip> <tailscale-hostname>`, then
  `python -m content_hoarder serve --host 0.0.0.0 --tls`. Install mkcert CA on
  iPhone, navigate to `https://<tailscale-hostname>:8788`, Share → Add to Home Screen.

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

## Just done (2026-07-11 session, public/private mirror)
- **Both remotes now in sync** at `47d23e9`. Private (`content-hoarder-private`)
  was already current; public (`origin` = `content-hoarder`) caught up 135
  commits. Going forward: **both remotes mirror the same history**; the
  `publish_safety_check.py` scan is the gate before every push.
- **Scanner false-positive fixed:** `publish_safety_check.py` was flagging its
  own test fixtures (real-shaped AWS key + PEM in `test_publish_safety.py`).
  Added a `tests/` exclusion to `scan_content`. Tree + `--history` both clean.
- **PUBLISH-SAFETY.md posture updated:** single shared history, mirrored to
  public + private. No allowlist/sanitization step needed (sensitive material
  is path-level gitignored, never scrubbed).

## Just done (2026-07-11 session, fix 2 RED UI tests)
- **Both pre-existing RED UI tests fixed + merged to main** (`5534fa0`),
  pushed to both remotes. Branch `feat/fix-ui-preregression` merged via
  `--no-ff`.
  - `test_subreddit_facet_drills_down`: the `.rail` is `display:none`
    below 700px (mobile uses `.navdrawer`). Test was written against
    desktop markup but ran on the mobile fixture → switched to
    `desktop_page`.
  - `test_relay_menu_labels_…`: 6 relay buttons at 64px `min-width`
    overflowed the 412px Pixel-6 viewport by 62px. Raised the compact
    breakpoint from 360px→480px, tightened gap (8→4px) + padding
    (24→16px). Now fits with room to spare.
  - Bumped sw.js CACHE + APP_VERSION v117→v118.
- **Suite: 1029 unit + 65 UI all green.** Playwright installed on this
  machine (`pip install -e .[ui] && playwright install chromium`).

## Just done (2026-07-07 session, wrap-up hygiene)
- **Bakeoff WIP archived off main.** The three uncommitted files
  (`NEXT.md`, `bakeoff/STATUS-REPORT.md`, `scripts/bakeoff_arm.py`) were parked
  on `archive/bakeoff-arm-wip`; main reverted to a clean tree ahead of the
  P3.5 merge. Nothing pushed.
- **Pre-existing UI failures kept out of P3.5.** The 2 Playwright failures
  (`test_subreddit_facet_drills_down`, `test_relay_menu_labels_…`) are
  confirmed pre-existing on main — they get a dedicated `feat/fix-ui-preregression`
  branch, not folded into the retirement packet.
- **Deferred by user:** private-repo push, Pixel-6 QA pass, and the fix branch.
  P3.5 is merged locally; nothing pushed.

## Next 1-3 actions (in order)
1. **Real-device QA**: iPhone (install via HTTPS + Add to Home Screen, offline launch)
   + Pixel-6 (deck mode + subreddit facet + redirects). Needs user hardware.
2. **Decide on bakeoff-winner adoption** for the default `aider-delegate`
   lane (`minimax/minimax-m3` for cost, `deepseek-v4-flash` for reliability).
3. **Pick the next feature to build.** Housekeeping is done, iOS PWA shipped.
   Open specs: media mirror (spec 10), video archive smoke (spec 11). Or a new
   direction the user chooses.

## Cherry-pick audit (2026-07-11) — no-op, already landed
- The 4 bakeoff oracle features were committed **directly to main** during
  the bakeoff session (commits `dcccc2c`, `248be11`, etc.), not left on
  run branches. All 21 oracle tests pass on main. Nothing to cherry-pick.
- Cleaned up 7 stale `delegated/run-*` local branches (all from a later
  LM-Studio qwen3-coder experiment, not the cloud bakeoff winners).

## Open decisions (need user)
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
- iOS splash screen images (`apple-touch-startup-image`) — deferred until
  after initial iPhone PWA testing; cosmetic only.
