## Epic 13 — UI bugs & quick fixes  (`bug`, `area:ui`)
*Discrete defects surfaced during the redesign; several are fixed in the v2 design pass (marked).*

- [x] ~~**P2 — "Hide NSFW" not working.**~~ ✅ Done 2026-06-20 (commit 54e270e): root cause was a criteria mismatch — the UI blurs on `over_18` but the backend `hide_nsfw` only filtered `nsfw_*` TAGS (71 over_18-untagged rows leaked). Aligned both include/exclude paths to (tag OR over_18). The settings toggle was already wired. *(User-reported 2026-06-20.)* The hide-NSFW control doesn't actually hide
  NSFW content. Likely the toggle isn't wired to the `safe=1` / `hide_nsfw` query path (`web.py`), or the setting
  isn't persisted/applied on load. **Fix + verify** end-to-end. This is the bug report that the unbuilt "NSFW toggle
  in settings" item (Epic 15 below) is non-functional — reconcile the two.
- [x] ~~**P2 — Re-apply NSFW blur when you click off a revealed post.**~~ ✅ Done 2026-06-20 (commit 4413f18):
  reveal now toggles the `.nsfw` class only (the veil node is kept and hidden via CSS, not deleted), so it's
  reversible; closing the reader or lightbox opened for an item re-adds `.nsfw` to its feed thumbnail. `reblur(fn)`
  in `main.js` (idempotent, no-op for non-NSFW) wired to a new `initReader({onClose})` (fires on every close path)
  + `createLightbox({onClose})` (tracks the opened item via `lastMediaFn`); `browse.css` `.veil` positioned
  regardless of `.nsfw`, hidden via `:not(.nsfw)`. Verified on mobile preview (reader + lightbox close both
  re-blur); 590 tests. *(User-reported 2026-06-20.)*
- [x] ~~**P2 — Video thumbnail not loading on some posts.**~~ ✅ Investigated + fixed 2026-06-20 (commit ff78721).
  *(User-reported 2026-06-20.)* **Root cause was NOT a missing thumbnail on the repro.** The repro (`reddit:t3_1u62v1i`
  "Diamond Thighs") has a valid `external-preview.redd.it` thumbnail that loads (HTTP 200) and renders correctly in
  list, card, AND reader — likely fixed by an enrich backfill since the report. **Real bug found:** card density
  (`pinCard` in `browse/render.js`) rendered **no media tile at all** for a poster-less video/gallery
  (`screen = t ? … : ""`), whereas the list (`monitorHtml`) and reader (`mediaTileHtml`) both fall back to a
  glyph-only play tile. Fixed: `pinCard` now emits a `.screen.noimg` glyph tile for poster-less video/gallery
  (+ `browse.css` full-width centered-glyph styling). SW v35→v36. Verified on mobile preview (full-width tappable
  🖼/🎬 tile); 590 tests. **Data finding (separate, not fixable):** 528 reddit video items (364 inbox) have no
  thumbnail and **none is recoverable** — 0 from cached threads (`reddit-thumbnails` dry-run), and a PullPush +
  live-OAuth sample returned `thumbnail:"default"` with no `preview` images (Reddit never generated a poster for
  these v.redd.it posts). The glyph tile is the correct terminal rendering for them.
- [ ] **P3 — Research + mimic reddit-app thumbnail cropping.** *(User-requested 2026-06-20.)* Survey how the major
  Reddit apps (Apollo, RedReader, Boost, Sync, official, Relay) crop/frame post thumbnails (aspect ratio, fill vs
  fit, focal-point/top anchoring, portrait handling) and adopt the best fit for our card/list densities. Builds on
  the T4 cover work (`browse.css` `.pin .screen` / `.monitor`). Output: a short comparison + a concrete sizing
  proposal before touching CSS.
- [x] ~~**P2 — Album/gallery lightbox loads extremely slowly.**~~ ✅ Done 2026-06-20 (commits 4f24df1 + dbcb433 + 1afbe5f): both fixes shipped — (b) the lightbox lazy-loads (only the in-view image fetches, via IntersectionObserver) and (a) sized ~1080px pre-signed `gallery_preview` variants now drive the feed card poster + lightbox (full original on tap), keyed off the `media_metadata` `p` ladder. Backfilled 1,730/1,738 galleries (`enrich --source reddit --gallery-previews`; 8 have no archived `p` data → graceful fallback to the original). *(User-reported 2026-06-20.)* Opening a reddit
  gallery in the lightbox is very slow (noticed on mobile data, but the cause is structural, not just the link).
  **Root cause:** `archival.providers._gallery` stores only the **full-resolution source** URLs
  (`media_metadata[*].s.u`, often 2000px+/multi-MB each), and `core/media.js` `openGallery` renders **all** of them
  at once (`<img loading="lazy">` in one stacked modal) — so a multi-image album pulls several full-size originals
  simultaneously. The 2026-06-20 card-poster change compounds it on the feed (the card now uses `gallery[0]` at full
  res). **Fix directions:** (a) **store + serve sized variants** — `media_metadata` also carries a pre-signed `p`
  resolution array (108/216/320/640/960/1080px); persist those (or a chosen ~1080px variant) and have the lightbox
  load the sized image first, fetching the full-res `s.u` only on tap/zoom; pre-signed `p` URLs sidestep the
  preview.redd.it signature problem. (b) **progressive load** — render only the first image immediately, defer the
  rest until scrolled into view (confirm the modal actually lazy-loads; in a stacked modal they may all sit near the
  viewport), with explicit width/height (or a tiny blurhash/low-res placeholder) to avoid layout jank +
  `decoding="async"`. (c) **card poster** — use a sized preview variant for the `gallery[0]` card thumbnail instead
  of the full-res source (revisit `thumb()` density logic, `core/media.js`). Relates to Epic 4 (gallery metadata /
  `_gallery`), Epic 1 P1 media-archiving (a locally-archived copy could be downscaled), and Epic 8 perf
  (predictive prefetch / 60fps). Quick win first: (a) for the lightbox is the highest-leverage.
- [x] ~~**P3 — Mobile "go to top" button.**~~ ✅ Done 2026-06-20 (commit 595e08f): rAF-throttled, mobile-only floating ↑ that clears the dock + safe-area and smooth-scrolls to top. *(User-requested 2026-06-20.)* A floating scroll-to-top affordance on
  mobile that appears after scrolling down the feed and jumps back to the top. Respect the dock / bottom-sheet
  layout + safe-area insets; reuse existing tokens/motion. Touches `browse/main.js` (scroll listener) + `browse.css`.
- [ ] **P3 — Ask GLM what looks better for Log-view title wrapping/cutoff.** *(User-requested 2026-06-20.)* In the
  **log** density, get a design opinion (GLM, via the frontend-design skill) on title **wrapping vs. ellipsis
  cutoff** — current is a 2-line clamp at `--fs-md`. Compare options (clamp lines, fade-out, single-line ellipsis,
  wrap-all) and pick. Relates to the shipped row-title shrink + the Epic 8 GLM-5.2 design-trial item.
- [ ] **P2 — Video not fetching properly.** *(User-reported 2026-06-19 — needs a repro.)* The report is terse:
  a video isn't fetching/loading correctly. **Source + repro item TBD** — get a specific permalink from the user
  before chasing it. Likely suspects to check once a repro is in hand: the `v.redd.it` media path — archive
  fetch populating `metadata.media_url`/`is_video` (`providers`, Epic 4), the HLS manifest derivation in
  `core/media.js` `openVideo` (`/HLSPlaylist.m3u8` + vendored `hls.min.js`), and the reader/lightbox video tile
  (`browse/reader.js` + `core/media.js`). Could also be YouTube enrich (`yt-dlp --dump-single-json`) failing to
  fetch. Pin down which source/post first.
- [x] ~~**P2 — Inline-video tap-autoplay no-ops on Chrome/Android (hls.js race).**~~ ✅ Fixed 2026-06-20
  (`frontend-staging`). *(Found 2026-06-20, review of the inline-video reader `c8c49a3`.)* In `browse/reader.js` the
  media-tile tap called `video.play()` **synchronously** right after `mountVideo()`, but for the **hls.js** path
  (Chrome/Android, no native HLS) the source wasn't attached yet (`loadHls().then(...)` → `h.attachMedia(video)`), so the
  eager `play()` no-op'd. **Fix:** `mountVideo` now takes an `{ autoplay }` option and calls `play()` at the point each
  path's source is actually ready — inside the hls.js `.then()` after `attachMedia`, and after `src` on the
  native-HLS/direct paths (`core/media.js`); the reader passes `autoplay:true` instead of calling `play()` itself.
  Predicate + autoplay path unit-verified against the live module; full Chrome/Android E2E not reproducible (no v.redd.it
  items in the live DB, desktop Chromium).
- [x] ~~**P2 — External-video Reddit post → dead inline `<video src=item.url>` (no lightbox fallback).**~~ ✅ Fixed
  2026-06-20 (`frontend-staging`). *(Found 2026-06-20, same review.)* `mediaType()` classifies YouTube and other
  external-video URLs as `cls:"video"` (`core/media.js:64,66`), so the reader's media-tile tap routed them through the
  inline `<video>` path, setting `video.src = item.url` — a dead player for a non-playable web page. **Fix:** the reader
  video branch now mounts an inline `<video>` only for **directly playable** sources (`hlsManifestUrl(srcUrl)` truthy, i.e.
  v.redd.it/HLS, or `.mp4|.webm|.mov`); YouTube / gfycat / redgifs / other external-video items fall through to
  `onMedia` → `openMediaFor` (lightbox, else open-original in a new tab). Verified the playability predicate against
  representative URLs. Relates to Epic 11 (YouTube promotion) + Epic 15.
- [x] ~~**P3 — Color accents on the Inbox / Keep / Archived / Done / All tabs.**~~ ✅ Already shipped in the
  v3 status-nav (`browse.css:119-131`): `.folder`/`.spill[data-status=…]` carry `--tab:var(--status-keep/-archive/-done)`
  with active-state tinting; Inbox = `--accent`. **Updated 2026-06-20 (Task F):** "All" was neutral `--text-muted`
  (not distinct when active) → now `--text-body` (solid neutral, no clashing 5th hue). *(User-requested 2026-06-17.)*
- [x] ~~**P3 — Stretch the thumbnail to the preview-box width (browse "log"/comfortable density).**~~ ✅ Already
  satisfied by the v3 comfortable-density rework (`browse.css:344,350`): the fixed 128×76 `.monitor` box +
  `.items.density-comfortable .monitor img{object-fit:cover}` fill the slot width. *(User-requested 2026-06-17.)*
- [x] ~~**P3 — Shrink the row title in the ledger + log views.**~~ ✅ Done 2026-06-20 (`frontend-staging`).
  *(User-requested 2026-06-20.)* The list-row titles read too large. **Was (desktop):** log/comfortable **18.88px**
  (`--fs-lg`); ledger/compact **15.52px** (`--fs-md`). **Now:** log → **`--fs-md`** (15.52px, ~18% smaller),
  ledger → **`--fs-sm`** (13.6px, ~12% smaller) — token-reuse, keeps the density hierarchy ledger < log < card.
  Changed base `.title` (used by ledger) + `.items.density-comfortable .title`, and dropped the now-redundant mobile
  override (comfortable was already `--fs-md` there). Card/Pinboard title (`.pin h3`) unchanged. Verified both
  rendered sizes in the preview.
- [x] ~~**P2 — Album/gallery thumbnail doesn't load (e.g. r/TankPorn M1A1 Abrams).**~~ ✅ VERIFIED
  SHIPPED: gallery thumbnail fallback is now covered by the gallery preview/fallback path; poster-less or
  unavailable gallery media renders a clean fallback tile instead of a broken/missing thumbnail. *(User-reported
  2026-06-17.)* Repro item:
  `reddit.com/r/TankPorn/comments/1u3tphi/ukrainian_m1a1_aim_abrams_with_anti_drone_cages/`. The
  original report covered both the card thumbnail and reader rendering; both are now handled by the shipped
  gallery preview/lightbox fallback path.
- [x] ~~**P3 — Pinboard portrait images anchored top-left (visual polish).**~~ ✅ Fixed 2026-06-20
  (`frontend-staging`). *(User-reported 2026-06-17; **cover** chosen by the user 2026-06-20.)* In the **card /
  "Pinboard"** density, portrait (tall) images showed pillarbox gutters in the column. **Real root cause (found
  2026-06-20 via preview geometry):** the `max-height:430px` was on the **`<img>`** with `width:100%` and no
  explicit height, so when a tall image hit the cap the browser **shrank the element's width too** (to preserve
  aspect) — e.g. 242×430 inside a ~345px single-column card, leaving side gutters. `object-fit` is irrelevant here
  (the element box was already aspect-correct), so the first attempt (flip to `object-fit:cover`) was a **no-op**.
  **Fix:** move the cap to the **container** — `.pin .screen{max-height:430px;overflow:hidden}` and drop
  `max-height` from the img (kept `object-fit:cover`/`object-position:center top`). The image now holds full column
  width; tall images crop their overflow at the top, short/landscape show fully. **Only visible in single-column
  (wide cards);** at 2-column widths nothing reaches the cap. **Trade-off:** very tall images crop rather than
  shrink-to-fit (reverses the v3 contain decision) — user-accepted. Verified computed styles applied; geometry
  diagnosed on real rows (live re-capture flaky this session — remote thumbnail load).
- [x] ~~**P2 — `Ctrl+Y` redo (mirror `Ctrl+Z` undo).**~~ ✅ Done 2026-06-20 (Task E): single-level redo (`lastUndone`, replays the last undone act, mirrors the single-level snackbar undo); bound Ctrl+Z/bare-z → undo, Ctrl+Y/Ctrl+Shift+Z/bare-y → redo; modifier chords now stop falling through to single-key actions. *(User-requested 2026-06-17.)* Undo exists (per-item +
  bulk snackbar, `api.bulkUndo`); add a **redo** that replays the last undone action. Needs a small undo/redo
  **stack** (not just the single last-action snackbar). Bind `Ctrl+Z` → undo / `Ctrl+Y` (+ `Ctrl+Shift+Z`) →
  redo — confirm `Ctrl+Z` is actually keyboard-bound today, not snackbar-only. Relates to the Epic 5 keyboard
  rework.
- [x] ~~**P3 — Reader subreddit label clips descenders (`r/gaming` → the "g" tail is cut off).**~~ ✅ Shipped
  (`b9c0bf0`): relaxed the `.rd-sub` line-height so descenders clear, keeping the one-line ellipsis truncation. *(User-reported
  2026-06-20.)* In the inline reader header the subreddit chip (`browse/reader.js:117` → `.rd-sub`,
  `browse/browse.css:717`) uses `line-height: 1` (`font:var(--fw-semibold) var(--fs-sm)/1 …`) together with
  `overflow:hidden` for the single-line ellipsis, so the em-box is ~cap-height and **descenders (g/j/p/q/y) are
  clipped at the bottom**. Fix: relax the line-height (e.g. `/1.3`) and/or add a hair of vertical breathing room
  so descenders clear, keeping the one-line ellipsis truncation. Styling only (`browse.css`). Verify on the
  Pixel-6/Firefox target.
- [x] ~~**P2 — Rework the comfortable density layout.**~~ ✅ Shipped on v3 (2026-06-13 audit): `.items.density-comfortable .item-fg` is locked to `height:100px` (browse.css:290) with the thumb constrained to the fixed monitor box; adaptive height is cards-only. Orig: **User spec (2026-06-08):** positioning is good,
  but make **every comfortable row a uniform fixed height (~100px)** — adaptive/dynamic height should
  apply to **cards density only**. Constrain the thumbnail within that fixed height (`object-fit: cover`)
  and keep the action slot aligned. Touches `app.css` `.items.density-comfortable`.
- [x] ~~**P2 — Tag-chip overload on enriched YouTube cards.**~~ ✅ Shipped on v3 (2026-06-13 audit): `core/render.js` `tagChips` is curated-first (`opts.curated`), capped (`max=3`) with a "+M more" expander on cards and a static "+N" on fixed-height rows — strategy (c) hybrid. `metadata.tags` untouched (FTS intact). Orig: Enriched YouTube videos render a wall of
  tag chips (e.g. the "I made a Self-Soldering Circuit" card shows ~25: `arduino`, `atmega`, `avr`,
  `circuit design`, `diy reflow`, `high voltage`, …). **Root cause:** the per-item chip renderers
  (`tagChips` in `static/app.js` *and* `static/triage.js`) print the raw `metadata.tags` array
  unfiltered, and the `enrich --source youtube` pass dumps every yt-dlp keyword into `metadata.tags`
  (~28,950 unique across the corpus). The sidebar rail already sidesteps this by restricting to the
  curated `categorize.FILTER_TAGS` (~15) via `db.tag_counts` — but the cards don't. **Investigate +
  decide a display strategy**, e.g.: (a) on cards, show only curated `FILTER_TAGS` chips (expose the
  vocabulary to the frontend, mirroring the rail) and drop raw keywords from the visible set; (b) cap to
  N chips with a "+M more" expander; (c) a hybrid — curated first, then a few keywords behind the
  expander. Keep all keywords in `metadata.tags` for FTS/search (non-destructive); this is display-only.
  Touches `tagChips` (app.js + triage.js), the card/`.tag-chips` CSS, and possibly a `FILTER_TAGS`
  endpoint/payload. Relates to Epic 9 (tagging) and the FILTER_TAGS perf work in the round-2 handoff.
- [x] ~~**Card-view text clipping / title overlap.**~~ Fixed by the v2 card (adaptive hero + bottom
  action row). (Also noted in Epic 5.)
- [x] ~~**P1 — Reddit videos & galleries broken — GATE G1 APPROVED (2026-06-12).**~~ ✅ **Shipped on
  v3 (verified by code audit 2026-06-13).** The design (`docs/reddit-media-rendering.md`) was
  implemented during the v3 build: `core/media.js` (`mediaType`, `imageUrl` recognizing `media_url`,
  `createLightbox` with `openImage`/`openGallery`/`openVideo`/`openMedia`, Esc + backdrop close) +
  `browse/main.js` `openMediaFor` dispatch (gallery → stacked lightbox, video+`media_url` → native
  `<video>`, image → lightbox, else permalink → redditmedia iframe fallback) + `browse/render.js`
  monitor/screen slots with gallery/video badges and `data-media` hooks. No Reddit iframe for playable
  media. **Remaining (deferred, documented §4.3):** the HLS/DASH **audio** tier for `v.redd.it` — a bare
  `<video src=media_url>` plays the video-only stream without audio on browsers lacking native HLS;
  the doc's "ship (c/a), revisit after a week" upgrade. Needs a real-browser audio check + possibly
  feature-detected HLS. Tracked as Epic 13 P2 ▸ "reddit_video audio" below.
- [x] ~~**P2 — reddit_video audio (HLS/DASH) — follow-up to the shipped media pass.**~~ Shipped: the
  stored `media_url` is the bare `https://v.redd.it/<id>` (audio-less / non-playable), so `openVideo`
  now derives the HLS manifest (`/HLSPlaylist.m3u8`, muxed audio+video) and plays it via native HLS
  where supported, else a lazy-loaded **vendored hls.js** (`static/vendor/hls.min.js`, full build —
  the light build omits the separate-audio rendition v.redd.it uses). `mediaType()` gained a
  `metadata.media_url`-based branch so reddit videos (whose `url` is the permalink) route to the player
  instead of the iframe, and the comfortable-density monitor now shows a play tile for thumbnail-less
  videos. Verified in-browser: both native-HLS and hls.js paths decode audio+video.
- [x] ~~**P2 — Card density visual rework.**~~ ✅ v3: card density ("Pinboard") uses natural height — `.pin .screen img{width:100%;object-fit:contain;max-height:430px}` (`browse.css:335`), no forced 16:9 `cover` crop, so tall text-screenshots render fully. Orig: The cards layout is structurally correct but reads poorly.
  **Root cause (from screenshot, 2026-06-08):** many Reddit posts are **tall text-screenshots** (e.g.
  r/BlueskySkeets) and the fixed **16:9 `object-fit:cover` hero crops the text off** — "image difficult
  to look at." First-pass tweaks applied for review (hero `max-height` 280→200px, `object-position: top`,
  trimmed head/main padding); if still bad, do a full rework — likely needs **per-aspect media handling**
  (don't force 16:9 on portrait/text images) and overlaps the Epic 13 P1 Reddit-media pass. User may
  provide a Figma layout. Touches `app.css` `.items.density-card` + `mediaSlotHtml` in `app.js`.
- [x] ~~**P2 — Compact density visual cleanup.**~~ ✅ v3: NSFW marker is an inline `.nsfw-tag` pill prepended to the meta line (`render.js:43`, `browse.css:265`) — no absolute overlay, so no collision with the byline. Orig: Compact rows are mostly fine, but the **NSFW label
  collides with the meta line** (screenshot): the "NSFW" text + teal pill overlap the byline so "posted …"
  is truncated/clipped (looks like a doubled "NSFV/NSFW"). Fix the NSFW marker placement in compact +
  general spacing polish.
- [x] ~~**P2 — Three-dot ⋯ visual menu shouldn't auto-close on change.**~~ ✅ SUPERSEDED (user-confirmed 2026-06-12): the v3 settings sheet (Epic 14) stays open across density/theme/loading changes and replaces the v2 `#visual-menu-pop` (which no v3 template loads). No ⋯ menu built. Orig: Changing a setting
  (density/theme/focus) closes `#visual-menu-pop`; keep it open so several can be toggled without
  reopening.
- [x] ~~**P2 — Tag chips only render in card view.**~~ Shipped on v3 (parallel session 2026-06-12,
  `feat/ui-polish-sweep`, verified 19/19 headless): `core/render.js` `tagChips` gained an
  `{expand:false}` mode wired into `logRow` (comfortable) + `ledgerRow` (compact); curated-first,
  capped, static "+N", display-only.
  > **Epic 13 polish-sweep audit (same session):** these P2s were verified ALREADY-SHIPPED on v3 —
  > **bulk Undo, bulk-bar no-shift, bulk button colors, NSFW blurred-thumb width, row-click-scope,
  > side-gutter scroll** (detail in `docs/parallel-run-2026-06-12.md`). The "three-dot
  > ⋯ menu stays open" item is **superseded by the settings menu** (Epic 14) — closed, no ⋯ menu
  > built (user-confirmed). Tick these on your next BACKLOG pass if you concur with the audit.
- [x] ~~**P2 — NSFW blurred thumbnail renders too wide (comfortable/list).**~~ ✅ v3: blur is constrained to the fixed monitor/screen thumb box (`browse.css:306-308`), with a veil overlay. The over-18 blurred thumb
  expands to ~40% of the row width with a centered "NSFW" overlay (screenshot) instead of the normal
  thumbnail box; constrain it to the standard thumb width/aspect. Likely shares a root with the
  comfortable-density fixed-height/thumbnail sizing above.
- [x] ~~**P2 — Bulk-action Undo missing.**~~ ✅ v3: `api.bulkUndo` (core/api.js) replays the prior statuses; wired into the bulk path (main.js:223) with a snackbar. Orig: Group-select → Keep/Archive/Done shows no Undo (the per-item
  Undo toast doesn't fire for bulk), so a bulk action can't be reversed. Wire Undo for `/bulk/status`.
- [x] ~~**P2 — Bulk bar shifts the list down when it appears.**~~ ✅ v3: `.opsbar` is a `position:fixed` overlay (browse.css:386), so selecting a row no longer pushes the list. Orig: Selecting a row makes the bulk bar push the
  whole list down, so the cursor is no longer over the originally-selected row (bad on desktop). Overlay
  the bulk bar or reserve its space so the list doesn't jump.
- [x] ~~**P2 — Bulk Keep/Archive/Done buttons not color-coded.**~~ ✅ v3: opbtn `.k/.a/.d` use the `--status-keep/-archive/-done` tokens (index.html:126-128). Orig: Color-code them to match the triage/row
  semantic colors.
- [x] ~~**P2 — Move processed items back to Inbox.**~~ ✅ v3: per-item "IN" button (`data-act="inbox"`, render.js:27) + bulk "X → INBOX" (index.html:129) + the `x` keyboard shortcut; toast "Back in the inbox." Orig: Kept/Archived/Done items need a reversible action to
  return them to `inbox` — per-item and as a bulk action.
- [x] ~~**P2 — Row click should open only on the title/link, not the whole row body.**~~ ✅ v3 (Playwright-audited 2026-06-12): opens only via the title `<a>` / media slot; body + meta clicks open nothing; avatar toggles select. Orig: Refine the `#items`
  delegated handler so a body click doesn't open the item — only the title/link does (avatar/checkbox
  still toggles select).
- [x] ~~**P2 — Esc doesn't close the Reddit video/thread modal.**~~ ✅ v3: `createLightbox` (core/media.js:88-90) has Esc + backdrop/`[data-media-close]` close built in, and clears the body to stop playback. Orig: `Esc` (and backdrop click) should close
  it like the other modals.
- [x] ~~**P3 — Reposition / iconify the Sort control.**~~ ✅ v3: moved OUT of the rail into the top shelf bar (`index.html:77-89`) — satisfies the "…or move it out of the rail" half. (Still a `<select>`, not an icon; iconify deferred if ever wanted.) Orig: Replace the sort dropdown with a sort icon or move
  it out of the rail.
- [x] ~~**P2 — Scroll the list from the side gutters too.**~~ ✅ v3: a `document` `wheel` handler forwards gutter scroll to the list (main.js:612, "13:385"). Orig: With the Gmail-style independent scroll, only
  the content column captures the mouse wheel — hovering the blank space beside it does nothing. Make the
  whole main pane (incl. side gutters) drive the content scroll (move `overflow-y` to a wider wrapper or
  widen the scroll region) so the wheel works anywhere in the main area, not just over the list. *(User
  note 2026-06-08.)*
- [x] ~~**Reddit "Sync newest" button cut off.**~~ Fixed (v2 pass): the header now wraps. The reddit header crowds at some widths (the new
  theme toggle); fix `header-right` wrapping/spacing in `reddit.css`.
- [x] ~~**Dropdowns clip into the search bar.**~~ Fixed (v2 pass): the tag filter moved to the sidebar and the topnav wraps. At some window widths the topbar selects overlap the
  search field and become unclickable; fix `.topbar` wrap/stacking in `app.css`.
- [x] ~~**Group-select only via the checkbox/avatar.**~~ Fixed (v2 pass): a row-body click opens the item; only the avatar toggles selection. A whole-row click should open the item; only
  the avatar/checkbox should toggle selection (tighten the `#items` delegated handler).
- [x] ~~**Triage done/Undo chip overlaps the Keep button.**~~ Fixed (v2 pass): the toast is lifted above the fixed action bar. Reposition the undo chip / action bar
  so they don't collide.
- [x] ~~**"Open on reddit" preview URL is malformed.**~~ Fixed (v2 pass): Reddit permalinks are normalized to absolute www.reddit.com URLs. It builds a relative `/r/…` path (resolving
  to `127.0.0.1:8788/r/…`); render Reddit permalinks as absolute `https://www.reddit.com/…`.
