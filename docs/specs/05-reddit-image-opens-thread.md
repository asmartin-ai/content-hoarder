# Spec 05 — Reddit image-link opens the comments thread

BACKLOG: Epic 15 #468. Branch: `feat/reddit-image-thread`. Touches: `static/browse/main.js`
(`openMediaFor`); optionally `static/browse/render.js` (a "view image" escape-hatch chip).

## Goal

Clicking a Reddit **image** item should open its **comments thread**, not the bare image URL — while
keeping the raw image reachable.

## Root cause (confirmed)
`openMediaFor()` (`browse/main.js:184-193`) dispatch order is gallery → video → **image** → permalink → url.
Because `imageUrl(item)` is checked (`:189-190`) before `m.permalink` (`:191`), a reddit image post
(where `item.url` is an `i.redd.it` URL and `metadata.permalink` exists) opens the bare image and never
reaches the permalink branch.

## Acceptance criteria
- A reddit image item (`item.url` = image, `metadata.permalink` set) opens the **thread** via
  `lightbox.openMedia(permalink)` (redditmedia embed + "Open on Reddit ↗" fallback).
- The raw image stays reachable (via `openMedia`'s embed and/or an explicit "view image" chip — see below).
- Galleries (`metadata.gallery`) and reddit videos still behave as before (their branches run first).
- Non-reddit image items (rare) are unaffected — still open the image directly.
- No console errors; preview-verified.

## Implementation (`browse/main.js:184-193`)
**Decision: Option 2 (gentler) — gate the image branch, don't blanket-reorder.**
Change the image check (`:189-190`) to:
`if (img && !(item.source === "reddit" && m.permalink)) return lightbox.openImage(img);`
so a reddit item with a permalink falls through to `if (m.permalink) return lightbox.openMedia(m.permalink);`
(`:191`). This avoids changing behavior for non-reddit images and for reddit images that somehow lack a permalink.

**Optional escape hatch (recommended, small):** in `browse/render.js`, for reddit image items add a
small "view image" chip (mirror `playpill`, anchor or a `data-img` button) that calls
`lightbox.openImage(imageUrl(item))`, so the user can still get the full-res image directly. If added,
wire a `[data-img]` handler in `main.js` near the `[data-media]` delegated handler (`:161-180`).

## Tests / verification
- Run `tests/test_static_core.py` + `tests/test_browse_view.py` after edits.
- Preview-verify (seed `models.new_item(source="reddit", url="https://i.redd.it/abc.jpg",
  metadata={"permalink":"/r/pics/comments/xxx/title/","media_type":"image"}, ...)`):
  click the thumbnail/playpill → lightbox shows the **thread** (redditmedia iframe + "Open on Reddit ↗");
  confirm the image is still reachable; confirm a gallery item and a reddit-video item are unchanged.

## Note (parity)
This and the HN article chip (spec 04B) are the SAME underlying pattern — separating "the content" from
"the discussion." See parity-ideas.md → "Discussion vs. content affordance" for generalizing it.
