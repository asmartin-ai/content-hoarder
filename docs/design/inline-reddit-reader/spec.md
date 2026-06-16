# Inline Reddit reader — spec (v1)

> Status: **design / brainstorm** (2026-06-15, branch `feat/frontend-v3`). Mockup built in
> Fable v3 tokens via `show_widget` (loaded state). This doc covers what the static frame
> can't: the state machine, the content-type matrix, the reuse map, and the build plan.

## Context — why

The mobile self-study video (2026-06-15) showed the worst UX moments were **external-app
handoffs**: tapping a saved item bounced out to a Firefox custom tab (blank on `reddit.com`
for ~15–20s) or threw an "Open in Relay — leave Firefox?" prompt every time. The app should
let you **read and triage a saved Reddit item in-app**, only handing off when you choose to.

This also attacks the *perceived* slowness: every item read in-app is one you don't pay a
browser-handoff round-trip for. (See the PWA→native research: the bigger smoothness win is
installing as a real PWA in Chrome, but inline viewing removes the handoffs regardless.)

## Decisions locked (user, 2026-06-15)

1. **v1 renders post + comments together** — the full thread, not post-only.
2. **Surface = full-screen reader sheet** — reuse the Fable `.sheetpanel` + `#scrim`
   slide mechanism (per [[preserve-fable-design]] — no new paradigms), full-height.
3. **Trigger = replace the tap** — tapping an item opens the in-app reader by default;
   **"Open original ↗"** is the secondary escape hatch (header).
4. (this session) **In-reader triage row** at the foot — Keep / Archive / Done dispatch
   the item without leaving. Friction asymmetry: Archive/Done cheap+filled, Keep deliberate.

## The good news — plumbing already exists (verified 2026-06-15)

| Capability | Already there | Location |
|---|---|---|
| Parsed post + comments endpoint | `GET /reddit/items/<fullname>/thread?sort=` → `{post, comments, cached, archived, ...}` | `web.py:484` |
| Thread cache table (gzip JSON) | `reddit_threads(fullname, thread_json, hydrated_at)` | `db.py:92` |
| On-demand hydrate (fetch+cache) | `reddit_hydrate.hydrate_one()` | `reddit_hydrate.py:29` |
| Thread parse (flatten, depth) | `reddit_thread.get_thread()` | `reddit_thread.py:44` |
| Media lightbox (image/gallery/video) | `createLightbox()` / `openMedia()` | `core/media.js:74` |
| Selftext + image URLs stored at import | `item.body`, `metadata.media_url/gallery/thumbnail` | `connectors/reddit.py:120` |
| Status dispatch (keep/archive/done/undo) | `POST /items/<fullname>` | `web.py` |

Live probe confirmed: `/thread` returned `cached:true`, a post with
`title/selftext/score/permalink/subreddit/author/created_utc`, and a comment list.
**No schema changes needed.** v1 is a render/UX layer over existing endpoints.

## Reader state machine

Open reader → call `/thread`:

- **`cached:true`** → render post + comments immediately. Chip: "loaded instantly · cached".
- **`cached:false`** → render the post (from the already-loaded list item: title/body/media),
  show a comments placeholder + auto-fire `hydrate_one()`; chip: "fetching thread…" → on
  success swap in comments. (Decision: **auto-hydrate on open** for comments, since the post
  itself always renders instantly from stored fields — so there's no blank screen ever.)
- **`archived:true`** (PullPush/Arctic fallback) → render, badge it "archived copy" so stale
  scores/missing media are explained.
- **hydrate error / deleted / private** → keep the post, replace comments with a one-line
  "couldn't load the live thread" + the **Open original ↗** affordance. Never a blank state.

## Content-type matrix (what renders inline)

| Post type | Inline? | Source |
|---|---|---|
| Text / self | 🟢 instant | `item.body` (stored) |
| Direct image (i.redd.it/imgur) | 🟢 instant | `imageUrl()` in `core/media.js` |
| Gallery (archived) | 🟢 instant | `metadata.gallery[]` |
| Gallery (not archived) | 🟡 hydrate | `/thread` → media_metadata |
| Reddit video (v.redd.it) | 🟡 hydrate | `metadata.media_url` or `/thread` manifest |
| External link | 🟢 title + link card | `item.url` (+ Open original) |
| Comments (any) | 🟡 auto-hydrate | `/thread` comments |
| Poll / crosspost / exotic | 🔴 escape | **Open original ↗** only |

Rule: **the post always renders from stored fields with zero network**; only comments and
non-stored media trigger a fetch. So the sheet is never blank, even offline.

## NSFW

Respect the existing gate: `metadata.over_18` → blur media behind the "NSFW" veil inside the
reader exactly as the list does (`render.js` isNsfw + two-tap reveal). Text/comments render;
media stays veiled until tapped. No new policy.

## Build plan (files)

- **New**: a `reader` module — `static/browse/reader.js` (open/close, fetch `/thread`,
  render post + threaded comments, hydrate states) + `.reader` styles in `browse.css`
  (full-height sheet reusing `#scrim`; depth-rail comment indentation; foot triage row).
- **Markup**: an `<aside class="reader" id="reader">` in `index.html` alongside the existing
  sheets (same `#scrim` overlay).
- **Wire the tap**: in `browse/main.js` the item-row tap → `openReader(fullname)` instead of
  following the `<a target="_blank">`; keep the `<a>` href as the "Open original" target.
  (Reddit items only in v1; other sources keep current behaviour — `source==='reddit'` guard.)
- **Reuse, don't rebuild**: `core/media.js` lightbox for media tiles; `POST /items/<fn>` for
  the foot triage actions (same calls the list/swipe already make) + existing undo/toast.
- **SW**: bump `CACHE` (cache-first on `/static/`) when these ship.

## Deferred / open

- **Other sources inline** (YouTube embed, HN thread): design the reader source-agnostic but
  ship reddit first. YouTube already has an embed path in `core/media.js`.
- **Comment sort control** (best/top/new) — the endpoint takes `sort=`; wire the header pill
  in a later pass.
- **Vote/reply** from the reader — out of scope (read-only; we don't write to Reddit here).
- **Pre-hydrate inbox threads in background** so cached:true is the common case — perf nicety,
  later.

## Verification (when built)

- `/thread` for a cached item renders post+comments with no network in DevTools.
- `cached:false` item: post paints instantly, comments hydrate without a blank frame.
- Deleted/private thread: post + "couldn't load" + Open original, never blank.
- Foot Keep/Archive/Done dispatches via `POST /items/<fn>` and toasts/undo like the list.
- NSFW item: media veiled, two-tap reveal; text/comments visible.
- Light + dark tokens resolve; `:focus-visible` on every control; reduced-motion fallback.
- Measure (per frontend-design skill): sheet `scrollWidth - clientWidth === 0`, overlay
  rects within frame, off-canvas `visibility:hidden` when closed.
