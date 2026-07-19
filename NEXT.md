# NEXT.md — content-hoarder session focus

`main`. Suite: **1038 unit green**; CI: passing on `main` (see `gh run list`).
Last wrapup: 2026-07-19.

## Just done (2026-07-19 session, splash + mirror + Spec 10/11 + CI fix)
- **iOS splash screens SHIPPED** on `main` (merged `e48c47e`, CI green on `8067e1b`):
  - `scripts/gen_splash_screens.py` (new): reads `manifest.webmanifest::background_color`
    (#0f1115) and emits 11 solid-color `apple-touch-startup-image-<WxH>.png` files
    for every shipping iPhone + iPad (~133 KB total).
  - `templates/index.html`: 11 `<link rel=apple-touch-startup-image media=...>`
    tags with device-width/height/dpr queries so iOS picks the right one.
  - `static/sw.js`: SHELL gains 11 splash URLs; CACHE v123→v124 in lockstep.
  - `static/browse/main.js`: APP_VERSION v123→v124.
  - `tests/test_pwa_meta.py`: 4 new regression tests (link tags present, media
    query has `-webkit-device-pixel-ratio`, served images at correct pixel
    dimensions via stdlib `struct` PNG IHDR decode, on-disk images match
    `manifest::background_color` at corner+center via Pillow).
  - `tests/test_service_worker.py` + `tests/test_subreddit_facet.py`:
    version-bump guards updated to v124.
  - `pyproject.toml`: added `Pillow` to `[project.optional-dependencies].dev`
    (CI fix in `8067e1b` — the color-mismatch test needs Pillow; the IHDR
    decode test uses stdlib only).
- **Media mirror SET UP** (Spec 10 implementation):
  - `K:\MediaMirror\content-hoarder\media\` is the chosen `<DEST>`.
  - `scripts/mirror-media.bat` (robocopy /MIR /MT:16 /R:2 /W:5, append log).
  - `scripts/verify-mirror-media.bat` re-hashes every dest file and compares to
    its filename (filename IS sha256; free integrity check).
  - Tradeoff accepted: same-drive mirror protects against accidental delete /
    corruption, not drive failure (user's stated threat model).
  - `docs/specs/10-media-backup.md`: DEST marked CHOSEN.
- **Spec 11 OAuth + rate-limit decisions** (per user direction):
  - OAuth for user-list-driven ops; `REDDIT_OAUTH_CLIENT_ID` configured.
  - yt-dlp + browser cookies for `archive-media --videos` smoke (public
    `v.redd.it` URLs don't need auth).
  - **No new `--video-throttle` flag** — operator passes
    `archive-media --throttle 2.0` for video runs (default 0.3s is for images).
  - `docs/specs/11-video-archive-smoke.md`: decisions #2 (auth) and #3
    (rate-limit) marked CHOSEN.
- **Bakeoff routing table** (Next #3, resolved obsolete):
  - `C:/Users/Kenja/Documents/LLM-dev/bakeoffs/Content-Hoarder-Bakeoff-Routing-2026-07-19.md`
    written: routing table, CH-B3 discriminator, caveats, verdict verbatim.
  - The `aider-headless-delegate` skill was already current (inspected
    `~/.claude/skills/aider-headless-delegate/SKILL.md`); LLM-dev file is now
    the audit trail / decision rationale.
  - Cross-substrate (vs PKMS) verdict still pending — open item in the LLM-dev file.
- **#46 mobile fastscroll** (also done this session, before splash):
  - Merged to main (`90cc660`, `--no-ff`); issue closed; rAF-deferred
    `onScroll` handle transform shipped in `b24903a`.
- **CI fix** (`8067e1b`): Pillow added to dev deps (see above).

## Next 1-3 actions (in order)
1. **Real-device Pixel-6 + iPhone QA**: deck gestures, subreddit facet, redirects,
   iOS splash screens (the new feature — first launch on a real device). User-gated.
2. **Spec 11 video-archive smoke** (user-gated first live run):
   `python -m content_hoarder archive-media --videos --limit 1 --apply --yes`
   against a DB copy of `data/app.db`. Spec 11 has the full procedure.
3. **Run first media mirror** (user-gated): `scripts/mirror-media.bat` against
   `K:\MediaMirror\`, then `scripts/verify-mirror-media.bat`. Re-runnable.
4. **Synthetic-corruption test for verify-mirror-media.bat** (CONSIDER from
   harvest Q2). Untested against real corruption; a 10-line pytest that writes
   a dest file with one flipped byte, then asserts the verify script reports
   MISMATCH, would harden it. ~S effort.

## Open decisions (need user)

### Spec 10 — Media mirror (partially resolved 2026-07-19)
- ✅ **Pick `<DEST>` drive** — CHOSEN: `K:\MediaMirror\content-hoarder\media\`.
- Manual-after-archive vs scheduled-weekly? (Recommended: manual, matches the
  existing gating posture.)
- Second mirror to a tailnet peer? (Default: no.)
- Tier-2 escalation (separate physical drive / external USB-C SSD) is available
  if the threat model widens.

### Spec 11 — Video archive smoke (auth + rate-limit resolved 2026-07-19)
- ✅ **OAuth or cookies?** — CHOSEN OAuth for user-list-driven ops; yt-dlp +
  browser cookies for the `archive-media --videos` smoke.
- **Pick a representative candidate.** Run the `LIMIT 5` query in the spec.
- yt-dlp + ffmpeg installed? Run the pre-flight check first.

### Ongoing
- Real-device Pixel-6 + iPhone QA for mobile changes (now including the new
  iOS splash screens).

## Recently obsoleted
- **Update `aider-headless-delegate` skill with the bakeoff's delegation lanes**
  (was Next #3) — skill was already current (verified 2026-07-19; lines 22-23,
  462-473, M19). The LLM-dev routing-table note
  (`C:/Users/Kenja/Documents/LLM-dev/bakeoffs/Content-Hoarder-Bakeoff-Routing-2026-07-19.md`)
  is the audit trail / decision rationale; the skill has the operational defaults.
- **`aider-delegate` MCP delegation for the splash + jitter work** (a 2026-07-14
  issue) — known to time out (M23); LM Studio had no models loaded; per the
  2026-07-14 delegation-worthiness gate, this is a deterministic transform
  (exact bytes known) → edited directly. Decision validated by the same task's
  history (3 dead sessions on #46 fastscroll; direct took minutes).

## Cherry-pick audit (2026-07-11) — no-op, already landed
The 4 bakeoff oracle features were committed **directly to main** during the
bakeoff session (commits `dcccc2c`, `248be11`, etc.), not left on run branches.
All 21 oracle tests pass on main. Nothing to cherry-pick. Cleaned up 7 stale
`delegated/run-*` local branches (all from a later LM-Studio qwen3-coder
experiment, not the cloud bakeoff winners).

## Icebox
- #72 Life-OS fixtures — real T1, needs Life-OS contract work; defer.
- P2.1/P2.2 engagement Phase 1 — depends on user flipping `learn-triage --apply`
  (their switch, deferred once already).
- iPhone PWA real-device test — deferred; user will test when ready.
- Cross-substrate bakeoff check (PKMS) — pending PKMS verdict.

---

## Session archive (one line each, by date)

| Date | Session summary | Spec / ref |
|---|---|---|
| 2026-07-19 | iOS splash screens + media mirror + Spec 10/11 decisions + #46 merge + CI Pillow fix | this file's "Just done" |
| 2026-07-19 | #46 mobile fastscroll merged (rAF-deferred onScroll handle transform) | `docs/bugs/46-*.md`, `docs/specs/46-*.md` |
| 2026-07-14 | #46 fastscroll fix + port (track-offset bug, scrub-load cascade pause) | `docs/specs/46-fastscroll-scrub-loads-plan.md` |
| 2026-07-12 | iOS PWA installability (Spec 13): 5 Apple meta tags, /sw.js root-scope, --tls flag, mkcert setup | `docs/specs/13-ios-pwa-installability.md` |
| 2026-07-11 | Public/private remote sync (135 commits), `publish_safety_check.py` test-fixture exclusion | `PUBLISH-SAFETY.md` |
| 2026-07-11 | Fix 2 pre-existing RED UI tests (subreddit facet + relay menu labels) — `desktop_page` switch + 480px compact breakpoint | `tests/ui/test_subreddit_facet.py`, `browse.css` |
| 2026-07-07 | Wrap-up hygiene: bakeoff WIP archived; pre-existing UI failures kept out of P3.5 | `archive/bakeoff-arm-wip` |
| 2026-07-05 | content-hoarder bakeoff complete: 80 runs / 4 tasks / 10 models, T3 winner `minimax/minimax-m3` (q2c=347), Pro tier not worth ~3× | `bakeoff/RESULTS.md`, `bakeoff/STATUS-REPORT.md` |
| 2026-07-04 | P3.5 legacy retirement: /triage + /reddit page routes → 302 redirects; CSS+JS deleted; v3 is one surface | `docs/specs/12-unify-one-surface.md` |
