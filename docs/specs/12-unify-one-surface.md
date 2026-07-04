# Spec 12 — Unify one surface (Epic 17, design-first gate)

**Status: PROPOSED 2026-07-03.** Design-only per DIRECTION §5 P3.0 (T1,
design-first — the gate for the rest of W3). **No code in this spec.**
Implementation packets P3.1..n are cut by this document.

**Mission (D1, DIRECTION §3):** `/triage` and `/reddit` functionality migrates
into the v3 browse surface (`/`). Legacy pages retire afterward in one
deliberate pass. Ends the two-UI maintenance tax (two `tokens.css`, two
render stacks — confirmed drifting in audit 2026-07-02).

**Survey basis:** the capability inventory below is the conclusion of a
read-only survey of `templates/triage.html`, `static/triage.js`,
`templates/reddit.html`, `static/reddit.js`, `web.py` routes,
`static/browse/{main,render,reader}.js` (2026-07-03).

---

## 1. Capability mapping

For every capability on the two legacy pages: **maps to X** (existing v3
mechanism, no new code beyond wiring) or **builds as Y** (new code in v3) or
**dropped, because Z** (with rationale). Nothing is silently lost.

### /triage → v3 browse

| Triage capability | Disposition | Notes |
|---|---|---|
| Single-card **deck** mode (`loadBatch`/`commit`, `#card-stack`) | **Builds as a v3 mode** | The v3 list stays default; a `/triage`-equivalent deck becomes a `?deck=1` mode of `/` driven by `/random` (already shipped). This is the load-bearing build — see §3 packet P3.1. |
| Swipe ← done / → archive / long-← snooze / ↑ reader / ↓ skip | **Maps** to `core/swipe.js` | Already shared; deck mode wires the same gestures. |
| Decision keys `s/e/y/u/z`, arrows, space, `?` | **Maps** with additions | Browse already has `Escape`/`?`/`Space`; deck mode adds `s/e/y/u/z`. Cheatsheet (`?`) extends. |
| Batch-size selector (10/20/30/50) + modes Smart/Newest/Random | **Maps** | `/random` already accepts these; deck mode surfaces the selector. |
| Filters (source/category/tag chips) | **Maps** | v3 rail + drawer already do this and more. |
| **Undo of last decision** (`#undo-btn`) | **Maps** | `core/api.js` `undoStatus` exists; deck mode surfaces an Undo affordance. |
| Reddit-unsave shortcut in menu | **Maps** | The trickle drainer is already wired into the Done action (`reddit_trickle`); deck mode inherits it. |

**Net new for triage migration:** the deck mode itself. Everything else is
reused. Triage's `static/triage.js`, `templates/triage.html`, `static/app.css`
**retire** once deck mode ships.

### /reddit → v3 browse

| Reddit capability | Disposition | Notes |
|---|---|---|
| **Subreddit rail** (`/reddit/subreddits` → `reddit_subreddit_counts`) | **Builds as a v3 facet** | The v3 source rail (`facets.sources`) has no subreddit dimension today. Add a `subreddit` facet exposed only when `source=reddit`. New endpoint or extend `/items` facets. See P3.3. |
| **Table vs grid view** toggle | ~~**Builds as density**~~ **Already shipped — no work** | > Corrected 2026-07-04: v3 already ships `#set-density` (Ledger/Log/Pinboard = compact/comfortable/card) at `templates/index.html:344` and `static/browse/main.js:2848`. The P3.2 packet is therefore **moot**; mark P3.2 as "no work" in §3. |
| **Thread viewer** with comment sort (best/top/new) | **Maps** to `browse/reader.js` | Reader already opens a reddit-thread view with sort; the reddit page's dedicated detail panel is redundant. **Confirm** reader.js covers all sort options before retiring (TODO in P3.4). |
| **Inline unsave** + **queue-unsaves-by-tag** | **Maps** | `/reddit/unsave/*` routes are source-agnostic enough; surface the by-tag enqueue in the v3 bulk-select overlay. |
| **Stats modal** (`/reddit/stats`) | **Dropped, because** | v3's rail + pulse + `stats` route already cover the same ground; the modal was a reddit-only affordance. The stats ROUTE stays (used by scripts). |
| **Header counts** | **Maps** | v3 already shows counts in rail/pulse. |
| **CSV/JSON export** link | **Maps** | `cli.py` `export` already exists; surface a link in the v3 row-menu. |
| **Kind/saved/sort filters** | **Maps** | v3 `operators.js` (`source:`/`status:`/`is:`/`has:`/`sort:`) already superset these. |

**Net new for reddit migration:** subreddit facet + density toggle. The
thread viewer + unsave workflow reuse the v3 reader + bulk overlay.
`static/reddit.js`, `static/reddit.css`, `templates/reddit.html` **retire**
once subreddit drill-down + density toggle ship.

---

## 2. Retirement checklist (executed in P3.5, after the builds land)

Removed from `sw.js` SHELL (and the asset files deleted):
- `/triage`, `/reddit` (navigation entries)
- `/static/app.css`
- `/static/triage.js`
- `/static/reddit.css`
- `/static/reddit.js`
- `/static/tokens.css` — **VERIFY FIRST**: confirm `index.html` loads
  `core/tokens.css` not root `tokens.css`. Survey says v3 uses core; verify
  before deleting (the audit flagged pre-existing SHELL hygiene debt here).
- `/static/haptics.js` — **VERIFY FIRST**: survey says triage-only today; if
  deck mode in v3 uses haptics, KEEP it. Keep if used anywhere.
- `templates/triage.html`, `templates/reddit.html`

Routes removed from `web.py`:
- `/triage` (`triage()`), `/reddit` (`reddit_page()`) — the **pages**.
- `/reddit/items`, `/reddit/items/<fn>/thread` → **STAY** (reader + scripts
  consume them); only the page-render routes retire. The JSON endpoints
  become first-class v3 APIs.

`sw.js` `CACHE` + `main.js` `APP_VERSION` bumped together (in lockstep, per
the standing rule).

---

## 3. Implementation cut (3-5 packets, ordered low-risk → higher)

Each packet = one branch off `main`, one focused change, full suite +
`pytest -m ui` green before merge. **Hard constraint (carried from
NEXT-DELEGATION): never two agents in `browse/main.js`/`core/media.js`/
`core/swipe.js`/`browse.css` simultaneously without split line scopes.**

**P3.1 — Deck mode in v3 (T2, the big one).**
- New `?deck=1` mode of `/`: one card at a time, driven by `/random`, with
  swipe + decision keys + batch selector + Undo. Body lives in a new
  `static/browse/deck.js` (NOT in main.js — keeps the surface split clean).
- Wires `core/swipe.js` + `haptics.js` + the existing `api.randomBatch`.
- Offline tests for the mode toggle + key handler; one UI regression test
  that deck mode opens to one card.
- Do NOT change default landing (`/` stays the list); deck is opt-in via
  querystring / a "Deck" toggle in the rail.

**P3.2 — Density toggle — NO WORK (superseded 2026-07-04).**
- v3 already ships `#set-density` (Ledger/Log/Pinboard) at
  `templates/index.html:344` + `static/browse/main.js:2848`. Packet is moot.
- See the correction note on the reddit capability table above.

**P3.3 — Subreddit facet (T2).**
- Extend `/items` facets (or add `/items/subreddits`) to return
  subreddit counts scoped to `source=reddit`. Backed by
  `db.reddit_subreddit_counts` (already exists for the legacy page).
- Surface as a second-tier rail under the reddit source, or a new facet
  group. Decide in P3.3's own design step (line-scope split from P3.1).
- Offline tests for the facet endpoint; UI test for subreddit drill-down.

**P3.4 — Reddit unsave-by-tag in bulk overlay + thread-view sort audit (T2).**
- Surface the by-tag enqueue in the v3 bulk-select overlay (the route is
  already source-agnostic).
- **Audit** `browse/reader.js` thread sort vs reddit.js's sort selector;
  confirm parity (best/top/new all wired). If gaps, fix in this packet.
- No retirement yet.

**P3.5 — Legacy retirement (T2, one deliberate pass).** ✅ DONE 2026-07-04.
- Execute the §2 checklist: delete templates + assets, remove `/triage` +
  `/reddit` page routes (keep JSON), strip SHELL entries, bump
  CACHE + APP_VERSION.
- Add a redirect from `/triage` → `/?deck=1` and `/reddit` → `/?source=reddit`
  for existing bookmarks (302, in web.py).
- Full suite + UI suite green; manual QA that no legacy asset 404s in the
  console (offline + online).

> Landed on `feat/p3.5-legacy-retirement` (2 commits): `dbe3c1c` (routes
> → 302 + redirect test), `77438e1` (asset deletion + sw.js/main.js
> v116→v117 + test refresh). Suite **1008 passed** (net 0: +1 redirect
> test, −1 page-render test). Branch unmerged at handoff; not pushed
> (§7). See `handoff-p3.5.md`.

---

## 4. User decision list (what to drop, what to keep)

Surfacing per DIRECTION §6.6 ("the user has a short decision list"):

1. **Stats modal (dropped)** — v3 rail/pulse covers it. OK to drop, or keep
   the route for scripts only? **Recommendation: drop the modal, keep the
   route.**
2. **Deck as `/triage` redirect target** — `?deck=1` vs a new `/deck` route?
   **Recommendation: `?deck=1`** (one route, mode of the same surface).
3. **Subreddit facet placement** — second-tier rail under reddit, or its own
   facet group? **Recommendation: second-tier** (matches the source-aware
   rail already in v3).
4. **`/static/haptics.js` keep-or-drop** — deck mode in P3.1 will use it;
   **KEEP** (don't retire in P3.5).

---

## 5. Done-when for this spec (P3.0 itself)

- Every capability on both legacy pages answered with maps/builds/dropped +
  rationale. ✅ (above)
- 3-5 packet implementation cut. ✅ (P3.1-P3.5)
- User decision list surfaced. ✅ (§4)
- No code written (gate condition). ✅

**Next concrete action:** user signs off on §4 decisions, then P3.1 (deck
mode) starts. P3.1 is the load-bearing packet; P3.2-P3.4 are independent and
parallelizable subject to the line-scope constraint. P3.5 lands last.
