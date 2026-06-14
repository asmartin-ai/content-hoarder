# Spec 06 — "Sync newest" in browse + relabel the drain button

BACKLOG: Epic 9 #240 (surface sync in browse) + #243 (disambiguate drain label).
Branch: `feat/sync-newest`. Touches: `templates/index.html`, `static/browse/main.js`,
`static/core/api.js`, `templates/triage.html`, `static/triage.js`.

## Premise corrections (confirmed — the original backlog text was slightly off)
- `#btn-sync` on `/reddit` ALREADY reads **"Sync newest"** and works (`reddit.html:24`, `reddit.js:384-410`).
  The browse view has **no** sync control — that's the build (#240).
- `#ru-sync` does NOT exist. The mislabeled control is `#ru-sync-triage` ("Sync now"/"Sync now (N)")
  in triage (`triage.html:40`, `triage.js:497-518`) — it DRAINS the unsave queue. That's the relabel (#243).

## Goal
(1) Add an incremental "Sync newest" control to the main browse header that POSTs `/reddit/sync`.
(2) Relabel the triage drain button so it reads as a drain ("Unsave queued (N)" / "Drain"), not "Sync now".

## Acceptance criteria
- Browse header has a "Sync newest" control; clicking it POSTs `/reddit/sync` `{}` (incremental: 3 pages,
  stop-on-known) and on success shows a toast like `+N new (F fetched, Pp, <stopped>)` and refreshes the
  list/counts/rail. On `auth_error`, toast "needs a reddit_session cookie".
- The triage drain button no longer says "Sync now": idle = "Drain" (disabled when nothing pending),
  pending = "Unsave queued (N)"; in-flight text "Draining…"; failure toast "Drain failed". Behavior
  (POST `/reddit/unsave/drain`) unchanged.
- No collision between the two labels. Preview-verified; no console errors.

## Implementation

### (1) Browse sync — `core/api.js`, `templates/index.html`, `browse/main.js`
- `core/api.js`: add `export const redditSync = (body) => postJSON("/reddit/sync", body || {});`
  (mirror `unsaveDrain` `:46-47`; `postJSON` rejects on `!r.ok`).
- `templates/index.html`: add a control in the `.con-row` action cluster (`:16-42`), next to
  `#dice`/`#open-settings` — e.g. `<button type="button" class="icon-btn" id="btn-sync-newest"
  title="Sync newest saved from Reddit" aria-label="Sync newest">⟳</button>` (match the existing
  icon-btn pattern; pick an icon consistent with the design system — see frontend-design skill).
- `browse/main.js`: wire it (mirror `$("#dice").addEventListener` `:378`). On click: disable, call
  `api.redditSync({})`, then `toast(...)` (`core/toast.js` `:47`) with the result, and refresh via
  `loadItems(true)` (`:64`) + `loadCounts()` (`:392`) + `refreshRail()` (`:412`). Re-enable in `finally`.
  Response fields: `{fetched,new,updated,pages,stopped,auth_error,network_error,username}`.
  Optionally also add a "Sync newest from Reddit" command to the palette (`:632-643`).

### (2) Relabel drain — `triage.js` + `triage.html`
- `triage.html:40`: default button text `Sync now` → `Drain`.
- `triage.js:497-518` (legacy IIFE, its own `fetchJSON`/`toast`): change label code `:504`
  `ruSyncBtn.textContent = s.pending ? ("Unsave queued (" + s.pending + ")") : "Drain";`
  in-flight `:510` "Syncing…" → "Draining…"; failure `:517` "Sync failed" → "Drain failed".
  Status text `:503` is fine ("N queued to unsave" / "all synced").

## Tests / verification
- Run `tests/test_browse_view.py` + `tests/test_static_core.py` after edits. (`/reddit/sync` route is
  covered by `tests/test_reddit_sync.py` — don't change the route.)
- Preview-verify: with no cookie configured, the browse Sync button toasts the auth message and the
  triage drain control is hidden/disabled correctly; labels read "Sync newest" (browse) vs "Drain"
  (triage) with no "Sync now" anywhere. (Live sync needs a real cookie — verify the wiring/UX, not a real pull.)

## Gotchas
- `triage.js` is the legacy v2 IIFE (no ES modules) — use its local `fetchJSON`/`toast`, not `core/*`.
- Noted but out of scope: `/reddit/unsave/drain` reads `body["max"]` while `core/api.js unsaveDrain`
  sends `{limit}` (key mismatch → server default 50). Leave unless trivial; if you touch it, make api.js
  send `{max}`.
