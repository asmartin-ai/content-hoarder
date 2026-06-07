---
name: frontend-design
description: "Design principles + content-hoarder's design system. Use when editing the UI (CSS/HTML/JS in src/content_hoarder/static or templates) to keep typography, spacing, color, motion, and accessibility consistent and avoid generic AI output."
---

# Frontend design — principles + content-hoarder design system

Distilled from the Claude-Code-Frontend-Design-Toolkit (the lightweight, dependency-free
parts). Apply these when touching the UI. **No new runtime dependencies, no web fonts, no
heavy frameworks** — this is a local-first vanilla-JS PWA.

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

## Checklist before finishing a UI change
- [ ] New values reference tokens (no stray hex/px); status colors use `--keep/--archive/--done`.
- [ ] Works in both light and dark (`data-theme`); on-fill text uses an `-ink` token.
- [ ] Interactive elements have `:focus-visible`.
- [ ] Any animation has a reduced-motion fallback.
- [ ] Looks right at 375px (mobile) and ≥1100px (desktop).
- [ ] No new dependency / web font added.
