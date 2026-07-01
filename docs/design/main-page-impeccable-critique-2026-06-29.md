# Main Page Impeccable Critique

> Snapshot as of 2026-06-29.

Date: 2026-06-29  
Surface: `/` browse/search/results page (`src/content_hoarder/templates/index.html`)  
Source snapshot: `.impeccable/critique/2026-06-29T19-46-14Z__src-content-hoarder-templates-index-html.md`

## User decisions from follow-up

1. **Start with direction B:** clarify row actions and mobile parity.
2. **Summarize P1/P2 issues first:** decide which issues to address before implementation.
3. **IA clarification:** `/` is **not** intended to replace `/triage` as the primary triage surface. Both `/` and `/triage` should support triage, with different modes/contexts.

## Design health summary

Score: **27/40**

The main page has a strong, specific identity: local log book / night-ops cockpit, apricot action accent, semantic Keep / Archive / Done colors, dense saved-item rows, and non-shaming backlog copy. It does **not** read like generic SaaS AI output.

The main risk is **bespoke power-tool overdesign**: too many affordances are visible or implied before the user makes the first decision. Returning power users benefit from the cockpit; first-time, tired, or mobile users may need a clearer path to “triage this item now.”

## IA note: `/` and `/triage`

The critique originally asked whether `/` should replace `/triage`. The answer is **no**.

Design direction should treat the two surfaces as complementary:

- `/` = browse/search/results triage surface: list-first, filter-first, good for search, comparison, bulk-ish decisions, media preview, and opportunistic triage while browsing.
- `/triage` = dedicated decision mode: one-at-a-time card/swipe workflow, lower distraction, good for focused clearing.

Implication: avoid making `/` pretend to be the only triage deck. Instead, make triage actions on `/` clearer and more accessible while preserving its browse/search/results role.

## P1/P2 issue summary

### P1-A — Default screen exposes too much vocabulary before the first decision

**Problem:** The first view presents command search, Today pebbles, Surprise, Settings, Triage, status folders, source/tag rail, sort, focus batches, ambient prompts, density, drawer, dock, shortcuts, swipe, and long-press grammar.

**Why it matters:** The product promise is “process and reduce.” Too much cockpit chrome can become a procrastination surface, especially for ADHD/tired use.

**Possible fix direction:** Keep `/` as browse/search/results, but sharpen hierarchy:

- Primary: search/current status/item rows.
- Secondary: filters/sort.
- Tertiary: Today/Surprise/Settings/density/diagnostic chrome.
- Make the first actionable item decision more obvious without converting `/` into `/triage`.

**Suggested Impeccable command:** `$impeccable distill src/content_hoarder/templates/index.html`

---

### P1-B — Row actions are powerful but under-explained

**Problem:** A row has many action paths: avatar selects, title opens source, media previews, icon buttons commit status, shortcuts commit status, long-press opens more actions, swipe commits, and mobile hides row actions.

**Why it matters:** This is the core issue selected to start with. Rows are the primary unit of work on `/`; if their action grammar is unclear, browse-mode triage feels risky or hidden.

**Possible fix direction:**

- In comfortable density, make `Keep`, `Archive`, and `Done` more legible than icon-only controls.
- Make selection visually distinct from source identity/avatar.
- Separate “open original” from “read/preview here.”
- On touch, provide a visible selected-row action tray or inline expanded actions with labels.
- Keep swipe/keyboard/long-press as accelerators, not required knowledge.

**Suggested Impeccable command:** `$impeccable polish src/content_hoarder/static/browse/render.js src/content_hoarder/static/browse/browse.css`

---

### P2-A — Recognition is weaker than recall for search, operators, and gestures

**Problem:** Efficient paths depend on remembered syntax and gestures: `/`, `>`, operators, shortcuts, swipe, long-press, and icon meanings.

**Why it matters:** Power users benefit, but returning users may forget how to operate the page. That is risky for a personal tool used in short, irregular sessions.

**Possible fix direction:**

- Make operator examples visible without requiring the right keystroke.
- Use clearer search placeholder/help copy.
- Add a visible shortcuts/help affordance.
- Show mobile swipe/tap hints until the user has successfully used each action.

**Suggested Impeccable command:** `$impeccable clarify src/content_hoarder/templates/index.html src/content_hoarder/static/browse/main.js`

---

### P2-B — Elevation conflicts with the “ledger, not cards” design principle

**Problem:** Some primary surfaces and accents approach overlay/card treatment. Detector also flagged side-tab borders and design-system drift in `browse.css`.

**Why it matters:** If the main feed feels like a floating dashboard card, real overlays lose semantic depth. Side-stripe accents are also explicitly banned by the local Impeccable design guidance.

**Possible fix direction:**

- Reduce primary sheet shadow.
- Reserve `--shadow-pop` for drawers, modals, menus, lightboxes, and stamps.
- Use tonal layering plus hairline borders for the feed.
- Replace side-stripe accents with full-row tint, leading icon, or subtler border treatments.

**Suggested Impeccable command:** `$impeccable layout src/content_hoarder/static/browse/browse.css`

---

### P2-C — Mobile action parity is too gesture-dependent

**Problem:** Project rules say every swipe needs a tap equivalent. On touch, row actions are hidden and the page relies heavily on swipe/long-press plus global navigation.

**Why it matters:** Android gesture navigation and distracted mobile use make hidden gestures fragile. Since `/` should support triage, mobile users need visible row-level decision controls.

**Possible fix direction:**

- Add a selected-row bottom tray or inline expanded action strip with labeled `Keep / Archive / Done / Snooze / More`.
- Keep swipe as an accelerator only.
- Make row-level touch actions visible before the user learns gestures.

**Suggested Impeccable command:** `$impeccable adapt src/content_hoarder/templates/index.html src/content_hoarder/static/browse/browse.css`

## Recommended starting point

Start with **P1-B / P2-C together** because they are the user-selected direction B and share the same root: browse-mode triage actions should be visible, legible, and mobile-equivalent.

Working goal:

> On `/`, a saved item row should clearly answer: what is this, how can I preview/read it, and how do I Keep / Archive / Done it — with equivalent pointer, keyboard, and touch paths.

Suggested first implementation scope:

1. Improve row action labels/affordances in comfortable density.
2. Clarify selection vs source/avatar.
3. Add or design a mobile selected-row action tray.
4. Preserve `/triage` as the focused one-at-a-time decision mode.

## Open decisions before implementation

1. For desktop comfortable density, should row actions be:
   - always labeled (`Keep`, `Archive`, `Done`),
   - icon + label on hover/focus only,
   - or current icons with stronger tooltips/help?

2. For mobile row actions, should the pattern be:
   - tap row/select → bottom action tray,
   - inline expanded action strip per selected row,
   - or visible compact actions on every row?

3. Should `/` keep the prominent `TRIAGE →` link as-is, rename it to something like `Card mode`, or visually demote it now that both views are intentionally triage-capable?
