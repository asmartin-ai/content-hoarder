# SPEC — P3: Relay strip icon-only polish

**Task ID:** `p3-relay-icon-only`
**Worktree branch:** `delegate/p3-relay-icon-only`
**SW cache version on success:** `ch-shell-v82` (bump from `v77`)
**Source backlog item:** Epic 16, `BACKLOG.md` ~L1015 ("Relay strip visual polish (icon-only, no text labels)")

## Goal

The current relay strip (the long-press / right-click action menu that slides in beside a row) has
icon + text label (e.g. "Source", "Author", "Tag", "Share", "Snooze"). Per
`docs/design/mobile-nav-redesign/relay-observations.md`, the user wants **icon-only** — larger
buttons, 5 evenly-spaced well-sized icons, no text overlap on narrow screens. The `flex-direction:
column` layout that puts text under icons is removed; the touch targets size up.

This is a **visual polish pass** — no behavior changes. The 5 actions (source, author, tag, share,
snooze) stay the same; the click handler (`main.js` ~L1584) stays the same; the template structure
stays the same (the `<span class="relay-lbl">` elements stay in the DOM for accessibility but are
hidden visually).

## Files in scope

- `src/content_hoarder/templates/index.html` — the `<template id="relay-strip-tpl">` (~L746–840).
  The `.relay-lbl` spans stay (they carry the `data-relay-label` attribute used by `main.js` to set
  the per-item author label, ~L1564–1565) but get a class or `aria-hidden` so CSS can hide them
  visually while keeping them accessible to screen readers.
- `src/content_hoarder/static/browse/browse.css` — the `.relay-strip` / `.relay-btn` / `.relay-lbl`
  rules (~L1752–1828). The bulk of the work is here.
- `src/content_hoarder/static/sw.js` — bump `CACHE` to `ch-shell-v82`, update the comment.
- `src/content_hoarder/static/browse/main.js` — bump `APP_VERSION` to `v74`.

**Do NOT touch:** the relay click handler (`main.js` ~L1584–1602), `openRowMenu` / `closeRelay`
(`main.js` ~L1517–1581), `core/swipe.js`, any Python.

## Design constraints (locked — the user's request from the backlog + the relay-observations doc)

1. **Icon-only.** The `<span class="relay-lbl">` text labels are hidden visually. The icon (`<svg>`)
  is the sole visible content. Use the accessible-hide pattern (not `display: none`) so screen
  readers still announce the button via its `aria-label`:
   ```css
   .relay-lbl {
       position: absolute;
       width: 1px; height: 1px;
       margin: -1px; padding: 0; border: 0;
       clip: rect(0 0 0 0);
       clip-path: inset(50%);
       overflow: hidden;
       white-space: nowrap;
   }
   ```
   (This is the standard visually-hidden / sr-only pattern. Keep the existing `data-relay-label`
   JS that sets the author label — it still writes to the span, the span is just not shown.)
2. **Larger buttons.** The current `.relay-btn` is `min-width: 56px; min-height: 60px` with a 24px
   icon. Bump to: `min-width: 64px; min-height: 72px` (Pixel-6 touch target — Google's Material
   guideline is 48dp minimum, 72px gives comfortable thumb room). Icon `width`/`height` → `32px`.
   Keep `flex: 1 1 0` so the 5 buttons share the row evenly.
3. **Evenly spaced.** `justify-content: space-evenly` is already set on `.relay-strip` (L1758) —
   keep it. The 5 buttons each take `flex: 1 1 0`, so they're equal-width by construction. Verify
   on a 412px-wide viewport (Pixel-6) that all 5 fit without horizontal scroll (5 × 64px = 320px,
   leaving 92px for gaps + padding — comfortable). If they overflow at the narrowest viewport,
   reduce `min-width` to 56px (the original) before reducing icon size.
4. **No text overlap.** The current bug (text overlap on narrow screens) is caused by the
   `flex-direction: column` + `max-width: 12ch` on `.relay-lbl` fighting for space. Removing the
   visible text eliminates the overlap. Don't try to fix the overlap while keeping text — the
   decision is icon-only.
5. **Icon-only also on desktop.** The relay strip opens on right-click too (desktop, ~L1609). The
   icon-only treatment applies to both. The `aria-label` on each button (already set: "Open source",
   "Open author", etc.) is the desktop tooltip equivalent (browsers show `aria-label` as a tooltip
   on hover for `<button>` elements with no visible text — verify, and if not, add a `title`
   attribute matching the `aria-label`).
6. **Hover/focus states stay.** The existing `:hover`/`:active`/`:focus-visible` rules
   (L1812–1821) keep working — they're color/border/background changes, independent of the label.
7. **Reduced motion:** the existing `@media (prefers-reduced-motion: reduce)` block (L1823–1829)
   is unchanged.
8. **The `.relay-strip` background + slide-in animation stay.** Only the button internals change.

## Implementation sketch

### `templates/index.html` — `<template id="relay-strip-tpl">`

Each button already has an `aria-label` (confirmed by reading L750–855): `"Open source"`,
`"Open author"`, `"Tag"`, `"Share"`, `"Snooze"`. No structural change needed. The existing
short labels ("Tag" / "Share" / "Snooze") are acceptable for screen-reader announcement; the
agent MAY expand them to "Tag item" / "Share item" / "Snooze item" for clarity, but it's not
required. The `<span class="relay-lbl">` stays as-is (CSS hides it).

Optional: add `title` attributes matching the `aria-label` for desktop hover tooltips:
```html
<button type="button" class="relay-btn" data-relay="source" role="menuitem"
        aria-label="Open source" title="Open source">
```
This is the only HTML addition. If the agent prefers to skip `title` (relying on `aria-label`
alone), that's fine — note it in the report.

### `browse.css` — the `.relay-*` rules

```css
/* .relay-strip, .row.relay-open, .row.relay-open .item-fg, .row.relay-open .relay-strip,
   .relay-scrim, the @media (prefers-reduced-motion) block — all UNCHANGED. */

.relay-btn {
    flex: 1 1 0;
    min-width: 64px;        /* was 56px */
    min-height: 72px;       /* was 60px */
    display: inline-flex;
    flex-direction: column; /* keep — the .relay-lbl is still a child, just visually hidden */
    align-items: center;
    justify-content: center;
    gap: 0;                 /* was 5px — no visible gap needed with no visible label */
    padding: 8px 4px;
    border: 1px solid var(--border-control);
    border-radius: var(--r-md);
    background: var(--surface-app);
    color: var(--text-muted);
    text-decoration: none;
    cursor: pointer;
    transition:
        color var(--dur) var(--ease),
        border-color var(--dur) var(--ease),
        background var(--dur) var(--ease);
}
.relay-btn svg {
    width: 32px;            /* was 24px */
    height: 32px;           /* was 24px */
    flex: none;
}
.relay-lbl {
    /* visually hidden, accessible to screen readers */
    position: absolute;
    width: 1px; height: 1px;
    margin: -1px; padding: 0; border: 0;
    clip: rect(0 0 0 0);
    clip-path: inset(50%);
    overflow: hidden;
    white-space: nowrap;
}

/* :hover / :active / :focus-visible — UNCHANGED (L1812–1821) */

/* Narrow-viewport guard: if 5 × 64px overflows, drop min-width before dropping icon size. */
@media (max-width: 360px) {
    .relay-btn { min-width: 56px; min-height: 64px; }
    .relay-btn svg { width: 28px; height: 28px; }
}
```

**Don't change `flex-direction: column` to `row`** — the `.relay-lbl` is still a child element
and `column` keeps it in the layout flow (just visually hidden). Switching to `row` would put the
hidden span next to the icon, which is fine semantically but changes the centering math; `column`
+ visually-hidden is the lower-risk change.

## Acceptance

1. **Icon-only:** open the relay strip (long-press a row on mobile, right-click on desktop). The 5
   buttons show **only icons** — no "Source", "Author", "Tag", "Share", "Snooze" text visible.
2. **Larger touch targets:** each button is at least 64×72px (mobile) — verify in devtools that
   the computed `min-width`/`min-height` match. The icon is 32×32px.
3. **Evenly spaced:** the 5 buttons share the row width equally (`flex: 1 1 0`), with
   `space-evenly` gaps. No button is wider/narrower than the others.
4. **No text overlap on narrow screens:** at 412px viewport width (Pixel-6), no text overlaps
   (there's no visible text). At 360px (narrow), the `@media (max-width: 360px)` rule kicks in and
   the buttons shrink to 56×64px with 28px icons — still no overflow.
5. **Accessibility:** with a screen reader (or devtools Accessibility panel), each button is
   announced by its `aria-label` ("Open source", "Open author", "Tag", "Share", "Snooze" — or
   the expanded forms if the agent chose to update them). The `.relay-lbl` spans are present in
   the DOM (read them with `document.querySelectorAll('.relay-lbl')`) but not visible.
6. **Hover/focus:** desktop hover shows the color/border/background change (existing). Focus ring
   (`:focus-visible`) shows on keyboard nav. (If `title` attributes were added, hover also shows a
   tooltip — optional.)
7. **All 5 actions still work:** tap each icon → the right action fires (source/author navigate,
   tag opens editor, share opens share sheet, snooze snoozes). No behavior change.
8. **Reduced motion:** the strip still slides in/out; under `prefers-reduced-motion: reduce` the
   transition is 1ms (existing rule unchanged).
9. **Desktop right-click:** right-click a row → relay strip opens with the same icon-only treatment.

## Validation block

```
# 1. Unit suite — same 5 known env failures, no new.
python -m pytest -q -m "not ui" 2>&1 | tail -20

# 2. Confirm the .relay-lbl is still in the template (CSS-hidden, not removed):
grep -c 'relay-lbl' src/content_hoarder/templates/index.html   # -> 5 (one per button)
grep -c 'relay-lbl' src/content_hoarder/static/browse/browse.css   # -> 1 (the visually-hidden rule)

# 3. Confirm aria-labels present on all 5 buttons:
grep -c 'aria-label=' src/content_hoarder/templates/index.html | head   # spot-check; the relay template has 5

# 4. SW + APP_VERSION bumped:
grep 'const CACHE' src/content_hoarder/static/sw.js   # -> "ch-shell-v82"
grep 'APP_VERSION' src/content_hoarder/static/browse/main.js | head -1   # -> "v74"

# 5. UI smoke (manual, Pixel-6 viewport in devtools):
python -m content_hoarder serve
# - long-press a row → relay strip opens, 5 icons only, evenly spaced, no text
# - tap each icon → correct action fires (source/author/tag/share/snooze)
# - right-click a row (desktop) → same icon-only strip
# - devtools: toggle prefers-reduced-motion → strip still slides (1ms)
# - devtools: set viewport to 360px → buttons shrink, no overflow
# - devtools: Accessibility panel → each button has its aria-label
```

## Report back

- Branch: `delegate/p3-relay-icon-only`
- Files changed:
- Unit suite result:
- UI smoke result (each acceptance check):
- Did you add `title` attributes for desktop tooltips? (yes/no):
- Did the narrow-viewport `@media (max-width: 360px)` rule get used, or did 5 × 64px fit at 412px?
- Anything punted to T1:
