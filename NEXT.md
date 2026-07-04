# NEXT.md — content-hoarder session focus

`main` is 20 commits ahead of `origin/main`. Not pushed (user-gated per §7).
Suite: **1008 passed**.

## Just done (2026-07-04 session, P3.5 legacy retirement)
- **P3.5 shipped** (spec 12 §2 — final packet of the W3 unify-one-surface
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
1. **Real-device Pixel-6 QA** of deck mode + subreddit facet + the redirects
   (visit `/triage` and `/reddit` from an old bookmark to confirm the 302
   lands on the right v3 surface). Playwright UI suite is current; run it
   on a machine with `pip install -e .[ui] && playwright install chromium`
   before sign-off.
2. **Merge `feat/p3.5-legacy-retirement` to main** locally (user said "merge
   as you see fit") — branch is currently 2 commits ahead of main.
3. **Push 20 local commits** to `origin/main`? (user-gated per §7)

## Open decisions (need user)
- Push the 20 local commits to `origin/main`? (user-gated per §7)
- Pick `<DEST>` drive for media mirror (spec 10).
- Pick representative item + auth posture for video smoke (spec 11).
- Real-device Pixel-6 QA pass for the mobile changes (issues #35-#48) +
  the new P3.1 deck gestures, P3.3 subreddit facet, and P3.5 redirects.

## Icebox
- #72 Life-OS fixtures — real T1, needs Life-OS contract work; defer.
- P2.1/P2.2 engagement Phase 1 — depends on user flipping
  `learn-triage --apply` (their switch, deferred once already).
- Live media/archive/unsave runs — all user-gated (§7).
- Delegate-tool unblock: file an issue / patch `delegate_to_aider` to
  allow new-file creation (it currently rejects unlisted paths AND the
  30s wrapper timeout prevents long tasks).
