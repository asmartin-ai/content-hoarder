# Tier 1 — Mobile "Jump" drawer · design spec

**Status:** approved direction (2026-06-15), prototype-validated (interactive mockup rendered in-session, v2).
**Replaces:** the mobile **`# tags` pill** (`#open-tags-phone`, `.spill.tagsbtn`) + the **`#tagsheet`** bottom sheet.
**Sources:** [`content-hoarder-recommendations.md`](content-hoarder-recommendations.md) (C1–C7), the Relay/Sync
studies ([`relay-observations.md`](relay-observations.md), [`sync-observations.md`](sync-observations.md)).
**Design constraints (non-negotiable):** preserve Fable's v3 "Log Book II" language — **reuse existing tokens,
components, and mechanisms, don't invent new paradigms** ([[preserve-fable-design]]); **no AI-generated art/icons**
([[no-ai-art-icons]]).

---

## 1. Purpose

The current mobile nav (a `# tags` pill that opens a bottom sheet) is *too many taps* and *hinders jumping
idea-to-idea*. Tier 1 replaces it with a **left slide-in drawer**: one searchable, grouped surface for jumping
between **sources, categories, and tags** in a tap or two. Desktop is unchanged — the `.rail` already does this.

## 2. Scope

**In Tier 1:** the drawer (C1), persistent live-filter search (C2), grouped jump list (C3), per-row
coloured icon + SI count + star-to-pin + ⋮ actions (C4/C5), section visibility (C6).

**Explicitly out (deferred or rejected):**
| Item | Disposition |
|---|---|
| Status (Inbox/Keep/Archived/Done/All) | **Stays separate** — keep the existing `.folders` / `.statuspills`. The drawer is a different axis (where content lives), not workflow state. |
| Mine \| Search scope tabs (C7) | **Dropped** — CH's sources are fixed connectors and tags are user-owned; "discover" reduces to "+ New tag". |
| Swipe-to-triage (Tier 2) | Later. Carries the **friction-asymmetry** rule (§9). |
| Density picker, customizable action grid, detail/media (Tiers 3–5) | Later. |

## 3. Locked decisions

- **Drawer**, not a redesigned sheet. Slides from the **left**, dims the list behind a scrim.
- Group order: **Pinned → Sources → Categories → Tags**. **Categories are their own group** (not merged into
  tags); **Sources sit on top** of the content groups.
- **Counts kept**, **SI-abbreviated** (`5000`→`5k`, `12650`→`13k`, `1.2M`→`1.2m`); right-aligned fixed column,
  full value on hover/`title`. These are *navigational* counts (where content is), not a guilt-inducing global
  backlog total — consistent with the no-backlog-counts principle.
- **Per-row actions** via a star (pin) + ⋮ (action sheet). **Pinned** items also surface in the Pinned group.
- Icons: human-made only — the app's `static/icons.js` (`window.chIcon`) in-app, Tabler Icons (MIT, Paweł Kuna)
  where a glyph isn't in the app set, credited. Coloured dots / the apricot LED are CSS, not art.
- Port by **reusing Fable mechanisms**, not new ones (§8).

## 4. Anatomy

```
┌─ drawer (left, ~87% width, max 302px) ──────────┐
│ ● Jump to…                                  [✕] │  header (apricot LED + title + close)
│ ┌─────────────────────────────────────────────┐ │
│ │ 🔍  filter sources & tags…                  │ │  live-filter search (pill)
│ └─────────────────────────────────────────────┘ │
│ PINNED                                       3   │  group header (label + #rows + chevron)
│   ● Reddit                  18k   ★   ⋮          │  row: icon · label · count · star · ⋮
│   ● Tech                    6.1k  ★   ⋮          │
│   # watch-later             13k   ★   ⋮          │
│ SOURCES                                      6   │
│   ● Reddit / YouTube / Hacker News / …           │
│ CATEGORIES                                   7   │
│   ● Tech / Music / Cooking / …                   │
│ TAGS                                        10   │
│   # tutorial / reference / …                     │
│ ───────────────────────────────────────────────  │
│ [＋ New tag]                          [⚙ manage] │  footer: add + section-visibility
└──────────────────────────────────────────────────┘
```

**Row** (min-height 46px, ≥44px touch): `[colored icon 30px] [label · flex, ellipsis] [count · SI, dim, mono]
[star 30px] [⋮ 30px]`. Source rows use the `--source-*` hue + brand glyph; category rows use a folder glyph in
`--accent`; tag rows use a hash glyph in `--muted`.

## 5. Interactions & states

| Trigger | Behaviour |
|---|---|
| Open | `☰` (replaces the `# tags` pill), left edge-swipe. Drawer slides in (`--dur-slow` 200ms, `--ease`); scrim fades to `rgba(5,7,10,.55)`; search autofocuses. |
| Close | scrim tap · `✕` · `Esc` · row select. Drawer slides out; **`visibility:hidden` when closed** (avoids phantom horizontal scroll — per the frontend-design mockup gotchas). |
| Live filter | typing filters rows across all groups by substring (case-insensitive); matches highlight `--accent`; empty groups hide; no-match shows an empty state. |
| Collapse group | tap group header → toggle; chevron rotates −90°. |
| Pin | star toggles pinned; pinned rows also render in the Pinned group; toast confirms. |
| Row select | sets the active source/tag/category filter, closes the drawer, shows an **active chip** in the shelf (`#fchips` area) with an `✕` to clear. Integrates with the existing browse filter state. |
| ⋮ | opens a bottom action sheet (reuses the sheet/scrim pattern): Pin · Mute · Rename · Hide-from-drawer. |
| Section visibility | the footer ⚙ → show/hide whole groups (C6). |

**A11y / motion:** `:focus-visible` apricot ring on every control; `aria-label` on icon-only buttons; rows are
`role="button" tabindex=0` (Enter/Space activate); all motion inside `@media (prefers-reduced-motion:reduce)`;
respects `env(safe-area-inset-*)`.

## 6. Visual spec (all from `static/core/tokens.css`)

- Surfaces: drawer `--panel`, search/sheet `--panel2`, hover `--row-hover`, border `--border` / `--border-strong`.
- Accent apricot `--accent #f2a97e`; active row `--accent-tint`; LED uses `--led-glow`.
- Type: Lexend; counts in **JetBrains Mono** (`--font-mono`); group labels uppercase, `--fw-semibold`,
  letter-spacing .12em, ≥11.5px. Radii: rows `--r-md`, search/chips `--r-pill`, sheet 18px.
- Motion: `--ease cubic-bezier(.25,.9,.35,1)`, open `--dur-slow`, micro `--dur`.
- Works in **both themes** (`data-theme`): verify the light "Day log" palette too (prototype shown in dark only).

## 7. Data & wiring

- **Sources / tags** already render into the desktop `.rail` (`#rail-sources`, `#rail-tags`). Refactor the
  populate step so **one render fills both the rail and the drawer** from the same data (no duplicate logic).
- **Counts:** per-source / per-tag item counts (the rail may already compute these; confirm). SI-format at render.
- **Active filter:** selecting a row drives the same filter pathway the rail/`#fchips` already use (so desktop
  and mobile share filter state + the chip UI).
- **⚠ Categories — open data dependency:** categories are currently folded into the tag system. The spec assumes a
  **separable category facet** (the Epic 1 P2 LLM auto-classifier produces categories — confirm there's a distinct
  field). *If no category facet exists yet, ship **Sources + Tags** first and add the Categories group when the
  facet lands.*

## 8. Port plan — reuse Fable, don't reinvent

| File | Change | Notes |
|---|---|---|
| `templates/index.html` | Replace `#open-tags-phone` with a `☰` control; replace the `#tagsheet` aside with a `.navdrawer` aside that **reuses the existing `.scrim` (`#scrim`) overlay** and mirrors the `.sheetpanel` slide pattern. Desktop `.rail` untouched. | not off-limits |
| `static/browse/browse.css` | Drawer styles built from existing tokens; reuse `.rail`/pill/row rules where possible; mobile-only (`.rail` stays the desktop expression of the same content). | not off-limits |
| `static/browse/main.js` | Drawer open/close controller, shared rail+drawer render, live-filter, pin state, section-visibility, active-filter wiring. | **OFF-LIMITS** — owned by the `ch-hydration` worktree (it edits `main.js`). **Coordinate timing: port after that branch merges to staging.** |

Net new design surface is minimal: a left drawer is the mobile expression of the existing `.rail`, using the
existing overlay/scrim mechanism — it should read as "always been part of Log Book."

## 9. Carry-forward to later tiers

- **Friction asymmetry (Tier 2 swipe-triage):** Archive/Done = cheapest gestures; **Keep = deliberate friction**
  (longer swipe). Correct the earlier "right = Keep" proposal in the recommendations doc when Tier 2 is designed.
- **Light-theme pass:** verify the drawer in "Day log" before shipping.
- **Section-visibility persistence:** which groups are hidden should persist (localStorage, like theme/density).

## 10. Build sequence (suggested)

1. Markup + CSS for the drawer shell (static, reuses scrim) — *delegatable*.
2. Shared rail+drawer render + SI counts — *delegatable (well-specified)*.
3. Live-filter + collapse + pin + active-filter wiring (main.js) — Claude, after worktree merge.
4. Section-visibility + persistence.
5. Light-theme + a11y + reduced-motion verification (Claude Preview).
