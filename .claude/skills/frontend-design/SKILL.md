---
name: frontend-design
description: "Design principles + content-hoarder's design system. Use when editing the UI (CSS/HTML/JS in src/content_hoarder/static or templates) to keep typography, spacing, color, motion, and accessibility consistent and avoid generic AI output."
---

# Frontend design — principles + content-hoarder design system

Distilled from the Claude-Code-Frontend-Design-Toolkit (the lightweight, dependency-free
parts). Apply these when touching the UI. **No new runtime dependencies, no CDN web fonts,
no heavy frameworks** — this is a local-first vanilla-JS PWA (locally-vendored woff2 is
allowed; v3 ships Lexend + JetBrains Mono in `static/fonts/`).

> **v3 transition (Epic 20, 2026-06-09):** the sections below describe the **v2** system,
> which still governs `/triage` + `/reddit` and legacy `static/tokens.css`. **v3 pages**
> (browse rewrite onward, branch `feat/frontend-v3`) use `static/core/tokens.css` —
> "Log Book II" design: charcoal night + apricot accent / dimmed daylight light, Lexend +
> JetBrains Mono, soft radii, components consume the semantic aliases only. Spec:
> `design-ref/v3-explorations/05-log-book-2.html` + README there. Rewrite this skill to
> v3 once Epic 20 ships all three pages.
>
> **Page→route map (verified 2026-06-11):** the app serves exactly three pages — `/`
> (the v3 browse shell, `index.html` + `static/browse/*`), `/triage`, and `/reddit`
> (both still v2). There is **NO `/browse` route** — don't assert or link one.

> **Shared ADHD design language (2026-06-12):** the cross-project *behavioral* principles
> (friction asymmetry, no backlog counts, guilt-free decay, recognition-over-recall
> resurfacing, shame-free copy, …) now live in
> **`K:\Projects\adhd-design-language\DESIGN-LANGUAGE.md`** — the single source of truth
> shared with PKMS (Epic 23). Consult it before designing any new surface/flow/copy;
> reference by path, never copy. This skill keeps the content-hoarder-specific visual
> system (tokens, gestures, PWA rules) below.

## Principles (avoid generic AI output)
1. **Tokens, not magic numbers.** Every color/space/size/radius/shadow comes from a CSS
   custom property in `:root`. One change should ripple everywhere.
2. **A real type scale.** Use the `--fs-*` ramp (not ad-hoc rem). Headings get tighter
   `letter-spacing` and `line-height`; body stays at 1.5–1.65.
3. **A spacing rhythm.** Use the `--sp-*` ramp; consistent vertical rhythm beats random gaps.
4. **Contrast + hierarchy.** Body text ≥ 4.5:1 on its background; muted text ≥ 3:1 and only
   for secondary info. Lead with one clear focal element per view.
5. **Restrained motion.** Short (120–200ms), eased, purposeful. ALWAYS wrap in
   `@media (prefers-reduced-motion: reduce)` to disable.
6. **Accessibility is non-negotiable.** Visible `:focus-visible` rings on every interactive
   element; hit targets ≥ 40px on touch; `aria-*` on icon-only controls.
7. **Depth via subtle elevation,** not heavy borders — small shadows + 1px hairline borders.
8. **Friction asymmetry (ADHD core thesis: process and reduce).** Actions that REDUCE the
   backlog (Archive, Done) must be the cheapest gestures in reach; the one action that
   PRESERVES items (Keep — the hoarder's exception) gets deliberate friction (e.g. the
   long-stage swipe, never the shortest gesture). When adding any new action, ask which
   side of reduce/preserve it sits on and price its gesture accordingly. (User-ratified
   2026-06-09 during the v3 Gate-1 review.)

## content-hoarder design system (source of truth: `static/tokens.css`)
All design values live in `src/content_hoarder/static/tokens.css` (linked before `app.css`
in every template). **Theme via `data-theme="light"|"dark"` on `<html>`** (no attribute =
dark, the native identity); `theme.js` persists the choice and applies it before first paint.
- **Surfaces (dark):** `--bg #0f1115`, `--panel #171a21`, `--panel2 #1e222b`, `--row-hover`,
  `--border #262b34`, `--border-strong`. Light inverts (`--bg #f5f6f8`, `--panel #fff`).
  **Text:** `--text`, `--muted`, `--dim`.
- **Accent (one brand teal):** `--accent #56c4b5` dark / `#2a9d8f` light, plus
  `--accent-strong`, `--accent-ink` (text on an accent fill), `--accent-tint` (wash).
- **Status language (fixed):** **keep = blue** `--keep`, **archive = green** `--archive`,
  **done = red** `--done`; each has an `-ink` (text-on-fill) and `-tint` variant. Use the
  token, never the hex; `--danger` is a legacy alias for `--archive`.
- **Source badges (theme-independent):** `--source-reddit|youtube|hackernews|obsidian|keep|firefox`.
- **Type:** system stack only; `--fs-xs .75 · --fs-sm .85 · --fs-md .95 · --fs-lg 1.15 ·
  --fs-xl 1.4rem`; weights `--fw-medium 600 / --fw-bold 700 / --fw-heavy 800`. Headings
  `letter-spacing:-.01em`.
- **Spacing:** `--sp-1 .25 … --sp-5 1.5rem`. **Radius:** `--r-sm 8 · --r-md 12 · --r-lg 16 ·
  --r-pill`. **Elevation:** `--shadow-row / --shadow-pop / --shadow-toast` (theme-tuned;
  `--shadow` aliases `--shadow-pop`).
- **Motion:** `--ease cubic-bezier(.2,.7,.3,1)`, `--dur 160ms` (`--dur-fast 120 / --dur-slow 200`).
- **Icons:** `static/icons.js` → `window.chIcon("keep"|"archive"|"done")` returns inline SVG
  (recolors via `currentColor`); any static `[data-ico]` element is auto-filled on load.
- **Inbox:** three densities (compact/comfortable/card) via a class on `.items`; rows have a
  source avatar that swaps to a select checkbox, hover-revealed icon actions, and swipe
  (right = archive, left = done). Browse keys: J/K move · S keep · E archive · Y done · X select.

## Mobile / PWA rules (do not regress)
- Target **Firefox on Android (Pixel 6)**. The triage card keeps its **40px `.card-stack`
  inset + 30px pointer edge-deadzone** so the system back-gesture never fires — never reduce it.
- Respect `env(safe-area-inset-*)`; `viewport-fit=cover` is set.

## Standalone mockups & device frames (gotchas that shipped broken phone views once)
When building self-contained HTML mockups with a phone-frame toggle (the v3 Gate-1 round):
- **Fixed screen + inner scroller**, not a scrolling frame: `.frame{overflow:hidden;
  height:<screen>}` + `.scroll{height:100%;overflow-y:auto;overflow-x:clip}` wrapping only
  the page content. Overlays (dock, bottom sheets, bulk bar, toast, scrim) live OUTSIDE the
  scroller, `position:absolute`, anchored to the frame — otherwise `bottom:0` anchors to the
  scrolled CONTENT and sheets render off-screen below the visible viewport.
- **Off-canvas panels need `visibility:hidden`** when closed (with a `transition:
  visibility 0s <dur>` for the exit animation). A panel translated out by 105% still
  contributes to `scrollWidth` → phantom horizontal scrolling (measured 158px once).
- **Verify by measurement, not presence**: per density/breakpoint assert
  `scroller.scrollWidth - scroller.clientWidth === 0`, fixed row heights via
  `getComputedStyle().height`, and overlay rects within the frame rect. "The element
  exists" catches none of these.
- Container queries (`container-type:inline-size` on the frame) make the phone toggle
  genuinely responsive — but see the `claude-preview-verify` skill (#6/#7) before
  asserting any of it in the preview (0-width fresh viewports; frozen transitions).

## Checklist before finishing a UI change
- [ ] New values reference tokens (no stray hex/px); status colors use `--keep/--archive/--done`.
- [ ] Works in both light and dark (`data-theme`); on-fill text uses an `-ink` token.
- [ ] Interactive elements have `:focus-visible`.
- [ ] Any animation has a reduced-motion fallback.
- [ ] Looks right at 375px (mobile) and ≥1100px (desktop).
- [ ] No new dependency / web font added.
