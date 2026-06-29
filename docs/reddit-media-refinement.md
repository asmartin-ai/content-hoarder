# Spec — Refine Reddit media metadata from the archive fetch

Status: **implemented 2026-06-03** · Epic 4 (P3) · drafted 2026-06-03

> **As built** — see the "As built" section directly below for the final decisions.
> Sections 1–8 are the original design record; where they differ from "As built",
> the code is authoritative.

Backlog item this addresses:

> **Refine media metadata from the same fetch.** The local data has no
> `reddit_video`/`preview`, so media is currently inferred by URL heuristics
> (`media_type = reddit_video` for `v.redd.it`, else `reddit_media` for media posts
> with no captured URL). When the archival fetch runs, populate real
> `thumbnail`/`reddit_video` URLs and split `reddit_media` into precise image/video.

---

## As built (2026-06-03)

Shipped on the existing `enrich --source reddit --scores` path; no new command.

- **`archival/providers.py`** — `_media_url` / `_thumb` / `_media_type` helpers feed
  `_norm_post`, which now emits `media_type` / `media_url` / `thumbnail`. Helpers are
  fully defensive (never raise on missing / None / malformed records).
- **`archival/service.py`** — `_overlay_fields` maps those into `metadata`
  (`media_type` overrides the connector's URL-heuristic value via merge_upsert's
  incoming-non-empty-wins). The url-overwrite is **guarded for videos**
  (`media_type != "reddit_video"`) so a `reddit_video` keeps its navigable permalink
  click-URL while the raw stream lives in `media_url`.
- **`media_type` values produced:** `image`, `reddit_video`, `gallery`, `link`, or
  `""` (unknown → keep the heuristic). **Galleries use a real `gallery` type** (not
  `reddit_media` as sections 3/8 proposed) — the frontend gained a one-line
  `PREVIEW_TYPES` entry, cleaner than the URL-regex label.
- **Correction to sections 3/4:** `post_hint == "rich:video"` is an **external**
  embed (YouTube, Streamable, …) with `is_video == False` — it must **not** map to
  `reddit_video` (that would clobber the connector's accurate `youtube`). Only
  `post_hint == "hosted:video"` (reddit-hosted) maps to `reddit_video`; `rich:video`
  falls through to `""`. (Caught in code-review.)
- **Frontend** (now `static/core/media.js` + `static/browse/main.js`; orig `static/app.js`/`triage.js`, app.js since deleted): `imageUrl` reads `media_url`
  for images (returns `""`, never a permalink, when absent); list + triage make
  video/gallery thumbnails click-to-embed; `sw.js` cache bumped to `v7`.
- **Tests:** `tests/test_archival.py` — provider extraction (image/video/gallery/
  sentinel/`rich:video`/`&amp;`-unescape) + a service overlay test (override +
  video-url guard + non-destructive). Full suite green (95).
- Deferred to Epic 7 (unchanged): inline gallery image arrays from `media_metadata`.

---

## 1. Why — the gap

`media_type` is currently inferred purely from the URL by
`connectors/reddit.py::_classify_media` / `_media_type_from_url`. The RSM source DB
stores only `url`/`permalink` (no `is_video`, `media`, `preview`, `thumbnail`), so
any post whose media URL wasn't captured collapses into the catch-all
`reddit_media` bucket.

Real distribution in `data/app.db` (2026-06-03):

| media_type     | count  |
|----------------|--------|
| **reddit_media** | **54,457** |
| link           | 9,642  |
| image          | 345    |
| reddit_video   | 165    |
| youtube        | 6      |

So **~85% of reddit items** render as a generic "▶ Preview" button with no image
and no idea whether they're an image, a video, or a gallery. The frontend already
supports rich rendering (`thumbnail` image slot, `image` lightbox, `reddit_video`
play button) — it's starved of data, not capability.

## 2. Feasibility — VERIFIED against the live APIs

The archive normalizers (`archival/providers.py::_norm_post`) keep only
`title/selftext/author/subreddit/permalink/url/created_utc/score/over_18` and
**discard the media fields**. But the raw API responses contain the full Reddit
submission object. Probed 2026-06-03 with three real saved posts
(`145oo7e` image, `144dcrq` hosted:video, `100c6ir` gallery) against **both**
providers — every field is present in both PullPush and Arctic-Shift:

```
image  (145oo7e): post_hint=image        is_video=false is_gallery=absent
                  thumbnail=https://b.thumbs.redditmedia.com/…jpg
                  preview.images[0].source.url=https://preview.redd.it/q88e38scv35b1.png?…&s=…
                  url_overridden_by_dest=https://i.redd.it/q88e38scv35b1.png   domain=i.redd.it

video  (144dcrq): post_hint=hosted:video is_video=true
                  media.reddit_video.fallback_url=https://v.redd.it/2r38ztbd6t4b1/DASH_…mp4
                  media.reddit_video.dash_url / hls_url also present
                  thumbnail=https://b.thumbs.redditmedia.com/…jpg
                  preview.images[0].source.url=https://external-preview.redd.it/…
                  url_overridden_by_dest=https://v.redd.it/2r38ztbd6t4b1   domain=v.redd.it

gallery(100c6ir): is_gallery=true         post_hint=absent
                  thumbnail=https://b.thumbs.redditmedia.com/…jpg
                  gallery_data.items=[{media_id: hqns4ryi4d9a1}, …]
                  media_metadata={"<id>": {"e":"Image","m":"image/jpg",
                                            "s":{"u":"<full url>"},"p":[{…resolutions}]}}
                  url_overridden_by_dest=https://www.reddit.com/gallery/100c6ir  domain=reddit.com
```

Notes that matter for implementation:
- Preview/thumbnail URLs are **HTML-escaped** in the JSON (`&amp;`) → must
  `html.unescape()`. The signed `?…&s=…` query is part of the URL; keep it intact.
- `thumbnail` can be a non-URL sentinel: `self`, `default`, `nsfw`, `spoiler`,
  `image`, or `""` → only use it if it `startswith("http")`.
- `media` / `secure_media` is `null` for non-video posts; for videos either may
  carry `reddit_video`. Prefer `media`, fall back to `secure_media`.
- **`media_metadata` IS returned by the archives.** This contradicts the premise of
  the Epic 7 P3 item ("the archives keep `is_gallery` but drop `media_metadata`…
  reddit `.json` is 403 without OAuth"). This fetch can also unlock inline gallery
  rendering — update that backlog item.

## 3. Design — three layers, riding the existing `--scores` run

The archive fetch already runs over **all** reddit items via
`enrich --source reddit --scores` (`scope="all"` →
`archival/service.py::recover`). Media refinement rides that exact path — no new
command, no new selection. Resumable via `--limit`, same as score hydration.

### Layer 1 — extract media in `archival/providers.py`

Add a media extractor and call it from `_norm_post` (comments have no media, so
`_norm_comment` is unchanged). Sketch:

```python
from html import unescape

_THUMB_SENTINELS = {"self", "default", "nsfw", "spoiler", "image", ""}

def _media_url(rec: dict) -> str:
    media = rec.get("media") or rec.get("secure_media") or {}
    rv = (media or {}).get("reddit_video") or {}
    return rv.get("fallback_url") or rec.get("url_overridden_by_dest") or rec.get("url") or ""

def _thumb(rec: dict) -> str:
    imgs = (rec.get("preview") or {}).get("images") or []
    if imgs:
        src = (imgs[0] or {}).get("source") or {}
        if src.get("url"):
            return unescape(src["url"])           # hi-res preview, unescaped
    t = rec.get("thumbnail") or ""
    return t if t.startswith("http") else ""      # skip self/default/nsfw sentinels

def _media_type(rec: dict) -> str:
    if rec.get("is_video") or ((rec.get("media") or {}).get("reddit_video")):
        return "reddit_video"
    if rec.get("is_gallery"):
        return "gallery"
    hint = rec.get("post_hint") or ""
    if hint == "image":
        return "image"
    if hint in ("hosted:video", "rich:video"):
        return "reddit_video"
    if hint == "link":
        return "link"
    return ""                                     # unknown → don't override heuristic
```

`_norm_post` gains: `media_type`, `media_url`, `thumbnail`, `is_gallery`
(+ optionally `domain`). Empty/`""` values are dropped downstream, so a post with
no media simply contributes nothing.

### Layer 2 — overlay in `archival/service.py::_overlay_fields`

Map the new fields into `md` (the metadata overlay). `merge_upsert` is
incoming-non-empty-wins, so a recovered `media_type` overrides the heuristic one:

```python
mt = fields.get("media_type")
if mt:
    md["media_type"] = mt
if fields.get("media_url"):
    md["media_url"] = fields["media_url"]
if fields.get("thumbnail"):
    md["thumbnail"] = fields["thumbnail"]
```

**`meaningful` flag:** today `_collect` skips a record unless `meaningful` (a real
title/body recovered). For the `--scores` (`scope="all"`) path, non-removed posts
already have a real title so `meaningful=True` and the overlay persists — media
rides along fine. Decide whether recovering media alone should also flip
`meaningful=True` (relevant only to `scope="removed"`, where a `[removed]` post
might still have surviving media). Low value; recommend leaving as-is for v1.

### Layer 3 — frontend (`static/app.js`, `static/triage.js`)

Populating `thumbnail` is the 80/20 win: `mediaSlotHtml` shows a real `<img>` for
all 54k posts with **zero JS change**. The deliberate parts:

- **`mediaSlotHtml` precedence (app.js:140).** When `thumbnail` is set, the code
  takes the `<img>` branch and never reaches the click-to-load button. For
  `image`/`gallery`/`video` that's fine *visually*, but the image must be made
  openable and the video/gallery must keep an "open" affordance. Today the `<img>`
  only gets the `img-open` class when `imageUrl(item)` is truthy.
- **`imageUrl` (app.js:109).** Returns the full image when the URL matches an image
  extension / `i.redd.it`, **or** when `media_type === "image"` (then returns
  `item.url`). For the 54k reddit_media items `item.url` is the **permalink**, not
  an image — so refining to `image` without also fixing the URL yields a broken
  lightbox. Two options:
  1. **Overlay `url` = the direct media URL for images only.** The archive's `url`
     field for an image post is the `i.redd.it/…png` already; `_overlay_fields`
     sets `overlay["url"]` from `fields["url"]` today. For **images** this is
     desirable (title-click → image). For **videos** it is NOT — a bare
     `v.redd.it/…` URL renders no page, which is exactly why the connector points
     videos at the permalink. So: overwrite `url` only when `media_type=="image"`;
     for video keep the permalink and stash the playable URL in `media_url`.
  2. **Prefer `media_url` in `imageUrl`/lightbox** and leave `item.url` alone.
     Cleaner separation; small `imageUrl` tweak to read `m.media_url` when
     `media_type==="image"`.
  Recommend **option 2** (don't mutate `url`; the lightbox/player reads
  `media_url`). Keeps click-through semantics stable and isolates the change.
- **Video play.** `reddit_video` currently opens the permalink embed
  (`openMedia`). With a real `media_url` (DASH/`fallback_url` mp4) you *could* play
  inline via `<video>`, but reddit DASH needs audio muxed separately — the
  permalink embed is more reliable. Recommend keeping the embed for v1; just add
  the thumbnail.
- **Gallery.** With `media_type="gallery"` the frontend's `PREVIEW_TYPES` map
  (`{reddit_video, reddit_media}`) won't match → no button, and the `/\/gallery\//`
  URL test that drives the "🖼 Gallery" label still works off `item.url`. Decide:
  keep emitting `reddit_media` for galleries (simplest — existing label + new
  thumbnail), or add a `gallery` type and teach the frontend about it. For v1,
  **emit `reddit_media` for galleries** (thumbnail lights up, label unchanged) and
  leave true gallery type + inline arrays to the Epic 7 follow-up.

## 4. media_type taxonomy (proposed)

| Signal                                   | media_type     | frontend effect                          |
|------------------------------------------|----------------|------------------------------------------|
| `is_video` or `media.reddit_video`       | `reddit_video` | thumbnail + "▶ Play" permalink embed     |
| `is_gallery`                             | `reddit_media`*| thumbnail + "🖼 Gallery" (url-based label)|
| `post_hint == "image"`                   | `image`        | thumbnail + lightbox (via `media_url`)   |
| `post_hint in (hosted:video, rich:video)`| `reddit_video` | as above                                 |
| `post_hint == "link"`                    | `link`         | plain link                               |
| none of the above                        | *(unchanged)*  | keep the existing heuristic value        |

\* v1 keeps galleries as `reddit_media`; a `gallery` type is the Epic 7 follow-up.

## 5. Testing

- **`tests/test_archival.py`** (provider-level): feed canned API records (the three
  probed shapes above — copy the real JSON into a fixture) through `_norm_post`;
  assert `media_type`/`media_url`/`thumbnail` for image, hosted:video, gallery, and
  a self/text post (no media → empty). Cover the sentinel-thumbnail skip and the
  `&amp;` unescape.
- **service-level**: a fake provider returning a media record → `recover` →
  assert the item's metadata gains `media_type`/`thumbnail`/`media_url` and that an
  existing heuristic `media_type` was overridden (e.g. `reddit_media` → `image`),
  non-destructively (title/status/score preserved).
- **regression**: comments still normalize with no media keys; a post the archive
  returns without media leaves the heuristic `media_type` intact.
- Mirror the existing injectable-provider pattern in `test_archival.py` (no live
  network in tests).

## 6. Rollout / scale

- Lights up via `python -m content_hoarder enrich --source reddit --scores --limit N`
  (resumable; `hydrated_at` marks attempts). The score-hydration and media
  refinement are the same pass.
- Full coverage is ~54k posts. PullPush batches 100 ids/request at a 4 s throttle
  (~25 req/min → the 54k is hours); Arctic-Shift batches 500 at 0.4 s and can carry
  most of the load. Run in `--limit` chunks like the YouTube enrich.
- **Run against a COPY of `data/app.db` first** (standing practice), confirm the
  `media_type` distribution shifts sensibly (reddit_media ↓, image/reddit_video ↑)
  and no `thumbnail` is a sentinel, then apply.
- Non-destructive throughout: only adds/overrides `media_type`, `thumbnail`,
  `media_url`; never touches title/body/status/score on an already-hydrated row.

## 7. Files to touch (when built)

- `src/content_hoarder/archival/providers.py` — `_media_url`/`_thumb`/`_media_type`
  helpers + extend `_norm_post`.
- `src/content_hoarder/archival/service.py` — `_overlay_fields` maps the media keys.
- `src/content_hoarder/static/app.js` — `imageUrl` reads `media_url`; verify
  `mediaSlotHtml` precedence for the thumbnail-present case.
- `src/content_hoarder/static/triage.js` — same lightbox/play affordance parity.
- `src/content_hoarder/static/sw.js` — bump `CACHE = "ch-shell-vN"` if app.js/JS
  changes (PWA cache).
- `tests/test_archival.py` — provider + service media tests.
- `docs/backlog/epic-04-recover-deleted-reddit-content.md` / GitHub issue #11 — keep historical notes
  current if media-recovery assumptions change. The old Epic 7 gallery premise has already been corrected
  (`media_metadata` IS available from the archives).

## 8. Open decisions (carry into the build)

1. Overlay `url` for images vs. read `media_url` in the lightbox — **recommend the
   latter** (don't mutate `url`).
2. Gallery: `reddit_media` for v1 vs. a new `gallery` type — **recommend
   `reddit_media` for v1**, gallery type with Epic 7.
3. Inline gallery image arrays from `media_metadata` — **defer to Epic 7** (bigger
   frontend lift; this spec proves the data is available).
4. Whether recovered-media-alone flips `meaningful` for `scope="removed"` — **leave
   as-is for v1**.
