# content-hoarder — applicable features from the Relay + Sync studies

**Purpose.** This is the synthesis doc. It merges the two reference studies —
[`relay-observations.md`](relay-observations.md) (features **R1–R30**) and
[`sync-observations.md`](sync-observations.md) (features **S1–S24**) — into a single, prioritized list of
features worth bringing into content-hoarder's **mobile** redesign. Each row cites its source so you can jump
back to the frame.

**The problem we're solving (restated).** The current mobile nav — the **tag-pill → `#tagsheet` bottom sheet** —
is *too many taps* and *hinders jumping idea-to-idea*. The desktop `.rail` (SOURCES + TAGS) is fine but is
`display:none` on mobile. Goal: **one-tap source/tag/category jumping + fast triage**, reusing what CH already
has (the undo snackbar, triage-score / smart mode, "persist active view", NSFW-hide).

**How to read.** Tiers are ordered by leverage against that problem. Each row shows a **reference frame** (pulled
from the Relay or Sync clip), the underlying **R#/S#** source, and a rough **effort** (S/M/L) for the CH front-end
(`templates/index.html`, `static/browse/main.js`, `static/browse/browse.css`). Where **both** apps do a thing,
that's a ⭐ **convergent** signal — the safest bets. The reference frame is illustrative of the *pattern*, not a
mockup of CH itself.

> **Pick from here, or from the two source docs.** Reply with CH-item IDs (e.g. "C1, C4, C7") or the underlying
> R#/S# numbers — either works. Nothing here is decided; it's a menu with a recommendation at the end.

---

## ⭐ Convergent signals (both apps independently do these — highest confidence)

These four showed up in *both* Relay and Sync, which makes them the lowest-risk adoptions:

| Pattern | Relay | Sync |
|---|---|---|
| **Searchable source list as the primary jump mechanism** | R1–R2 (search field + Mine/Search type-ahead) | S3–S4 (alphabetical subs + in-drawer live search) |
| **Distance-threshold swipe actions for triage** | R10–R11 (progressive peek, springs back) | S17–S19 (orange/purple/red + multi-band comment swipe) |
| **A density control with a dense "scan" mode** | R18, R23 (compact left-thumb, layout toggle) | S9, S12 (Change-view → Compact) |
| **Header/subtitle echoes the active view + sort/state** | R14 (sort in subtitle) | S14 (two-line "Frontpage / Top (M)") |

---

## Tier 1 — The tag-pill replacement (core nav) · do this first

A left **drawer** (☰ + edge-swipe, dims the browse list) whose body is a **searchable, grouped, prunable jump
list**. This is the heart of the redesign.

| Ref | Feature | Why for content-hoarder |
|---|---|---|
| <img src="frames/frame_037.png" width="150"> | **C1 — Slide-in left drawer** over a dimmed browse list (☰ + edge-swipe)<br><sub>from R6 / S1 · effort M</sub> | Replaces the `#tagsheet`; feed stays in place behind it instead of navigating away |
| <img src="sync-frames/frame_050.png" width="150"> | **C2 — Persistent search field** at the top of the drawer that **live-filters** sources/tags as you type<br><sub>from R1–R2 / S4 ⭐ · effort S</sub> | *The* fix for "too many taps" — jump to any source/tag/category in 2–3 keystrokes |
| <img src="sync-frames/frame_001.png" width="150"> | **C3 — Grouped jump list:** *Smart views* (Inbox/To-triage, All, Saved, Smart/decay) → *Sources* (Reddit / YouTube / Links) → *Tags & Categories*<br><sub>from R3–R4 / S2–S3 · effort M</sub> | Gives **categories** a real home above raw sources; "idea-to-idea" becomes one tap per group |
| <img src="sync-frames/frame_060.png" width="150"> | **C4 — Per-row coloured icon + trailing ⋮** on every jump row<br><sub>from S3 / S5 · effort M</sub> | Colour aids fast visual scanning; the ⋮ exposes per-source/tag actions (pin, mute, mark-read, recolour) in one tap |
| <img src="frames/frame_046.png" width="150"> | **C5 — Pinned / Favourites group** (star a source or tag to pin it to the top)<br><sub>from R4 / S2 · effort S</sub> | Your most-jumped scopes sit at the top; maps to CH's tag system |
| <img src="sync-frames/frame_095.png" width="150"> | **C6 — "Section visibility"** — show/hide whole drawer groups<br><sub>from S6 · effort S</sub> | Power users prune the drawer to only the groups they use — a direct "too many taps" answer |
| <img src="frames/frame_013.png" width="150"> | **C7 — Mine \| Search scope tabs** (filter *my* tags/sources vs *discover/add* new)<br><sub>from R1 · effort M</sub> | Cleanly separates "jump to existing" from "add a new source/feed" |

## Tier 2 — Fast triage (the second core win)

| Ref | Feature | Why for content-hoarder |
|---|---|---|
| <img src="frames/frame_025.png" width="150"> | **C8 — Swipe-to-triage on browse cards:** right = **Keep**; left = 2-stage **Archive → Delete** (colour + icon change at the threshold)<br><sub>from R10–R11 / S17–S18 ⭐ · effort M</sub> | One-handed, glanceable triage; **pairs with the existing undo snackbar** (commit on release → snackbar → undo restores in place) |
| <img src="sync-frames/frame_215.png" width="150"> | **C9 — Multi-band single swipe** for graded verbs (light = Keep · mid = Tag/Save · far = Archive), live colour feedback<br><sub>from S19 · effort M</sub> | The strongest gesture across both apps — express several verbs in one drag without lifting a finger |
| <img src="sync-frames/frame_150.png" width="150"> | **C10 — Triage/Swipe mode** toggle — the whole list switches to a triage-optimized layout<br><sub>from S20 · effort S</sub> | A dedicated "process my backlog" mode, distinct from browsing |
| <img src="sync-frames/frame_150.png" width="150"> | **C11 — "Hide done"** — collapse items already Kept/Archived so only un-triaged remain<br><sub>from S20 · effort S</sub> | The "clear the done pile" button for a hoarding-cleanup session |
| <img src="sync-frames/frame_080.png" width="150"> | **C12 — Inline action row** on each card mirroring the swipe verbs (Keep / Archive / Tag / ⋮)<br><sub>from S13 / R29 · effort S</sub> | Non-gesture fallback for discoverability + accessibility — every swipe verb also a visible button |

## Tier 3 — Density & layout

| Ref | Feature | Why for content-hoarder |
|---|---|---|
| <img src="sync-frames/frame_113.png" width="150"> | **C13 — "Change view" density picker:** Cards / Small cards / **Compact** (default = Small cards)<br><sub>from S9–S12 / R18,R23 ⭐ · effort M</sub> | Flip between *browse/enjoy* (Cards) and *triage-fast* (Compact, ~10/screen) in one sheet |
| <img src="sync-frames/frame_070.png" width="150"> | **C14 — Two-line header** = active view + sort/filter state (e.g. "To-triage / Newest")<br><sub>from S14 / R14 ⭐ · effort S</sub> | Always shows "what am I looking at + how it's ordered"; the ▾ is a drawer-free view switch |
| <img src="sync-frames/frame_080.png" width="150"> | **C15 — Media-type badges** on thumbnails (video ▶ / image / link / YouTube)<br><sub>from S16 · effort S</sub> | Glanceable item type in a mixed-media hoard |
| <img src="frames/frame_001.png" width="150"> | **C16 — Tag chips + NSFW badge** inline on the metadata line; **domain shown inline**<br><sub>from R19–R20 / S10 · effort S</sub> | Builds on the shipped NSFW-hide toggle; domain is key for link/YouTube items |
| <img src="frames/frame_002.png" width="150"> | **C17 — Collapse-on-scroll header** → slim bar<br><sub>from R21 · effort S</sub> | Reclaims vertical space while triaging a long list |
| <img src="frames/frame_085.png" width="150"> | **C18 — True-black borderless list + one accent + semantic colours** (keep/archive/delete colour set)<br><sub>from R22 · effort S</sub> | Visual coherence; the swipe colours come from this palette |

## Tier 4 — Customization & state (Sync's signature, worth stealing)

| Ref | Feature | Why for content-hoarder |
|---|---|---|
| <img src="sync-frames/frame_150.png" width="150"> | **C19 — Customizable action grid** (a sheet/FAB where you pin & hold-drag-reorder your own triage verbs + bulk actions)<br><sub>from S7 · effort L</sub> | Replaces the tag-pill *sheet itself* with a user-arranged action surface — power users put Archive/Tag/Delete in muscle-memory slots |
| <img src="sync-frames/frame_100.png" width="150"> | **C20 — Per-view overflow menu** mixing toggles (Remember position, Expand-on-open, NSFW-hide, Unread-only) + maintenance one-shots<br><sub>from S8 / R9 · effort M</sub> | One place for per-view prefs + maintenance |
| <img src="sync-frames/frame_100.png" width="150"> | **C21 — "Remember position"** — restore scroll/read position on return<br><sub>from S24 / R26 ⭐ · effort S</sub> | Don't lose your place in a 1000-item hoard; extends the shipped "persist active view / no skeleton flash" |

## Tier 5 — Detail & media (lower priority for the nav redesign)

| Ref | Feature | Why for content-hoarder |
|---|---|---|
| <img src="frames/frame_086.png" width="150"> | **C22 — Item detail as a routed screen** that restores feed scroll **+ selection** on back<br><sub>from R26 / S21 ⭐ · effort M</sub> | The open → act → back-to-next triage loop depends on not losing your place |
| <img src="frames/frame_083.png" width="150"> | **C23 — Pinned slim action bar** in the item view (Keep/Archive · Tag · Share · ⋮)<br><sub>from R27 / S21 · effort S</sub> | Act on an item without scrolling back up |
| <img src="sync-frames/frame_015.png" width="150"> | **C24 — Inline media player / image lightbox** (full-bleed, minimal controls, swipe-to-dismiss restores scroll)<br><sub>from S23 · effort M</sub> | Preview saved video/YouTube/images in place |
| <img src="sync-frames/frame_022.png" width="150"> | **C25 — Dead-link "tombstones"** — keep saved metadata + show a stub when a source is removed/deleted<br><sub>from S22 · effort S</sub> | Directly extends the reddit-title-hydration "(untitled)/deleted" handling — don't drop the row |
| <img src="frames/frame_082.png" width="150"> | **C26 — "Next item" affordance** (FAB / swipe-back to the next un-triaged item)<br><sub>from R29 / S15 · effort M</sub> | Keeps a triage queue flowing one-handed |

---

## Recommended first slice (MVP of the redesign)

If you want the smallest build that actually kills the tag-pill pain, it's these five — all Tier 1/2/3 core,
all convergent or near-convergent, ~M total:

1. **C1 + C2 + C3** — the drawer with a searchable, grouped (Smart views / Sources / Tags & Categories) jump list. *This alone answers "too many taps / hinders idea-jumping."*
2. **C8** — swipe-to-triage (Keep / Archive→Delete) wired to the existing **undo snackbar**.
3. **C13 + C14** — a Compact density option + a two-line header so triage mode is dense and legible.

Everything else (the customizable grid C19, multi-band swipe C9, detail/media C22–C26) layers on top once the
core nav + triage feel right.

## Decisions for you (these shape the build)

- **Drawer vs bottom-sheet for the jump list?** Both apps use an edge drawer (C1). CH's old v2 had a drawer
  mechanism (`#nav-toggle` / `.nav-backdrop`) we can reuse. Confirm you want a *drawer* (not a redesigned sheet).
- **How do Categories relate to Tags in the jump list?** Currently categories are folded into the tag system.
  Do you want them as a **separate group** (C3) or kept merged?
- **Swipe verb mapping.** Default proposal: right = Keep, left-short = Archive, left-long = Delete (C8). Want a
  different mapping, or the graded multi-band version (C9) from the start?
- **Sources vs Tags as the primary axis.** Relay/Sync are source-first (subreddits). CH has both sources *and*
  tags — which should be the top group in the drawer?

## Next step

Reply with the **CH-item IDs** you want (or the R#/S# numbers), and answer the decisions above where you have an
opinion. I'll turn the picks into a concrete implementation plan on `feat/restore-sidebar-nav` off `staging`,
starting with the MVP slice unless you say otherwise.
