# Agent A — Note-with-video reader (Keep / Obsidian)

> **Sandbox-safe.** Frontend + small extraction reuse. No live DB, no network, no external
> APIs. Playwright UI tests are the oracle.

## Context (from BACKLOG.md Epic 15 #931)

A note (Keep or Obsidian) that has **real content AND a single YouTube link** must NOT be
promoted/converted to a `youtube:<id>` item — the note text is the irreplaceable thing
(Epic 11's promotion deliberately leaves these alone; the standalone-only heuristic skips
notes with meaningful surrounding prose). Instead, keep it as a `keep:` / `obsidian:` item and
open it in the **inline reader exactly like the Reddit comment reader**: the **YouTube video
plays at the top** (where the post media sits) and **the note's own content renders below,
where the comment thread would be**.

The link→video *promotion* for notes already shipped (`note_youtube.py`, commit `49e9fc9`) —
reuse its extraction. This is the **reader** half: the user opens a note-with-video and sees
the video + their note together, in-app.

## Write scope (only these)

- `src/content_hoarder/static/browse/reader.js` — add a "note mode" to `initReader().open()`
- `src/content_hoarder/static/browse/browse.css` — styles for the note-mode layout (reuse tokens)
- `src/content_hoarder/static/browse/main.js` — routing only (the existing `keep`/`obsidian`
  tap→reader branch at ~line 289 already opens the reader; you're extending what the reader
  renders, not the routing rule)

**Do not touch** `note_youtube.py` (Python), `db.py`, connectors, or any backend file. The
extraction you need already exists in `note_youtube.py` — mirror its logic in JS (see below).

## What exists (verified anchors — read these first)

- `static/browse/reader.js` `initReader({ onTriage, onMedia, onImage, closeSheets, onClose,
  onBodySaved })` (~line 239) is the reader factory; `.open(item)` shows `section#reader`.
- `mediaTileHtml()` (~line 412) renders the post-media slot at the top — this is where the
  YouTube iframe goes.
- The post body / comment-thread region renders below it (`renderThread` etc.).
- `core/markdown.js` `renderMarkdown()` already renders Obsidian markdown (links, lists, code,
  images) — reuse it for the note body. Keep notes are plain text + checklist (`listContent`);
  render checklists too.
- `main.js` line 289-298: `keep` and `obsidian` sources already route a title/body tap into
  `readerUI.open(rItem)` — so the routing is done; you only change what the reader shows.
- The shipped note-editor (`onBodySaved`, `bodyHtml`, `bodyControlsHtml`, `openBodyEditor`)
  already lets users edit note bodies in the reader — your note-mode must coexist with it.

## The extraction to mirror (from `note_youtube.py`, do NOT import it — it's backend Python)

`note_youtube._candidate_urls(text)` + `_note_yt_ids(item)` extract YouTube ids from a note's
body, handling: bare URLs, `[text](url)` markdown links, `![](url)` embeds, and the host forms
`youtu.be/<id>`, `youtube.com/watch?v=<id>`, `youtube.com/shorts/<id>`, `youtube.com/embed/<id>`.
Mirror this in a small JS helper (e.g. `extractYoutubeIds(text) -> string[]`) inside
`reader.js` or a tiny new `core/youtube.js` (your call — keep it pure so it's node-testable).
There is likely already an id-extraction helper in `connectors/firefox.py` / the firefox
YouTube promotion path — grep `youtube_id` / `youtu.be` in `static/` first to reuse, not dup.

## Build

1. **JS extraction helper** — `extractYoutubeIds(text)`. Pure, node-testable. Cover the host
   forms above. De-dup, preserve first-seen order.
2. **Reader note-mode** — when `initReader().open(item)` is called for a `keep`/`obsidian` item:
   - if `extractYoutubeIds(item.body)` returns **exactly one** id → render note-mode:
     - top: a responsive YouTube `<iframe>` (`https://www.youtube-nocookie.com/embed/<id>`,
       `loading="lazy"`, `allow="autoplay; encrypted-media"`, `allowfullscreen`) in the
       `mediaTileHtml` slot.
     - below: the note body — Obsidian via `core/markdown.js renderMarkdown()`, Keep as
       rendered text + checklist. Reuse the existing note-body rendering the editor uses.
   - **zero ids** → existing behavior (note-only reader, no video slot).
   - **two or more ids** → do NOT render note-mode (a multi-video note is Epic 15 #941, a
     separate unbuilt item); fall back to existing behavior. Leave a clear code comment.
3. **Lifecycle** — when the reader closes, the iframe must be torn down (stop playback), same
   as the existing inline-video teardown (`stopInlineVideo`, ~line 399). Add an equivalent
   iframe removal on every close path (button/Esc/popstate/swipe/F-A-D) — funnel through the
   existing close path, don't add a new one.
4. **CSS** — reuse `browse.css` tokens; the video tile should respect the same max-height cap
   the post-media tile already uses (the Epic 15 #924 rework capped `.rd-media img` to 42vh /
   inline video 52vh — match that family). No new design language.

## Guardrails (AGENTS.md)

- **Source-badge / glyph contract:** don't `esc()` the `glyph()` output. Not relevant here
  (you're not rendering source badges), but don't break it either.
- **Gallery lightbox = stacked images, never a reddit iframe** — irrelevant here; the YouTube
  iframe is for the note's video slot, not a gallery.
- Vanilla JS, ES modules, **no build step**, no new npm dependency. Reuse `core/util.js`
  (`esc`, `safeUrl`) — sanitize anything user-controlled (note bodies are already escaped by
  the markdown renderer; don't double-escape).

## Tests (the oracle)

1. **Node unit tests** for `extractYoutubeIds` — mirror the backend `_note_yt_ids` test cases
   if they exist (grep `tests/test_note_youtube`). Cover: bare URL, markdown link, embed
   form, `youtu.be`/`watch`/`shorts`/`embed`, multiple ids (returns all), zero ids, dup id
   (de-duped). Add under the existing node-test convention (grep how `core/markdown.js` is
   node-tested).
2. **Playwright UI test** under `tests/ui/` (per AGENTS.md, `pytest -m ui`): seed a synthetic
   `keep:` item with a body containing one YouTube link + real prose; open the reader; assert
   the iframe `src` is `youtube-nocookie.com/embed/<id>` AND the note body text renders below;
   close the reader (back button) and assert the iframe is gone from the DOM. Add a second
   case: a note with **no** YouTube link renders no iframe (existing behavior preserved).
3. `python -m pytest` (default run, no network) stays green vs baseline.

## Out of scope (do not build)

- Multi-video note reader (Epic 15 #941) — separate item.
- Backend changes to store `metadata.youtube_ids` — extraction is client-side here (the body
  is already in the item). If a later backend pass stamps `metadata.youtube_ids`, prefer it,
  but don't block on it.
- Promoting/converting notes — that's Epic 11 (already shipped) and explicitly does NOT fire
  for notes-with-prose.

## Done when

- Reader opens a one-video note showing the embedded video + note body.
- Zero-video notes behave exactly as before.
- Multi-video notes fall back gracefully (no broken half-render).
- Iframe tears down on every close path.
- Node tests + Playwright test green; full suite green vs baseline.
- Committed on a branch named `feat/note-with-video-reader`; not pushed/merged.
