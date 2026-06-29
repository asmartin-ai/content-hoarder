---
target: src/content_hoarder/templates/index.html
total_score: 27
p0_count: 0
p1_count: 2
timestamp: 2026-06-29T19-46-14Z
slug: src-content-hoarder-templates-index-html
---
Method: dual-agent (A: f29a8c07-b860-4a22-993e-b3f340170e43 · B: d5e3161c-272f-437d-902b-17e86bdb71f0)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Strong loading, active tabs, toast/snackbar, batch, and progress feedback; some background operations and internal chrome remain unclear. |
| 2 | Match System / Real World | 3 | Keep / Archive / Done maps well to saved-content triage; product terms like Focus, pebbles, Night ops, fuzzy, and command mode require learning. |
| 3 | User Control and Freedom | 3 | Undo, clear filters, Esc-close sheets, Back to Inbox, and reversible chips are strong; single-level undo and hidden row menus still make mistakes feel possible. |
| 4 | Consistency and Standards | 3 | Strong token/status system; browse vs legacy triage/reddit patterns and desktop-vs-mobile row actions diverge. |
| 5 | Error Prevention | 3 | Destructive Done purge safeguards are solid; row swipe/long-press commitments need clearer prevention and visible alternatives. |
| 6 | Recognition Rather Than Recall | 2 | Efficient paths depend on remembered shortcuts, gestures, command syntax, icon meanings, and hidden menus. |
| 7 | Flexibility and Efficiency | 4 | Excellent power-user machinery: command search, operators, facets, status tabs, density modes, focus batches, bulk tray, shortcuts. |
| 8 | Aesthetic and Minimalist Design | 2 | Cohesive identity, but the first screen exposes too much chrome around the item list. |
| 9 | Error Recovery | 2 | Some plain-language errors exist; several failures remain generic or silent. |
| 10 | Help and Documentation | 2 | Operator popover and shortcut sheet help, but there is no clear first-run orientation or “start here” path. |
| **Total** | | **27/40** | **Good foundation; power-user strong, first-session cognitive load is the main design risk.** |

## Anti-Patterns Verdict

**LLM assessment:** The main page does not read as generic AI slop. It has a specific, committed product identity: dark local log book, apricot phosphor accent, semantic status colors, dense rows, and emotionally mature backlog copy. The risk is not “AI SaaS dashboard”; it is “bespoke power-tool overdesign.” Too many clever affordances appear at once: command search, Today pebbles, Surprise, status folders, rail facets, sort, focus batches, ambient slot, dock, drawer, long-press, swipe, shortcuts, density modes, and sheets.

**Deterministic scan:** Target-only detector scan of `src/content_hoarder/templates/index.html` found 0 issues. A linked-CSS scan of `index.html`, `static/core/tokens.css`, and `static/browse/browse.css` found 30 findings: 5 warnings and 25 advisories. Warning rules: 3 `side-tab`, 1 `layout-transition`, 1 `broken-image`. Advisories: 15 `design-system-color`, 10 `design-system-radius`.

**Detector findings worth acting on:**
- `src/content_hoarder/static/browse/browse.css:674` — `border-left: 3px solid var(--accent)`.
- `src/content_hoarder/static/browse/browse.css:3610` — `border-left: 3px solid var(--source-twitter)`.
- `src/content_hoarder/static/browse/browse.css:3058` — `transition: padding`.

**Likely false positives / context-sensitive findings:**
- `browse.css:1532` broken image is inside a CSS comment mentioning `<img>`, not a shipped missing-src image.
- `browse.css:3696` side-tab is blockquote styling, not a colored card/list accent.
- Many radius/color advisories reflect an incomplete DESIGN.md sidecar or intentional legacy/intermediate values, not necessarily defects.

**Visual overlays:** Browser visualization was attempted but unavailable because this environment cannot find a Chrome executable. No reliable user-visible overlay is available.

## Overall Impression

This is a thoughtful, unusually specific product UI with a strong emotional thesis: process saved content without shame. The core direction is right. The biggest opportunity is ruthless hierarchy: make the first ten seconds about clearing one saved item, then progressively reveal the cockpit.

## What's Working

1. **The product has an actual identity.** The night-ops/log-book palette, Lexend + JetBrains Mono split, apricot accent, and status triad feel tailored to content-hoarder rather than generic SaaS.
2. **Triage mechanics are strong.** Rows carry source, title, metadata, tags, domain, media monitor, and F/A/D actions. Undo, haptics, focus batches, and cleared-page feedback support the product purpose.
3. **The copy understands the user.** “Nothing carries over,” “That’s enough for today,” “No rush,” and related empty-state language reduce guilt instead of weaponizing productivity.

## Priority Issues

### [P1] The default screen exposes too much product vocabulary before the first decision

**Why it matters:** The product promise is “process and reduce.” The first impression currently asks the user to parse a cockpit: command search, Today pebbles, Surprise, Settings, Triage, status folders, source/tag rail, sort, focus batch, ambient prompts, density, drawer, dock, and hidden keyboard/gesture systems.

**Fix:** Establish a stricter default hierarchy: primary = search/current status/item rows; secondary = filters/sort; tertiary = Today/Surprise/Settings/density/diagnostic chrome. Consider a clear “Start with 25” or “Clear first batch” path that makes the first action obvious.

**Suggested command:** `$impeccable distill src/content_hoarder/templates/index.html`

### [P1] Row actions are powerful but under-explained

**Why it matters:** The saved item row is the core work unit, but its grammar is dense: avatar selects, title opens source, media previews, icon buttons commit status, shortcuts commit status, long-press opens more actions, swipe commits, and mobile hides row actions. That is efficient after learning but fragile before learning.

**Fix:** In comfortable density, show labeled `Keep`, `Archive`, `Done` actions or reveal labels on row focus/hover. Make selection visually distinct from the source avatar. Separate “open original” and “read/preview here” more clearly. On touch, add a visible selected-row bottom action tray.

**Suggested command:** `$impeccable polish src/content_hoarder/static/browse/render.js src/content_hoarder/static/browse/browse.css`

### [P2] Recognition is weaker than recall for search, operators, and gestures

**Why it matters:** Power users will love `/`, `>`, operators, and shortcuts, but returning or first-time users must reconstruct syntax and gesture rules. This increases abandonment risk for exactly the tired/ADHD use case the product is built for.

**Fix:** Make operator examples visible without needing the right keystroke. Use plainer placeholder/help copy, e.g. “Search titles, tags, source. Try `source:reddit tag:video`.” Add a visible shortcuts/help affordance. Show mobile swipe/tap hints until each action has been used.

**Suggested command:** `$impeccable clarify src/content_hoarder/templates/index.html src/content_hoarder/static/browse/main.js`

### [P2] Elevation conflicts with the “ledger, not cards” design principle

**Why it matters:** The main sheet and some accents approach overlay/card treatment even though the feed is the primary content surface. If the feed feels like a floating dashboard card, real overlays lose semantic depth.

**Fix:** Reduce primary sheet shadow; reserve `--shadow-pop` for drawers, modals, menus, lightboxes, and stamps. Use tonal layering plus hairline borders for the feed. Replace side-stripe accents with full-row tint, leading icon, or subtle border/color treatment.

**Suggested command:** `$impeccable layout src/content_hoarder/static/browse/browse.css`

### [P2] Mobile action parity still feels too gesture-dependent

**Why it matters:** The project rules say every swipe needs a tap equivalent. The CSS hides row actions on touch while mobile relies on swipe/long-press plus global dock/navigation. Android gesture-nav and distracted use make this risky.

**Fix:** Add a selected-row bottom tray or inline expanded action strip with labeled `Keep / Archive / Done / Snooze / More`. Keep swipe as accelerator, not required knowledge.

**Suggested command:** `$impeccable adapt src/content_hoarder/templates/index.html src/content_hoarder/static/browse/browse.css`

## Persona Red Flags

**First-time user:** May not know whether to start with Browse, Triage, Focus, Search, Surprise, or status tabs. Terms like fuzzy, `> commands`, Night ops, pebbles, and Pinboard add vocabulary before value. Needs a “clear one save now” path.

**ADHD triage user:** The copy, focus batches, undo, and cleared-page moment are excellent. The risk is that the visible chrome becomes a procrastination surface: tuning filters/settings/density instead of deciding on an item.

**Power search user:** Strong filters, operators, exact mode, sorts, and facets. Risk: operator syntax is discoverable only after engagement; active filters and changed result reasons could be clearer.

**Mobile user:** The app clearly considers PWA/mobile constraints, but per-row actions hide on touch. Swipe and long-press are easy to miss and conflict-prone; visible tap actions need to be equally first-class.

## Minor Observations

- `TRIAGE →` may confuse IA: is the main page the triage surface or is `/triage`?
- `Done` being red is consistent with the design system, but can read destructive. Completion copy must keep disambiguating it.
- The app-version badge is useful diagnostic chrome but should probably live under Settings outside debugging sessions.
- “Archived” lacks a count while Keep/Done show counts, which may look like missing data.
- The “PAGE CLEARED” stamp is memorable; keep it rare so it stays rewarding rather than theatrical.
- Search exactness is not obvious until the operator popover is open.

## Questions to Consider

- Is the main page primarily a search cockpit or a triage deck? Which one owns the first 10 seconds?
- What would you hide until the user has cleared their first 10 items?
- Should `Done` feel like completion, deletion, or both — and is red carrying the right emotional meaning?
- If a tired user opens the app for two minutes, what single action should the page make irresistible?
