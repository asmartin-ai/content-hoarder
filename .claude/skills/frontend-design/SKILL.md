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

## content-hoarder design system (current)
- **Palette (dark):** `--bg #0f1115`, `--panel`, `--panel2`, `--text #e5e7eb`,
  `--muted`, **accent `--accent #2dd4bf` (teal)**, status colors `--keep` (green),
  `--danger` (red/archive), `--done` (blue). Keep the single-accent discipline.
- **Type scale:** `--fs-xs .75rem · --fs-sm .85rem · --fs-md .95rem · --fs-lg 1.15rem ·
  --fs-xl 1.4rem`. Headings use `letter-spacing:-.01em`.
- **Spacing:** `--sp-1 .25 · --sp-2 .5 · --sp-3 .75 · --sp-4 1 · --sp-5 1.5rem`.
- **Radius:** `--r-sm 8 · --r-md 12 · --r-lg 16px`. **Shadow:** `--shadow` for cards/popovers.
- **Motion:** `--ease cubic-bezier(.2,.7,.3,1)`, `--dur 160ms`.

## Mobile / PWA rules (do not regress)
- Target **Firefox on Android (Pixel 6)**. The triage card keeps its **40px `.card-stack`
  inset + 30px pointer edge-deadzone** so the system back-gesture never fires — never reduce it.
- Respect `env(safe-area-inset-*)`; `viewport-fit=cover` is set.

## Checklist before finishing a UI change
- [ ] New values reference tokens (no stray hex/px).
- [ ] Interactive elements have `:focus-visible`.
- [ ] Any animation has a reduced-motion fallback.
- [ ] Looks right at 375px (mobile) and ≥1100px (desktop).
- [ ] No new dependency / web font added.
