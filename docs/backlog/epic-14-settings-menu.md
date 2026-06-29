## Epic 14 — Settings menu  (`enhancement`, `area:ui`)
*A single settings cog consolidating preferences that are currently scattered or absent.*

*Epic 14 effectively complete on `feat/frontend-v3` (parallel session 2026-06-12, verified 27/27
headless). The gear + settings sheet (theme / density / loading / daily-goal) shipped earlier; the
parallel session added the missing **Stats** panel (`#statsheet`, GET /stats) into the menu.*
- [x] ~~**P2 — Settings cog + panel.**~~ Shipped on v3 (gear → `#settings` sheet, Esc/scrim close).
- [x] ~~**P2 — View density in settings**~~ (compact / cozy / cards) — in the settings sheet, persisted.
- [x] ~~**P2 — Light/dark theme toggle in settings**~~ — `theme.js` toggle surfaced in the sheet.
- [x] ~~**P2 — Infinite scroll by default; Focus mode batches.**~~ Shipped: load-on-scroll default,
  Focus mode batches; LOADING control lives in the settings sheet.
- [x] ~~**P3 — Focus mode wider on desktop.**~~ Desktop Focus mode should use a wider content column.
- [x] ~~**P3 — "Swipe only on mobile" → now a decision (see Epic 16).**~~ ✅ v3: implemented — `swipe.js:37` ignores mouse pointers, `attachSwipe` is touch-only by default (no toggle). Orig: Inbox swipe is mobile/touch-only by
  default, not a toggle.
- [x] ~~**P3 — Hide the Stats button under settings.**~~ ✅ v3: Stats is the `#statsheet` panel inside the settings menu (GET /stats), per the 2026-06-12 parallel session. De-cluttered.
- [x] ~~**P2 — NSFW toggle in settings (hide/show NSFW posts AND nsfw_* tags).**~~ ✅ Done 2026-06-20 (commits 82ab283 + 54e270e): the toggle already existed + persisted (state.safe → ?safe=1); completed it — the rail/drawer/autocomplete drop the nsfw_* facets while off (refreshRail on toggle), and the Epic 13 P2 over_18 fix makes the posts actually hide. *(User-requested
  2026-06-17.)* A persisted toggle in the settings sheet that, when OFF (default), hides NSFW content
  everywhere: the feed already supports it via the `safe=1` query param (`web.py` `hide_nsfw`), so wire
  the toggle to that; AND hide the NSFW tag facets (`nsfw_erotic`, `nsfw_other`, `nsfw_talk`) from the
  sidebar tag rail so they're not even listed while NSFW is off. When ON, show NSFW posts (blur-on-tap
  reveal already exists, Epic 16) and surface the nsfw_* tags. Mirror the `is:nsfw` operator semantics
  (Epic 12) and the curated NSFW tag set from `nsfw_rules.json` (Epic 9). Persist like density/theme.
