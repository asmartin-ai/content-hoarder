# Agent C — `/triage` first-entry back guard (back returns to `/`, not exit)

> **Sandbox-safe.** Pure frontend, History API. No live DB, no network. Playwright UI test is
> the oracle (the whole point is the mobile PWA back button).

## Context (from BACKLOG.md Epic 16 #995)

On mobile (Chrome/Pixel-6 target), pressing the OS **back** button on the `/triage` view
**exits the PWA** when `/triage` is the *first* PWA history entry — i.e. the user launched or
refreshed directly onto `/triage`, so there's nothing below it in the history stack. Normal
navigation (inbox → click the TRIAGE link) already returns to the inbox correctly.

The **reader + overlays** half of this problem already shipped (`core/overlaynav.js`, commit
referenced in Epic 16 #996). The **triage PAGE-as-entry** case is still open: it needs a
page-level guard — if `/triage` is the entry (no same-origin referrer / `history.length<=1`),
push a sentinel so back routes to `/` instead of exiting. This must coordinate with the
overlay coordinator (an open overlay's back takes precedence over the page-level guard).

## Write scope (only these)

- `src/content_hoarder/static/triage.js` — the page-level guard (or a tiny new helper it calls)
- `src/content_hoarder/templates/triage.html` — only if a tiny boot hook is needed there
  (prefer keeping all logic in `triage.js`, which loads as an ES module at `triage.html:106`)

**Do not touch** `core/overlaynav.js` (it's shared and already correct — your guard must
*coordinate with* it, not modify it), `browse/*`, `reddit.js`, `app.css`, or any backend file.

## What exists (verified anchors — read these first)

- `static/core/overlaynav.js` — **read the whole file (~47 lines).** It owns ONE `popstate`
  listener over a **stack** of overlay close-callbacks. `pushOverlay(onClose)` pushes a
  history entry + closer; OS-back runs only the TOP closer; `settleTop()` unwinds a manual
  close. Your page-level guard MUST NOT add a competing `popstate` listener that fires
  alongside it (that's the exact bug `overlaynav.js` was written to prevent). The coordination
  rule: **an open overlay's back closes the overlay first**; only when no overlay is open does
  back hit the page-level sentinel → navigate to `/`.
- `templates/triage.html` loads `triage.js` as `<script type="module">` (line 106). It also
  loads `theme.js`, `haptics.js`.
- The browse view (`/`) is the inbox. `/triage` is the focused triage deck.

## Build

The guard should run **once at `triage.js` module boot**, before/around the existing init:

1. **Detect "am I the first entry."** Heuristic (combine, don't rely on one):
   - `history.length <= 1` (nothing before us), AND/OR
   - no same-origin referrer (`document.referrer` is empty or cross-origin), AND/OR
   - `performance.getEntriesByType("navigation")[0].type` is `"navigate"` (a real load, not a
     back/forward restore) — pick the combination that's robust on Chrome/Android. Document
     which signal(s) you use and why.

2. **If first entry: push one sentinel history entry** for `/` (or the inbox path) so the
   *first* OS-back lands on the inbox instead of exiting:
   - `history.pushState({ chTriageEntry: true }, "", "/")` — pushing the *inbox* URL as the
     sentinel means a back-navigation actually navigates there (not just a no-op popstate).
     Think carefully: `pushState` changes the URL bar without navigating; the subsequent
     OS-back will fire `popstate` and you then do `location.assign("/")` (or rely on the
     pushed URL). The cleanest correct pattern: push a state entry, and on the `popstate` that
     matches your sentinel, `location.replace("/")` to actually navigate. **Test the exact
     sequence in Playwright** — History API + mobile back is subtle.
   - **Only push once.** Guard against double-push (e.g. if the module re-initializes).

3. **Coordinate with `overlaynav.js`:** your `popstate` handler (if any) must early-return
   when `overlaynav`'s stack is non-empty. The simplest correct approach: don't add your own
   `popstate` listener at all — instead expose a predicate the overlaynav flow can consult, OR
   check a shared flag. **Read `overlaynav.js` first** and pick a coordination shape that
   doesn't add a second competing `popstate` listener. The rule to enforce: an open
   reader/lightbox/sheet always closes before the page-level back-to-inbox fires.

4. **Non-entry case:** if `/triage` was reached by normal navigation (inbox → triage link),
   do nothing — the natural history already has `/` below, so back works without help.

## Guardrails (AGENTS.md)

- Vanilla JS, ES module, **no build step**, no dependency.
- Don't break `overlaynav.js`'s LIFO stack semantics — the shipped invariant is "one back
  closes the top overlay, never the page." Your guard fires only when the overlay stack is
  empty.
- Don't add a competing `popstate` listener that double-fires.
- Mobile-first: the target is Chrome/Android (Pixel-6). The Web Haptics / Gecko / TWA iceboxes
  are irrelevant here.

## Tests (the oracle)

Add a Playwright UI test under `tests/ui/` (per AGENTS.md: `pytest -m ui`, Pixel-6 viewport +
**PWA-standalone** emulation, app served in-process off a copy of the live DB with autosync
OFF). This bug is mobile/PWA-back-specific — the UI suite is exactly where AGENTS.md says to
verify it ("Verify any mobile/PWA UI change here").

1. **Entry case:** launch the app **directly onto `/triage`** (simulate "user opened/refreshed
   the triage PWA directly"). Press browser-back (Playwright `page.goBack()`). Assert the page
   navigates to `/` (inbox) — **not** that the page unloads / the app exits. (In headless
   Chromium, "exit" manifests as the page navigating to about:blank or the history being
   exhausted — assert you land on `/`.)
2. **Normal-nav case:** open `/`, click the TRIAGE link, press back → assert you return to `/`
   (existing behavior, must not regress).
3. **Overlay precedence:** from `/triage` as entry, open something that registers with
   `overlaynav` (if triage has an overlay — e.g. a lightbox/sheet; check `triage.js`), press
   back → assert the overlay closes AND the page stays on `/triage` (the page-level sentinel
   did NOT fire). Press back again → now `/`. (If `/triage` has no overlay today, document
   that and skip; the coordination must still be correct by construction.)
4. **No double-push:** reloading `/triage` multiple times must not stack sentinel entries
   (back still goes to `/` in one press, not two).

`python -m pytest` (default, no network) stays green; `pytest -m ui` adds the new cases.

## Out of scope

- The reader/lightbox back behavior (already shipped via `overlaynav.js`).
- Any `/reddit` view back behavior (separate page, not in this item).
- Making back work when the *whole* app was cold-launched onto `/triage` from outside — that's
  the same case as "first entry"; the sentinel handles it.

## Done when

- Launching/refreshing directly onto `/triage` then pressing back navigates to `/` (inbox),
  verified in the Playwright UI test.
- Normal inbox→triage→back still works (no regression).
- Open overlays still close before the page-level back fires.
- `pytest -m ui` green with the new cases; default suite green vs baseline.
- Committed on `fix/triage-back-guard`; not pushed/merged.
