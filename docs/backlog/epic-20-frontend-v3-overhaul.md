## Epic 20 — Frontend v3 overhaul  (`enhancement`, `area:ui`)
*Decision (2026-06-09): full overhaul on `feat/frontend-v3` — vanilla JS, no build step, mobile
fluidity first-class. Plan: shared `static/core/` layer (util/api/toast/render/media — kills the
~250-line helper triplication across app.js/reddit.js/triage.js), tokens v3 seeded from
`design-ref/`, page-by-page rewrite (browse → triage → reddit) behind a design-approval gate.
**Absorbs** (don't fix twice): the Epic 13 density/NSFW/bulk-bar/Esc/tag-chip items, Epic 14
infinite-scroll/focus-batches, Epic 16 swipe items, Epic 5 keyboard rework, the toast undo-button
listener leak (app.js:75, triage.js:413), reddit.css hardcoded colors → tokens, dead CSS
(`.item-age`, `.source-badge`), sw.js versioned cache + `/reddit` added to the PWA shell.*

*Gate-1 outcome (2026-06-09): "Log Book II" locked — `design-ref/v3-explorations/05-log-book-2.html`
is the Stage C spec; tokens v3 + `static/core/` shipped (commit b20e977).*

*ADHD round LOCKED (2026-06-11): the Stage C spec is now **05 + `06-adhd-round.html`** — twelve
approved additions (win pebbles w/ optional daily goal, no raw backlog counts → "· N new" slice,
dateline greeting, resurfacing card per the locked one-pager, surprise-me + dice, operator-discovery
popover, active-filter chips, consume-cost pills, smart sort w/ "why" [build waits on triage-score
integration — model is shipped on main; pending: explore/exploit mix, seen-recently penalty,
always-on why], Focus batch strip → PAGE CLEARED stamp → empty state, live row-clear + undo +
two-stage Keep swipe ≈90/170px, quiet decay line; ☾ resting-soon markers deferred — need a
server-side flag). Mockups are gitignored; the additions list also lives in the explorations
README + plan file. New backend in scope: `GET /pulse` (new_today/cleared_today/swept_recent) and
`GET /resurface` + dismiss/letgo POSTs per `docs/resurfacing-card-design.md`. Items below are
build-tracking now, not open design questions:*

- [x] ~~**P2 — Two-stage swipe actions (mobile).**~~ ✅ v3: `core/swipe.js` `commit2`/`onRightLong` (commit2≈170px) wired in `browse/main.js` (commit 80, commit2 170, onRightLong→keep). Sync-style short/long thresholds per direction:
  short → = Archive, **long → = Keep** (the extra travel is deliberate friction — a "hoarder
  tax" that fits the reduce-the-backlog thesis), short ← = Done, long-left unassigned. Underlay
  color+icon swap at the second threshold + a haptic pulse (`navigator.vibrate`); long-press
  stays = select. **Design locked 2026-06-11** (06-adhd-round.html, thresholds ≈90px/≈170px,
  demoed working); build in Stage C.
- [x] ~~**P2 — 4-way swipe: Snooze on the unassigned long-left (+ snooze-decay).**~~ ✅ SHIPPED 2026-06-26:
  **Backend:** `db.snooze` stamps `metadata.snoozed_until` (monotonic wave, direct UPDATE — never
  `bulk_set_status`, so no unsave enqueue) + increments `metadata.snooze_count`; triage batches exclude
  snoozed items via `get_random_batch` filter; `is:snoozed` search operator. **Escalation:** after N snoozes
  (~3) the item routes through decay (`decay_label='snooze-escalated'`, reversible, no guilt copy).
  **Frontend:** long-← swipe claims Snooze; `POST /items/<fn>/snooze` + `POST /items/<fn>/unsnooze` routes;
  hardened `snooze` CLI (dry-run default, `--apply --yes` gate, auto-backup, `snooze-audit.jsonl`).
  Friction-asymmetry: snooze is priced above Done/Archive but below Keep. *(User idea 2026-06-12.)*
- [x] ~~**P2 — 4-DIRECTIONAL triage: add the vertical axis (↑ = thread, ↓ = skip-for-later).**~~ ✅ SHIPPED
  2026-06-26: ↑ opens the reader/thread (via `triage.js` swipe-up → `readerUI.open` + `preloadNext`),
  ↓ calls the existing Skip (no-decision pass). Direction lock resolves diagonal drags to one axis.
  Works alongside the existing 2-stage horizontal swipe (←/→ = Done/Archive/Keep, long-← = Snooze).
  Reader close returns to the triage deck (card stays undecided). *(User idea 2026-06-22.)*
- [ ] **P2 — Triage visual rework + inbox-like filtering.** *(User ideas 2026-06-22 + mobile test
  2026-06-29.)* A fresh visual pass on the triage card/deck — hand it to a design bakeoff arm (GLM,
  per the Epic 20 P3 GLM-5.2 design-arm trial). Pair with the 4-directional gesture item above: the new
  ↑/↓ affordances need visual hinting (edge cues / peek), the reader should animate up from the bottom when
  opened by ↑, and side-swipe tilt can return as low-priority polish. Add **inbox-like filtering** so triage
  can process a selected slice (source/tag/status/category/smart-sort subset) instead of the whole inbox.
  Move light/dark controls into a settings menu, and make the bottom triage buttons match the inbox swipe
  icons/actions. Scope + lock the design via the `frontend-design` skill + visual review before any build.
- [x] ~~**P2 — Command palette v1.**~~ Shipped (2026-06-11, the bakeoff's T3 winner —
  GLM-5.1's sample + review fixes): `static/browse/palette.js` (ES module, fuzzy
  subsequence match with strict-prefix > word-boundary > scattered tiers, arrows wrap,
  Enter runs, Escape exits, listbox/option ARIA), commands for pages/theme/density/sort.
  `>` flips the search bar to command mode; placeholder now advertises it. Deferred to a
  v2: status-view switching, bulk ops on selection (need the selection model exposed).
- [x] ~~**P2 — Filter-state visibility (simple now).**~~ ✅ v3: active source/tag chips (`#fchips`) built from `state.source`/`state.tags` (main.js:440). Active source/tag chips with ✕ + "clear
  all" rendered in the sheet shelf next to the result count; define the algebra (single-select
  source, multi-select tags) and keep it visible. **Design locked 2026-06-11** (06, demoed);
  build in Stage C. **P3 — advanced later:** palette-driven filter builder, saved filters,
  tag search inside the rail.

*PKMS-research additions (2026-06-10 handoff; see Epic 21 for context). These ride the same
Stage C design gate:*

- [x] ~~**P2 — No backlog counts in v3 (research-mandated).**~~ ✅ v3: the pulse shows "· N new" + win pebbles, never raw totals (`state.pulse` = new_today/cleared_today/swept_recent). No raw inbox/All totals anywhere —
  backlog counts read as failure and drive abandonment (97.55% of items never leave inbox; the
  number can only be demoralizing). Sidebar shows curated slices instead; audit the Stats modal
  + progress copy for guilt framing (never re-open/read-% as health, no "you haven't…");
  finishable batch progress only ("3 of 7"), never streaks/points/leaderboards.
  **Design locked 2026-06-11** (06: `Inbox · N new` slice, Archived count dropped, win
  pebbles w/ optional goal); build in Stage C via `GET /pulse`.
- [x] ~~**P2 — Resurfacing card: "Still interested in X?".**~~ ✅ v3: the ambient slot renders "Still interested in <em>X</em>?" + Not-now/Let-it-go, fetching GET /resurface (main.js:301-350, locked-design `resurface.py`). Machine-initiated, phrased as a
  curious question, never a count badge or red dot (recognition beats recall for ADHD). v1
  candidates need no LLM: cluster = curated knowledge tag (`tips`/`coding`/`science`) × old
  saves; never `memes`/`vtubers` (identity content isn't a task). Dismiss = silent decay + a
  no-renag window. **Design LOCKED 2026-06-11** — one-pager
  [`docs/resurfacing-card-design.md`](docs/resurfacing-card-design.md) (all 4 questions
  decided) + card rendered verbatim in 06; build = `resurface.py` + `GET /resurface` +
  dismiss/letgo POSTs in Stage C (triage_score ranking term is active post-`learn-triage` — the model
  ships on main; further tuning is open).
- [x] ~~**P2 — "Surprise me" card.**~~ ✅ SHIPPED on v3 2026-06-13: `surprise()` (`browse/main.js:358`) pulls `/random?n=1` into the ambient slot ("DEALT AT RANDOM — NO STRINGS"); ⚄ dice button (`main.js:378`, `render.js:196`). No count/streak. Orig: One bounded random old save on demand — converts the
  rediscovery-joy that sustains the save habit into a deliberate retention loop. Rides
  `db.get_random_batch` (check n=1 / cross-status support). No count, no streak.
  **Design locked 2026-06-11** (06: same ambient slot, never both cards, + ⚄ dice for
  user-pulled); build in Stage C.
- [x] ~~**P3 — "Surprise me" card: render media + open → reader.**~~ ✅ SHIPPED 2026-06-26: `surprise()`
  (`browse/main.js:358`) now renders the item's thumbnail (`thumb(it, "list")`) on the card, and the "Open"
  button routes into `section#reader` for note/discussion items (`reddit`/`hackernews`/`keep`/`obsidian`)
  or falls through to the media lightbox for media-only items. *(User-requested 2026-06-17.)*

*Code-quality / dead-code cleanup migrated 2026-06-20 from the retired
`docs/IMPLEMENTATION-HANDOFF-2026-06-17.md` work queue (I1–I4). The v3 `static/core/` layer was created to
kill exactly this duplication; the two non-module legacy pages (`/triage`, `/reddit`) still carry copies:*

- [x] ~~**P2 — Dead duplicate `icons.js` + offline cache gap (I1).**~~ ✅ Done 2026-06-20 (`frontend-staging`,
  systematic-mode rework) via the cleaner (b) end-state. The interim (a) fix (`a35242e`, caching `/static/icons.js`)
  was superseded: `/triage` now loads `triage.js` as an **ES module** importing `chIcon`/`fillIcons` from
  `core/icons.js`, the `<script src="/static/icons.js">` tag is gone, and **`static/icons.js` is deleted**.
  Discovery during the rework: `static/icons.js` was NOT dead — it was the **generator source** for `core/icons.js`
  (`scripts/_gen_core_icons.py`); per user decision the one-shot generator was **retired** too, so `core/icons.js`
  is now the single hand-maintained icon source (header updated). `sw.js` shell → v33: dropped `/static/icons.js`,
  added `/static/core/icons.js` (so `/triage` icons render offline). **Verified:** `/static/icons.js` 404s,
  `/triage` action icons + dynamic stamps render via `core/icons.js`, no console errors.
- [x] ~~**P2 — Helper duplication on the legacy pages (I2).**~~ ✅ Done 2026-06-20 (`frontend-staging`). Converted
  `triage.js` + `reddit.js` to **ES modules**: triage imports `esc`/`safeUrl`/`isTypingTarget`/`ago` from
  `core/util.js` and `getJSON` (as `fetchJSON`) from `core/api.js`; reddit imports `esc`. Local copies removed →
  one source of truth. Both files were already IIFE-wrapped (leaked no globals), and reddit's `window.doUnsave`/
  `doUndo`/`openThread` (inline-onclick targets) are explicit `window.` assignments that survive module conversion —
  **verified** by clicking a real onclick row (detail panel opened). Note: the B0a single-quote `esc` divergence was
  already fixed in both files before this (now byte-identical), so the dedup is behavior-neutral except triage's
  relative-time now matches the browse view (`ago`: `"42s"` vs the old `"now"` for <1min items).
- [ ] **P3 — Unused `app.css` selectors (I3) — defer.** `app.css` (~2100 lines, consumed only by the legacy
  `/triage` page) has many unreferenced selectors (e.g. `.ai-*` suggest-UI classes), but confidence on
  individual selectors is medium. Defer to a triage redesign; don't bulk-delete without per-selector usage
  checks.
- [x] ~~**P3 — Document the two token files (I4) — doc-only.**~~ ✅ Shipped (`1ff18bf`): each token file now
  carries a header comment noting which pages consume it — `static/tokens.css` (legacy dark/teal, used by
  `/triage` + `/reddit`) and `static/core/tokens.css` (v3 "Log Book" apricot, used by browse) — to prevent a
  future "looks duplicated, delete one" mistake. Both are live and intentional; unify only when the legacy pages
  are redesigned.
