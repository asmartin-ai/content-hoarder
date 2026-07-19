# NEXT.md — content-hoarder session focus

`feat/ios-splash-screens` branch, ready to merge. Suite: **1038 unit + 4 new PWA splash tests green.** (2026-07-19)

## Just done (2026-07-19 session, iOS splash screens + media mirror + Spec 10/11)
- **iOS splash screens IMPLEMENTED** on `feat/ios-splash-screens`:
  - `scripts/gen_splash_screens.py` (new, ~95 lines): reads
    `manifest.webmanifest::background_color` (#0f1115) and emits 11 solid-color
    `apple-touch-startup-image-<WxH>.png` files for every shipping iPhone + iPad.
    Total ~133 KB (solid color compresses extremely well).
  - `templates/index.html`: 11 `<link rel=apple-touch-startup-image>` tags, each
    with a `media="(device-width: Npx) and (device-height: Npx) and
    (-webkit-device-pixel-ratio: N)"` query so iOS picks the right one per device.
  - `static/sw.js`: SHELL gains 11 splash URLs; CACHE v123→v124 in lockstep.
  - `static/browse/main.js`: APP_VERSION v123→v124.
  - `tests/test_pwa_meta.py`: 4 new regression tests — splash link tags present
    for every shipped size, every media query has `-webkit-device-pixel-ratio`,
    every image served at the declared pixel dimensions (PNG IHDR decode), and
    every image matches the manifest's `background_color` corner+center.
  - `tests/test_service_worker.py` + `tests/test_subreddit_facet.py`:
    version-bump guards updated to v124.
  - **Test suite: 1038 unit + 4 new PWA tests = 1038 + 4 (within PWA test file) all green.**
  - `pyproject.toml` does NOT need a new dep — `Pillow` was already a transitive
    dev dep; the generator script is committed under `scripts/` for re-runs.
  - Generator emits RGB PNG (not RGBA) — solid color + no alpha channel is
    smaller and matches what iOS expects.
  - iOS launch image policy: solid color matching `background_color` is the
    spec-correct pattern (Apple renders the icon itself on top of the launch
    image, so the image does NOT need a logo).
- **Media mirror SET UP** (Spec 10 implementation, per user direction):
  - `K:\MediaMirror\` created on the K: drive root.
  - `scripts/mirror-media.bat` (robocopy /MIR /MT:16 /R:2 /W:5, append log)
    mirrors `K:\Projects\content-hoarder\data\media\` →
    `K:\MediaMirror\content-hoarder\media\`.
  - `scripts/verify-mirror-media.bat` re-hashes every dest file and compares
    to its filename (the source is content-addressed, so the filename IS the
    expected sha256 — free integrity check).
  - `docs/specs/10-media-backup.md`: ✅ CHOSEN `<DEST>` = `K:\MediaMirror\content-hoarder\media\`.
    Tradeoff accepted: same-drive mirror does NOT protect against K: drive
    failure (tier-2 of the spec's "Target drive/host" section remains an open
    escalation if the threat model widens).
  - Threat model per user: "accidental deletion / corruption", LAN-only,
    single-user. Not "the K: drive dies".
  - Scheduling: manual-after-archive (lowest risk, matches the "every action
    gated" posture). Scheduled task is a future option.
- **Spec 11 OAuth + rate-limit decisions** (per user direction):
  - ✅ OAuth for any user-list-driven ops (saved-list sync, hydrate-batch).
    `REDDIT_OAUTH_CLIENT_ID` is configured (RedReader public installed-app id);
    run `python -m content_hoarder reddit-oauth --login` once to mint the
    refresh token.
  - For the `archive-media --videos` path, yt-dlp + browser cookies are
    sufficient (public `v.redd.it` URLs don't need auth). Pass
    `--cookies-from-browser chrome` to yt-dlp.
  - **No new `--video-throttle` flag** — operator passes
    `archive-media --throttle 2.0` for video runs (1s+ is plenty for
    yt-dlp's sub-request burst, vs the default 0.3s which is for images).
    Two flags that mean almost the same thing is a UX regression; keep
    the existing `--throttle` knob.
  - `docs/specs/11-video-archive-smoke.md`: open user decisions #2 (auth
    posture) and #3 (rate-limit) marked CHOSEN with the rationale.
- **Bakeoff routing table** (per user direction "note in LLM-dev"):
  - `C:/Users/Kenja/Documents/LLM-dev/bakeoffs/Content-Hoarder-Bakeoff-Routing-2026-07-19.md`
    written: TL;DR routing table for the `aider-headless-delegate` skill,
    discriminator task (CH-B3: 3-file wiring), caveats (ZenMux promo
    liveness, 2-run variance), and verdict verbatim.
  - **The skill itself is already up to date** (inspected
    `~/.claude/skills/aider-headless-delegate/SKILL.md` line 22-23, 462-473,
    M19) — all four "action item" checkboxes in the LLM-dev file are
    marked DONE. NEXT #3 was obsolete. The LLM-dev file is now the
    audit trail / decision rationale; the skill has the operational defaults.
  - Cross-substrate (vs PKMS) verdict still pending — flagged as the
    open item in the LLM-dev file.
## Just done (2026-07-19 session, #46 fastscroll merged)
- **#46 merged to main** (`90cc660`, `--no-ff`), pushed to both remotes,
  feature branch deleted, issue closed.
- **Additional fix:** rAF-deferred handle transform in `onScroll` — during
  rapid fling scroll the compositor outruns main-thread scroll events;
  deferring the transform write to `requestAnimationFrame` aligns it with
  frame boundaries so handle tracks the visual scroll position.
- **Suite: 1038 unit + 65 UI (9 fastscroll) all green.**
- **Doc cleanup:** kept `docs/bugs/46-*.md` and `docs/specs/46-*.md` as
  permanent design records; they document resolved decisions (option 2/3
  icebox items, Nova rework reasoning, scrub-load fix plan).
- **Note:** the original mobile-scrollbar spec (`docs/specs/mobile-scrollbar.md`)
  still describes the pre-rework edge-zone pill design — kept as record
  of what didn't ship; the bug doc at `docs/bugs/46-mobile-scrollbar.md`
  is the source of truth for what shipped.
- **Jitter polish IMPLEMENTED** on `feat/46-mobile-fastscroll`. 7 files changed:
  - `fastscroll.js`: freeze metrics snapshot at pointerdown (avoid per-frame
    getComputedStyle+scrollHeight reflow), defer layout() while dragging (guard
    + layoutPending flag), ResizeObserver for image-load height changes (reuses
    same rAF-coalesced scheduleLayout helper), `.dragging` class on bar during
    grab. ResizeObserver teardown in the returned cleanup closure.
  - `browse.css`: `.fastscroll-bar.dragging { transition: none }` kills the
    250ms opacity fade-in at grab; `transition: background 0.15s var(--ease)`
    on `.fastscroll-handle` softens the color flip; reduced-motion rule added
    for the handle.
  - `main.js` v122→v123 + `sw.js` CACHE v122→v123 in lockstep.
  - 2 new regression UI tests: `test_fastscroll_dragging_class_toggles` and
    `test_fastscroll_mid_drag_mutation_does_not_move_handle`. 9/9 fastscroll UI
    green (7 existing + 2 new).
  - 2 static guard tests bumped to v123.
  - Spec: `docs/specs/46-fastscroll-jitter-fix-spec.md`.
  - Audit: scout agent identified 8 candidate improvements; 5 jitter fixes
    shipped (B1-B4, B5), option 2/3 remain icebox, B6 (deck-mode teardown)
    deferred as not blocking.
- **Delegation decision:** aider-delegate MCP timed out (known issue M23),
  LM Studio had no models loaded. Per 2026-07-14 delegation-worthiness gate,
  this is a deterministic transform (exact bytes known) → edited directly.
- **Suite: 1038 unit + 65 UI all green.**

## Just done (2026-07-14 session, #46 fastscroll fix + port)
- **Fastscroll track-offset bug fixed** on `staging/test-stack-2026-07-12`
  (`7c4bbfa`) then **ported to `feat/46-mobile-fastscroll`** (`7ec9030`) — the
  branch was still the old hidden-pill version; now has the Nova rework + fix,
  parity with staging. **#46 is PR-ready.**
  - Root bug: `fastscroll.js` read `--fastscroll-track-top/-bottom` off
    `documentElement` but `browse.css` defines them on `.fastscroll-bar` (custom
    props don't propagate up) → both parsed 0, handle drifted ~120px below track.
    Fix = read from the bar. Plus guarded `setPointerCapture` (NotFoundError on
    fast tap aborted scrub — caught by a new regression test), 22px hit target,
    rAF-coalesced MutationObserver, onResize teardown fix.
  - Branch shell v120→v121; 2 new regression UI tests (handle-in-track,
    track-tap-maps-full-range). 1036 unit + 6 fastscroll UI green.
- **Delegation postmortem** (aider-delegate MCP kept timing out): notes +
  fix plan in `~/Documents/LLM-dev/{investigations,stack-planning}/*2026-07-14*`.
  A separate session is assigned to implement the plan. Memory:
  `delegation-async-friction`.
- **Next for #46:** open the PR to main (order: #76→#77→#75, then #46);
  reviewer may re-bump the shell version relative to main's tip.
- **Scrub → `/items` cascade FIXED** (`e43854f`, shell v122): pause infinite
  scroll while scrubbing + one catch-up load on `fastscroll:settle`. Plan
  `docs/specs/46-fastscroll-scrub-loads-plan.md`. UI tests: 7/7 green.
  Device check still on user (network panel). Jitter polish stays **Fable 5**.
- **CLIProxyAPI :8317 left running** (user-confirmed; SuperGrok trial to Jul 18).

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
1. **Merge `feat/ios-splash-screens` to main** (this session's work, ready).
2. **Real-device Pixel-6 QA**: deck mode + subreddit facet + redirects. Needs user
   hardware. (iPhone PWA test deferred — user will test when ready.)
3. **Run first media mirror** (the new `scripts/mirror-media.bat` against
   `K:\MediaMirror\`, then `verify-mirror-media.bat`). User-gated (the user
   triggers each archive-media pass).
4. **Spec 11 video-archive smoke**: pick a representative v.redd.it item
   (the `LIMIT 5` query in `docs/specs/11-video-archive-smoke.md`), then
   `python -m content_hoarder archive-media --videos --limit 1 --apply --yes`
   against a DB copy. User-gated (first live run).

## Recently obsoleted
- **Item 3 from previous Next (update `aider-headless-delegate` skill with
  the user's chosen delegation lanes)** — skill at
  `~/.claude/skills/aider-headless-delegate/SKILL.md` is already up to date
  (verified 2026-07-19; lines 22-23, 462-473, M19). The LLM-dev routing-table
  note `C:/Users/Kenja/Documents/LLM-dev/bakeoffs/Content-Hoarder-Bakeoff-Routing-2026-07-19.md`
  is the audit trail / decision rationale; the skill has the operational
  defaults.

## Cherry-pick audit (2026-07-11) — no-op, already landed
- The 4 bakeoff oracle features were committed **directly to main** during
  the bakeoff session (commits `dcccc2c`, `248be11`, etc.), not left on
  run branches. All 21 oracle tests pass on main. Nothing to cherry-pick.
- Cleaned up 7 stale `delegated/run-*` local branches (all from a later
  LM-Studio qwen3-coder experiment, not the cloud bakeoff winners).

## Open decisions (need user)

### Spec 10 — Media mirror (partially resolved 2026-07-19)
- ✅ **Pick `<DEST>` drive** — CHOSEN: `K:\MediaMirror\content-hoarder\media\`
  (same drive; threat model is accidental delete / corruption, not drive
  failure). See `scripts/mirror-media.bat` + `scripts/verify-mirror-media.bat`.
- Manual-after-archive vs scheduled-weekly? (Recommended: manual, matches
  the existing gating posture.)
- Second mirror to a tailnet peer? (Default: no.)
- Tier-2 escalation (separate physical drive / external USB-C SSD) is
  available if the threat model widens.

### Spec 11 — Video archive smoke (auth + rate-limit resolved 2026-07-19)
- ✅ **OAuth or cookies?** — CHOSEN OAuth for user-list-driven ops; yt-dlp
  + browser cookies for the `archive-media --videos` smoke (public
  `v.redd.it` URLs don't need auth).
- **Pick a representative candidate.** Run the `LIMIT 5` query from the spec to
  find a `v.redd.it` item that's recent enough to still be served.
- yt-dlp + ffmpeg installed? Run the pre-flight check first.

### Ongoing
- Real-device Pixel-6 QA for mobile changes (deck gestures, subreddit facet,
  redirects, **iOS splash screens** — the new feature from this session).

## Icebox
- #72 Life-OS fixtures — real T1, needs Life-OS contract work; defer.
- P2.1/P2.2 engagement Phase 1 — depends on user flipping
  `learn-triage --apply` (their switch, deferred once already).
- iPhone PWA real-device test — deferred; user will test when ready.
- iOS splash screen images (`apple-touch-startup-image`) — **DONE 2026-07-19**;
  see "Just done" above.
