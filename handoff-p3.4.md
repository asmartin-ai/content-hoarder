# Handoff — content-hoarder post-P3.1 + P3.3

Paste this at the top of the next session.

## Repo state

- Branch: `main`, 18 commits ahead of `origin/main`, NOT pushed (user-gated
  per DIRECTION §7 — never push without sign-off).
- Tree clean except for this handoff file. Suite: **1008 passed**
  (`python -m pytest`). UI suite separate: `pytest -m ui` (needs Playwright;
  not installed in last sandbox — UI tests `importorskip` it gracefully).
- CWD: `K:\Projects\content-hoarder`. Run via `python -m content_hoarder <cmd>`.
- Read `AGENTS.md` + `docs/specs/12-unify-one-surface.md` + `NEXT.md`
  BEFORE editing.

## What just shipped (2026-07-04, P3.1 + P3.3)

- **Spec 12 doc fix** (`4bb017c`): superseded stale "density toggle" row
  with a `Corrected 2026-07-04` note; P3.2 marked no-work.
- **P3.1 deck mode** (`031e44c`, merged `9a7df73`): `?deck=1` mode of `/`.
  New `static/browse/deck.js` (DI-injected, Node-unit-tested). Decision
  keys `s/e/y/u/z/Space` + arrows gated on `state.deck`. Dock-deck button
  + settings-panel button + popstate sync + pushState on toggle. Wires
  `core/swipe.js` + `haptics.js` + snackbar undo. CACHE/APP_VERSION → v115.
  8 new tests (offline keymap + served-static guards + Playwright UI reg).
- **P3.3 subreddit facet** (merged): second-tier rail under reddit source.
  When `source=reddit`, rail fetches `/reddit/subreddits` (status-scoped)
  and renders subreddit chips; click → `state.subreddit` → `/items?subreddit=`
  (operator already existed in `search_query.py`). Auto-clears on leaving
  reddit. CACHE/APP_VERSION → v116. 3 new tests.

## Delegation note

- MiniMax-M2.7 IS available on OpenModel (`api.openmodel.ai/v1/models`).
- **`delegate_to_aider` is currently blocked** for new-file work: it
  refuses unlisted paths in `editable_files` ("editable_files not found
  in repo") AND the MCP wrapper times out at 30s regardless of
  `timeout_seconds`. P3.1 + P3.3 were implemented directly with the
  delegation spec archived at `delegation/P3.1-deck-mode.md`. If a future
  session wants to delegate again, either (a) pre-create the new files
  yourself then delegate only edits, or (b) patch the delegate tool.

## Non-obvious things to know

- **Deck keymap is gated, not merged.** `state.deck && deck.key(e, state)`
  at the TOP of the keydown handler (after typing-target check). When
  deck is off, list-mode `s`/`e`/`y` keep working. Don't merge the maps.
- **`state.subreddit` is reddit-only.** The click handler clears it
  whenever `state.source` becomes non-reddit. Don't add a subreddit chip
  to non-reddit sources.
- **CACHE/APP_VERSION are now at v116.** The P3.1 static test uses a
  `>=115` floor (not a hard `==v115`) so subsequent bumps don't trip it.
  Future packets: bump both in lockstep per the standing rule.
- **Playwright UI tests are written but unrunnable** in the last sandbox
  (`importorskip` skips them). Run them on a machine with
  `pip install -e .[ui] && playwright install chromium` before signing
  off on P3.1 deck gestures or P3.3 facet on a real Pixel 6.

## Next 1-3 actions (in order)

1. **P3.5 legacy retirement** — execute spec 12 §2 checklist in one
   deliberate pass: delete `/triage` + `/reddit` PAGE routes from
   `web.py` (keep the JSON endpoints — reader + scripts consume them);
   strip `sw.js` SHELL entries for `/triage`, `/reddit`, `/static/app.css`,
   `/static/triage.js`, `/static/reddit.css`, `/static/reddit.js`; delete
   the template + asset files; KEEP `/static/haptics.js` (deck uses it)
   and `/static/tokens.css` only if `index.html` still loads it (VERIFY
   FIRST — `templates/index.html` should load `core/tokens.css` instead).
   Add 302 redirects `/triage` → `/?deck=1` and `/reddit` → `/?source=reddit`.
   Bump CACHE + APP_VERSION together.
2. **Real-device Pixel-6 QA** of the P3.1 deck gestures + P3.3 facet.
3. **Push 18 local commits** to `origin/main` (user-gated).

## Constraints (verbatim, in effect)

- Never commit `*.db`, exports, Takeout dumps, or `.env`. Only synthetic fixtures.
- Never expose the web app to the public internet (Tailscale/LAN only).
- Keep tests offline and deterministic.
- Never touch live data: `data/app.db`, `data/media/`, `data/*.backup-*`,
  audit logs, `.env`, `nsfw_rules.json`.
- Destructive/network commands (delete, purge-done, decay --apply,
  bankruptcy, reddit-unsave --drain/--live, reddit-sync, hn-sync,
  enrich --archives, archive-media --apply, scan-media --apply,
  reddit-hydrate --network) are NEVER run by an agent.
- CACHE + APP_VERSION bump in lockstep on every shippable UI change.

## Git workflow

- Branch off `main` per packet (e.g. `feat/p3.5-legacy-retirement`).
- Commit subject ≤50 chars, imperative, no trailing period. Body wrapped 72.
- Merge to main locally after suite green (user said "merge as you see fit").
- Do NOT push to origin without explicit sign-off.

## First concrete action

`git checkout -b feat/p3.5-legacy-retirement main`, then read
`docs/specs/12-unify-one-surface.md` §2 (the retirement checklist) and
verify whether `templates/index.html` loads `/static/tokens.css` or
`/static/core/tokens.css` before deleting the root one. Then delete the
legacy routes + assets in one commit, add the 302 redirects in a second,
bump CACHE + APP_VERSION.
