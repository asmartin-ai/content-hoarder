# Manual QA Test Checklist

Walk through these on **desktop** and **mobile**. The checklist is organized as **user stories** —
realistic usage sequences you can flow through in one sitting — rather than a flat feature matrix.
Each story groups related checks so you don't have to jump around the app.

Legend: 🖥 = desktop only · 📱 = mobile only · ⬛ = test on both.

> **Findings → backlog, not here.** Keep this file a neutral checklist; file anything broken as a
> `BACKLOG.md` item under the right Epic, not as an inline note.

## How to run / test

- **Desktop:** `python -m content_hoarder serve` → http://127.0.0.1:8788
- **Mobile:** `python -m content_hoarder serve --host <tailscale-ip>` → open the URL on the phone
  (Chrome / Pixel-6 target) and install to home screen. See [MOBILE_TAILSCALE.md](MOBILE_TAILSCALE.md).
- **Mobile layout** engages at **≤ 860 px** (left sidebar becomes a hamburger drawer). Preview on
  desktop via DevTools device-emulation, but do a real-phone pass for swipe/touch.
- **Service worker:** the shell is precached (`sw.js` — check the current `CACHE` constant for the
  version). After a code change, bypass it (DevTools → Application → Service Workers → "Update on
  reload") or you may test stale assets.
- Re-check **light + dark** theme and (where relevant) `prefers-reduced-motion`.

---

## Story 1 — "I open the app and orient myself"

Cold start, shell, theme, offline. The first 30 seconds.

- [ ] **Loads clean:** app opens at `/`, no console errors on first paint. ⬛
- [ ] **Offline:** load, kill the network, reload — the shell still renders (service worker). ⬛
- [ ] **Install to home screen** (Chrome menu → Install app → real WebAPK); the installed PWA opens
      standalone. 📱
- [ ] **Theme toggle** (three-dot ⋯ menu → Light/dark) switches instantly, persists across reload,
      and both modes are readable. ⬛
- [ ] **Reduced motion:** with the OS "reduce motion" setting on, swipes/animations are neutralized. ⬛
- [ ] **Responsive:** desktop shows the left rail; at ≤860px it collapses to the hamburger drawer. ⬛

## Story 2 — "I scan the inbox and pick something to read"

Navigation, source tabs, filters, the pulse, finding an item.

- [ ] **Source tabs** (All / Reddit / YouTube / Hacker News / Firefox / Obsidian …) switch the list
      and show per-source counts; the Firefox tab shows the **Firefox logo** avatar + blue dot. ⬛
- [ ] **Three-dot ⋯ visual menu** opens: Compact / Comfortable / Cards, Light/Dark, Focus mode. ⬛
- [ ] **Focus mode** toggles a distraction-reduced layout and persists. ⬛
- [ ] **Status nav** (Inbox / Keep / Archived / Done …) filters the list and shows live counts; counts
      **cross-filter** with the active source/tag. ⬛
- [ ] **Tag filter** — curated tags (~15) with counts; selecting filters (OR across selected); an
      active tag stays visible (count 0) even if cross-filters would hide it. Tags collapse + persist. ⬛
- [ ] **Sort** control changes ordering (recency, playlist position, duration, etc.). ⬛
- [ ] **Pulse / progress strip** updates as you triage (done count, streak, win pebbles). ⬛
- [ ] **Independent scroll (desktop):** scrolling the list doesn't move the rail, and vice-versa; the
      header stays fixed. 🖥
- [ ] **Mobile drawer:** hamburger opens the rail; backdrop tap / swipe closes it; list doesn't scroll
      underneath while the drawer is open. 📱
- [ ] **Stats** opens the stats modal. ⬛

## Story 3 — "I search and filter to find a specific thing"

Search bar, operators, the command palette.

- [ ] **Search pill** (`#q`) — typing filters the list; the clear (✕) button empties it. ⬛
- [ ] **Operators** compose with each other and with the sidebar/dropdown filters. On both the browse
      bar and the Reddit view search:
  - [ ] `source:reddit` / `source:youtube` (mixed case too). ⬛
  - [ ] `kind:post` · `status:inbox` · `subreddit:hololive`. ⬛
  - [ ] `tag:memes` (single) · `tag:memes,coding` (OR) · `tag:coding tag:japan` (AND). ⬛
  - [ ] `is:saved` · `is:nsfw` · `is:snoozed`. ⬛
  - [ ] `before:2023-01-01` · `after:2022-12-31` (date range). ⬛
  - [ ] `score:>100` · `score:<5` · `score:100`. ⬛
  - [ ] `"exact phrase"` (quoted) and `-removed` (negation). ⬛
  - [ ] Combine: e.g. `source:youtube before:2023-01-01 -shorts`. ⬛
  - [ ] **#fuzzy** toggle — typo-tolerant matching for bare free-text. ⬛
  - [ ] A malformed operator (`before:notadate`) degrades to plain text without erroring. ⬛
- [ ] **Command palette** (`>`) — fuzzy match, arrows wrap, Enter runs, Escape exits. 🖥

## Story 4 — "I triage items from the list" (browse)

Row interactions, densities, swipe, keyboard, the act of deciding.

- [ ] **Compact density** — dense rows; the ▶ media pill sits beside (not under) the action icons. ⬛
- [ ] **Comfortable density** — rows with thumbnails. ⬛
- [ ] **Cards density** — large cards; title isn't clipped; adaptive hero + bottom action row. ⬛
- [ ] **Row click opens** the item; only the **avatar/checkbox** toggles selection. ⬛
- [ ] **Swipe-reveal** (drag left/right): short → = Archive, long → = Keep, short ← = Done, long ← =
      Snooze. Underlay color + icon swap at the long threshold + haptic pulse. A row swipe never
      side-scrolls the page. 📱
- [ ] **Keyboard:** `J`/`K` move focus, `S` keep, `E` archive, `Y` done, `X` select, `T` tag, `Q`
      surprise. 🖥
- [ ] **Group select** — selecting rows shows the bulk bar with a count; bulk Keep/Archive/Done apply
      and the selection clears; **Undo** reverts. ⬛
- [ ] **Tag chips** render on rows; **category** (listenable/watch/wotagei) shows as a tag. ⬛
- [ ] **Companion 💬 chip** on a consolidated YouTube row links out to the Reddit/HN discussion. ⬛
- [ ] **NSFW blur** — over-18 media is blurred with tap-to-reveal; revealing allows opening the lightbox. ⬛
- [ ] **Tappable meta:** `r/<sub>` opens the subreddit, `by <author>` opens the user page, an HN item
      opens the HN thread — without triggering row-open/select. ⬛
- [ ] **Empty states** — searching with no matches / an empty status show the right message. ⬛
- [ ] **Load more / batch** — "Show more" appends the next batch; no duplicates. ⬛

## Story 5 — "I open the reader and work through a thread"

Opening items, the inline reader, triaging from inside it.

- [ ] **Reddit thread thumbnail → reader** (not the reddit iframe) when the item has no lightboxable
      media; image/video/gallery thumbnails still open the lightbox. 📱
- [ ] **Title/body tap opens the reader** for Reddit / HN / Keep / Obsidian / YouTube / Twitter. ⬛
- [ ] **Reader renders:** post + comment thread (Reddit/HN), note body (Keep/Obsidian), YouTube iframe,
      Twitter stored media + text. Markdown renders (links, bold, quotes, lists, code, inline images). ⬛
- [ ] **Comment UX:** tap-byline collapses/expands; author `u/name` links to the profile; fully-dead
      threads auto-collapse; OP comments highlighted. ⬛
- [ ] **Reader has no triage dock:** the old `.rd-foot` action dock is intentionally gone; reader actions
      remain available via keyboard (`F`/`A`/`D`/`T`/`S`) and row/list gestures after returning. ⬛
- [ ] **Done/Archive/Keep from the reader does NOT refresh the feed** — the list keeps its position;
      the triaged item leaves lazily on the next load. ⬛ *(shipped on `staging/mobile-polish-t3` via A2)*
- [ ] **Closing the reader** (back button / ✕ / Esc / swipe) returns to the exact scroll position. ⬛
- [ ] **Closing the reader stops media playback** (no audio bleed after close). ⬛
- [ ] **Note editor** (Keep/Obsidian): edit-body toggle, textarea, live preview, save; checklist lines
      toggle. ⬛
- [ ] **Open original ↗** + **Share** in the reader header work. ⬛

## Story 6 — "I use the triage deck" (`/triage`)

The focused Tinder-style triage flow.

- [ ] **Swipe card** left/right shows the stamp and commits keep/archive/done. ⬛
- [ ] **4-directional swipe:** ↑ opens the reader/thread, ↓ skips (no-decision pass), ←/→ = Done/Archive
      + Keep, long-← = Snooze. 📱
- [ ] **Action bar** shows Keep / Archive / Done icons in semantic colors, each with a `<kbd>` hint. ⬛
- [ ] **Keyboard:** `S` keep · `E`/`→` archive · `Y`/`←` done. 🖥
- [ ] **Undo toast** appears after an action, reverts it, sits above the action bar (no overlap). ⬛
- [ ] **Snooze** (long-left swipe or button) hides the item for 7 days; repeat snoozes escalate to
      decay (reversible). 📱
- [ ] **Direct-entry back guard:** launching/refreshing directly onto `/triage` then pressing back
      navigates to `/` (inbox), not exit the PWA. 📱
- [ ] **Recover** button on `[removed]`/`[deleted]` Reddit cards patches title/body in place. ⬛
- [ ] **Category re-tag chips** (YouTube items) change the processing area + persist. ⬛
- [ ] **`?`** opens the shortcut cheatsheet; `Esc`/backdrop closes; ignored while typing. ⬛

## Story 7 — "I look at media" (lightbox / gallery / video)

The media viewer, zoom, and gallery flows.

- [ ] **Image thumbnail** opens the media modal. ⬛
- [ ] **Gallery** (Reddit multi-image) opens the inline stacked lightbox with all images. ⬛
- [ ] **Reddit video** plays with audio (HLS) inline in the reader; permalink stays navigable. ⬛
- [ ] **Hold-to-preview** (Relay-style): press-and-hold a thumbnail opens the lightbox temporarily;
      release closes it. 📱 *(shipped 2026-06-27 on `staging/mobile-polish-t2`; pending real-device
      verification of the swipe/long-press race + the click-after-peek suppression)*
- [ ] **Scroll-lock:** while the lightbox is open, the browse list behind it doesn't scroll. ⬛
- [ ] **Pinch-zoom / mouse-wheel zoom** inside the lightbox zooms the image (not the page). ⬛
  *(shipped 2026-06-27 on `staging/mobile-polish-t2`; 1×–4× clamp, `dblclick` resets, gallery image-swap
  resets; pending real-device pinch verification)*
- [ ] **Swipe-to-pan** (when zoomed) + **swipe-far-to-close** (Relay-style dismiss). 📱
  *(not yet shipped — C3, unblocked now that C2 pinch-zoom landed on staging; spec
  `delegation/SPEC-c3-lightbox-pan-close.md` ready)*
- [ ] **Back from lightbox** returns to the feed (not exit the app). ⬛

## Story 8 — "I tag items" (mobile + desktop)

The tag editor flow — especially the mobile fast path.

- [ ] **Open tag editor** from the row (Tag button / long-press menu / `T` key). ⬛
- [ ] **Suggestions on open (mobile):** the last 2 categories + the most-common manual tag appear
      before typing; they disappear once you type. 📱
- [ ] **Tap a suggestion** applies the tag without opening the keyboard. 📱
- [ ] **Type + Enter** applies the tag; on mobile the editor closes (single-tag flow); on desktop it
      stays open for multi-tag. ⬛
- [ ] **No keyboard flicker** across the commit (no close-then-reopen). 📱
- [ ] **Remove a tag** via the chip ✕; the rail refreshes. ⬛
- [ ] **Create a new tag** on the fly (typing a novel name → "create"). ⬛
- [ ] **User tags survive re-import** (the `tags_manual` stamp holds). ⬛

## Story 9 — "I use the sidebar + sheets" (focus + modals)

Drawer, modals, import, the things that overlay the list.

- [ ] **Sidebar open dims + scroll-locks the browse list** — no scroll bleeds through while the drawer
      or any sheet is open. ⬛
- [ ] **Import modal:** pick a file **or** paste a URL → Prepare → preview → Commit; Cancel/Close
      dismiss. ⬛
- [ ] **Stats modal** renders totals/counts. ⬛
- [ ] **Shortcut cheatsheet** (`?`) readable on browse + triage. ⬛
- [ ] **Media + Reddit thread modals** open/close cleanly (Esc + backdrop). ⬛

## Story 10 — "I use the Reddit management view" (`/reddit`)

The dedicated Reddit surface.

- [ ] **Subreddit rail** lists subreddits with counts; selecting filters. ⬛
- [ ] **Table ↔ grid** view toggle switches layout. ⬛
- [ ] **Filters:** tag, kind, saved, subreddit, fuzzy + search operators (Story 3). ⬛
- [ ] **Thread viewer** loads comments inline in the detail panel. ⬛
- [ ] **Unsave** flips `is_saved` optimistically; **Undo** cancels a still-pending unsave; a real
      re-save failure surfaces. ⬛
- [ ] **Sync newest** pulls newly-saved items (high-water mark). ⬛
- [ ] **Reddit-unsave drain** controls: save cookie, enable unsave-on-done, drain the queue (count +
      confirm). ⬛
- [ ] **NSFW blur** in the Reddit view. ⬛
- [ ] Header doesn't crowd/clip at any width. ⬛
- [ ] Reddit permalinks render as absolute `https://www.reddit.com/…`. ⬛

## Story 11 — "Backend / data passes show up in the UI" (verify effects)

CLI-driven; confirm the UI reflects them.

- [ ] **Cross-source consolidation** — the promoted YouTube videos appear with real titles + 💬 chips. ⬛
- [ ] **YouTube enrich** — videos show exact duration/channel/views + thumbnails. ⬛
- [ ] **Title recovery** — `[Private/Deleted video]` items show Wayback-recovered titles. ⬛
- [ ] **Reddit archival** — `[removed]/[deleted]` recovered; scores hydrated; media split into
      image/video/gallery with real thumbnails. ⬛
- [ ] **Reddit cookie sync** — brings in items saved since the last sync. ⬛
- [ ] **Categorization / tagging** — Reddit multi-label tags + YouTube categories drive the tag filter. ⬛
- [ ] **Firefox tabs import** — tabs appear; YouTube tabs promoted to `youtube:` items. ⬛
- [ ] CLI-only (no UI): **dedup**, **bankruptcy**, **export-obsidian** — run and confirm the DB/UI
      reflects the result. 🖥

## Story 12 — "I use the ambient + surprise features"

Resurfacing card, surprise-me, the dice.

- [ ] **Resurfacing card** renders "Still interested in X?" + Not-now / Let-it-go; dismiss is silent;
      let-it-go decays + is undoable. ⬛
- [ ] **Surprise me** (⚃ dice) deals a random item; the card shows its thumbnail; Open routes into the
      reader for discussion/note items or the lightbox for media. ⬛
- [ ] **Filter-state chips** show active source/tag with ✕ + "clear all". ⬛
- [ ] **Dates** on rows show posted / added / synced with an absolute-date tooltip. ⬛
- [ ] **Firefox tabs filter** — `is:firefox-tab` shows only `open_in_firefox` items. ⬛

---

## Known gaps / WIP (don't file these as new bugs)

- **Tag-chip overload** on enriched YouTube cards (a wall of raw keyword chips) — display fix pending.
- **Mobile long-press group-select** deferred from the retention/gallery split (tap-opens-modal shipped).
- **Swipe physics feel** iceboxed (user: "right now it's fine") — re-activate if it feels laggy/stiff.
- **Hold-to-preview media** (B4) **shipped 2026-06-27 on `staging/mobile-polish-t2`** — pending real-device
  verification of the swipe/long-press race + click-after-peek suppression.
- **Pinch-zoom in lightbox** (C2) **shipped 2026-06-27 on `staging/mobile-polish-t2`** — 1×–4× wheel +
  pinch, pending real-device pinch verification. **Pan + swipe-far-to-close** (C3) shipped on
  `staging/mobile-polish-t3`; verify one-finger pan/close on real device.
- **Don't refresh feed on reader triage** (A2) shipped on `staging/mobile-polish-t3`; verify feed position
  and lazy item removal on real device.
- **Scroll-deceleration** (E2) low priority — rapid fling to top feels weird.
- **Relay strip refinements** (P3) **shipped 2026-06-27 on `staging/mobile-polish-t2`** — icon-only,
  larger touch targets, narrow-screen shrink.

---

> Tip: capture screenshots of anything off (especially on mobile) with the viewport width noted.
> The comfortable-density, Reddit-media, and mobile-lightbox items are the most likely to surface issues.
