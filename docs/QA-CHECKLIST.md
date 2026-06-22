# Manual QA Test Checklist

A by-feature checklist of everything shipped so far, to walk through on **desktop** and **mobile**.
Legend: 🖥 = desktop only · 📱 = mobile only · ⬛ = test on both.

> Annotations from the 2026-06-08 QA pass were groomed into `BACKLOG.md` (Epics 13–16, 19, 20) —
> keep this file a neutral checklist; file findings as backlog items, not inline notes.

## How to run / test

- **Desktop:** `python -m content_hoarder serve` → http://127.0.0.1:8788
- **Mobile:** `python -m content_hoarder serve --host <tailscale-ip>` → open the URL on the phone
  (Chrome / Pixel-6 target) and install to home screen. See [MOBILE_TAILSCALE.md](MOBILE_TAILSCALE.md).
- **Mobile layout** engages at **≤ 860 px** (left sidebar becomes a hamburger drawer). You can preview
  it on desktop via DevTools device-emulation, but do a real-phone pass for swipe/touch.
- **Service worker caveat:** the shell is precached (`sw.js` — check the current `CACHE` constant for
  the version). After a code change, bypass it (DevTools → Application → Service Workers → "Update on
  reload") or you may test stale assets.
- Re-check **light + dark** theme and (where relevant) `prefers-reduced-motion`.

---

## 1. Shell / PWA / cross-cutting  ⬛

- [x] App loads at `/`; no console errors on first paint. ⬛
- [ ] **Offline:** load, kill the network, reload — the shell still renders (service worker). ⬛
- [ ] **Install to home screen** (Chrome menu → Install app → real WebAPK); the installed PWA opens standalone. 📱
      *(No in-app `install-hint` banner exists in v3 — install via the browser menu. Chrome does fire
      `beforeinstallprompt`, so a custom install button is possible if wanted.)*
- [x] **Theme toggle** (three-dot ⋯ menu → Light/dark) switches instantly, persists across reload, and
      both modes are readable. ⬛
- [ ] **Reduced motion:** with the OS "reduce motion" setting on, swipes/animations are neutralized. ⬛
- [x] **Responsive:** desktop shows the left rail; at ≤860px it collapses to the hamburger drawer. ⬛

## 2. Top bar & navigation  ⬛

- [ ] **Search pill** (`#q`) — typing filters the list; the clear (✕) button empties it. ⬛
- [x] **Source tabs** (All / Reddit / YouTube / Hacker News / Firefox / Obsidian …) switch the list and
      show per-source counts; the Firefox tab shows the **Firefox logo** avatar and a blue dot. ⬛
- [x] **Three-dot ⋯ visual menu** opens and offers: **Compact / Comfortable / Cards**, **Light/Dark**,
      **Focus mode**. ⬛
- [x] **Focus mode** toggles a distraction-reduced layout and persists. ⬛
- [ ] **Stats** opens the stats modal; **Reddit** link opens `/reddit`; **Import** opens the import modal;
      **Sync newest** triggers a Reddit sync (see §8). ⬛

## 3. Left rail (desktop) / drawer (mobile)

- [x] **Status nav** (Inbox / Keep / Archived / Done …) filters the list and shows live counts. ⬛
- [x] Counts **cross-filter** with the active source/tag (e.g. pick Reddit → status counts update). ⬛
- [x] **Tag filter** — curated tags (~15) with counts; selecting one filters (OR across selected). An
      active tag stays visible (count 0) even if cross-filters would hide it. ⬛
- [x] **Tags section collapses/expands** by clicking the "Tags" title; collapsed state persists. ⬛
- [x] **Tools** subsection (Stats, Reddit sync, Reddit, Import) — each row activates by click and by
      Enter/Space. ⬛
- [x] **Sort** control changes ordering (recency, playlist position, duration, etc.). ⬛
- [x] **Independent scroll (desktop):** scrolling the list doesn't move the rail, and vice-versa; the
      header stays fixed. 🖥
- [ ] **Mobile drawer:** hamburger opens the rail; backdrop tap / swipe closes it; list scrolls normally
      underneath. 📱

## 4. Inbox / Browse list (`#items`)

- [x] **Compact density** — dense rows; the ▶ media pill sits beside (not under) the keep/archive/done
      action icons (no overlap). ⬛
- [x] **Comfortable density** — rows with thumbnails. *(Known WIP — see §11.)* ⬛
- [x] **Cards density** — large cards; title isn't clipped/overlapped; adaptive hero + bottom action row. ⬛
- [x] **Row click opens** the item (detail/media); only the **avatar/checkbox** toggles selection. ⬛
- [ ] **Group select** — selecting rows shows the **bulk bar** with a count; bulk Keep/Archive/Done apply
      and the selection clears; **Undo** reverts. ⬛
- [x] **Swipe-reveal icons** on a row (drag left/right) reveal trash/keep and commit the action. ⬛
- [ ] **Keyboard:** `J`/`K` move focus, `S` keep, `E` archive, `Y` done, `X` select. 🖥
- [x] **Pulse / progress strip** updates as you triage (done count, streak). ⬛
- [x] **Load more / batch** — "Show more" appends the next batch; no duplicates. ⬛
- [x] **Tag chips** render on rows; **category** (listenable/watch/wotagei) shows as a tag. ⬛
- [x] **Companion 💬 chip** on a consolidated/promoted **YouTube** row links out to the Reddit/HN
      discussion (new tab). ⬛
- [x] **NSFW blur** — over-18 media is blurred with a tap-to-reveal overlay; revealing then allows opening
      the lightbox. ⬛
- [x] **Tappable meta:** `r/<sub>` opens the subreddit, `by <author>` opens the user page, a **Hacker
      News** item opens the **HN thread** — without triggering row-open/select. ⬛
- [ ] **Dates** — rows show *posted* / *added in source* (when available) / *synced here*, with an
      absolute-date tooltip. ⬛
- [ ] **Firefox tabs filter** — the `is:firefox-tab` operator shows only `open_in_firefox` items
      (re-surfaced as a search operator; BACKLOG Epic 7). ⬛
- [x] **Empty states** — searching with no matches / an empty status show the right message. ⬛

## 5. Search & operators (`#q`)  ⬛

Test on **both** the browse bar and the Reddit view search. Operators should compose with each other and
with the sidebar/dropdown filters.

- [ ] `source:reddit` / `source:youtube` (also try mixed case e.g. `source:YouTube`). ⬛
- [ ] `kind:post` · `status:inbox` · `subreddit:hololive`. ⬛
- [ ] `tag:memes` (single) · `tag:memes,coding` (OR) · `tag:coding tag:japan` (AND). ⬛
- [ ] `is:saved` · `is:nsfw`. ⬛
- [ ] `before:2023-01-01` · `after:2022-12-31` (date range). ⬛
- [ ] `score:>100` · `score:<5` · `score:100`. ⬛
- [ ] `"exact phrase"` (quoted = exact) and `-removed` (negation). ⬛
- [ ] Combine: e.g. `source:youtube before:2023-01-01 -shorts`. ⬛
- [ ] **#fuzzy** toggle — typo-tolerant matching for bare free-text. ⬛
- [ ] A malformed operator (`before:notadate`) degrades to plain text and doesn't error. ⬛

## 6. Triage (`/triage`)

- [ ] **Swipe card** left/right shows the Tinder-style **stamp** and commits keep/archive/done. ⬛
- [ ] **Action bar** shows the **Keep / Archive / Done** SVG icons in their semantic colors, each with a
      `<kbd>` hint. ⬛
- [ ] **Keyboard:** `S` keep · `E`/`→` archive · `Y`/`←` done. 🖥
- [ ] **Undo toast** appears after an action and reverts it; it sits above the action bar (no overlap). ⬛
- [ ] **Inline Reddit embed** — click-to-load shows the thread on the card. ⬛
- [ ] **Category re-tag chips** (YouTube items) change the processing-area tag and persist. ⬛
- [ ] **"Ask AI"** (local-LLM) annotates a keep/skip suggestion without changing status. ⬛
- [ ] **Recover** button on `[removed]`/`[deleted]` Reddit cards patches the title/body in place. ⬛
- [ ] **Companion 💬 chips** + **NSFW blur** + **date labels** behave as in the list. ⬛
- [ ] **`?`** opens the keyboard **shortcut cheatsheet**; `Esc`/backdrop closes; ignored while typing. ⬛

## 7. Media / gallery lightbox

- [x] **Image** thumbnail opens the media modal (`openImage`/`openMedia`). ⬛
- [ ] **Gallery** (Reddit multi-image) opens the inline **stacked lightbox** (`openGallery`) with all
      images. ⬛
- [ ] **Reddit video** item keeps a navigable permalink. *(Known WIP — see §11.)* ⬛
- [ ] On mobile, tapping a thumbnail opens the modal. *(Known gap — see §11.)* 📱

## 8. Reddit view (`/reddit`)

- [ ] **Subreddit rail** lists subreddits with counts; selecting filters. ⬛
- [ ] **Table ↔ grid** view toggle switches layout. ⬛
- [ ] Filters: **tag**, **kind**, **saved**, **subreddit**, **fuzzy** + the search operators (§5). ⬛
- [ ] **Thread viewer** — opening an item loads its comments inline in the detail panel. ⬛
- [ ] **Unsave** flips `is_saved` optimistically; **Undo** cancels a still-pending unsave (no spurious
      re-save), and a real re-save failure surfaces. ⬛
- [ ] **Sync newest** pulls newly-saved items (high-water mark; O(new)). ⬛
- [ ] **Reddit-unsave drain** controls: save cookie (`reddit_session`), enable unsave-on-done, drain the
      queue — with a count + confirm before draining. ⬛
- [ ] **NSFW blur** in the Reddit view. ⬛
- [ ] Header doesn't crowd/clip at any width (theme toggle + Sync button wrap). ⬛
- [ ] Reddit permalinks render as absolute `https://www.reddit.com/…` (not `127.0.0.1/r/…`). ⬛

## 9. Modals

- [x] **Stats** modal — totals/counts render. ⬛
- [ ] **Import** modal — pick a file **or** paste a URL → **Prepare** shows a preview → **Commit**
      imports; **Cancel/Close** dismiss. ⬛
- [ ] **Shortcut cheatsheet** (`?`) — readable on browse + triage. ⬛
- [ ] **Media** + **Reddit thread** modals open/close cleanly (Esc + backdrop). ⬛

## 10. Backend / data features (verify the effect shows in the UI)

These are driven by CLI/data passes; confirm the UI reflects them.

- [ ] **Cross-source consolidation** — `consolidate` folded HN/Reddit links into canonical YouTube rows;
      the **128 promoted** videos appear as real YouTube items with real titles + 💬 discussion chips. ⬛
- [ ] **YouTube enrich** — enriched videos show exact duration/channel/views and thumbnails. ⬛
- [ ] **Title recovery** — `[Private/Deleted video]` items show Wayback-recovered titles where found. ⬛
- [ ] **Reddit archival** — `[removed]/[deleted]` recovered; scores/upvotes hydrated; media split into
      image/video/gallery with real thumbnails. ⬛
- [ ] **Reddit cookie sync** — "Sync newest" brings in items saved since the last sync. ⬛
- [ ] **Categorization / tagging** — Reddit multi-label tags + YouTube processing-area categories drive
      the tag filter. ⬛
- [ ] **Firefox tabs import** — imported tabs appear; YouTube tabs were promoted to `youtube:` items. ⬛
- [ ] CLI-only (no UI yet): **dedup**, **bankruptcy** (bulk-archive), **export-obsidian** — run and
      confirm the DB/UI reflects the result. 🖥

## 11. Known gaps / WIP (don't file these as new bugs)

- **Tag-chip overload** on enriched YouTube cards (a wall of raw keyword chips) — display fix pending.
- **Mobile:** tap-thumbnail-opens-modal **shipped on v3**; still open — long-press group-select, swipe
      physics/feel, and a swipe-only mode (Epic 16). Verify a row-swipe never side-scrolls the page (should not).
- *(Resolved on v3 — no longer gaps: Reddit v.redd.it video plays with audio (HLS) + galleries render inline;
  comfortable density is a fixed-height row.)*
- Some Epic 15 tappable-link and Epic 16 NSFW/scroll items may already be live from the design-v2 pass
  but aren't ticked in the backlog — confirm and report which are actually working.

---

> Tip: capture screenshots of anything off (especially on mobile) with the viewport width noted — the
> comfortable-density and Reddit-media items above are the most likely to surface issues.
