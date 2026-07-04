# NEXT.md — content-hoarder session focus

Branch: `fix/w0-js-hardening` (6 commits ahead of `origin/main`). Not pushed.
All work merges into one branch this session; user reviews/merges.

## Just done (2026-07-03 session)
- **W0 hardening complete** (audit 2026-07-02 findings):
  - P0.1 SSRF gate — `safe_fetch_url()` in `_http.py` + wired into
    `media_archive.default_fetch` + `redgifs_resolver`. Caught+fixed port/
    userinfo bypass the delegate missed (parsed.hostname, not netloc).
  - P0.2 SW offline — `core/markdown.js` in SHELL, `.catch` fallbacks,
    CACHE+APP_VERSION v111→v113 in lockstep.
  - P0.3 staleness signal + reader AbortController + `folder_id` 400 +
    snooze clamp.
- **W1 specs (report-only)**: spec 10 (media backup, robocopy mirror),
  spec 11 (video-archive smoke plan).
- **W3 design gate**: spec 12 (unify-one-surface, cuts P3.1-P3.5).
- **#73 publish-safety**: `scripts/publish_safety_check.py` + boundary doc
  + tests. Working tree + git history both scan clean.
- Suite: 953 → **991 passed**, UI 67 passed.

## Next 1-3 actions (in order)
1. **Review + merge `fix/w0-js-hardening` to `main`** — 6 commits, all
   user-gated per §7. Verify the SSRF bypass fix manually first
   (`safe_fetch_url('http://127.0.0.1:80/x')` → `(False, "blocked_host")`).
2. **Decide the 4 P3.0 questions** (spec 12 §4): stats modal drop, deck
   route shape (`?deck=1`), subreddit facet placement, haptics keep.
3. **P3.1 deck mode** off `main` once merged — the load-bearing unification
   packet. New `static/browse/deck.js`, don't bloat main.js.

## Open decisions (need user)
- W3 §4 decisions (above) before any P3.1 code.
- Pick `<DEST>` drive for media mirror (spec 10).
- Pick representative item + auth posture for video smoke (spec 11).
- Real-device Pixel-6 QA pass for the mobile changes (issues #35-#48) — the
  UI suite catches structural regressions, not physical feel.

## Icebox
- #72 Life-OS fixtures — real T1, needs Life-OS contract work; defer.
- P2.1/P2.2 engagement Phase 1 — depends on P3.0 decisions + user flipping
  `learn-triage --apply` (their switch, deferred once already).
- Live media/archive/unsave runs — all user-gated (§7).
