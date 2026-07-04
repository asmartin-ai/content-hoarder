# NEXT.md — content-hoarder session focus

`main` is 11 commits ahead of `origin/main`. Not pushed (user-gated per §7).
Suite: **997 passed**.

## Just done (2026-07-04 session)
- **Merged to main**: `fix/w0-js-hardening` (W0 hardening + audit lows + #73
  publish-safety + spec 10/11/12) and `fix/audit-lows-coverage`
  (`config.validate()` startup warning + tests). Branches deleted.
- **P3.4 shipped**: reddit unsave now reachable in the v3 surface —
  per-item via the relay row-menu button (reddit-only, hidden when
  `is_saved == 0`) + bulk UNSAVE in the bulk tray (queues only reddit
  items with `is_saved !== 0`). Both queue locally; the existing
  `/reddit/unsave/drain` contacts Reddit. CACHE/APP_VERSION v113→v114.
- **P3.4 audit done**: thread sort parity confirmed — both `reader.js`
  and `reddit.js` expose best/top/new and persist under their own
  localStorage key. No gap.
- Spec 12 §1 row "Density toggle → Builds as density" is **stale**: v3
  ships `#set-density` (Ledger/Log/Pinboard = compact/comfortable/card).
  P3.2 needs no work; update spec when P3 cut is revised.

## Next 1-3 actions (in order)
1. **Answer the 4 P3.0 decisions** (spec 12 §4): stats modal drop,
   `?deck=1` vs `/deck`, subreddit facet placement, haptics keep.
2. **P3.1 deck mode** off `main` — load-bearing unification packet. New
   `static/browse/deck.js`, don't bloat main.js. Blocked on decision 2.
3. **P3.3 subreddit facet** — independent of P3.1 subject to the line-scope
   split. Blocked on decision 3.

## Open decisions (need user)
- W3 §4 decisions (above) before any P3.1/P3.3 code.
- Push the 11 local commits to `origin/main`? (user-gated per §7)
- Pick `<DEST>` drive for media mirror (spec 10).
- Pick representative item + auth posture for video smoke (spec 11).
- Real-device Pixel-6 QA pass for the mobile changes (issues #35-#48).

## Icebox
- #72 Life-OS fixtures — real T1, needs Life-OS contract work; defer.
- P2.1/P2.2 engagement Phase 1 — depends on P3.0 decisions + user flipping
  `learn-triage --apply` (their switch, deferred once already).
- P3.5 legacy retirement — lands last, after P3.1 + P3.3.
- Live media/archive/unsave runs — all user-gated (§7).
