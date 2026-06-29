## Epic 15 — Reddit / HN as-app navigation  (`enhancement`, `area:reddit`)
*Make saved items behave like the native apps when tapped.*

- [x] ~~**P2 — Tap subreddit → open the subreddit; tap user → open the user page.**~~ Shipped (design-v2
  round 2; user-verified): meta-line `r/<sub>` / `by <author>` link to Reddit (new tab) without triggering
  row open/select.
- [x] ~~**P2 — Reddit image-link → open the comments thread, not the raw image URL.**~~ Shipped (PR #4):
  a reddit item whose media classifies as an image routes the tap to the in-app reader (image + thread).
- [x] ~~**P2 — Hacker News item → open the HN discussion thread, not the linked article.**~~ Shipped
  (user-verified).
- [x] ~~**P2 — Hacker News author → open the HN user profile** (`news.ycombinator.com/user?id=<author>`),
  mirroring the Reddit user link.~~ Shipped (PR #3).
- [x] ~~**P2 — HN: chip to open the linked article/story URL directly.**~~ Shipped: an "Article ↗" pill
  in the meta line links to `item.url` (omitted on Ask/Show-HN self-posts, where the title already opens
  the discussion).
- [x] ~~**P3 — (Optional) Fetch article thumbnails for HN items.**~~ Shipped: `HNConnector.enrich()` now
  fetches the linked article's og:image into `metadata.og_image` (best-effort, idempotent, gated like
  other enrich passes); `thumb()` renders it in the HN monitor slot.
- [x] ~~**P2 — Reddit video → open the in-app reader (video + comments), not the bare lightbox.**~~
  Shipped (2026-06-17): extends the image→reader routing to v.redd.it video; the reader's media tile
  plays the HLS stream (Epic 13 P2), with poster backfill (sync/lazy/offline `reddit-thumbnails`).
- [x] ~~**P2 — Markdown formatting in the reader's comment + post bodies.**~~ ✅ Done 2026-06-20 (commit 250e1d1): `core/markdown.js` `renderMarkdown()` — a safe subset (links, bold/italic, > quotes, ul/ol, inline + fenced code, bare URLs), XSS-safe by escaping first and gating every href through safeUrl; one renderer drives both the post self-text and comments. +11 node-backed tests. *(User-requested 2026-06-17.)*
  The inline reader currently renders comment/self-text as **plain escaped text** (`reader.js`
  `renderThread` → `helpers.esc(c.body)`; `paragraphs()` only splits on blank lines). Reddit bodies are
  **markdown** — links, **bold**/*italic*, `>` quotes, lists, code, and bare URLs (incl. **giphy** +
  external links). Render a safe subset to HTML (escape first, then linkify + apply markdown; no raw
  HTML injection — XSS-safe). Reuse one renderer for both the post self-text and comments. Keep it pure
  so it stays node-testable like the other reader helpers.
- [x] ~~**P2 — Comment-thread UX: tap-to-collapse, author links, auto-collapse dead threads.**~~ ✅ SHIPPED
  2026-06-22 (`browse/reader.js` + `browse.css`, sw.js v58→v59). *(User-requested 2026-06-22.)* (1) **Tap the
  comment byline** (`.rd-cby`) to collapse/expand the thread — a big tap target alongside the `−`/`+` button;
  ignores taps on the author link, and the body stays non-toggling (links/images/selection work). (2) **Author
  `u/name` → a link** to the Reddit profile (`noopener noreferrer nofollow`; `[deleted]` stays a plain span).
  (3) **Auto-collapse fully-dead threads** on load — pure `deadThreadCollapseSet()` collapses a deleted comment
  only when it HAS replies AND its whole subtree is deleted, so a live reply under a deleted parent stays
  visible. +5 node tests; verified live (author link, dead-subtree collapse, collapsed shows "N replies").
- [x] ~~**P3 — Inline media playback inside the reader's comment thread.**~~ *(User idea 2026-06-17.)*
  ✅ **IMAGES SHIPPED 2026-06-22:** `core/markdown.js` renders `![alt](url)`, bare image URLs, and Reddit's
  native `![img](media-id)` (resolved server-side from `media_metadata` — `reddit_thread._resolve_media`,
  passed through on each comment + the post selftext) as inline `<img>`, tap → lightbox. Host-allowlisted
  (Reddit + imgur + giphy; others → safe link) with `referrerpolicy=no-referrer` + lazy-load; XSS-safe.
  sw.js→v58.
  ✅ **VIDEO SHIPPED 2026-06-26:** `<video>` player in the reader media tile (`.rd-body video`) plays
  `v.redd.it`/gfycat/streamable URLs embedded in comment bodies, with native controls, autoplay-on-attach,
  and stop-on-close. Closes the previously-open (a) video-in-comments subtask.
  ⏳ **STILL OPEN:** the RES-informed refinements — a tap/expander gate so a comment with many images doesn't
  auto-load a wall, and NSFW reveal on inline comment media. Don't start until RES screenshots are in hand.
- [x] ~~**P2 — Thumbnail tap = quick media peek (lightbox); title/body opens the thread.**~~ ✅ SHIPPED
  2026-06-22 (browser-verified): in `browse/main.js` the `[data-media]` tap now always calls `openMediaFor`
  (plain media — image lightbox / video player / gallery viewer); the reddit-image/video → reader
  interception (added 2026-06-17, `107665b`) was reverted. Title/body tap still opens the reader. The
  lightbox already registers with the overlay coordinator (`core/media.js` `pushOverlay`), so OS/back closes
  it and returns to the feed (verified). SW v66. *(User-requested 2026-06-17.)* (HN article thumbnails: they
  use the title-`<a>` route, not `[data-media]`, so they're unaffected.)
- [x] ~~**P2 — Broad reader source coverage + local-rich renderers.**~~ ✅ SHIPPED 2026-06-26
  (`feat/reader-source-coverage`): title/body taps now open the in-app reader for Reddit, HN, Keep,
  Obsidian, **YouTube**, and **Twitter/X** while media/thumb taps stay media-first. YouTube rows render a
  lazy `youtube-nocookie.com` iframe from `source_id`/URL plus local metadata (`channel`, duration, playlist,
  availability, views, categories, description, `metadata.companions`). Twitter/X rows render stored tweet
  text, author/reply context, quote-tweet block, outlinks, and stored media from `metadata.media_urls` /
  `thumbnail` with no X network calls. Added node-backed helper tests and Playwright regressions against
  synthetic UI DB rows; UI tests no longer require a private `data/app.db`.
- [x] ~~**P2 — Video plays inline in the reader (no lightbox).**~~ ✅ VERIFIED SHIPPED:
  the reader now mounts playable video inline in the media tile using the shared HLS/`<video>` path; the
  lightbox remains the browse-list quick peek. *(User-requested 2026-06-17.)*
- [x] ~~**P3 — Reposition the reader's media preview (takes too much vertical space at top).**~~ ✅ Done 2026-06-20 (Task B): capped `.rd-media img` to 42vh and inline video to 52vh (was 58/70vh; kept `contain`, tap still opens the full lightbox). *(User-requested
  2026-06-17.)* In `section#reader` the post-media tile dominates the top of the view; shrink/reposition it so
  the post + thread are reachable with less scrolling (cap its height, or make it a collapsible/cover-fit
  tile). Reader layout only.
- [x] ~~**P3 — Reader triage buttons show their hotkey shortcuts.**~~ ✅ Shipped (`4ff7126`): Keep/Archive/Done
  buttons display their keys and the reader-scoped F/A/D keys are wired (capture-phase, triages the reader's own
  item). *(User-requested 2026-06-17.)* Relates to the Epic 5 keyboard rework.
- [x] ~~**P2 — Note-with-video reader (Keep/Obsidian): play the video where the comments go.**~~ ✅ SHIPPED
  2026-06-26: single-video notes render a YouTube iframe (`youtube-nocookie.com/embed/<id>`) in the reader's
  media tile with the note body below (**Obsidian** = markdown via `core/markdown.js`; **Keep** = plain text +
  checklist with line-through). **Checklist view-mode toggles shipped 2026-06-26:** Keep-style `[ ]` / `[x]`
  and Markdown task-list `- [ ]` / `- [x]` lines are clickable in the reader, preserve line shape, and save
  through the existing `/items/<fn>/body` route with optimistic UI + revert on failure. Keep invocation of the
  Epic 11 standalone heuristic — notes with real content
  stay as `keep:`/`obsidian:` items, NOT promoted. Iframe tears down on every close path (button/Esc/popstate/
  swipe/F-A-D). Multi-video notes fall back gracefully (the multi-video reader handles them). Node-tested
  `extractYoutubeIds()` + Playwright UI test. *(User-requested 2026-06-19.)*
- [x] ~~**P3 — Multi-video note reader: embed several YouTube videos from one note.**~~ ✅ SHIPPED 2026-06-26:
  tabbed video switcher — one active iframe at a time with "Video 1" / "Video 2" / … tab bar below.
  `note_youtube.py` now skips multi-video notes in the promote pass (`len(vids) != 1`) — they're exclusively
  this reader's domain. Note body renders below the video tab bar. Playwright UI test covers tab switching +
  body rendering. *(User idea 2026-06-19.)*
- [x] ~~**P2 — Edit note bodies as raw markdown, in the reader.**~~ *(User-requested 2026-06-19.)* Let the reader
  edit a note's body as **raw markdown** (a textarea + rendered live preview reusing the reader's markdown
  renderer above) — **reuse the reader view**, not a separate editor surface. ✅ **Reader editor shipped
  2026-06-25:** Keep/Obsidian items now open in the existing reader with an edit-body toggle, textarea, live
  markdown preview, save/cancel controls, and an in-memory feed refresh after save. Backend: a `POST /items/<fn>/body`
  endpoint updating `body` + rebuilding `search_text`/FTS (precedented by `/recover` + `/category`), re-deriving
  Obsidian inline `#tags` + `[[wikilinks]]`. **Re-import durability (the crux — `merge_upsert` overlays the
  incoming body, db.py:417):** stamp `metadata.body_edited_at` and skip the body overlay for dirty rows so a
  later vault/Takeout re-import can't clobber the edit; for **Obsidian** optionally also write the edit back to
  the `.md` on disk (needs the absolute vault root persisted — today only the vault *name* + a relative
  `source_id` are stored, obsidian.py:118/131). **Keep** edits are DB-only (Takeout is a dead export, no live
  target) and its body is plain text + a structured `listContent` checklist, so Keep editing is
  plain-text/checklist, not markdown. Scope note: this nudges content-hoarder from triage/consumption toward
  authoring — the alternative for rich editing is deep-linking out to Obsidian (`obsidian://`). Relates to
  Epic 11 (note items) + the reader-markdown renderer.

- [x] ~~**P2 — Highlight the OP's comments in the reader thread.**~~ ✅ Shipped (`a91b20e`): OP comments now
  carry an accent left-border / tinted background, not just the inline badge. *(User-requested 2026-06-19.)* On a Reddit
  thread the comments written by the **original poster** should stand out visually. A bare **"OP" badge already
  renders** (`browse/reader.js:50`, guarded by `helpers.opAuthor` derived at reader.js:156) — this asks for
  actual **highlighting** of those comments (e.g. an accent left-border / tinted background on the OP comment
  block, mirroring the `r/<sub>`-app convention), not just the inline tag. Styling on the `.rd-op` comment
  (`.rd-c` carrying the OP author) in `reddit.css`; the `opAuthor` plumbing is already in place so no new data
  is needed.

- [x] ~~**P2 — Reddit thread thumbnail → reader (not the reddit iframe).**~~ ✅ Shipped 2026-06-27
  (`browse/main.js openMediaFor`): when the item has no lightboxable media (`!imageUrl(item)` and `media_type`
  not in `{image,gallery,reddit_video}`), the thumbnail tap routes to `readerUI.open()` instead of the lightbox.
  Mirror of the empty-gallery gate at `main.js:549`.
- [x] ~~**P2 — Reader triage dock rework (design bakeoff — GLM-5.2).**~~ ✅ Shipped then **removed** 2026-06-27.
  The first implementation (`.rd-foot` + semi-circle dock) landed during the T2 mobile-polish sprint, but the
  real-device follow-up showed it felt wrong on mobile. The T3 regression batch deliberately deleted the dock
  (`t3-drop-reader-dock`): reader actions now stay available through keyboard shortcuts (`F`/`A`/`D`/`T`/`S`),
  row/list gestures after returning to the feed, and normal reader header affordances. Treat the dock design as
  superseded, not as current UI.
- [x] ~~**P2 — Don't refresh the feed on reader Done/Archive/Keep.**~~ ✅ SHIPPED 2026-06-27
  (`delegate/a2-no-feed-refresh-on-triage`, SW v84 → v86 merged). `act()` and `snooze()` gained an
  `{fromReader:true}` option: reader triage (F/A/D keys, dock buttons, S key) skips the leave-animation,
  `clearItemFirstPageCache`, item removal, and `render()`. The triaged item stays in `state.items` with its
  status updated in-memory; removed lazily on the next `loadMore`/refresh. Undo reverts the in-memory status
  without reflow. Inline row path unchanged. `snooze()` got the same `{fromReader:true}` treatment via the
  dock's Snooze button and `S` keyboard shortcut. Verified: same 5 known env failures, no new.
- [ ] **P2 — Reader/text-post preview blurbs.** *(Mobile test 2026-06-29.)* For text-heavy Reddit posts,
  generate a compact preview before opening the full thread. Start with a non-AI version first if possible
  (first meaningful selftext paragraph, top N comments once cached, title+subreddit context, link/domain
  summary); then optionally add local-LLM summaries when `assist/llm.py` is configured. Keep it cached in
  metadata or `reddit_threads`-derived side data, never block opening the reader, and label AI output clearly.
- [ ] **P2 — Show post text under image lightbox when a Reddit post has media + selftext.** *(Mobile test
  2026-06-29; Relay reference: “Halloween couple costume idea”.)* Some posts have both an image and
  accompanying text. The media lightbox should render the post text/caption below the image, similar to
  Relay for Reddit, without turning the image preview into the full reader. Keep links markdown-safe and
  make the text collapsible for long posts.
- [ ] **P3 — Video lightbox swipe gestures parity with images.** *(Mobile test 2026-06-29.)* Nice-to-have:
  vertical swipe-to-close / pan-like gestures for videos mirroring image lightbox behavior. Risk: video
  controls, HLS/hls.js, browser fullscreen, and pointer capture can conflict, so design/test carefully and
  keep normal video controls reliable.

### Icebox — true WYSIWYG markdown editing *(Epic 15)*
- [ ] **Icebox — Obsidian-grade WYSIWYG (type-and-see-formatting) note editing.** *(Deferred 2026-06-19.)*
  Live-preview rich editing rather than the raw-markdown textarea above. **High effort + fidelity risk:** the
  no-build-step constraint means vendoring a CodeMirror/ProseMirror-class editor; markdown↔rich-text
  round-tripping loses fidelity; and Obsidian's superset (`[[wikilinks]]`, `![[embeds]]`, callouts,
  frontmatter, Dataview) gets corrupted by a generic WYSIWYG. Reactivate only if raw-markdown editing proves
  insufficient — otherwise prefer deep-linking out to Obsidian for rich editing.
