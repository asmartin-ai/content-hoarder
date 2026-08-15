---
name: frontend-design
description: "Design principles + content-hoarder's design system. Use when editing the UI (CSS/HTML/JS in src/content_hoarder/static or templates) to keep typography, spacing, color, motion, and accessibility consistent and avoid generic AI output."
---

# Frontend design — principles + content-hoarder design system

Distilled from the Codex-Frontend-Design-Toolkit (the lightweight, dependency-free
parts). Apply these when touching the UI. **No new runtime dependencies, no CDN web fonts,
no heavy frameworks** — this is a local-first vanilla-JS PWA. v3 ships Lexend + JetBrains
Mono as locally-vendored woff2 in `static/fonts/`.

> **v3 only (Epic 20 shipped; P3.5 retired the legacy pages 2026-07-04).** The app serves
> exactly **one** page — `/` (`index.html`, the v3 browse shell + `static/browse/*` +
> `static/core/*`). `/triage` → 302 `/?deck=1` and `/reddit` → 302 `/?source=reddit` are
> redirects, NOT live pages. There is **NO `/browse` route** — don't assert or link one.
> The v2 teal system (`static/tokens.css` + `triage.js`/`reddit.js`) is **deleted**; the
> single live token system is `static/core/tokens.css` (v3 "Log Book", apricot). Do NOT
> recreate v2 tokens or legacy page markup.

> **Shared ADHD design language (2026-06-12):** the cross-project *behavioral* principles
> (friction asymmetry, no backlog counts, guilt-free decay, recognition-over-recall
> resurfacing, shame-free copy, …) now live in
> **`K:\Projects\khaos\adhd-design-language\DESIGN-LANGUAGE.md`** — the single source of truth
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
   `@media (prefers-reduced-motion: reduce)` to disable (v3 makes this global in tokens.css).
6. **Accessibility is non-negotiable.** Visible `:focus-visible` rings on every interactive
   element; hit targets ≥ 40px on touch (v3 `--touch-min: 44px`); `aria-*` on icon-only
   controls.
7. **Depth via subtle elevation,** not heavy borders — small shadows + 1px hairline borders.
8. **Friction asymmetry (ADHD core thesis: process and reduce).** Actions that REDUCE the
   backlog (Archive, Done) must be the cheapest gestures in reach; the one action that
   PRESERVES items (Keep — the hoarder's exception) gets deliberate friction (e.g. the
   long-stage swipe, never the shortest gesture). When adding any new action, ask which
   side of reduce/preserve it sits on and price its gesture accordingly. (User-ratified
   2026-06-09 during the v3 Gate-1 review.)

## content-hoarder design system (source of truth: `static/core/tokens.css`)
All design values live in `src/content_hoarder/static/core/tokens.css` (linked from
`index.html`). **Theme via `data-theme="light"|"dark"` on `<html>`** (no attribute = dark,
the native "night ops" identity); light = "daylight ops". `theme.js` persists the choice and
applies it before first paint. **v3 rule: components consume the SEMANTIC ALIASES
(`--surface-*`, `--text-*`, `--status-*`, `--border-*`, `--focus-ring`), not raw tokens.**
- **Surfaces (night):** `--bg #101216`, `--panel #171a21`, `--panel2 #20242d`,
  `--row-hover`, `--border #2a2f3a`, `--border-strong #3d4452`. Daylight inverts
  (`--bg #e1e5ea`, `--panel #edf0f3`). **Text:** `--text #e0e5ec`, `--muted`, `--dim`.
- **Accent (one brand apricot):** `--accent #f2a97e` night / `#a96a05` light, plus
  `--accent-strong`, `--accent-ink` (text on an accent fill), `--accent-tint` (wash),
  `--led-glow` (0 0 8px accent) for the "phosphor" cockpit feel.
- **Status language (fixed):** **keep = blue** `--keep`, **archive = green** `--archive`,
  **done = red** `--done`; each has an `-ink` (text-on-fill) and `-tint` variant. Consume
  the semantic `--status-*` aliases.
- **Source badges (theme-independent):** `--source-reddit|youtube|hackernews|obsidian|keep|firefox|twitter`.
- **Type:** Lexend (humans) + JetBrains Mono (instruments — counts, gauges, keys), both
  vendored woff2, no CDN. `--fs-xs .73 · --fs-sm .85 · --fs-md .97 · --fs-lg 1.18 ·
  --fs-xl 1.45rem`; weights `--fw-regular 400 … --fw-bold 700`. Headings
  `letter-spacing:-.01em`; `--lh-tight 1.26 / --lh-snug 1.32 / --lh-normal 1.55`.
- **Spacing:** `--sp-1 .25 … --sp-5 1.5rem`. **Radius (soft "Pebble"):**
  `--r-sm 8 · --r-md 14 · --r-lg 20 · --r-pill 999px`. **Elevation:**
  `--shadow-row / --shadow-pop` (theme-tuned).
- **Motion:** `--ease cubic-bezier(.25,.9,.35,1)`, `--dur 150ms`
  (`--dur-fast 120 / --dur-slow 200`). Reduced-motion is global, handled once in tokens.css.
- **Icons:** `core/icons.js` (ES module) exports `chIcon("keep"|"archive"|"done"|"firefox")` →
  inline SVG (recolors via `currentColor`) and `fillIcons(root)` to hydrate static `[data-ico]`
  placeholders (call it on init). All views import it.
- **Inbox:** three densities (compact/comfortable/card) via a class on `.items`; rows have a
  source avatar that swaps to a select checkbox, hover-revealed icon actions, and swipe
  (right = archive, left = done). Browse keys: J/K move · S keep · E archive · Y done · X select.

## Mobile / PWA rules (do not regress)
- Target **Chrome on Android (Pixel 6)**. The deck keeps its **40px card edge-inset + 30px
  pointer edge-deadzone** (`browse.css` `.deck-host`/`.deck-card`) so the system back-gesture
  never fires — never reduce it.
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
- **Playwright scrim clicks on bottom sheets:** `locator("#scrim").click()` aims at
  the scrim's center; on mobile bottom sheets the visible sheet often covers that
  point, so Playwright reports an intercept from a sheet child. Close sheets with
  `Escape` or click a measured coordinate outside the sheet instead of assuming the
  scrim locator itself is clickable.
- Container queries (`container-type:inline-size` on the frame) make the phone toggle
  genuinely responsive — but see the `Codex-preview-verify` skill (#6/#7) before
  asserting any of it in the preview (0-width fresh viewports; frozen transitions).
- **Rendering an app mockup via `show_widget` (visualize MCP):** its house style (sentence-case only,
  two font-weights, transparent outer bg, **no `position:fixed`**) fights an app's own design language.
  Wrap the app-styled phone in a neutral host container (`background:var(--color-background-secondary)`),
  give the phone its OWN tokens + dark bg, anchor overlays (drawer/scrim/sheet) with `position:absolute`
  inside a `position:relative` faux-viewport (never `fixed` — it collapses the iframe height), and
  deliberately deviate on uppercase labels / weights *inside* the frame for fidelity. Icons: Tabler
  (`ti ti-*`, human-made/MIT) or the app's `icons.js` — never AI-drawn art.

## Where design artifacts live (repo conventions)
- **`design-ref/` is git-ignored** (root `.gitignore`) — it's LOCAL reference material (the v3 explorations,
  mockups, bulky screen-recordings/frame sets), never committed. Don't try to commit into it.
- **Version-controlled design docs go in `docs/`** (docs-as-code) — e.g. `docs/design/<topic>/`. Commit the
  markdown plus only the SMALL images it embeds; keep bulky raw source (videos, full frame extractions) OUT of
  git (local in `design-ref/`, regenerable via ffmpeg; git-LFS or external storage only if it must be versioned).
- **Gotcha: `git add <ignored-path>` adds nothing and still exits 0** (prints a hint, not an error) — a commit
  can silently omit the files you meant to add. After staging into a tree with ignored dirs, **verify the staged
  count** (`git diff --cached --name-only | wc -l`) before committing; use `git add -f` only deliberately.

## Checklist before finishing a UI change
- [ ] New values reference tokens (no stray hex/px); status colors use `--status-*` aliases.
- [ ] Works in both light and dark (`data-theme`); on-fill text uses an `-ink` token.
- [ ] Interactive elements have `:focus-visible`.
- [ ] Any animation has a reduced-motion fallback (global in v3; per-component where added).
- [ ] Looks right at 375px (mobile) and ≥1100px (desktop).
- [ ] No new dependency / web font added.
