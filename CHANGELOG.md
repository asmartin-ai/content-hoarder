# Changelog

This project follows [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Suggestions in Clear.** A gentle highlight marks the Keep or Archive button that AI, with
  per-library consent, or your triage history would pick. No reason text appears on the card;
  the model's reason remains in `metadata.llm` for analysis.
  Decisions feed agreement stats and automatic background learning; Today can suggest an undoable
  learned pile to let go. AI gets relevant counts from your own decisions, not other titles.
  Turning AI off clears its hints across tabs.
- **Local tuning and pilot analytics.** `surface-stats` reports feature outcomes, calibration,
  hint agreement and AI usage. Temporary, opt-in-at-deployment demo analytics records pilot
  behaviour in each tester's library; `demo-events` reads it. See [AI suggestions](docs/ai-suggestions.md).
- **Settings page.** The nav gear opens AI, theme, density, daily goal, content
  and NSFW, archived media, Done retention, Reddit unsave and library tools. Add links to Settings;
  the Library settings sheet is gone.
- **More demo saves.** The synthetic library now has 45 fictional saves, including community
  clusters that can produce learned piles.
- **Hosted mode: a library per account.** Each Google account signed in to a hosted instance
  reads and writes its own SQLite file (`data/users/<hash>.db`); `app.db` keeps only accounts,
  sessions and invites. Testers no longer see each other's items, and the privacy page says so.
- **Add page: more than 1,000 Reddit saves.** Under the bookmarklet, a line points to Reddit's
  data request, whose ZIP (`saved_posts.csv`, `saved_comments.csv`) the Reddit connector already
  imports. On a phone, where the bookmarklet can't run, the page says to use the data request.
- **Clear explains its buttons.** A first-visit “? What the buttons mean” link opens a guide to
  Done, Archive, Keep, Not now and Skip; the `?` in the top bar also opens it.
- **Sign out** button at the bottom of Add in hosted mode. Signing out clears the browser's cached
  pages and storage (`Clear-Site-Data`), so the next person on that phone can't see them.

### Changed

- Finishing with an empty inbox offers **Add more saves**.

- Faster, smoother Library on long lists: the next page is appended instead of re-rendering every
  row, a decision removes one row instead of rebuilding the list, and the fast-scroll handle
  measures once per frame instead of on every scroll event.
- The service worker no longer precaches HLS (543 KB) or the iOS splash images, fetches its shell
  fresh (`cache: "reload"`) so a deploy can't install stale files, and survives one failed file.
  Static files and pages send `Cache-Control: no-cache`. SW cache `ch-shell-v151`.
- **Sign-in no longer waits for YouTube.** Google (and Twitch) sign-in lets you in at once; the
  pull runs in the background and Add shows "bringing your saves over", then the count.
- **Times follow the reader's time zone.** The browser sends its zone (`ch_tz`); Today's greeting
  and date, "cleared today", and Home's week and rhythm use it instead of the server's.
- **One tester's import no longer slows the others.** Parsing and writing an import runs in a
  worker thread (`src/import_worker.ts`), one import per library at a time (a second gets "an
  import is already running"). With a 20,000-item file, other requests took up to 922 ms before
  and 17 ms after. Uploads are capped at 100 MB, with a plain message when a file is bigger.
- Phone: sheets in the Library lock the page behind them on iOS, the tag sheet sits above the
  keyboard, the tag "+" and select circles have 44 px tap areas, filter chips no longer get
  clipped, and the Clear buttons fit a 320 px screen.
- Today's "Clear N" counts the cards actually waiting ("Clear 3", not "Clear 10").
- Home's sample buttons are visibly inert instead of links that jumped to the top.
- Add shows its preview and messages right under the drop box, says "Adding…" while it works,
  "already here" when nothing is new, and a plain message for a file type it can't read.

### Fixed

- **The Library stopped at 50 items.** Infinite scroll never loaded a second page, so a library
  of 1,000 saves looked like 50. Pages are also deduped, and triaging an item no longer shifts
  the next page by one.
- Done/Keep/Archive/snooze from the reader left the item in the list until a reload.
- An expired session now goes to sign-in instead of "That didn't stick" toasts and skeletons that
  pulse forever.
- A malformed address (`/invite/%E0%A4%A`, `/media/%E0%A4%A`) is a 404, not a crash; a malformed
  cookie no longer breaks Today or Home.
- **Security:** an import preview can only be committed by the account that made it.
- Clear: a quick double tap no longer decides the next, unseen card; a second finger no longer
  hijacks a swipe; an expanded card scrolls instead of skipping or opening; Undo works on the
  "Cleared" screen; a failed save no longer rewinds the deck under you; returning with Back no
  longer takes taps before the deck is ready.
- Rows from Reddit's data-request CSVs only fill gaps: they no longer replace a saved item's real
  title, link or metadata with the slug-derived ones, and they're marked `reddit_export_thin`
  until a richer import arrives. Saved comments from the CSV get a title from the post's link
  instead of none. A `reddit-saved.json` from the bookmarklet no longer imports as about 500
  dead Twitter links.
- A browser bookmarks export that contained a Hacker News or Reddit link imported only those
  links and dropped every other bookmark. Bookmarks exports are now recognised first.
- **Security:** imported items never keep a `javascript:`/`data:`/`vbscript:` URL, and the
  Library, reader, relay, lightbox and share refuse one already stored. In hosted mode one tester's
  import could otherwise run script in every tester's session.
- **Security:** the sign-in, privacy and invite pages send `frame-ancestors 'none'` and
  `X-Frame-Options: DENY` like every other page.
- Home's rhythm strip put today's decisions on yesterday's dot whenever the process time zone
  differed from the system one (every evening under `bun test`).
- Home's "Worth seeing again" no longer offers an item you snoozed.
- Holding a decision key in Clear no longer decides one card per key repeat.
- `scripts/demo.sh` is executable again.

### Changed

- **Clips play inside the round card.** Tapping a Reddit clip (v.redd.it via HLS, a direct
  `.mp4`/`.webm`, or its archived copy) plays it in place instead of opening the reader; any
  decision, undo or leaving the round stops it. Swipes that start on a playing video go to its
  controls. The Library's "sections" button uses an SVG instead of the ⚙ glyph. SW cache
  `ch-shell-v148`.
- **Smooth, fast rounds (`docs/design/deck-pass.md` §3).** Everything that moves in Clear animates
  transform/opacity only. Drags paint once per frame, with no subtree-wide style invalidation (about
  8× less style work per frame). Decisions no longer lock input: the card flies off as a ghost while
  the next one, already rendered underneath, is promoted in place, so rapid D/A/S chains all land.
  Flicks commit from a short drag and fly out at the finger's speed; early releases spring back;
  the card underneath rises as you drag; Undo rewinds the card from the side it left by. The blurred
  backdrop is rasterised at a quarter size. The Library's three `transition: all` controls now
  name their properties.
- **Deck pass (`docs/design/deck-pass.md`).** Today and Clear get their own look. Clear: every card
  fills the stage at one size on its community's tinted paper (stable hue per subreddit/channel);
  pictures sit whole over a blurred copy of themselves; text posts are typeset posters in Bricolage
  Grotesque (vendored, the Hearth display face) sized by title length; saved comments lead with a big
  open quote; dead galleries say so and open on tap. Dragging tilts the card, fades in a DONE/ARCHIVE
  stamp and lights the matching orb; the pad is five orbs (Done and Archive biggest); Undo moved to
  the top bar and the running clock is gone. The cleared screen adds a receipt of the round's cards
  and counted-up cleared · minutes freed · time spent. Today: the day title ("Sunday evening"), the
  next round as a fanned hand of its cards over the Clear button, today's count in a pebble ring, and
  piles as memory tiles. `home.css` split into `home.css` + `today.css` + `clear.css`. Reddit's
  literal `&#x200B;` no longer prints in card bodies. SW cache `ch-shell-v144`.
- **Clear v2 (`docs/design/clear-v2.md`).** Round cards are rich and server-rendered
  (`src/web/views/card.ts`): media hero with gallery/clip/duration badges and archived-copy
  fallback, subreddit/author/age head, self-text and saved comments rendered as markdown, the cached
  top comment, removed-post note, score/comments/views/domain stats, Show more; the next card peeks
  from behind. Today and Clear are server-rendered TypeScript views; Today uses vendored htmx 2.0.11
  for its partials (Up next filmstrip of the exact next round, wins, pile tiles with thumbnail
  mosaics, whisper) with an `HX-Trigger` undo snackbar — the first step of the HTMX migration
  (issue #3); the Library list is unchanged. `/clear/deal` serves cards; `home.html`, `today.js`
  and `card.js` are gone. Piles list entertainment subreddits before age piles. SW cache
  `ch-shell-v142`.
- **Three-room UI ("Clear" overhaul, `docs/design/clear-overhaul.md`).** `/` is now **Today**: one
  lit "Clear 10" button (5/10/25), wins-only counting (today + all-time, pebbles toward the daily
  goal), a re-entry line, up to three sweeps, and the resurfacing whisper — no remaining-inbox count.
  `/clear` is a **round**: one card at a time, big Done/Archive pad in the thumb zone, smaller
  Keep/Not now/Skip/Open, multi-step Undo, swipe ←/→/↑/↓, progress beads, a quiet in-round streak,
  resumable via `sessionStorage`, and a CLEARED stamp with today's pebbles. The browse page moved to
  `/library` (`/browse` alias) and lost its second triage system: deck mode, focus batches, the PAGE
  CLEARED stamp, the console goal bar, dice, Triage button, version badge (now in settings), swipe
  legend, and the mobile dock. One shared nav (Today · Clear · Library): top bar on desktop, bottom
  tab bar on phones. `/triage` and `/?deck=1` land on `/clear`; the reader returns to `/clear`.
  Service-worker cache `ch-shell-v140`.

### Added

- **Hosted, invite-only mode for a friend pilot (`CONTENT_HOARDER_PUBLIC_ORIGIN`).** Off unless that
  origin is set; local use is unchanged. `bun scripts/invite.ts` prints a one-use invite link. The
  first Google account to open it owns a session (30 days, hashed in `hosted_sessions`); everyone
  else sees "invite-only". Google sign-in (PKCE) also reads the user's YouTube playlists and liked
  videos once; **Connect Twitch** reads followed channels into a new `twitch` source. Access tokens
  are used for that pull and never stored. `/privacy` explains this.
- **Add page (`/add`)**: drop a bookmarks export or any file the importers know, or paste links;
  preview, then add. New `bookmarks` (Netscape HTML) and `links` (plain text, OneTab, markdown)
  connectors. A read-only "Get my Reddit saves" bookmarklet downloads the saved listing for import.
  An empty Today now points to Add instead of offering a round. Service worker `ch-shell-v147`.
- **Home (`/home`), a dashboard prototype built around what's specific to Khaos.** The sections:
  - **Start here:** one suggested round, with lighter and bigger options.
  - **This week's flow:** what arrived, by source, and where your attention moved it: let go, kept, learning, commitment. "Let go" is the headline.
  - **Worth seeing again:** the oldest waiting save, with a reason.
  - **Parked until…:** shelved work that wakes on a condition.
  - **Agent receipts.**
  - **Patterns noticed:** user-model offers.
  - **Attention guard:** nudge budget, quiet hours, earned-autonomy progress.
  - **A 14-day rhythm strip** and module status chips.

  Real data: Start here, arrivals by source, let go and kept counts, the resurfaced save and the
  rhythm. Everything else is marked "Sample". `MODULES` in `src/web/views/home.ts` is the first
  version of the module registry that life-os will own. Home tab added to every nav. SW cache
  `ch-shell-v146`.
- **Sanitized demo (`docs/DEMO.md`).** `scripts/demo.sh` starts a fresh library in a new temp folder
  with 24 invented saves (`docs/demo/demo-saves.json`). It runs from that folder, so it loads no
  `.env` and never opens `data/app.db`. The doc has the walkthrough, verified vs unverified steps
  and a safety checklist.
- **Offline mode.** `CONTENT_HOARDER_OFFLINE=1` makes `safeFetchUrl` refuse every non-loopback
  host, and Reddit hydration returns `offline` (the reader says so) without stamping a failure.
  `scripts/demo.sh` and the test preload (`bunfig.toml` → `tests/preload.ts`) set it, so demos,
  smoke runs and tests can't reach Reddit or archives by accident. SW cache `ch-shell-v145`.
- **Sweeps** — `GET /sweeps`, `POST /sweeps/apply`, `POST /sweeps/undo`: one-tap reversible rest
  of an entertainment subreddit pile or a source's saves older than four years, via `decay()` waves
  labelled `sweep`. Knowledge subreddits and resurface tags are excluded; never enqueues Reddit
  unsaves. `/pulse` gains `swept_today` and `cleared_total`.
- Hearth tokens `--win*`, `--moss*`, `--ember-fill*`, `--dur-stamp` in `static/core/tokens.css`.
- Drag-and-drop to status buckets on desktop (issue #13): Library rows drag onto the
  Inbox/Keep/Archived/Done folders, reusing the existing status path (haptics, undo snackbar).
  Vanilla HTML5 DnD — no new runtime dependency.
- `assist-auto-archive` CLI (issue #25): lists high-skip subreddit buckets from the learned
  triage model with live inbox counts, and (with `--apply`) archives each via the reversible,
  wave-stamped decay path (`label='auto-archive'`, queryable via `is:decayed`).
- PKMS promote action (Spec 15, ADR 0027): the row menu's Promote affordance POSTs the item to
  PKMS via the opt-in bridge (`PKMS_CAPTURE_URL`/`PKMS_CAPTURE_TOKEN`); the deterministic
  capture answer (``saved ✓``/``already saved ✓``, deduped on `ch_item_id`) is stamped onto
  `metadata.promotion` with a lifecycle receipt, snackbared verbatim; errors toast
  `data.error` (unconfigured 400 / transport 502). Never reads or prints the token.
- `user_tags` registry + `tag create|list|rename|delete` CLI (Epic 26 P3, issue #70):
  pre-create empty tags (stable id + display name), rename across the whole vocabulary in one
  transaction (bulk rewrite of `tags_manual`/`tags`, FTS rebuild), delete-from-vocabulary;
  the derived vocabulary still surfaces unregistered stamps, so nothing drops out.

### Fixed

- An empty inbox (nothing imported yet, or everything decided or snoozed) no longer breaks the
  deal query. Before, Today showed a blank card and Clear said "Couldn't reach the server" while
  the server was running; now both say "Nothing waiting here".
- `import` on a path that doesn't exist now says `Nothing found at "<path>"`, instead of asking
  for `--source`.
- The reader's Reddit comment threads load again. Since the web split (2026-10-21), the generic
  item route swallowed `/reddit/items/<id>/thread`, so every thread answered 404 and the reader
  said "Network error". Regression test in `tests/web.test.ts`.
- "Not now" no longer counts as cleared in the round, so the round and Today agree.

### Performance

- Browse reads: composite and expression indexes keep the feed in scan order instead of
  sorting a bucket per request — status/source feeds (14ms → 0.4ms), status page at offset
  10k (82ms → 7.4ms), `sort=created_utc|saved_utc|score` (18-20ms → 0.3ms), `author:`/
  `subreddit:` facets (10-21ms → 0.1-0.5ms), `/reddit/items` (16ms → 0.7ms) and the triage
  deck's smart pool (25ms → 0.4ms, triage-score scan pinned now that its ORDER BY matches the
  index expression).
- `sort=shuffle` (mixed browse) transposes per-source previews instead of ranking every row
  in a window function: 95ms → 1.4ms per page.
- Imports: `db.mergeUpsertMany` inserts never-seen rows with one multi-row statement per
  250-row chunk (per-row statement dispatch dominated the import), with per-row replay on a
  failed chunk so one bad item still reports its own error. The `items_au` FTS trigger now
  skips the index rewrite when none of its six mirrored columns changed, and new rows probe
  existence instead of materializing the stored row: 1k-row import 99ms → 66ms, 1k-row
  re-merge 103ms → 89ms (with the nine new indexes already included). Single-row
  `mergeUpsert` callers pay ~24µs more per new row for those indexes.
- `reddit-sync` upserts a whole listing page in one transaction through
  `db.mergeUpsertMany` instead of committing row by row (5 pages × 100 new saves:
  33ms → 17ms). A stored row the merge cannot parse now lands in `SyncResult.errors`
  instead of aborting the run, and the page's other rows still commit.
- `subreddit:`/`author:` IN lists now carry `COLLATE NOCASE` on the operand rather than on
  the `IN` expression, which is what makes those comparisons case-insensitive and the NOCASE
  indexes usable.

### Changed

- Browse shell split into ES modules (no behaviour change): `src/static/browse/main.js` (4,092
  lines) is now the entry point only. The surface lives in `browse/shared.js` (state + DOM/storage
  helpers + view persistence), `browse/data.js` (query params, first-page prefetch, feed loading,
  counts, rail facets, pulse), `browse/feed.js` (render, Focus batches, infinite scroll, deck URL
  toggle), `browse/actions.js` (triage + undo/redo, row interactions, bulk tray, next-thread
  preload, unsave/promote), `browse/lightbox.js` (hold-to-preview, media lightbox, archive.today
  recovery), `browse/relay.js` (long-press row menu), `browse/nav.js` (tabs, rail/chip filters,
  drag-and-drop, search + operators, sort, keymap), `browse/drawer.js` (mobile jump drawer),
  `browse/chrome.js` (pebbles/dateline, scroll-to-top, fast-scroll, shrink-on-scroll header,
  version badge), `browse/ambient.js` (resurfacing card + surprise), `browse/panels.js` (sheets,
  settings, Done retention, stats/dupes, Sync newest) and `browse/instances.js` (deck/reader/
  tag-editor wiring). Fetched URLs, DOM ids/classes, events and keyboard shortcuts are unchanged;
  `sw.js` precaches the new files and bumps the shell to `ch-shell-v130` (badge `v130`).
- Browse UI overhaul (deck, console, rail, mobile header). Deck mode is now a real focus surface:
  the list chrome (tabs, shelf, swipe hint, rail, dock shortcuts) hides while it is open, the card is
  rebuilt on the v3 tokens with source identity, media, an excerpt and a labelled decision row
  (Keep / Archive / Done / Read / Skip) wired to the same commit path as the keys and swipe. The card
  previously used deleted v2 variables (`--surface`, `--line`, `--mute`, `--ink`), which rendered a
  white card with night-theme text at ~1.1:1 contrast.
- Console: single 57px row with a right cluster; the daily goal is a labelled bar (`765 cleared` once
  met) instead of eight anonymous dots, icon buttons are borderless until hover, Triage is an outlined
  button, and the version badge is de-emphasised. Desktop sheet widened to 1200px with a 210px rail.
- Rows: 0.8rem metadata and 0.78rem snippets; section headers lose the `//` marker; the source-own
  domain chip (`reddit.com` on a Reddit permalink) is suppressed; the source stripe is 55% opacity.
- Tokens: `--dim` raised to `#7b8798` (dark) and `#5a6875` (light) so tertiary text meets AA; DESIGN.md
  no longer points at the deleted legacy token file.
- Phones: header is two rows (identity + count, then search), shelf stays on one line, the tab strip
  fades at the edge, and deck mode stacks to one column with a 2×2 action pad.

### Fixed

- Reddit autosync killed the web server on its first tick: `SyncScheduler` closes the connection
  it opens, and `serveApp` handed it the shared request connection, so every later request answered
  `Cannot use a closed database`. The scheduler now opens its own connection (same pattern as the
  unsave drainer), `serveApp` exposes it for deterministic ticks, and `tests/web.test.ts` covers the
  regression.
- Promote row-menu action was dead UI: `promoteItem` was dispatched but never defined
  (Spec 15 §7) — handler wired, `promoteItem` wrapper added to `core/api.js`, and the
  `[hidden]` attribute now honored by the relay buttons (`browse.css`).
- `bridge.pkms._note_name` no longer records a non-✓ 2xx body as the vault-path
  `delivery_ref`.
- PKMS promote: a 2xx body without the ``saved ✓``/``already saved ✓`` confirmation is now
  recorded ``failed`` (error set, no delivery_ref) instead of being stamped ``promoted`` —
  a partial receipt was previously presented as success and permanently blocked re-promote
  (Spec 15 §5/§1.6).
- `db.create_user_tag` masks only duplicate-name (UNIQUE) failures as "already exists";
  other DB errors propagate instead of being mislabeled.
- `db.rename_user_tag_in_vocab` rolls back the vocabulary row + item stamps on failure
  (matches `delete_user_tag`); docstring now matches the actual commit contract.
- Bun CLI parity: the legacy Python dry-run/safety note text and JSON export bytes are
  preserved verbatim, Twitter bookmark order is retained, and nested folder/tag options and
  positional arguments are scoped to their own commands. Help output and malformed-command
  errors match the Python original byte-for-byte.
- SW cache + APP_VERSION bumped v128 → v129 (new static assets must not serve stale).

### Changed

- `src/web.ts` split into `src/web/` modules (server lifecycle, route table, item/settings/import
  handlers, HTTP/guard/static/state helpers) and the autosync tick moved to
  `src/sync/scheduler.ts`; every route path, status code, JSON shape, and the scheduler's
  own-connection contract are unchanged.
- **Runtime cutover to Bun + TypeScript.** The CLI, web app, SQLite layer, connectors, archival,
  media, and OCR paths are TypeScript on Bun (`bun run check` is the gate: tsc,
  `oxlint --deny-warnings`, oxfmt, tests). `bun:sqlite` replaces stdlib sqlite3 with the same
  schema, FTS5 external-content indexes, durability triggers, and non-destructive upsert
  semantics. SSRF policy is enforced with `node:net` `BlockList`, refusing IPv4-mapped IPv6,
  noncanonical/encoded IPv4 spellings, and every localhost alias form. OCR is magick
  first-frame plus native tesseract; video archival is ffmpeg over HLS/DASH via youtubei.js.
  No yt-dlp and no Python sidecar.
- The previous "refreshed the Python lockfile / Flask 3.x / `.venv`" entry has been removed: it
  described a runtime this project no longer has.
- Repository relocated under a new parent directory (2026-08-15 unification); all internal
  path references were updated.


## 1.1.0 - 2026-07-01

### Added

- Added inbox-only triage filtering by source, category, tags, and Smart/Newest/Random mode, with persisted filter state and stale-session clearing when filters change.
- Added cached Hacker News thread rendering in the browse reader, including synthetic UI coverage for nested HN comments.

### Changed

- Reworked the triage deck controls around the pinboard-style card shell, clearer edge hints, reader handoff affordances, and settings-menu theme controls.
- Hardened archive.today media recovery so media-only retries can skip metadata archive providers, and broadened the PWA shell cache for `/reddit`, triage tokens, reddit assets, and HLS playback.

### Fixed

- Stabilized the mobile browse header around both finger-fling momentum and floating up-button scroll-to-top: near-top swipes now smoothly scrub the header between compact and expanded states without clipping the Today indicator, the up button finishes at the true top, and reduced-motion preferences remain respected.

## 1.0.0 - 2026-06-29

### Release posture

- First SemVer-stable local release of content-hoarder as a local-first saved-content triage tool.
- The app remains intentionally local-only: SQLite database, local media store, and optional external integrations gated by explicit commands/settings.

### Highlights

- Unified saved-content import/search/triage across Reddit, YouTube, Hacker News, Obsidian, Google Keep, Firefox tabs, Twitter/X bookmark exports, and related local sources.
- v3 browse surface with source/status filtering, search operators, bulk actions, reader/lightbox overlays, mobile PWA support, and service-worker shell caching.
- Reddit media recovery and preservation path: scan deleted media, archive local bytes, prefer same-origin archived media, and per-item archive.today recovery for already-gone media.
- Reddit OAuth support, saved-list sync, cached discussion/thread hydration, and guarded Reddit unsave-on-Done workflow.
- Deterministic offline tests plus Pixel-6/PWA Playwright coverage for the mobile interaction paths.

### Fixed for 1.0.0

- Fixed lightbox blank-space drags scrolling the inbox behind the overlay.
- Fixed long-press relay menu activation shifting the pressed row under the finger.
- Fixed hold-to-preview image peeks panning/zooming into empty space, including full-viewport zoom bounds and transform reset between opens.
- Removed the mobile per-row `Decide` button; row triage remains available via gestures, keyboard, row menus, and existing action paths.
- Hardened async gallery hydration so a late response cannot reopen the lightbox after the user closes it.

### Notes

- `data/media/` is gitignored and is not contained in metadata-only DB backups; back it up separately if local media archival matters.
- Browser/PWA asset cache is versioned separately by the service-worker cache name and visible app build badge.
