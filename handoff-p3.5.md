# Handoff — content-hoarder P3.5 (legacy retirement) — DONE

P3.5 executed in one deliberate pass on `feat/p3.5-legacy-retirement`
(two commits ahead of `main`). Suite green at **1008 passed** (net 0:
one redirect test added, one page-render test removed). Not merged to
main yet; not pushed (user-gated per §7).

## What landed

### Step 1 — Routes + redirects (`dbe3c1c`)
- `web.py`: `/triage` and `/reddit` page-render routes replaced with
  **302** redirects:
  - `/triage` → `/?deck=1`
  - `/reddit` → `/?source=reddit`
- JSON endpoints **untouched** (they're first-class v3 APIs now):
  `/reddit/items*`, `/reddit/items/<fn>/thread`, `/reddit/subreddits`,
  `/reddit/stats`, `/reddit/unsave/*`.
- `from flask import … redirect …` added.
- New test `test_legacy_triage_and_reddit_pages_redirect_to_v3` asserts
  both 302s and their `Location` suffixes.

### Step 2 — Asset deletion + version bumps (`77438e1`)
- **Deleted** (8 files):
  - `templates/triage.html`, `templates/reddit.html`
  - `static/triage.js`, `static/reddit.js`
  - `static/reddit.css`, `static/app.css`
  - `static/tokens.css` (root copy — `index.html` loads
    `/static/core/tokens.css`; verified before deletion)
  - `scripts/wp2_t29_css_audit.py` (one-off app.css audit, obsolete)
- **KEPT** `static/haptics.js` (deck mode uses it).
- `sw.js`: `CACHE` `ch-shell-v116` → `ch-shell-v117` with comment
  `// v117: P3.5 legacy retirement`. SHELL pruned of `/triage`, `/reddit`,
  `/static/tokens.css`, `/static/app.css`, `/static/triage.js`,
  `/static/reddit.css`, `/static/reddit.js`.
- `browse/main.js`: `APP_VERSION` `v116` → `v117`.
- `index.html`: the two in-app TRIAGE buttons now point straight at
  `/?deck=1` (don't rely on the 302).
- Tests refreshed:
  - `test_service_worker.py`: asserts retired URLs/assets are GONE from
    SHELL; haptics.js + core/tokens.css remain; still iterates SHELL
    and 200s every URL.
  - `test_subreddit_facet.py`: APP_VERSION/CACHE expectations → v117.
  - `test_reddit_view.py`: dropped `test_reddit_page_renders` (page
    retired; the JSON-endpoint tests in the same file all still pass).

## Done-when checklist (all confirmed)
- [x] `/triage` and `/reddit` page routes gone; both return 302 to the v3
      equivalent.
- [x] JSON endpoints (`/reddit/items*`, `/reddit/subreddits`, `/reddit/stats`,
      `/reddit/unsave/*`) all still 200 (covered by `test_reddit_view.py` +
      `test_subreddit_facet.py` + `test_web.py`).
- [x] Legacy template + asset files deleted (except haptics.js, and
      tokens.css — index.html loads the core/ copy, not root).
- [x] `sw.js CACHE` + `main.js APP_VERSION` both at v117.
- [x] `python -m pytest` green (1008 passed, no JSON-endpoint regression).

## Not done (intentional)
- **Merge to main**: branch is 2 commits ahead; user said "merge as you
  see fit" but the handoff task explicitly said ONE pass with ONE commit
  per logical step, so I leave the local merge to the next session (or
  the user) to keep the branch inspectable. The two commits are
  surgical and reviewable.
- **Push to origin**: user-gated per DIRECTION §7; never without sign-off.
- **UI/Playwright suite**: not installed in this sandbox (`importorskip`'d).
  Run on a machine with `pip install -e .[ui] && playwright install chromium`
  before final sign-off — verify the 302 redirects land correctly in a
  real browser (the unit test confirms status + Location; Playwright
  confirms the rendered target).

## Git state
- Branch: `feat/p3.5-legacy-retirement` (2 commits ahead of `main`).
- `main` itself is 18 commits ahead of `origin/main` (now 20 after merge).
- Tree clean apart from `handoff-p3.1.md` (untracked, predates this session)
  and this file.

## Next session
1. Merge `feat/p3.5-legacy-retirement` to `main` locally (fast-forward).
2. Refresh `NEXT.md` (already updated — P3.5 marked done, next actions
   listed).
3. Real-device Pixel-6 QA: tap `/triage` and `/reddit` from old
   bookmarks, confirm the 302 lands on `/?deck=1` / `/?source=reddit`.
4. Push decision (user-gated).

## Constraints honored
- No `*.db`, exports, Takeout, or `.env` touched.
- No live-data mutation; no destructive/network CLI run.
- CACHE + APP_VERSION bumped in lockstep.
- Tests stay offline and deterministic.
