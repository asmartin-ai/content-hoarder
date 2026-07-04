# NEXT.md — content-hoarder session focus

`main` is 18 commits ahead of `origin/main`. Not pushed (user-gated per §7).
Suite: **1008 passed**.

## Just done (2026-07-04 session, P3.1 + P3.3)
- **Spec 12 doc fix**: superseded the stale "Density toggle → Builds as
  density" row with a `Corrected 2026-07-04` note; marked P3.2 as no-work
  (v3 already ships `#set-density`). Commit `4bb017c` on main.
- **P3.1 deck mode shipped + merged** (`9a7df73`). `?deck=1` mode of `/`,
  one card at a time, driven by `/random`. Body in new
  `static/browse/deck.js` (DI-injected, unit-tested in Node). Wires
  `core/swipe.js` + `haptics.js` + `snackbar` undo. Decision keys
  `s/e/y/u/z/Space` + arrows active ONLY in deck mode (list-mode s/e/y
  unchanged). Dock-deck button + settings-panel button + popstate sync.
  CACHE/APP_VERSION v114 → v115. 8 new tests.
- **P3.3 subreddit facet shipped + merged**. Second-tier rail under the
  reddit source: when `source=reddit` active, rail fetches
  `/reddit/subreddits` (status-scoped) and renders subreddit chips;
  click filters via `source=reddit + subreddit=<name>` (the `subreddit:`
  operator already existed). `state.subreddit` auto-clears when leaving
  reddit. CACHE/APP_VERSION v115 → v116. 3 new tests.
- **Delegation tooling blocked**: `delegate_to_aider` refuses new files
  in `editable_files` (validates existence) and the wrapper times out at
  30s regardless of `timeout_seconds`. P3.1 + P3.3 were implemented
  directly; the spec lives at `delegation/P3.1-deck-mode.md` for the
  record. MiniMax-M2.7 IS available on OpenModel — the block is the
  delegate tool, not the model.

## Next 1-3 actions (in order)
1. **P3.4 audit is done** (per prior session); next is **P3.5 legacy
   retirement** — execute spec 12 §2 checklist: delete `/triage` +
   `/reddit` page routes (keep JSON), strip SHELL entries, delete
   `static/{triage.js,reddit.js,reddit.css,app.css,tokens.css (verify)}`,
   add 302 redirects (`/triage` → `/?deck=1`, `/reddit` → `/?source=reddit`).
   KEEP `/static/haptics.js` (deck uses it). One deliberate pass.
2. **Real-device Pixel-6 QA** of deck mode + subreddit facet — both ship
   untested on real hardware (Playwright not installed in sandbox; UI
   tests are in place for when it is).
3. **Push 18 local commits** to `origin/main`? (user-gated per §7)

## Open decisions (need user)
- Push the 18 local commits to `origin/main`? (user-gated per §7)
- Pick `<DEST>` drive for media mirror (spec 10).
- Pick representative item + auth posture for video smoke (spec 11).
- Real-device Pixel-6 QA pass for the mobile changes (issues #35-#48) +
  the new P3.1 deck gestures + P3.3 subreddit facet.

## Icebox
- #72 Life-OS fixtures — real T1, needs Life-OS contract work; defer.
- P2.1/P2.2 engagement Phase 1 — depends on user flipping
  `learn-triage --apply` (their switch, deferred once already).
- Live media/archive/unsave runs — all user-gated (§7).
- Delegate-tool unblock: file an issue / patch `delegate_to_aider` to
  allow new-file creation (it currently rejects unlisted paths AND the
  30s wrapper timeout prevents long tasks).
