# Codex Handoff — Design v2, Round 2


> Current status: see **Codex implementation status / review addendum** near the end of this file
> for the implemented changes, review fixes, verification results, and residual notes.

---

Follow-up fixes + a few easy backlog features after the v2 reconciliation. Backend changes ARE in
scope (item 3). Anchor visual decisions to `design-ref/Content Hoarder Design System v2/`
(kit: `ui_kits/content-hoarder/kit.css`) and the screenshots in `design-ref/design_handoff_screens/`.
Some items intentionally **deviate** from design-ref — those are called out explicitly.

**Service worker / caching (read this first):** the app precaches CSS/JS/icons with a version constant
(`static/sw.js`, currently `const CACHE = "ch-shell-v8"`). Any static-asset change is invisible to
cached/installed clients until that bumps. Strategy for this round: **bump once at the very end**
(`v8` → `v9`) in the final commit. For local preview, bypass the SW (DevTools → Application → Service
Workers → "Update on reload").

**Branch:** the round-1 work is already committed on **`feat/design-v2-round2`** (start there — see
*Commit strategy* for the existing commits). **Suggested order:**
**3 → 1 → 4 → 5 → 7 → 9 → 10 → 11 → 12 → 8 → 2 → 6**, committing each item as you go.

---

# Part 1 — Design fixes (carried over)

## 1. Keep / Archive / Done icons missing on the triage action bar

**Symptom:** the design-ref SVG icons aren't shown for Keep/Archive/Done in **triage**.

**Root cause:** `static/icons.js` (`chIcon()`) is already correct and matches the design-ref art, and the
inbox rows ([app.js:359-361](src/content_hoarder/static/app.js#L359)) + sidebar nav already use it. But the
**triage action bar buttons are text-only** — [triage.html:54-64](src/content_hoarder/templates/triage.html#L54)
render just `<span class="act-label">Done</span><kbd>…` with no glyph.

**Do this:**
- In `templates/triage.html`, add an icon placeholder inside each `.act` button, e.g.
  `<span class="act-ic" data-ico="keep" aria-hidden="true"></span>` (and `archive` / `done`). `icons.js`
  auto-fills any `[data-ico]` on load. Map: Keep→`keep`, Archive→`archive`, Done→`done`.
- Add `app.css` `.act .act-ic svg { width: 19px; height: 19px; }` (the kit reserves `.act svg {19px}`) + a
  small gap so the icon sits left of the label.
- **Cheap verify:** confirm `icons.js`'s glyphs still match the canonical design-ref source
  (`design-ref/.../ui_kits/content-hoarder/icons.js` + noun SVGs in `design-ref/.../uploads/`). They matched
  at handoff; re-vendor only if you find a diff.

**Done when:** triage Done/Keep/Archive show the bookmark / box / wastebasket SVGs in their semantic colors.

## 2. Tag filter dropdown + native selects don't match design-ref

**Reference:** design-ref `components/inputs/Select.jsx` (`background: var(--panel2); border: 1px solid
var(--border); border-radius: var(--r-sm); padding: 0.4rem 0.5rem; font-size: var(--fs-sm);`),
`Checkbox.jsx` (`accent-color: var(--accent)`), and `01-inbox-comfortable-dark.png`.

**Do this:**
- Native selects (`app.css` `select`, [app.css:130](src/content_hoarder/static/app.css#L130)): the OS dropdown
  arrow is the main off-brand tell — add `appearance: none; -webkit-appearance: none;` + a custom caret, keep
  the panel2/border/r-sm/fs-sm values.
- Tags `<details class="side-tags">` ([app.css:~1274](src/content_hoarder/static/app.css#L1274)): summary reads
  like the design-ref control (panel2, hairline border, r-sm, caret rotating on `[open]`); option rows read
  like clean rail rows / accent checkboxes.
- We are **keeping** this as a dropdown (decided earlier) — restyle only.

## 3. Integrate categories into the tab bar (backend + frontend)

**Goal:** categories (`listenable`/`watch`/`wotagei`/`unknown`) become **tabs**, not a sidebar dropdown —
parallel to source tabs. (Backlog Epic 5 P2.)

**Confirmed data flow:**
- `category` lives in `metadata.category` (JSON), already filterable via `category=` on `/items`
  (`db.search_items`, `db.py:~363`).
- Source tabs: `loadSources()` ([app.js:514](src/content_hoarder/static/app.js#L514)) → `GET /sources`
  (`web.py:~333` → `db.source_counts(conn, status=…)`), status-cross-filtered →
  `{sources:[{id,label,badge_color,count}]}`.
- Category counts already exist in `/stats` `by_category` (`db._category_counts`, `db.py:~721`).
- `buildQuery()` ([app.js:~432](src/content_hoarder/static/app.js#L432)) currently reads category from the select.

**Backend:** add `GET /categories` mirroring `/sources` (accept `?status=` and optionally `?source=`),
returning `{categories:[{id,label,count}]}`. Promote `_category_counts` to a public
`db.category_counts(conn, status=None, source=None)` so it cross-filters like source tabs. Vocabulary from
`categorize.VALID_CATEGORIES`; label = capitalized id.

**Frontend:** add a category tab strip (recommended: a **second `.tabs` row** under `#source-tabs`, reusing
`.tab` styling — your judgment on exact presentation). In `app.js`: add `let activeCategory = "";`,
`loadCategories()` (mirror `loadSources()`), a `#category-tabs` click handler (set `activeCategory` →
`load(true)` + `loadCounts()`), update `buildQuery()` to use `activeCategory`, and refresh category-tab
counts when status OR source changes. **Remove** the `<select id="category">` from the rail and the
`loadCounts()` block that rewrites its option labels. Keep an "All" category tab first.

**Done when:** category is chosen from a tab strip, counts cross-filter by status (and source), the rail has no
category dropdown, and it composes with source + status + tags + search.

## 4. Compact: media chip overlaps the action icons — **deviate from design-ref**

**Design-ref behavior to change away from:** compact pins the ▶ media pill and *hides it on hover* so the
action icons take the same slot (`app.css:556-558`, the swap). User wants them **side by side**, like
comfortable's `[thumbnail][keep][archive][done]`.

**Do this:** lay the media chip out immediately left of the action slot, no swap:
- Remove the hover-hide ([app.css:557-558](src/content_hoarder/static/app.css#L557)).
- Pin the chip just left of the actions, mirroring how the comfortable thumb reserves the slot via
  `margin-right: var(--act-w)` ([app.css:1489](src/content_hoarder/static/app.css#L1489)); actions stay in the
  absolute right slot and fade in beside it. Result: `[media ▶][keep][archive][done]`, no overlap.

## 5. Comfortable: fixed-height rows — **deviate from design-ref**

**Design-ref behavior to change away from:** the comfortable thumbnail stretches to fill row height
(`align-self: stretch; height: auto;` + negative margins, [app.css:1483-1491](src/content_hoarder/static/app.css#L1483)),
so a tall image drives row height.

**Do this:** give comfortable rows a **uniform fixed height** independent of the thumbnail — constrain the
thumb to a fixed height with `object-fit: cover` (keep the vignette mask + reserved action slot), drop the
stretch/auto growth. Pick the height to match `01-inbox-comfortable-dark.png`.

**Done when:** every comfortable row is the same height; portrait/tall thumbnails are cropped, never stretching.

## 6. Sidebar is cluttered — clean it up (your judgment)

**Context:** after item 3 the category select is gone. The design-ref rail (screenshots) is minimal: a
**STATUS** group + a **FILTER BY TAG** group. Remaining bits to rehome with judgment:
- `sort` — consider moving out of the rail (compact control near tabs/top bar) or visually quieting it.
- The **legend** ("What they mean") duplicates the status-nav labels — remove it or make it a small
  collapsible footnote (`kit.css` `.side-foot` dashed treatment).
- `Stats` + `Reddit sync` + the Reddit link are infrequent — tuck into one overflow/"More" or a compact row.
- `fuzzy` can be a small inline toggle near search.

Keep ids where you relocate controls (`#sort`, `#fuzzy`, `#btn-stats`, `#btn-reddit`, `#tag`) so handlers
don't break. **Done when:** the rail reads clean and grouped (close to the screenshots), no loss of function.

---

# Part 2 — New / backlog features

## 7. Gmail-style independent scroll for sidebar vs. main content

**Goal:** the left rail and the inbox list scroll **independently** under a fixed header (like Gmail web),
each with its own scrollbar — the page itself doesn't scroll as one tall column.

**Current:** the whole page scrolls; `#sidebar` is `position: sticky; top: 112px`
([app.css:~](src/content_hoarder/static/app.css)). No window scroll listener exists (the list uses a
"Load more" button), so converting to scroll containers is safe.

**Do this (desktop):**
- Make `.layout` a fixed-height region below the sticky header: `height: calc(100dvh - <header-height>);
  overflow: hidden;` (use `100dvh`, not `vh`, for mobile correctness). The header height is the
  `.header-stack` (topbar + source/category tabs) — today the sticky offset is `112px`; reuse that (ideally as
  a CSS var so it stays in sync).
- Give `#sidebar` and `#content` each `height: 100%; overflow-y: auto;` (own scrollbars). Replace the
  sidebar's `position: sticky; top: 112px` with this self-scroll. Sticky elements inside content (bulkbar,
  pulse strip) become sticky to the **content** scroll container — change their `top: 112px` to `top: 0`.
- Style the column scrollbars to match (thin, `--border-strong` thumb) per `kit.css:21-29`.
- **Scope to desktop only.** Below the existing mobile breakpoint (≤860px) the sidebar is a drawer and content
  scrolls normally — keep that; don't apply the fixed-height/overflow there.

**Done when:** on desktop, scrolling the list doesn't move the rail and vice-versa, the header stays put, and
mobile (drawer) behavior is unchanged.

## 8. Keyboard shortcut cheatsheet (`?`)

**Goal:** pressing `?` opens a modal listing the shortcuts. (Backlog Epic 5/10 P3.) Complements the `.kbar`
hint bar added last round.

**Do this:** add a small modal (reuse the existing `.modal`/`.modal-box` pattern in `index.html` + `app.css`)
listing the browse keys (`J`/`K` move · `S` keep · `E` archive · `Y` done · `X` select · swipe/hover) and the
triage keys (`S` keep · `E`/`→` archive · `Y`/`←` done). Bind `?` (Shift+/) in `app.js`'s key handler (and
optionally `triage.js`) to toggle it; `Esc` / backdrop click closes. Use `<kbd>` styling already in `app.css`.
Ignore the key when focus is in an input/textarea/select.

**Done when:** `?` opens a readable shortcut sheet on both browse and triage; `Esc` closes it.

## 9. Lock layout width — swipe must not side-scroll the page (mobile P1)

**Goal:** swiping a row never triggers horizontal page scroll. (Backlog Epic 16 P1.)

**Do this:** contain horizontal overflow at the page level — `html, body { overflow-x: hidden; }` (or
`overflow-x: clip`) and ensure the swipe transform on `.item-fg` is clipped by `.item { overflow: hidden; }`
(already present) so a dragged row can't widen the viewport. The body already has `overscroll-behavior:
contain`; pair it with the width lock. Verify on a narrow viewport that a full-commit swipe doesn't reveal
horizontal scroll.

**Done when:** on a phone-width viewport, swiping rows left/right moves only the row, never the page.

## 10. NSFW blur in inbox & triage

**Goal:** over-18 media is blurred with a click/tap to reveal, in the **inbox** and **triage** — matching the
Reddit view. (Backlog Epic 16 P2.)

**Current:** the inbox render (`app.js`) has **no** NSFW handling. The `/reddit` view already does it — reuse
its pattern (`reddit.css` `.nsfw` `filter: blur(...)` + the centered "NSFW" overlay) and its over-18 detection
(locate the field it reads — Reddit's `metadata.over_18`). Triage may already blur (`.nsfw-tag` in `app.css`);
verify and only add what's missing.

**Do this:** when an item is over-18, render its inbox thumbnail/media (and triage media if missing) blurred
with an overlay label; clicking reveals (and only then allows opening the lightbox). Honor a sensible default
(blurred until revealed). Keep it token-driven (no new colors).

**Done when:** over-18 items are blurred in inbox + triage with a reveal interaction, consistent with `/reddit`.

## 11. Tappable subreddit / author / HN links

**Goal:** meta-line entities open their real destination. (Backlog Epic 15 P2.)

**Current:** the meta/origin label is built in `app.js` around
[app.js:236-251](src/content_hoarder/static/app.js#L236) (`r/<subreddit>`, `by <author>`) and the source map
includes `hackernews` ([app.js:198](src/content_hoarder/static/app.js#L198)).

**Do this:**
- Reddit: render `r/<subreddit>` as a link to `https://www.reddit.com/r/<subreddit>` and `by <author>` to
  `https://www.reddit.com/user/<author>` (new tab, `rel="noopener"`). Stop the link click from triggering the
  row-open/select handler (`e.stopPropagation()`).
- Hacker News: make the item open the **HN discussion** (`https://news.ycombinator.com/item?id=<id>`) — derive
  the id from `source_id`/metadata rather than the linked article URL.
- Keep these as real `<a>` elements styled like the existing meta text (hover → `--accent`).

**Done when:** tapping a subreddit/author opens the right Reddit page, and HN items open the HN thread.

## 12. Firefox source icon + tab-dot color

**Context:** the Firefox source shows a `⊕` placeholder glyph in its avatar, and its source-tab dot is
Firefox-orange while Firefox cards are blue. A real Firefox icon is already in the repo
(`static/firefox.svg`, recolorable via `currentColor`; credit in `static/CREDITS.md`).

**(a) Replace the ⊕ glyph with the Firefox SVG.** The avatar renders a text glyph from the source map
([app.js:201](src/content_hoarder/static/app.js#L201) — `firefox: { glyph: "⊕", … }`) into
`<span class="av-face">` ([app.js:~214](src/content_hoarder/static/app.js#L214)). Render the Firefox icon
instead, kept consistent with the other glyphs (**white, on the blue tile**). Recommended: inline the SVG the
way `icons.js`'s `chIcon` does (`fill="currentColor"`, so `.av-face`'s `color:#fff` makes it white) — either
add a `firefox` entry to `icons.js` using the path from `static/firefox.svg` and render `chIcon("firefox")`
for the firefox avatar, or special-case the firefox glyph to emit the inline SVG. **Avoid `<img src>`** (can't
recolor to white). Size it like the other ~0.82rem glyphs.

**(b) Firefox tab dot → card blue.** The tab dot color is the backend `badge_color`. Every source's
`badge_color` matches its `--source-*` token **except Firefox**: the connector is Firefox-orange `#ff7139`
([firefox.py:93](src/content_hoarder/connectors/firefox.py#L93)) while cards use `--source-firefox` =
`#0060df` (via `srcAccent`). Change `firefox.py` `badge_color` to `#0060df` so the dot matches the cards.
Check no test pins the old value.

**Note:** `static/firefox.svg` + the `CREDITS.md` entry are already added (uncommitted) — commit them with
this item.

**Done when:** the Firefox source shows the Firefox logo in its avatar, and its tab dot is the same blue as
Firefox cards.

---

# Commit strategy

The repo uses Conventional Commits (`feat(scope): …`). Keep history clean and reviewable: stay on the
existing round-2 branch, small logical commits, one per item.

**Step 0 — already done.** The round-1 work is committed on branch **`feat/design-v2-round2`** (created off
`main`):
- `024fbcc` `feat(design): apply Design System v2 — accent tokens, search pill, top-bar controls, pulse strip, kbar, focus mode, triage retheme` (tokens.css, app.css, app.js, index.html)
- `afa575a` `feat(design): canonical v2 app icon (H glyph) + bump SW cache to v8` (icon.svg, icon-192/512.png, sw.js)

Just `git switch feat/design-v2-round2` and continue. (`design-ref/` is gitignored — its cleanup needs no
commit. The SW cache is at `v8`; bump to `v9` in your final round-2 commit.)

**Steps 1..n — one commit per item**, suggested messages:
- `feat(triage): show design-system icons on Keep/Archive/Done buttons`        (item 1)
- `feat(ui): integrate categories as a tab strip (+ /categories endpoint)`     (item 3 — backend+frontend; or split `feat(api):` / `feat(ui):`)
- `fix(ui): compact density — media chip no longer overlaps row actions`       (item 4)
- `fix(ui): comfortable density — fixed-height rows`                            (item 5)
- `feat(ui): independent sidebar/content scroll (Gmail-style)`                  (item 7)
- `fix(mobile): lock layout width so row-swipe doesn't side-scroll the page`    (item 9)
- `feat(ui): NSFW blur with click-to-reveal in inbox + triage`                 (item 10)
- `feat(ui): tappable subreddit/author + HN-thread links`                       (item 11)
- `feat(ui): Firefox source icon (firefox.svg) + matching tab-dot color`        (item 12 — includes the already-added `static/firefox.svg` + `CREDITS.md`)
- `feat(ui): keyboard shortcut cheatsheet (?)`                                  (item 8)
- `style(ui): align tag dropdown + native selects with the design system`      (item 2)
- `refactor(ui): declutter the sidebar rail`                                    (item 6)

**Final commit — bump the SW cache once for the whole round:** set `static/sw.js` `CACHE` `v8` → `v9` and
commit `chore(pwa): bump service-worker cache to v9` (so all round-2 asset changes ship to cached clients).

**Notes:**
- Don't push or open a PR unless asked — just commit on the branch.
- Mark the matching backlog lines done in `BACKLOG.md` as you ship (Epic 8 app-icon is already effectively
  done this session; Epic 5 P2 categories, Epic 15/16 items above). A `docs(backlog): tick shipped items`
  commit at the end is fine.
- This handoff file itself doesn't need committing (or commit under `docs:` if you prefer).

---

# Verification (don't declare done from code alone)

Run the Flask app, bypass/refresh the service worker, check in-browser:
1. **Triage**: Done/Keep/Archive show SVG icons in semantic colors.
2. **Category tabs**: switching status/source updates counts; selecting a category filters + composes with
   source/status/tags/search; no rail dropdown.
3. **Selects / Tags dropdown**: consistent dark styling + custom caret.
4. **Compact**: media chip + action icons side by side, no overlap.
5. **Comfortable**: uniform row height; thumbnails cropped. Compare to `01-inbox-comfortable-dark.png`.
6. **Independent scroll** (desktop): rail and list scroll separately under a fixed header; mobile drawer
   unchanged.
7. **Cheatsheet**: `?` opens it on browse + triage; `Esc` closes; ignored while typing in a field.
8. **Swipe**: phone-width viewport — row swipe never side-scrolls the page.
9. **NSFW**: over-18 media blurred + reveal in inbox + triage.
10. **Tappable meta**: subreddit/author/HN open the right destinations; row open/select still works elsewhere.
11. **Firefox**: avatar shows the Firefox logo (white on the blue tile); the source-tab dot is the same blue
    as Firefox cards (`#0060df`).
12. **Sidebar**: visibly decluttered; all relocated controls still work.
12. Re-check **light + dark**; `prefers-reduced-motion` still neutralizes animation.
13. **SW cache bumped** to `v9`; run the test suite (add coverage for `/categories` + `db.category_counts`).
## Codex implementation status / review addendum

This handoff has been implemented, plus a follow-up tag-first refactor requested after the initial round.
Treat the sections below as historical source requirements; the current worktree already includes the
implementation.

### Implemented in current worktree

- Backend category/tag refactor: `listenable`, `watch`, and `wotagei` are mirrored into
  `metadata.tags`; `unknown` remains legacy `metadata.category` only.
- Compatibility retained: `POST /items/<fullname>/category`, `/items?category=...`, `/categories`, and
  `/stats.by_category` still work.
- Browse UI refactor: removed the second category tab row; sidebar now has status rows, tag rows, and a
  separated Tools section for Stats, Reddit sync, and Reddit.
- Fuzzy search moved back beside the search input.
- Comfortable inbox density tightened; the forced tall row height was removed and thumbnails are pinned
  edge-to-edge within the row.
- Previous round-2 items remain implemented: shortcut modal, NSFW reveal, Reddit/HN meta links, Firefox
  icon/color, service worker cache `v9`, triage action icons, compact media/action overlap fix.

### Review fixes applied after implementation

- Fixed `db.merge_upsert` so re-importing an item with `metadata.category` does not clobber existing
  non-processing tags. It now merges existing/incoming non-processing tags first, then swaps only the
  processing-area tag.
- Fixed the browse tag rail so an active selected tag remains visible with count `0` when source/status
  cross-filters would otherwise hide it, leaving the user a clear way to turn it off.
- Removed a dead `categorize_source` variable and extended tests for category-to-tag mirroring.

### Latest UI follow-up applied

- Tags in the browse sidebar are now collapsible by pressing the same-styled `Tags` section title. The
  collapsed state persists in `localStorage` as `ch-tags-collapsed`.
- The Import action moved from the top bar into the sidebar `Tools` subsection as a list row, with
  Enter/Space keyboard activation matching Stats and Reddit sync.
- Browse visual settings moved into a topbar three-dot menu: Compact, Comfortable, Card view,
  Light/dark theme, and Focus mode. Existing localStorage keys and handlers remain in use.

### Verification run

- `python -m py_compile src/content_hoarder/db.py src/content_hoarder/web.py src/content_hoarder/categorize.py`
  passed.
- `git diff --check` passed.
- `.venv\Scripts\python.exe -m pytest --basetemp .pytest-review-tmp` passed: `140 passed in 2.24s`.
- After the latest UI follow-up, `.venv\Scripts\python.exe -m pytest --basetemp .pytest-ui-tmp` passed:
  `140 passed in 2.16s`; `.pytest-ui-tmp` was removed afterward.

### Residual notes for Claude Code review

- I did not run browser/manual visual verification.
- Windows denied deletion of generated pytest temp dirs `.pytest-tmp/` and `.pytest-review-tmp/`, even after
  scoped workspace-verified cleanup attempts. They are untracked artifacts.
- Pre-existing dirty/untracked round-2 assets are still present and intentionally not reverted:
  `src/content_hoarder/static/CREDITS.md` and `src/content_hoarder/static/firefox.svg`.

## Claude Code performance follow-up (post-Codex)

Browser/manual verification surfaced two performance regressions from the tag/category refactor.
Both fixed; 140 tests still pass. Measured against the live DB (84,122 items, 525 MB).

1. **Tag rail rendered the entire `metadata.tags` namespace (~29k tags).** `db.tag_counts` was
   broadened from reddit-only to all-sources, which pulled in ~28,950 YouTube per-video keywords
   (from the enrich pass) on top of the ~15 curated facets. The `/stats` `by_tag` payload was
   ~725 KB and the sidebar built ~87k DOM nodes **on every action**.
   - Fix: added `categorize.FILTER_TAGS` (the curated vocabulary = `REDDIT_TAGS` + processing
     tags) and restricted `tag_counts` to it. Rail now renders 15 tags. (Keywords stay in
     `metadata.tags` for FTS/search — non-destructive.)
2. **`normalize_processing_tags()` ran on every request.** Codex added it to `init_db()`, but
   `connect()` calls `init_db()` per connection, so a ~123 ms `json_extract` scan + per-row parse
   ran on **every** HTTP request (inflating `/items`, `/stats`, `/sources`, …).
   - Fix: removed it from `init_db()`; the one-time legacy backfill now runs from the `init-db`
     CLI command. Going forward `set_category()` / `merge_upsert()` keep the mirror in sync.
3. **Decoupled the facet scans from the hot path.** `by_tag`/`by_category` were dropped from
   `get_counts()`/`/stats` (the Stats modal doesn't use them); the rail fetches curated tags from a
   new `GET /tags` endpoint **on navigation only** (init / source / status change), not after each
   triage action. Added `?light=1` to `/stats` (status counts only) for the per-action refresh.

   Result (per triage action): `/stats` ~480 ms + 725 KB + ~87k DOM nodes  →  `/stats?light=1`
   **~6 ms / 93 B**; `/items` 148 ms → **3 ms**. Tag rail refresh on nav: `/tags` ~119 ms / 245 B.

   Touched: `categorize.py` (`FILTER_TAGS`), `db.py` (`tag_counts`, `get_counts(light=)`, `init_db`),
   `web.py` (`/tags`, `/stats?light=`), `cli.py` (`init-db` backfill), `app.js` (`loadTags`,
   `loadCounts` light), `tests/test_web.py`. Verified in-browser: rail shows 15 tags, cross-filters
   by source/status, no console errors. **Not committed** — left for review alongside the round-2 work.

> Deferred to backlog (user): rework the **comfortable** density layout (Epic 13) — the round-2
> fixed-height pass is unsatisfactory.
