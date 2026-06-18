# content-hoarder — implementation handoff (2026-06-17)

> Snapshot as of 2026-06-17. Volatile facts (line numbers, `file:line` refs, "open" status) are
> point-in-time — verify against the repo before acting. Supersede with a newer dated handoff rather
> than editing in place. **Correction (same day): B3 is NOT a bug — see §1.**
>
> **Shipped since this handoff (2026-06-17/18, bakeoff merges):** **F9** (bare `r/<sub>` subreddit shorthand —
> alias, `subreddit:` kept), **F14** (Firefox/HN topic tagging + `investing` bucket, wired as
> `categorize --source firefox|hackernews`), and **F15 DB primitive** (`db.purge_done` retention sweep —
> glm-5p2 arm; the CLI/sweep + settings UI half is still open, see §3E / Epic 21). B0a/B0b were already
> fixed. Everything else below is still open. Test floor is now **555 passed** (was 524 at write time).

A self-contained work queue produced from a desktop-testing session + a repo sweep. It is meant to be
handed to a fresh chat with **no memory of the originating conversation**, so each item carries its own
file paths, rationale, scope, and acceptance criteria. Where a line number is prefixed `~` it was not
re-verified at write time — confirm before relying on it.

**Repo:** `K:\Projects\content-hoarder` (Python 3.12 + Flask + SQLite, vanilla-JS PWA; no build step).
**Test baseline at handoff:** `python -m pytest` → **524 passed, 0 failed** (run from the repo root with
`./.venv/Scripts/python.exe`). Treat 524-green as the regression floor.
**Authoritative backlog:** `BACKLOG.md` (25+ epics). Every feature below was filed there this session and
is cross-referenced by epic; this doc is the consolidated, scoped view.

Conventions used here: **P1** soon · **P2** next · **P3** someday. "Seam" = the function/file to touch.

---

## Table of contents
1. [Bugs](#1-bugs) — 4 open, 2 already-fixed
2. [Improvements](#2-improvements) — code quality / dead code
3. [Features to implement](#3-features-to-implement) — scoped, grouped by area
4. [Decisions locked this session](#4-decisions-locked-this-session) — read before building the features they gate
5. [Architecture quick-reference](#5-architecture-quick-reference)
6. [Delegation suitability (GLM/qwen bakeoff)](#6-delegation-suitability-glmqwen-bakeoff) — which items to offload, with oracle scope

---

## 1. Bugs

### Already fixed this session (listed for completeness — do NOT redo)
- **B0a — `reddit.js` `esc()` missing single-quote escape (XSS hardening).** FIXED: added `'`→`&#39;` in
  `src/content_hoarder/static/reddit.js` `esc()`. (`core/util.js` already had the full 5-char escape.)
- **B0b — NSFW blank-keyword catch-all.** FIXED: `categorize.py` `_load_nsfw_rules` now strips blank
  `erotic_keywords` entries (a `""` had produced an empty regex alternative matching every subreddit →
  whole corpus mis-tagged `nsfw_erotic`). Regression test added:
  `tests/test_categorize_reddit.py::test_nsfw_blank_keyword_does_not_match_everything`.

### Open bugs

| ID | Severity | Title | Location |
|----|----------|-------|----------|
| B1 | medium | Same-second "let it go" waves collide → UNDO reverses both clusters | `resurface.py:166` + `db.decay` |
| B2 | low (fails safe) | Reconcile cap guards on row count, not real truncation → unsaves never reconciled at exactly 1000 saved | `db.py:~1040` |
| ~~B3~~ | **not a bug** | `tag_youtube_source` dropping enrich keyword tags on retag is **BY DESIGN** ("keyword noise drop"), test-locked | `categorize.py:~489` |
| B4 | low | `/import/prepare` temp file leaks up to 1h if previewed but never committed | `web.py:~763` |
| B5 | low/UX | `Exact` checkbox in the search bar closes the operator suggestions popover | `static/browse/operators.js` |
| B6 | medium | Album/gallery thumbnail fails to load on a specific Reddit gallery post | gallery extraction (`archival/providers.py` `_gallery`) |

---

**B1 — Same-second decay-wave undo collision** *(confirmed by code read)*
- **What:** `letgo()` (`resurface.py:152`) decays a cluster and stamps `metadata.decayed_at = now`
  (whole seconds) via `db.decay`. `undo_letgo()` (`resurface.py:166`) reverses by a **1-second window**:
  `db.undecay(decayed_after=decayed_at, decayed_before=decayed_at+1)`. The undo selects rows purely by the
  timestamp window — `tag/sub` are explicitly unused (see the comment at `resurface.py:169`).
- **Failure:** two "let it go" actions on **different clusters** within the same wall-clock second get the
  **same** `decayed_at`. Pressing UNDO on one cluster's toast un-decays **both** clusters. Violates the
  "one independently reversible wave" invariant in `db.decay`'s docstring (`db.py:~1233`).
- **Fix:** make the wave id unique per call instead of time-windowed. Options: (a) have `db.decay` allocate
  a unique monotonic wave id (mirror `db.allocate_saved_order`) and return it; `undo_letgo` selects on that
  id, or (b) `letgo` passes a unique `decay_label`/wave token and `undo_letgo` selects by label, not a time
  window. Prefer (a) for a general fix.
- **Acceptance:** a test that calls `letgo(A)` then `letgo(B)` with a frozen identical `now`, then
  `undo_letgo(A)` — only A's rows return to inbox; B's stay decayed.

**B2 — Reconcile cap uses `len(present) >= cap`** *(agent-traced; fails safe)*
- **What:** `db.py:~1040` skips saved-list reconciliation when `len(present) >= cap` (~1000), inferring
  "the listing was truncated." Reddit's saved listing caps ~1000 per type, so a truncated export could make
  a still-saved item look absent (and get wrongly unsaved) — hence the guard. But it keys on the count
  actually parsed, which cannot distinguish "complete export of exactly 1000" from "truncated at 1000."
- **Failure:** a user with exactly `cap` saved posts and a complete export → reconciliation is silently
  skipped, so genuine unsaves are never detected. Fails safe (never an *erroneous* unsave), so low severity.
- **Fix:** pass an explicit `truncated_by_kind` flag from the sync/import layer (which knows whether it
  stopped on `after`-exhaustion vs. a page cap) rather than inferring from the row count.

**B3 — `tag_youtube_source` drops non-processing tags on retag — NOT A BUG (by design).** *(Resolved
2026-06-17.)* `categorize.py:~489` keeps only processing tags (`listenable/watch/wotagei`) + the
freshly-derived topic tags, then `merge_upsert`s `{"tags": deduped}` (no category → wholesale replace),
so enrich's per-video keyword tags (`arduino`, `diy reflow`, …) are dropped on retag. This is **intended
("keyword noise drop") and test-locked** by `tests/test_categorize_youtube.py:61`
`test_youtube_keyword_noise_drop` (asserts tags → `["watch", "science"]`). The repo sweep mis-flagged it
as "silent data loss"; reading the existing test proved it by-design. **No action — do not "fix" it**
(a fix would break that test). Kept here only to close the loop.

**B4 — `/import/prepare` temp-file leak** *(agent-traced; minor)*
- **What:** `/import/prepare` (`web.py:~763`) writes an uploaded/yt-dlp temp file and stashes it in
  `_prepared[token]`. It's only unlinked by `/import/commit` (`web.py:~833`) or the 1-hour TTL sweep in
  `_cleanup_prepared` (`web.py:~718`) — and the sweep only runs on the *next* `/import/prepare`. If a user
  previews but never commits and no further prepare happens, the temp file lingers.
- **Fix:** acceptable given the TTL, but add cleanup on app teardown or a timer. Low priority.

**B5 — `Exact` checkbox closes the operator suggestions popover** *(user-reported)*
- **What:** clicking the **Exact-only** checkbox in the search bar dismisses the `#oppop` operator
  suggestions popover, interrupting query-building.
- **Fix:** the checkbox toggle shouldn't blur/close the popover. Touches `static/browse/operators.js`
  (popover open/close on focus/blur) and the exact-checkbox handler. Keep suggestions open across the toggle.
- **Acceptance:** with the popover open, toggling Exact leaves it open and the suggestion list intact.

**B6 — Album/gallery thumbnail doesn't load** *(user-reported)*
- **Repro item:** `reddit.com/r/TankPorn/comments/1u3tphi/ukrainian_m1a1_aim_abrams_with_anti_drone_cages/`
  — the gallery card renders with no thumbnail.
- **Likely cause:** the archive fetch didn't populate `metadata.gallery`/`thumbnail` for this row, or the
  stored thumb URL 404s. Check `archival/providers.py` `_gallery` extraction (from `gallery_data` +
  `media_metadata`) for this post, and the thumbnail fallback when `media_metadata` is missing.
- **Acceptance:** verify against the live DB row first; the card shows a thumbnail after the fix (re-fetch
  via `enrich --source reddit --scores` if metadata was simply never populated).

---

## 2. Improvements

| ID | Value | Title | Location |
|----|-------|-------|----------|
| I1 | high | Dead duplicate `icons.js` + offline cache gap | `static/icons.js`, `static/core/icons.js`, `sw.js` |
| I2 | medium | Helper duplication on the 2 legacy pages | `static/triage.js`, `static/reddit.js` vs `static/core/util.js` |
| I3 | low | Unused `app.css` selectors | `static/app.css` |
| I4 | doc-only | Two token files are intentional but undocumented | `static/tokens.css` vs `static/core/tokens.css` |

**I1 — Dead duplicate `icons.js` + offline cache gap** *(high)*
- `static/icons.js` (legacy self-executing IIFE) and `static/core/icons.js` (ES-module export) contain the
  same icon set. Only `static/icons.js` is referenced (by `templates/triage.html:~97`); the browse page uses
  `core/icons.js`; the reddit page inlines SVG. **`static/icons.js` is NOT in the `sw.js` SHELL cache array**,
  so on an offline cold-open of `/triage`, icons can fail to render.
- **Action:** either (a) add `/static/icons.js` to the `sw.js` SHELL, or (b) delete `static/icons.js`,
  migrate `triage.html` to the `core/icons.js` module (or inline like reddit.js), and remove the script tag.
  (b) is the cleaner end-state.
- **Acceptance:** triage icons render offline; no duplicate icon source remains.

**I2 — Helper duplication on legacy pages** *(medium)*
- `triage.js` and `reddit.js` each define their own `esc` / `safeUrl` / `isTypingTarget` / `ago` /
  `fetchJSON`. `static/core/util.js` already exports the canonical versions (the v3 `core/` layer was
  created specifically to kill this triplication, but the two non-module legacy pages still carry copies).
- **Action:** convert `triage.js`/`reddit.js` to ES modules importing from `core/util.js`, or extract a
  shared non-module `util` that sets globals. This also retires B0a permanently (one esc, not three).

**I3 — Unused `app.css` selectors** *(low; defer)*
- `app.css` (~2100 lines, consumed only by the legacy `/triage` page) has many unreferenced selectors
  (e.g. `.ai-*` suggest-UI classes). Medium confidence on individual selectors. Defer to a triage redesign;
  don't bulk-delete without per-selector usage checks.

**I4 — Two token files (intentional, document it)** *(doc-only)*
- `static/tokens.css` (legacy dark/teal, used by `/triage` + `/reddit`) and `static/core/tokens.css`
  (v3 "Log Book" apricot, used by browse) are **both live and intentional** — not dead code. Add a one-line
  comment in each (and/or `sw.js`) noting which pages consume which, to prevent a future "looks duplicated,
  delete one" mistake. Unify only when the legacy pages are redesigned.

---

## 3. Features to implement

All scoped from a desktop-testing session. Grouped by area. Each is also filed in `BACKLOG.md` under the
noted epic.

### 3A. Reader & media viewing

**F1 — Thumbnail tap = quick media peek; title/body opens the thread** · P2 · Epic 15
- **Problem:** today, tapping a Reddit image/video thumbnail in the list routes straight to the in-app
  reader (media + comments). User wants a fast media peek without the thread.
- **Scope:** split the tap target. Tapping the **media thumbnail** opens a **lightbox peek of the media
  only** (no thread). Tapping the **title / rest of the row** opens the in-app reader (media + thread).
  **Exclude Hacker News article thumbnails** — those keep current behavior (do not peek).
- **Seam:** the `[data-media]` dispatch in `static/browse/main.js` vs. the title `<a>` handler; lightbox is
  `static/core/media.js` (`openImage`/`openGallery`/`openVideo`).
- **Acceptance:** thumbnail click → lightbox, no navigation to reader; title click → reader; HN thumbnail
  click → unchanged; works on touch + desktop.

**F2 — Video plays inline in the reader (no lightbox)** · P2 · Epic 15
- **Problem:** in `section#reader`, a video currently opens the lightbox.
- **Scope:** play the video **inline in the reader's media tile**, reusing the HLS/`<video>` path in
  `static/core/media.js`. The lightbox remains for the browse-list peek (F1); this is reader-only.
- **Acceptance:** opening a reddit-video item's reader plays it inline (audio+video via HLS) without a
  lightbox; Esc/scroll behavior unaffected.

**F3 — Reposition the reader's media preview** · P3 · Epic 15
- **Problem:** the post-media tile dominates the top of `section#reader`; the post + thread require excess
  scrolling.
- **Scope:** shrink/reposition the tile — cap its height, or make it collapsible / cover-fit. Reader layout
  only.
- **Acceptance:** the post text + first comments are visible without long scrolling on a typical
  image/video post.

**F4 — Reader triage buttons show their hotkey shortcuts** · P3 · Epic 15
- **Scope:** the triage action buttons at the bottom of the reader display their keyboard shortcuts
  (Keep/Archive/Done hints), mirroring the `?` cheatsheet.
- **Acceptance:** each reader triage button shows its key; the keys still work.

**F5 — "Surprise me" card: render media + open → reader** · P3 · Epic 20
- **Problem:** the surprise-me ambient card under-renders and its open action doesn't go to the reader.
- **Scope:** when the dealt item **has an image**, render the image on the card (not just title/meta); the
  card's **"Open" action routes into `section#reader`** (the same reader a normal open uses), not an
  external tab or bare lightbox.
- **Seam:** `surprise()` in `static/browse/main.js:~358` + the Epic 15 reader routing.
- **Acceptance:** a surprise-me draw with an image shows the image; Open lands in the reader.

### 3B. Browse list / cards UI

**F6 — Stretch the thumbnail to the preview-box width (log/comfortable density)** · P3 · Epic 13
- **Scope:** in the browse **log/comfortable** density, stretch the media thumbnail to the full width of its
  preview box (respect the fixed row height + `object-fit`).
- **Seam:** `.items.density-comfortable .item-fg` / the monitor thumb box in `static/browse/browse.css`.
- **Acceptance:** comfortable rows show a full-width thumbnail; row height stays fixed; no overflow.

**F7 — Pinboard portrait images anchored top-left (visual polish)** · P3 · Epic 13
- **Problem:** in the **card / "Pinboard"** density, portrait (tall) images sit top-left in their slot
  instead of centered/filled.
- **Seam:** `object-position`/sizing for `.pin .screen img` in `static/browse/browse.css:~335`.
- **Acceptance:** portrait images read well (centered/filled) in pinboard cards.

**F8 — Color accents on the Inbox / Keep / Archived / Done / All tabs** · P3 · Epic 13
- **Scope:** give the main-view status tabs (`#status-nav`) per-status color accents. Reuse the existing
  `--status-keep` / `--status-archive` / `--status-done` tokens; pick accents for **Inbox** + **All**.
  Styling only.
- **Seam:** `static/browse/browse.css` status-nav rules.
- **Acceptance:** the active status section is visually distinct; colors match the triage/row semantics.

### 3C. Search

**F9 — Bare `r/<sub>` (and `u/<user>`) as subreddit/author shorthand** · P2 · Epic 12
- **Problem:** `r/tankporn` should be equivalent to `subreddit:tankporn`.
- **Scope:** recognize a leading/standalone `r/<sub>` token (case-insensitive, COLLATE NOCASE like the
  existing operator) in `search_query.py` and map it to the subreddit filter; likewise consider `u/<user>`
  → author. Only treat a leading/standalone token as the operator (don't capture `r/…` inside free text).
- **Decision (open):** whether `r/` is an **alias** (both `r/` and `subreddit:` work) or the **canonical**
  form (deprecate `subreddit:`). See §4.
- **Seam:** `src/content_hoarder/search_query.py`; autocomplete in `static/browse/operators.js`.
- **Acceptance:** `r/tankporn` returns the same rows as `subreddit:tankporn`; a free-text `r/x` mid-query is
  not mis-parsed; parse tests added.

**(B5 above is the search popover bug — implement alongside F9 if convenient.)**

**F10 — Revisit operator names for intuitiveness** · P3 · Icebox · Epic 12
- **Scope (deferred):** the current vocabulary (`source:`/`kind:`/`status:`/`subreddit:`/`tag:`/`is:`/`has:`/
  `before:`/`after:`/`score:`) gets more intuitive names. Pairs with F9. Gather the rename list first; keep
  old names as aliases for a transition. Reactivate when the user supplies a concrete naming preference.

### 3D. Tagging & taxonomy

**F11 — Parent/child tag grouping in the rail (visual)** · P2 · Epic 26
- **Scope:** group the flat tag list under **parent tags** (e.g. **Humorous**, **Educational**, **Trivial**,
  **Gaming**) with sub-tags **indented** under their parent. Selecting a parent **highlights + selects all
  of its sub-tags** (OR-filter across the children). **Visual grouping only** — underlying tags stay flat
  for FTS/search; this needs a parent→children map + rail UX.
- **Seam:** the sidebar rail + `db.tag_counts` / `categorize.FILTER_TAGS`.
- **Acceptance:** parents render with indented children; clicking a parent filters by all children; tag
  storage unchanged.

**F12 — Source-aware tag rail** · P2 · Epic 26
- **Problem:** tags aren't source-exclusive, but most cluster to one source (defense/anime → reddit; channel
  topics → youtube).
- **Scope:** when a source tab is active, surface the tags actually present for that source (volume-sorted)
  instead of the global vocabulary. Reuse the cross-filtered-counts pattern (`/sources?status=` style).
- **Decision (open):** how to treat shared/cross-source tags (always show vs. fold under an "all sources"
  group). See §4.
- **Acceptance:** switching source changes the rail's tag set to that source's tags with correct counts.

**F13 — Overall categories↔tags model reorg** · P2 · Epic 26 · *decision gate first*
- **Scope:** decide + implement a unified taxonomy: whether processing **categories**
  (`listenable`/`watch`/`wotagei`, stored on `metadata.category`) become a reserved **tag namespace** so one
  filter UI + one rail covers both; how parent/child relationships are stored (static parent→children map
  vs. a real hierarchy on `metadata`); how `categorize.py` buckets map onto the F11 parents.
- **Sequencing:** **sketch the model before** refactoring `categorize.py` + `db.search_items` + the rail.
  F11/F12 are the near-term visual wins; F13 is the structural follow-up. Large.

**F14 — Extend tagging to Firefox tabs + Hacker News** · P2 · Epic 9
- **Problem:** tagging ships for reddit + youtube; Firefox-tab and HN items are largely untagged but many are
  clearly bucketable (gaming / defense / **investing** / coding …).
- **Scope:** add `firefox_tags()` / `hackernews_tags()` (or fold into the `categorize --topics` pass) using
  URL/host + title-keyword heuristics. Mirror `youtube_tags()`: conservative seed maps, preserve processing
  tags, never touch `metadata.category`. **Add a new `investing` bucket** (confirm it doesn't already exist;
  gaming/defense already do). Firefox-tab YouTube items already promote to youtube items, so they inherit
  youtube tagging — this targets the **non-YouTube** Firefox tabs + HN. Optional local-LLM assist for the
  tail.
- **Seam:** `src/content_hoarder/categorize.py`.
- **Acceptance:** a sample of Firefox/HN items receives correct buckets; precision stays high (dry-run preview
  first); `metadata.category` untouched.

### 3E. Triage & data lifecycle

**F15 — Done items auto-delete after a retention window (Gmail-trash style)** · P2 · Epic 21
- **Scope:** items marked **Done** stay in the Done bucket for **X days** (default ~30, like Gmail trash —
  make it configurable), then the entry is auto-deleted. **Hard constraint: unsave must be unaffected** —
  the auto-delete must **NOT** enqueue a Reddit unsave. Use the direct-delete path, never `bulk_set_status`
  (mirror the decay-design guard); the `delete` CLI's auto-backup + `data/delete-audit.jsonl` apply. Needs a
  `done_at` / status-transition timestamp to age from (confirm one exists — `processed_utc` is set when an
  item leaves inbox; verify it's stamped on the Done transition specifically, else add a stamp). Reversible
  until the purge runs; surface the window in settings.
- **Seam:** builds on the Epic 21 `delete` machinery + `db.decay` guards.
- **Acceptance:** a Done item older than the window is purged on the sweep; a test pins that the purge path
  does **not** enqueue an unsave; the window is configurable; pre-purge backup is written.

**F16 — `Ctrl+Y` redo (mirror `Ctrl+Z` undo)** · P2 · Epic 13
- **Problem:** undo exists (per-item + bulk snackbar, `api.bulkUndo`) but there's no redo, and the keyboard
  bindings may be snackbar-only.
- **Scope:** add a **redo** that replays the last undone action. Needs a small undo/redo **stack** (not just
  the single last-action snackbar). Bind `Ctrl+Z` → undo / `Ctrl+Y` (+ `Ctrl+Shift+Z`) → redo. **Confirm
  whether `Ctrl+Z` is actually keyboard-bound today** (vs. snackbar-only) and add it if not.
- **Acceptance:** undo then redo restores the action; the stack survives several steps; keys work on desktop.

**F17 — Predictive prefetch cache for the top of each sort** · P2 · Epic 8
- **Problem:** switching sort/source triggers a fresh fetch.
- **Scope:** warm a small cache so the top of each sort is instant. Prefetch the **first ~10 items per
  source** for the **top** of each sort: **newest**, **oldest**, **SHUFFLE·MIX** (shipped), and
  **shuffle-likely** (the smart/likely-done sort — **gated on `feat/triage-score` integration**, see notes).
  User directive: *"don't be too lazy"* — a real per-source × per-sort warm, not a single-page cache.
- **Open design:** where the cache lives (in-page prefetch vs. a server-warmed slice / ETag), invalidation on
  new sync/decay, and a memory bound. See §4.
- **Acceptance:** after warm, switching among the listed sorts renders the first items without a visible
  fetch; cache invalidates after a sync/decay.

### 3F. Misc affordances

**F18 — Share button on items** · P2 · Epic 5
- **Scope:** add a Share affordance to the item (row/card + reader).
- **Open scope:** native Web Share API (`navigator.share` — works on the mobile PWA, clipboard fallback on
  desktop) vs. a plain "copy permalink"; and *what* is shared — the source permalink
  (reddit/HN/youtube/firefox URL) vs. a deep-link back into content-hoarder. Recommended default:
  Web-Share-with-clipboard-fallback sharing the source permalink (works on the Pixel-6 target). See §4.
- **Acceptance:** tapping Share invokes the share sheet on mobile / copies the link on desktop; the shared
  URL is correct for the item's source.

**F19 — "Move to PKMS" button** · DEFERRED · Epic 21 (icebox)
- **Status:** intentionally deferred. The eventual trigger is a per-item "Move to PKMS" button, but it rides
  the Epic 21 promote-pipeline export (`docs/thread-hydration-feasibility.md`), which is iceboxed until PKMS
  Phase 3. **Do not build the button before the promote pipeline exists.** Listed here only so it isn't
  re-proposed as new.

---

## 4. Decisions locked this session
Read these before building the features they gate — they reflect explicit user choices.

- **F1 (thumbnail tap):** thumbnail → **lightbox peek (no thread)**; title/rest-of-row → **thread/reader**;
  **HN article thumbnails are excluded** from peek (keep current behavior).
- **F11/F12/F13 (tags):** parent tags are **visual grouping** (indent children; selecting a parent selects
  all children) — *and* the user explicitly wants an **overall reorganization of how categories and tags are
  handled** (F13). F11/F12 are near-term; F13 is the structural reorg behind a decision gate.
- **F15 (Done retention):** the retention auto-delete **must not trigger a Reddit unsave** — hard constraint.
- **F19 (PKMS button):** **ignore for now**; deferred to the existing iceboxed promote pipeline.
- **Open (un-decided) — surface to the user before building:**
  - **F9:** is `r/` an *alias* for `subreddit:` or a *replacement* (deprecate `subreddit:`)?
  - **F12:** how shared/cross-source tags appear when a source is active.
  - **F17:** cache location (in-page vs. server-warmed) + invalidation strategy.
  - **F18:** Web Share vs. copy-link, and source-permalink vs. CH deep-link.

---

## 5. Architecture quick-reference
(So a fresh chat doesn't have to rediscover it. Source of truth: `AGENTS.md`.)

- **Data model:** one generic `items` table, PK `fullname = "<source>:<source_id>"`. Source-specific fields
  live in the `metadata` JSON blob (adding a source needs no schema change). Triage:
  `status ∈ {inbox, keep, archived, done}`; `processed_utc` set when an item leaves inbox; `status_prev`
  enables one-step undo.
- **Write ownership:** connectors never touch the DB — they parse and yield `models.new_item(...)` dicts;
  `pipeline.py` owns all writes. `merge_upsert` is non-destructive (overlays only non-empty incoming fields,
  shallow-merges `metadata`, never overwrites user/triage state).
- **Decay safety invariant (verified):** `db.decay` uses a direct `UPDATE` and never routes through
  `bulk_set_status`, so a mass decay **cannot** enqueue Reddit unsaves. Preserve this for F15.
- **Frontend layering:** v3 browse uses ES modules under `static/core/` (`util`, `api`, `toast`, `render`,
  `media`, `swipe`, `icons`) + `static/browse/` (`main.js`, `render.js`, `reader.js`, `operators.js`,
  `palette.js`). The legacy `/triage` and `/reddit` pages are **non-module** scripts still using
  `static/{app.css, triage.js, reddit.js, reddit.css, icons.js, tokens.css}` (see I1/I2/I4).
- **Reddit transport:** OAuth (installed-app / RedReader client id, no secret) is built and preferred when
  configured; the `reddit_session` cookie is the automatic fallback. Lightbox/media: `static/core/media.js`
  (`mediaType`, `openImage`/`openGallery`/`openVideo`, HLS via vendored `hls.min.js`).
- **Tests:** all offline, deterministic, `:memory:` SQLite, synthetic fixtures, no network. Keep them so.
- **Verify before "done":** run `./.venv/Scripts/python.exe -m pytest` and diff against **547 passed**
  (was 524 at write time; F9 + F14 added tests since).

---

## 6. Delegation suitability (GLM/qwen bakeoff)

*Added 2026-06-18. Which open items suit the oracle-driven offload bakeoff (red pytest oracle →
local model implements Arm B → human reviews + integrity-gates vs. oracle-gaming), the way F9 + F14
were built. **The other chat decides whether to actually delegate** — this section only scopes the
candidates so it can pick one up cold.*

**The fit criterion (all three must hold):** the item is (1) pure **backend / Python**, (2) expressible
as a **deterministic pytest oracle** (the oracle *is* the spec), and (3) free of **visual/preview
judgment**. UI/CSS/JS-interaction work fails (2)+(3) — it can't be pytest'd and needs the preview; for
those, the oracle costs more than the fix, or can't be written at all → **do them inline, don't delegate.**

**Model lane** *(per the Batch-4 bakeoff conclusion + memory):* **qwen3p7-plus** = the adopted
single-shot implementer (cheaper; use for a clean single-file fix); **GLM-5.1** = the agentic/fallback
lane (use when the change is multi-touch or qwen's Arm fails). Tooling/protocol: the `aider-headless-delegate`
skill (run-branch isolation + the integrity gate that catches a silently-failed run or a rewritten oracle).

| Item | Verdict | Lane |
|------|---------|------|
| **B1** decay-undo collision | ✅ delegate (strong) | qwen single-shot |
| ~~**F15** Done auto-delete retention~~ | ✅ **DONE** 2026-06-18 (glm-5p2 arm) | DB primitive merged; CLI/sweep half remains |
| **B2** reconcile-cap truncation flag | 🟡 borderline | GLM (crosses sync/import seam) |
| **B4** import temp-file leak | 🟡 borderline | qwen (small; oracle ≈ fix size) |
| B5, I1, I2, I3, F1–F8, F10–F13, F16–F19, OCR | ❌ don't delegate | inline — UI/preview/design-gated, or not oracle-shaped |

### Scoped candidates (oracle spec for a fresh chat)

**B1 — decay-undo wave collision** · ✅ strong · qwen single-shot
- **Oracle (RED):** `letgo(A)` then `letgo(B)` on two different clusters with a **frozen identical `now`**
  (inject it), then `undo_letgo(A)` → only A's rows return to inbox; B's stay decayed. Today both return
  (the undo selects on a 1-second `decayed_at` window, not a wave id).
- **Seam:** `resurface.py:152` (`letgo`) / `:166` (`undo_letgo`) + `db.decay` / `db.undecay` (`db.py:~1233`).
- **Fix shape (anti-gaming):** make the wave id **unique per call** — preferred (a): `db.decay` allocates a
  monotonic wave id (mirror `db.allocate_saved_order`) and returns it; `undo_letgo` selects on that id, not a
  time window. Pure-additive: existing single-wave undo stays green; the new test pins the two-wave case.
- **Constraint:** must NOT route through `bulk_set_status` (decay-safety invariant — no Reddit unsave on decay).

**F15 — Done items auto-delete after a retention window** · ✅ strong · GLM
- **Oracle (RED):** (a) a Done item whose age > window is purged on the sweep; (b) **a test that the purge
  path does NOT enqueue a Reddit unsave** (the hard constraint — assert the `reddit_unsave` table stays empty
  after a purge); (c) the window is configurable (settings); (d) a pre-purge backup is written.
- **Seam:** builds on the Epic 21 `delete` machinery + `db.decay` guards. Needs a `done_at`/status-transition
  timestamp to age from — **confirm `processed_utc` is stamped specifically on the Done transition**, else add
  the stamp (that's its own small oracle).
- **Fix shape (anti-gaming):** use the **direct-delete path**, never `bulk_set_status` (mirror the decay
  guard). Reuse the `delete` CLI's auto-backup + `data/delete-audit.jsonl`. Add as a new sweep entrypoint so
  existing delete/decay tests stay byte-identical.
- **Why GLM not qwen:** multi-touch (settings + timestamp + sweep + safety guard) — fits the agentic lane.

**B2 — reconcile cap uses `len(present) >= cap`** · 🟡 borderline · GLM
- **Oracle (RED):** a sync that exhausted the listing (`after` ran out) at exactly `cap` saved items still
  reconciles genuine unsaves; a truncated listing (stopped on a page cap) still skips reconciliation. Pin both
  via an explicit `truncated_by_kind` flag, not the row count.
- **Seam:** `db.py:~1040` + the sync/import layer that knows exhaustion-vs-page-cap.
- **Borderline because:** threads a new flag from the caller through to `db` — crosses files, so it's more
  agentic than a single-file oracle. Fails safe today (never an *erroneous* unsave), so low urgency.

**B4 — `/import/prepare` temp-file leak** · 🟡 borderline · qwen
- **Oracle (RED):** an item previewed (`/import/prepare`) but never committed and with no subsequent prepare
  has its temp file cleaned up (on teardown or a timer), not left until the 1-hour TTL.
- **Seam:** `web.py:~763` (`/import/prepare`) / `:~833` (`/import/commit`) / `:~718` (`_cleanup_prepared`).
- **Borderline because:** the fix is small enough that writing the oracle ≈ writing the fix — delegate only if
  batching it with another web-layer item; otherwise inline.
