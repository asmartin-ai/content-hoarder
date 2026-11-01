---
name: content-hoarder
description: Local-first saved-content triage cockpit for search, recovery, media review, and backlog reduction.
colors:
  night-bg: "#101216"
  night-panel: "#171a21"
  night-inset: "#20242d"
  night-hover: "#1b1f27"
  night-border: "#2a2f3a"
  night-border-strong: "#3d4452"
  night-text: "#e0e5ec"
  night-muted: "#98a2b3"
  night-dim: "#636e7e"
  flight-bg: "#e1e5ea"
  flight-panel: "#edf0f3"
  flight-inset: "#d6dce3"
  flight-text: "#17222d"
  phosphor-accent: "#f2a97e"
  phosphor-accent-strong: "#ffc29d"
  keep-blue: "#7da4f5"
  archive-green: "#54c794"
  done-red: "#ef7568"
  reddit-orange: "#ff5722"
  youtube-red: "#ff3b30"
  hackernews-orange: "#ff8a3d"
  obsidian-purple: "#a78bfa"
  keep-yellow: "#fbbc04"
  firefox-blue: "#4a9df8"
  twitter-blue: "#1d9bf0"
typography:
  display:
    fontFamily: "Lexend, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "1.45rem"
    fontWeight: 700
    lineHeight: 1.26
    letterSpacing: "-0.01em"
  headline:
    fontFamily: "Lexend, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "1.18rem"
    fontWeight: 700
    lineHeight: 1.32
  title:
    fontFamily: "Lexend, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "0.97rem"
    fontWeight: 600
    lineHeight: 1.32
  body:
    fontFamily: "Lexend, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "0.97rem"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "JetBrains Mono, ui-monospace, Cascadia Mono, Consolas, monospace"
    fontSize: "0.73rem"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "0.02em"
rounded:
  sm: "8px"
  md: "14px"
  lg: "20px"
  pill: "999px"
spacing:
  xs: "0.25rem"
  sm: "0.5rem"
  md: "0.75rem"
  lg: "1rem"
  xl: "1.5rem"
components:
  button-primary:
    backgroundColor: "{colors.phosphor-accent}"
    textColor: "#2e1605"
    rounded: "{rounded.sm}"
    height: "34px"
    padding: "0 0.85rem"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.night-text}"
    rounded: "{rounded.sm}"
    height: "34px"
    padding: "0 0.85rem"
  search-command:
    backgroundColor: "{colors.night-panel}"
    textColor: "{colors.night-text}"
    rounded: "{rounded.pill}"
    height: "42px"
    padding: "0 16px"
  item-row:
    backgroundColor: "{colors.night-panel}"
    textColor: "{colors.night-text}"
    rounded: "{rounded.md}"
    padding: "0.75rem 1rem"
  status-chip:
    backgroundColor: "rgba(242,169,126,0.11)"
    textColor: "{colors.phosphor-accent-strong}"
    rounded: "{rounded.pill}"
    padding: "5px 10px"
---

# Design System: content-hoarder

## 1. Overview

**Creative North Star: "The Local Log Book"**

content-hoarder should feel like a personal operations log for reducing a messy backlog: calm enough to keep the user from bouncing, fast enough that a decision costs one tap, and tactile enough that each decision feels confirmed. It has three rooms (see `docs/design/clear-overhaul.md`): **Today** (`/`, lamp mode — one lit object, "Clear 10"), **Clear** (`/clear`, focus mode — one card at a time in a finite round), and **Library** (`/library`, bench mode — search, filters, the reader). A dark “night ops” default with a daylight alternate, Lexend for human-readable scanning, JetBrains Mono for instrument readouts, fixed action colors, and source badges that identify content without turning the app into confetti.

The system rejects generic SaaS polish, decorative hero language, and any UI that celebrates hoarding more content. Visual decisions serve search, filtering, triage, media review, recovery, and error recovery. Empty states should feel like permission to stop; error states should be specific and non-blaming.

**Key Characteristics:**
- Dense, legible list-first layouts with optional card/pinboard density, not endless nested cards.
- Restrained dark-first palette with one warm phosphor action accent and a stable status triad.
- Tactile controls: pills, pebbles, command bars, row actions, and sheet panels with short state transitions.
- Media previews and source glyphs that help decide quickly without stealing the whole hierarchy.
- Copy that reduces guilt: “Cleared”, “That’s enough for today”, “Nothing is deleted; undo any time”, “nothing carries over”.

## 2. Colors

The palette is restrained and operational: charcoal cockpit surfaces, apricot phosphor for current action, and fixed semantic colors for triage state.

### Primary
- **Apricot Phosphor** (`#f2a97e`): the active product accent on v3 browse for focus rings, command prompt, current selection, and “inbox/current work” emphasis. It should remain rare; if more than roughly 10% of a screen is accent, the interface is shouting.
- **Ember Fill** (`--ember-fill` `#f2a97e` with `--ember-fill-ink` `#2e1605`, both themes): the one lit object — Today's “Clear 10” hero and the primary button on the cleared screen. Only lamp-mode surfaces get the soft glow.

### Secondary
- **Keep Blue** (`#7da4f5`): “worth revisiting” status, Keep actions, and keep-tinted feedback.
- **Archive Green** (`#54c794`): “set aside, out of the way” status, Archive actions, clear/swept progress, and non-destructive archive feedback.
- **Done Red** (`#ef7568`): “finished with it” status, Done actions, and completion/destructive-adjacent states. Reserve stronger warning language for irreversible deletes/purges.

### Tertiary
- **Source Badges** (`#ff5722`, `#ff3b30`, `#ff8a3d`, `#a78bfa`, `#fbbc04`, `#4a9df8`, `#1d9bf0`): source identity only. They belong in avatars, glyphs, rails, and small source marks, not in structural controls.
- **Win Green** (`--win` `#8fce96` / light `#22713a`): celebration only — pebbles, the CLEARED stamp. Archive-green is a triage verb and keeps its own token.
- **Moss** (`--moss` `#a3bd97` / light `#4d6843`): the resurfacing question (“Still curious about …?”) on Today.

### Neutral
- **Night Ops Background** (`#101216`): default app field for v3 browse.
- **Panel Stack** (`#171a21`, `#20242d`, `#1b1f27`): cards, inset controls, hovered rows, sheet panels, and row bodies.
- **Hairline Stack** (`#2a2f3a`, `#3d4452`): row dividers, control borders, and focusable shells.
- **Readable Ink** (`#e0e5ec`, `#98a2b3`, `#7b8798`; light theme `#5a6875` for the dim step): body, metadata, and tertiary hints. Muted text must remain readable at AA; the dim step carries small meta and must not drop below 4.5:1 on its surface.
- **Daylight Ops Stack** (`#e1e5ea`, `#edf0f3`, `#d6dce3`, `#17222d`): light theme for bright environments, not a separate brand.

### Named Rules

**The One Accent Rule.** On v3 browse, apricot phosphor is the only product accent. Keep / Archive / Done colors are semantic states, and source hues are identity marks. Do not invent decorative accents.

**The Semantic Status Rule.** Keep is blue, Archive is green, Done is red. Do not remap these by page, density, or mood.

**The No Panic Rule.** Irreversible or failure states can be clear and red-adjacent, but backlog volume and empty/error copy must not become alarmist.

## 3. Typography

**Display Font:** Lexend with system sans fallback.  
**Body Font:** Lexend with system sans fallback on every surface.
**Label/Mono Font:** JetBrains Mono for instrument labels, counts, keyboard hints, indexes, and command syntax.

**Character:** Lexend’s open letterforms support quick scanning across messy saved-content titles. JetBrains Mono marks the “instrument panel” layer: counts, operators, keyboard shortcuts, and batch readouts.

### Hierarchy
- **Display** (700, `1.45rem`, `1.26`, `-0.01em`): page headings, empty-state titles, and brand-scale text. Product UI should not use giant fluid hero type.
- **Headline** (700, `1.18rem`, `1.32`): sheet headings, panel headings, and triage card emphasis.
- **Title** (600, `0.97rem`, `1.32`): saved-item titles, row headings, operator labels.
- **Body** (400, `0.97rem`, `1.55`): readable item snippets, settings explanations, recovery notes, and empty/error prose. Keep prose around 65–75ch when it runs long.
- **Label** (600, `0.73rem`, mono, slight tracking): source/status labels, keyboard affordances, counts, and technical state. Use all-caps sparingly for tool chrome, not marketing eyebrows.

### Named Rules

**The Scan First Rule.** Titles, metadata, duration, tags, and source must be distinguishable in one glance. If the user has to reread a row to find the decision signal, the hierarchy failed.

**The Product Type Rule.** No display fonts, ornamental serifs, or huge marketing headers in task surfaces. This is a tool, not a landing page.

## 4. Elevation

Depth is mostly tonal layering plus hairline borders. Shadows are reserved for overlays, popovers, lightboxes, and sheet panels that must separate from dense content. Rows and cards should feel placed on a ledger, not floating in a SaaS card grid.

### Shadow Vocabulary
- **Row Shadow** (`0 1px 0 rgba(0,0,0,.22)` dark / `0 1px 0 rgba(30,40,50,.07)` light): structural row separation only.
- **Pop Shadow** (`0 14px 44px rgba(0,0,0,.5)` dark / `0 12px 32px rgba(30,40,50,.25)` light): popovers, drawers, sheet panels, lightboxes, and menus.
- **LED Glow** (`0 0 8px var(--accent)`): the tiny live/status brand pebble only. Do not generalize it into neon UI.

### Named Rules

**The Ledger, Not Cards Rule.** Use rows, sheets, rails, and tonal groups before reaching for card stacks. Nested cards are prohibited.

**The Shadow Has a Job Rule.** A shadow means overlay, focus, or separation. If a shadow is only decorative, remove it.

## 5. Components

### Buttons
- **Shape:** tactile rectangles or pills depending on context (`8px` for normal buttons, `999px` for command/pill controls; `20px` for the hero and the round's big Done/Archive pad).
- **Primary:** filled with the accent (`--ember-fill` for the one lit object, `--accent` elsewhere), high-contrast ink, medium weight, and short state transitions.
- **Hover / Focus:** border or fill shifts plus a visible `2px` focus ring using the accent. Active states may move `translateY(1px)`; avoid dramatic motion.
- **Status actions:** Keep / Archive / Done controls carry their fixed semantic colors and must keep text/icon labels available, especially on touch.

### Chips
- **Style:** small pill chips with tinted backgrounds, mono or compact sans labels, and enough contrast for metadata use.
- **State:** selected operator/status chips use accent tint and stronger text; source chips use source hues only as identity marks. Overflow tags collapse behind `+N more` rather than flooding rows.

### Cards / Containers
- **Corner Style:** gentle corners (`14px` medium, `20px` large panels) with pills for controls.
- **Background:** panel stack over app field; insets use the second panel layer.
- **Shadow Strategy:** flat by default; pop shadow only for overlays.
- **Border:** hairline borders define controls, rows, and panels. No colored side-stripe borders.
- **Internal Padding:** compact rhythm (`0.5rem`, `0.75rem`, `1rem`, `1.5rem`) tuned for scan density.

### Inputs / Fields
- **Style:** command/search inputs are pill-shaped shells with panel backgrounds, border-control strokes, a prompt glyph, and inline hinting.
- **Focus:** accent border plus a subtle accent tint ring; never remove focus outlines.
- **Error / Disabled:** errors should state the recovery path (“Couldn’t load — is the server up?”) and disabled destructive controls should explain what confirmation is missing.

### Navigation
- **Style:** one shared nav (`static/core/nav.css`, `.ch-nav`) with three tabs — Today · Clear · Library. Desktop (> 700px): a sticky 56px top bar. Phone (≤ 700px): a fixed bottom tab bar with labels under icons. A running round hides the nav (focus mode). Inside the Library: sticky console, status folders, rail facets, sheet panels, row actions; on phones status pills, drawer, tap actions, and long-press menus.
- **States:** current status is visibly selected; counts are instrument readouts; source/category/tag filters must be reversible and visible as chips.
- **Mobile:** every swipe has a tap equivalent, edge-deadzone constraints remain, and the PWA shell must avoid system gesture conflicts.

### Signature Component: Saved Item Row

Rows are the core unit of work. They combine source avatar, title, meta line, tags, URL/domain, optional snippet, fixed media monitor, and F/A/D action cluster. The row must answer: what is this, where did it come from, how old/long is it, is there media, and what can I do next?

### Signature Component: Today Hero

Today is a lamp-mode room: one lit object. The hero button reads “Clear 10” (or “Resume round · N cards left”) with a cost line (“about 2 minutes · smart picks”), a 5/10/25 size picker under it, and Enter starts it. Below it, quiet: today's pebbles and wins line (“12 cleared today · 2,107 all-time” — wins only, never the remaining inbox size), the sweeps, an optional moss resurfacing whisper, and a link to the Library. A re-entry line says what happened last time; after a long gap it says “Welcome back. Nothing is owed — start small.”

### Signature Component: Sweep Row

“Let a pile go” offers up to three piles the machine can rest in one tap: an entertainment subreddit, or a source's saves older than four years. Knowledge subreddits and resurface tags are never offered — they resurface instead (one machine fate per content class). Each row shows label, two sample titles, count, Peek (a round over that pile) and Let go (archive-green, because it archives). Let go is a reversible, wave-stamped decay that never touches Reddit; the snackbar names what rested and carries Undo.

### Signature Component: Round Card (Clear)

A round is a finite batch (5/10/25) of single cards on a focus surface with no app nav. The top bar has × (leave; the round is kept and resumable), progress beads that fill with the colour of each decision, and a clock. The card carries a source chip, title, a provenance line (“r/ADHD · 3y ago · 4.2k points · example.com”), a cost pill when the cost is known (“12 min video”, “3 min read”, “a glance”), an optional thumbnail and excerpt. The pad prices gestures: Done and Archive are the two big buttons (reduce the pile — cheapest), Keep and Not now are small (preserve and defer cost more), Skip and Open sit beside them, Undo walks back one decision at a time. Swipe left = Done, right = Archive, up = Open, down = Skip; Keep and Not now are deliberately tap-only. On phones the pad lives in the thumb zone at the bottom; keyboard hints show only with a fine pointer. A quiet “on a roll · N” appears after three quick decisions; it never persists.

### Signature Component: Console and Rail

The Library console sits under the shared nav: the search field (placeholder teaches an operator: “try subreddit:adhd”), then a quiet right cluster of borderless SVG icon buttons (sync, search on phones, settings). No goal bar, no triage button, no version badge — wins live on Today, triage lives in Clear, and the shell version is in the settings sheet footer. The rail is 210px, 32px rows, and scrolls inside its own column with a fade at the bottom; source hues appear as a dot on the avatar, never as a filled block or a row stripe.

### Signature Component: Empty / Cleared State

Empty states are permission states. The round ends on the CLEARED stamp — the one loud moment, win-green — with a summary (“10 in 1:42 — 6 done · 3 archived · 1 kept”), today's pebbles, and three equal exits: One more round, Let a pile go, That's enough for today. Empty states should teach the next useful action without implying backlog failure.

### Signature Component: Recovery / Error State

Recovery UI should name the external action and scope: one item, original URL, archive.today/PullPush/Arctic-Shift when relevant, local media when available. Error states should be plain, specific, and retryable; never silently fail or blame the user.

## 6. Do's and Don'ts

### Do:
- **Do** preserve the dark-first “night ops” identity and the daylight alternate; both are first-class, not a theme switch bolted on.
- **Do** consume semantic aliases from `static/core/tokens.css`; it is the only token system (the v2 teal file and its pages are gone).
- **Do** keep Keep / Archive / Done colors fixed and visible across keyboard, pointer, swipe, and touch paths.
- **Do** write empty states that reduce pressure and offer a next action: another batch, enough for today, adjust filters, or recover context.
- **Do** make destructive or irreversible flows explicit, scoped, and backed by confirmation / backup language.
- **Do** verify mobile/PWA behavior when changing Today, rounds, browse, media, drawer, tab bar, swipe, or install-related UI.

### Don't:
- **Don't** use generic SaaS dashboards with decorative metrics, hero gradients, and marketing-page polish.
- **Don't** create a hoarding-machine UI that celebrates accumulating more instead of clearing or deciding.
- **Don't** use guilt-driven productivity copy: streak shame, overdue language, red-alert backlog panic, or scolding empty states.
- **Don't** use overstimulating neon terminal aesthetics, glassmorphism, ornamental animations, or decorative card grids.
- **Don't** make ambiguous destructive actions around deletes, Reddit unsave, recovery, archival, or purge flows.
- **Don't** escape trusted source glyph SVG output from `chIcon()`; visible SVG text is a source-badge regression.
- **Don't** reintroduce a second token file or a page-local palette; every surface reads the semantic aliases.
- **Don't** reference a CSS variable that `static/core/tokens.css` does not define. A missing variable silently falls back to the declaration's hard-coded colour — the deck card shipped white with night-theme text because `.deck-card` asked for `--surface`, `--line`, `--mute` and `--ink` from the deleted v2 file.
