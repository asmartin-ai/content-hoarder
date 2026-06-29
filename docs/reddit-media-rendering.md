# Reddit media rendering — design for Epic 13 P1 "Reddit videos & galleries broken"

Status: **SHIPPED on v3** · 2026-06-13 (design draft was 2026-06-12, overnight run). Implemented in
`static/core/media.js` + `static/browse/` (`openMediaFor` dispatch, `createLightbox` with Esc/backdrop,
native `<video>`/gallery/image + iframe fallback). The v2 `app.js` line refs below are historical
(app.js removed). One open follow-up: v.redd.it HLS/DASH **audio** (BACKLOG Epic 13 P2).
Binding user direction (2026-06-08): **avoid the Reddit iframe embed** — render galleries/video
natively from the archived `media`/`gallery` metadata; study how RES + old.reddit present media.

Inputs: live-DB inventory (read-only, `data/app.db`, scripts in `K:\Projects\overnight-20260612\q*.py`),
v2 code (`K:\Projects\content-hoarder`, `main` branch — read at the time via the `ch-score` worktree,
removed 2026-06-16), v3 code (`K:\Projects\content-hoarder`, `feat/frontend-v3`),
RES source (fetched verbatim from GitHub this session), live URL probes against reddit CDNs
(curl, 2026-06-12). All claims below are tagged **[measured]**, **[probed]**, **[fetched]**
(verbatim source read this session), or **[reported]** (web search/paraphrase, not independently verified).

---

## 0. TL;DR + the one decision that gates everything

The bug is not one bug. Three distinct defects share the symptom:

1. **Detection is keyed to `media_type`, which is wrong for ~85% of media posts.** 53,854 posts
   sit in the `reddit_media` catch-all; the *true* corpus (by `media_url` shape) is ~26k images,
   ~7k reddit videos, ~1.9k galleries. Galleries with captured image arrays are mostly typed
   `reddit_media` (1,588 of 1,682), so type-keyed code paths never fire.
2. **The video player is fed an unplayable URL.** v3's `openVideo(m.media_url, …)` receives the bare
   `https://v.redd.it/<id>` directory URL for all 372 *typed* videos — a native `<video>` cannot play
   it. Meanwhile 5,325 *untyped* v.redd.it posts carry a directly playable `DASH_*.mp4?source=fallback`
   URL nobody uses. The typed and playable populations are almost perfectly disjoint.
3. **Even the playable fallback mp4 is silent.** Probed and box-parsed this session: both eras
   (2023 `DASH_720.mp4`, 2025 `CMAF_1080.mp4`) contain exactly one track, handler `vide`, zero
   `soun`/`mp4a` — reddit serves audio as a separate stream.

**THE decision gate — video audio.** Recommendation (one line): **feature-detect native HLS
(`canPlayType('application/vnd.apple.mpegurl')`) and play `https://v.redd.it/<id>/HLSPlaylist.m3u8`
with full audio where supported (Firefox Android ≥151 — the primary mobile target — Chrome ≥142,
Safari); elsewhere play the silent fallback mp4 labeled honestly ("🔇 silent preview") with a
"watch with sound on Reddit ↗" link; vendored hls.js stays a priced, explicitly-deferred upgrade.**
Everything else (images, galleries, gifs) has a clear zero-dependency answer and no gate.

---

## 1. Problem statement

Reddit video and gallery items did not play / render correctly in the inbox (historical backlog:
`docs/backlog/epic-13-ui-bugs-quick-fixes.md`, Epic 13 media rendering item). The frontend has rich rendering capability but (a) keys it off the unreliable
`media_type`, (b) hands the `<video>` element a non-media URL, and (c) falls back to the Reddit
iframe embed (`redditmedia.com`) — which the user has ruled out: it is online-only, third-party,
themed wrong, frequently refuses to render in an iframe, and leaks browsing to Reddit.

### 1.1 Current code paths

**v2 inbox — `src\content_hoarder\static\app.js`** (on `main`; classic script, served at `/`):

| Function | Lines | Behavior today |
|---|---|---|
| `redditUrl` / `redditEmbedUrl` | 86–96 | permalink → `www.redditmedia.com/...?embed=true` iframe URL |
| `openMedia(permalink)` | 97–104 | **the avoided iframe** — injects `<iframe class="reddit-embed-frame">` |
| `openImage(url)` | 106–112 | `<img>` lightbox — works, but only reached when `imageUrl()` ≠ "" |
| `openGallery(urls)` | 114–122 | stacked `<img>` lightbox from `metadata.gallery` — works when wired |
| `imageUrl(item)` | 272–278 | returns full image only if `item.url` matches `IMG_EXT`/i.redd.it **or `m.media_type === "image"`** → fails for the 23,513 i.redd.it posts typed `reddit_media` (their `item.url` is the permalink, their type is wrong) |
| `PREVIEW_TYPES` | 396 | `{reddit_video: "▶ Play", reddit_media: "▶ Preview", gallery: "🖼 Gallery"}` |
| `galleryAttr(m)` | 399–400 | embeds `data-gallery` JSON when `m.gallery` is a non-empty array |
| `mediaSlotHtml(item)` | 413–438 | thumb + class routing: `img-open` (lightbox) vs `rd-preview` (iframe) |
| click handler | 827–836 | `[data-gallery]` → `openGallery` (✓ native); `.rd-preview` → `openMedia` (✗ iframe — **all videos land here**); `.img-open` → `openImage` |

**v2 triage — `src\content_hoarder\static\triage.js`** (on `main`):
`openGallery` (61–67, duplicated copy), `mediaHtml` (169–206) — galleries with arrays render
**inline** (`tcard-gallery`, lines 173–183, tap → lightbox via 360–368); but `reddit_video` /
`reddit_media` / `gallery`-typed posts without arrays get a `rd-preview-lg` button (187–192)
→ Reddit iframe. Same root defects.

**v2 reddit threads — `static\reddit.js`:** only URL-heuristic `mediaType()` classification
(637–656); no playback path of its own.

**v3 browse — `K:\Projects\content-hoarder\src\content_hoarder\static\browse\`** (ES modules):

| Function | File:lines | Behavior today |
|---|---|---|
| `openMediaFor(item)` | main.js:183–192 | gallery array → `openGallery` ✓; `mediaType(item).cls === "video" && m.media_url` → **`lightbox.openVideo(m.media_url, m.thumbnail)`** — for typed videos `media_url` is the bare `https://v.redd.it/<id>` → `<video>` shows an endless spinner / error; then `imageUrl` ✓-when-typed; then **permalink → iframe** |
| `monitorHtml` / `pinCard` | render.js:62–76, 122–138 | thumbnails + 🖼/🎬 glyph badges; pinCard shows `🖼 N` gallery count (132–133) |
| `mediaType(item)` | core/media.js:43–57 | **URL-heuristic over `item.url` only** — for `reddit_media` posts `item.url` is the permalink → classified "Text post"; the v.redd.it/i.redd.it evidence sits unread in `m.media_url` |
| `createLightbox` | core/media.js:77–127 | `openMedia` (iframe), `openImage`, `openGallery` (stacked), `openVideo` (native `<video>`, poster, src) — the right shells already exist |
| `imageUrl` | core/media.js:34–39 | same `media_type === "image"` gate as v2 → same 23.5k misses |

**Backend (context, not in scope to change for rendering):**
`archival/providers.py::_media_url/_thumb/_media_type/_gallery` (lines 55–116) populate
`metadata.{media_type, media_url, thumbnail, gallery}` from the archive APIs;
`archival/service.py:91` overlays them. `_gallery` (67–81) already handles animated entries
(`s.u or s.gif or s.mp4`). `docs/reddit-media-refinement.md` records the provenance.

**Root cause in one sentence:** the renderers trust `media_type` (a label that the enrichment pass
only fixed for ~1,250 of ~35,000 media posts) instead of the **`media_url` URL shape and the
`gallery` array presence, which are correct for nearly everything.**

---

## 2. Corpus reality [measured 2026-06-12, `app.db` read-only]

64,037 reddit items = 55,444 posts + 9,593 comments (comments carry no media).

### 2.1 Typed counts vs true counts

`json_extract(metadata,'$.media_type')`, source='reddit':

| media_type | count | comment |
|---|---:|---|
| `reddit_media` | 53,854 | the catch-all — decomposed below |
| `link` | 9,927 | 36 of these hold `$.gallery` arrays |
| `image` | 810 | |
| `reddit_video` | 372 | |
| `gallery` | 59 | |
| `youtube` | 15 | |

Decomposing `reddit_media` by `media_url` (posts only):

| media_url shape | count | true kind |
|---|---:|---|
| `i.redd.it` | 23,513 | **image** (21,525 have thumbnails; 839 are `.gif`) |
| `v.redd.it` | 6,583 | **reddit video** (6,073 thumbnails; **5,325 carry a full `DASH_*.mp4?source=fallback` URL**, 0 raw_json) |
| `reddit.com/...` permalink/self | 9,550 | text/self |
| imgur total | 3,409 | 2,052 direct-ext images · 406 `.gifv` (video) · rest album/page links |
| `/gallery/` | 1,932 | **gallery** |
| gfycat | 1,097 | **dead host** (service shut down 2023); 914 still have poster thumbnails |
| direct img ext (other hosts) | 249 | image |
| redgifs | 9 | link-out |

**True per-kind totals (what the design must serve):**

- **image ≈ 26,600** (23,513 + 2,052 imgur + 810 typed + 249 other) — *13× the video corpus, 36× typed counts*
- **reddit_video ≈ 6,958** (372 typed + 6,583 untyped + 3 stragglers) — of which **~6,135 have a playable
  stored fallback URL** (67 CMAF + 5,325 DASH + …; whole-corpus: 5,568 `DASH_`, 743 `CMAF_` URLs)
  and **~820 have only the bare `https://v.redd.it/<id>`** (305 of the *typed* 372 are bare —
  the typed population is the *worst*-equipped one)
- **gallery: 1,682 posts have a `$.gallery` URL array** (1,588 typed `reddit_media`, 58 `gallery`,
  36 `link`); 1,932 have `/gallery/` URLs → ~250 gallery posts have **no** captured array
  (deleted/unrecovered) and can only link out
- gif-ish: 839 i.redd.it `.gif` + 406 imgur `.gifv`
- NSFW is negligible here: 5 of 6,958 videos, 16 of 1,682 galleries (`over_18`)

**Lead with images and galleries in expectations, videos in engineering effort:** images are a
two-line detection fix; galleries are wiring that 90%-exists; video needs the real design.

### 2.2 Gallery array shape

`$.gallery` = flat ordered list of full-size **preview.redd.it** URLs (host split measured over
the first 400 arrays: 2,143 preview.redd.it vs 4 i.redd.it). Lengths: min 1 / median 4 / mean 5.5 /
max 20 (reddit's gallery cap; 47 arrays at exactly 20). Zero `.mp4` entries in the whole corpus,
80 `.gif` entries (render fine in `<img>`).

### 2.3 Sample metadata structures (5 per kind, abridged; full dumps in the q3 output)

**reddit_video, modern enrich (68 of 372 have raw_json)** — `reddit:t3_1tx02l2`:
```
metadata: media_type=reddit_video
          media_url=https://v.redd.it/mp69us2tvb5h1/CMAF_1080.mp4?source=fallback
          thumbnail=https://external-preview.redd.it/dWw3…Pk.png?format=pjpg&…&s=2943ac…
          permalink=https://www.reddit.com/r/StandUpComedy/comments/1tx02l2/…
raw_json.media.reddit_video: {bitrate_kbps:5000, fallback_url:…CMAF_1080.mp4?source=fallback,
          has_audio:true, height:1920, width:1080, duration:94,
          dash_url:…/DASHPlaylist.mpd?a=<sig>, hls_url:…/HLSPlaylist.m3u8?a=<sig>,
          scrubber_media_url:…CMAF_96.mp4, is_gif:false, transcoding_status:completed}
raw_json.preview.images[0].source.url=https://external-preview.redd.it/… (+6 resolutions)
```
(also sampled: t3_1txbpp8, t3_1tx9o78 — identical shape, CMAF_1080/CMAF_480)

**reddit_video, bare (304 of 372)** — `reddit:t3_1plfjv1`, `t3_1s9r9qu`, `t3_1t2n75t`:
```
metadata: media_url=https://v.redd.it/4ai2l2vdax6g1     ← bare id, no path
          thumbnail=https://external-preview.redd.it/…png?format=pjpg&…   raw_json: EMPTY
```

**untyped video (the 6,583)** — e.g. `https://v.redd.it/y7etx8k3xd9a1/DASH_720.mp4?source=fallback`,
`…/oyla4z9kqb9a1/DASH_1080.mp4?source=fallback` — full fallback URL, `media_type=reddit_media`.

**gallery, typed** — `reddit:t3_1txs0r6` (6 imgs), `t3_1tw28ks` (11), `t3_1twf4r3` (4):
```
metadata: media_type=gallery, media_url=https://www.reddit.com/gallery/1txs0r6
          gallery=[https://preview.redd.it/5sx7yv524i5h1.png?width=573&format=png&auto=webp&s=f64…, ×6]
raw_json.media_metadata.<id>: {status:valid, e:Image, m:image/png,
          s:{x:792,y:823,u:https://preview.redd.it/<id>.png?width=792&…&s=…},   ← source
          p:[{x:108,y:112,u:…?width=108&crop=smart&…}, ×3–6]}                   ← preview ladder
raw_json.gallery_data.items=[{media_id, id, caption?, outbound_url?}, …]        ← ORDER + captions
```

**gallery, untyped holder** — `reddit:t3_100c6ir` (2), `t3_100i683` (3), `t3_100cgul` (4):
`media_type=reddit_media`, `media_url=…/gallery/100c6ir`, `gallery=[preview.redd.it…]`, raw_json EMPTY.

**image** — `t3_146we0g`, `t3_1l6ibwg`, `t3_1nwx1rx`, `t3_1oakwgs`, `t3_1pkc78y`:
```
metadata: media_type=image, media_url=https://i.redd.it/fk2qfxtdne5b1.png
          thumbnail=https://preview.redd.it/fk2qfxtdne5b1.png?auto=webp&s=663…
```
Note the pair: **thumbnail = preview.redd.it/<same path>?…** — the i.redd.it path and the
preview.redd.it path are the same string. This makes the durable-URL fallback (§4.2) a regex, not a fetch.

`$.preview` objects: **0 everywhere** (never stored). `$.media`: 0 (lives only in raw_json for 68 videos
+ 59 galleries' media_metadata). Crossposts: 6 raw_json mention `crosspost_parent` — negligible.

### 2.4 Live URL probes [probed 2026-06-12 via curl, browser UA]

| Probe | Result |
|---|---|
| stored 2023-era `…/DASH_720.mp4?source=fallback` | **200 video/mp4** — stored fallback URLs survive 2.5+ years |
| stored 2025-era `…/CMAF_1080.mp4?source=fallback` | **200 video/mp4** |
| derived `https://v.redd.it/<bare-id>/HLSPlaylist.m3u8` (no signature) | **200** application/x-mpegurl, **both eras** |
| derived `…/DASH_720.mp4` on a 2026 video | **403** (era mismatch); `…/CMAF_720.mp4` → **200** |
| `Access-Control-Allow-Origin` on v.redd.it playlist + mp4 | **`*`** — fetch()/hls.js from localhost would work |
| audio renditions, unsigned | 2023 era: `DASH_audio.mp4` **200** (`DASH_AUDIO_128.mp4` 403); 2026 era: `CMAF_AUDIO_128.mp4` **200** |
| fallback mp4 track layout (first 1.5MB box scan, both eras) | **1 `trak`, handler `vide`, 0 `soun`/`mp4a` → video-only/silent, confirmed** |
| HLS master playlist content | lists audio (`#EXT-X-MEDIA:TYPE=AUDIO`, `CMAF_AUDIO_128.m3u8` / `HLS_AUDIO_64_K.m3u8`) + video renditions per era (`CMAF_220…720` / `HLS_224…576`) |
| signed gallery URL `preview.redd.it/…&s=<full sig>` from 2023 | **206 image/jpeg — signatures are content-bound, not time-bound** |
| `external-preview.redd.it` video poster | 206 image/jpeg |
| Referer tests: i.redd.it + preview.redd.it with foreign/localhost referer | **all 206 — no hotlink blocking**; no UA requirement either |

Implications: everything renderable is renderable **today, from stored metadata, cross-origin,
without auth, signatures, or proxying**. The only hard constraint is the muxing of audio.

---

## 3. Research notes — how others do it

### 3.1 RES (Reddit Enhancement Suite) [fetched verbatim — github.com/honestbleeps/Reddit-Enhancement-Suite]

`lib/modules/hosts/vreddit.js`: fetches **unsigned** `https://v.redd.it/${id}/DASHPlaylist.mpd`,
parses the MPD, sorts `Representation[frameRate]` by bandwidth (user option `minimumVideoBandwidth`,
default 3000 kB/s), detects audio via the manifest:

> `// Audio is in a seperate stream, and requires a heavy dash dependency to add to the video`
> `const muted = !manifest.querySelector('AudioChannelConfiguration');`

If **muted**: hands the player plain mp4 `BaseURL`s (`type: 'video/mp4'`) — i.e. exactly our
silent-fallback path. If **it has audio**: hands the serialized manifest as
`application/dash+xml`, played by **dash.js — RES ships `"dashjs": "4.7.4"` in package.json**
[fetched]. So the state of the art in the extension the user asked us to study is: *silent native
mp4 when there's no audio; a vendored ~heavyweight DASH library when there is.* Crossposts:
`postMetadata.crosspost_parent_list[0]` replaces the metadata when present [fetched, vreddit.js:60–62].

`lib/modules/hosts/redditgallery.js`: resolves gallery posts by fetching post JSON, then for each
`gallery_data.items` entry builds the **durable direct URL from the media id + mime**:

> ``src: `https://i.redd.it/${media_id}.${m.substr(6)}` ``

and returns `type: 'GALLERY'` pieces (RES's gallery expando pages one image at a time with
prev/next + counter). Takeaway we adopt: **`i.redd.it/<media_id>.<ext>` is the canonical,
signature-free image URL**; our stored preview.redd.it URLs carry the same `<media_id>.<ext>`
path, so the durable form is derivable client-side with a string swap — no API, no backfill.

### 3.2 old.reddit

old.reddit's own expando player stitches the separate DASH video+audio streams in its player JS;
external consumers that take only `fallback_url` get silent video — a widely-reported behavior
[reported: github.com/aledeg/xExtension-RedditImage#4; getmediatools.com guide]. Old-era audio
lives at `…/DASH_audio.mp4`, newer at `…/DASH_AUDIO_128.mp4` / `…/CMAF_AUDIO_128.mp4`
[probed — both naming eras confirmed live]. RES's expandos and old.reddit both render plain
`<img>` for i.redd.it and preview.redd.it [fetched: hosts/ireddit.js routes through defaultImage].

### 3.3 Browser-native HLS [reported — caniuse.com/http-live-streaming via WebFetch 2026-06-12]

| Browser | Native HLS in `<video>` |
|---|---|
| Safari (mac/iOS) | yes, since v6 — Apple's own protocol |
| **Chrome desktop** | **yes since ~142** (recent 2025/26 addition) |
| Chrome Android | yes (~147–149) |
| **Firefox Android** | **yes since ~151** — *the app's primary mobile target (Pixel 6 Firefox) is ≥151 as of mid-2026* |
| Firefox desktop | **no** (through 154) |
| Edge | no (79–149) |

Caveat: WebFetch paraphrases and these Chrome/Firefox versions are recent claims I could not
double-source tonight — but the design **feature-detects** (`video.canPlayType('application/vnd.apple.mpegurl')`)
rather than UA-sniffing, so being wrong about a version number changes coverage, not correctness.

### 3.4 hls.js — the priced, rejected-for-now option

Measured from jsdelivr (hls.js@1, 2026-06-12): `hls.min.js` **543,002 bytes**, `hls.light.min.js`
**354,437 bytes** on disk (the vendored artifact; ~⅓ that over the wire gzipped). It would play
`HLSPlaylist.m3u8` **with audio in every browser** via MSE (v.redd.it CORS is `*` [probed], so it
works from localhost). The skill constraint says "NO new runtime dependencies, no CDN; locally-vendored
assets allowed" — so vendoring is *lawful* (the fonts precedent) but it is a real runtime JS
dependency in spirit: 354KB of third-party code to maintain, vs. the current `core/` total of ~40KB.
**Treat as a deliberate user decision, not a default** — see Gate G1.

### 3.5 imgur `.gifv`

`i.imgur.com/<id>.gifv` is an HTML page wrapping a video; the direct media is the same path with
`.mp4` (community-standard mapping; RES routes imgur through its API and renders `type:'VIDEO'`
[fetched, hosts/imgur.js]). Plan: string-swap `.gifv → .mp4` into `<video muted loop playsinline>`;
verify one corpus URL during the build (imgur purged some old anonymous uploads in 2023 — expect
some 404s; `onerror` → link-out).

### 3.6 Privacy / Referer / CSP

- No hotlink/Referer blocking on i.redd.it / preview.redd.it / external-preview.redd.it / v.redd.it
  [probed §2.4]. Add `referrerpolicy="no-referrer"` on all reddit-media elements anyway: zero cost,
  stops leaking the local app's URL structure to reddit's CDN logs, and immunizes against future
  referer rules.
- Loading media does disclose *which* archived items you view to reddit's CDN (IP + URL). That is
  inherent to hotlinking and accepted for now; a local media-mirror pass is future work (out of
  scope — noted in Icebox).
- The app sets **no CSP today** (grep: zero `Content-Security-Policy` anywhere in `src/`), so no
  header changes are required. If a CSP is ever added: `img-src`/`media-src` need
  `*.redd.it *.redditmedia.com i.imgur.com`.
- `esc()` + `safeUrl()` are already applied in every render path touched (app.js, core/media.js);
  keep that invariant for any new attribute (gallery JSON in `data-gallery` is `esc()`d — good).

---

## 4. Design

### 4.0 The detection layer — `resolveMedia(item)` (root fix, shared)

One pure function in `static/core/media.js` that converts an item into a render plan. **Decision
order: evidence (gallery array > media_url shape) before labels (`media_type`).**

```js
// core/media.js — sketch, not final code
export function resolveMedia(item) {
  const m = item.metadata || {};
  const mu = m.media_url || "";
  if (Array.isArray(m.gallery) && m.gallery.length)
    return { kind: "gallery", urls: m.gallery, poster: m.thumbnail };
  const v = mu.match(/v\.redd\.it\/([\w-]+)(\/.*)?/);
  if (v) return { kind: "video", id: v[1],
                  fallback: /\.mp4/.test(mu) ? mu : "",        // stored DASH_/CMAF_*.mp4
                  hls: "https://v.redd.it/" + v[1] + "/HLSPlaylist.m3u8",
                  poster: m.thumbnail, permalink: m.permalink };
  if (/\.gifv(\?|$)/i.test(mu)) return { kind: "video", fallback: mu.replace(/\.gifv/i, ".mp4"), loop: true };
  if (IMG_EXT.test(mu) || /i\.redd\.it\//.test(mu)) return { kind: "image", url: mu };
  if (/gfycat\.com/.test(mu)) return { kind: "dead", poster: m.thumbnail, url: mu };  // host shut down
  // …then the existing item.url heuristics, media_type as last-resort label, else {kind:"link"}
}
```

This single function un-breaks all three defects at once and is the only place future shapes get added.
The existing `mediaType()` (core/media.js:43) stays for *labeling* (icons/badges) but rendering
decisions move to `resolveMedia`. Also fix `mediaType()`/`thumb()`/`imageUrl()` to consult
`m.media_url` in addition to `item.url` (today they read the permalink and answer "Text post").

### 4.1 image (~26,600 — the biggest win, ~zero risk)

**Recommendation: extend `imageUrl()` to recognize `media_url` by URL shape**, independent of
`media_type`:

```js
const direct = (u) => IMG_EXT.test(u) || /i\.redd\.it\//i.test(u);
export const imageUrl = (item) => {
  const m = item.metadata || {};
  if (direct(item.url || "")) return item.url;
  if (direct(m.media_url || "")) return m.media_url;          // ← the 23.5k unlock
  return m.media_type === "image" ? (m.media_url || "") : "";
};
```

Lightbox `openImage` is already correct. Add to the `<img>`s: `referrerpolicy="no-referrer"`, and
an `onerror` durable-URL swap (preview.redd.it path ↔ i.redd.it path — same `<id>.<ext>`, §3.1).
i.redd.it `.gif` (839) needs nothing — `<img>` animates gifs natively.

### 4.2 gallery (1,682 with arrays; median 4 imgs) — **extend the stacked lightbox, don't replace**

RES pages one-image-at-a-time; old.reddit needs RES for galleries at all. For an archive-triage
app the existing **stacked vertical scroll** (v2 `openGallery` app.js:114, core `openGallery`
media.js:110) is the better fit — one swipe gesture scans a median-4 gallery; no pager state;
already styled (`browse.css:471`). Verdict: **extend**:

1. **Fix detection** — galleries open via `resolveMedia` (array presence), not `media_type`. In v2
   `mediaSlotHtml` the `data-gallery` attr exists (app.js:399–400, 827–831) and triage renders
   arrays inline (triage.js:173–183) — those keep working; the fix removes the cases that fell
   through to `rd-preview` → iframe.
2. **Counter + position**: header "3 / 11" updated via scroll `IntersectionObserver`
   (~15 lines) — the only thing the stacked view lacks vs. RES paging; cheap and optional (P2).
3. **Durable-URL onerror** per image: `preview.redd.it/<p>?…` → `https://i.redd.it/<p>` (path is
   the media id + ext, §2.3/§3.1). Signed URLs verified live from 2023 [probed], so this is
   belt-and-braces, not a blocker.
4. The ~250 `/gallery/` posts **without** arrays: render poster + "Open gallery on Reddit ↗"
   link-out (NOT the iframe). Re-running `enrich --source reddit --scores` shrinks this set over
   time; no new backfill machinery in this pass.
5. `.gif` entries (80) work in `<img>` as-is. `.mp4` entries: zero in corpus today — add a
   one-line `<video muted loop>` branch only if `_gallery` ever emits them (provider already can,
   providers.py:78).

### 4.3 reddit_video (~6,958) — the gate

Facts the options must respect [all probed §2.4]: fallback mp4s are **silent by construction**,
both eras; unsigned `HLSPlaylist.m3u8` works and carries audio; CORS is open; ~6,135 items have a
stored playable fallback URL; ~820 have only a bare id; posters exist for ~92%; the primary mobile
target (Firefox Android ≥151) plays HLS natively [reported]; desktop Firefox does not.

| Option | Audio | Deps | Coverage | Price / risk |
|---|---|---|---|---|
| (a) silent fallback mp4 + honest label + "audio on Reddit ↗" | never | none | ~6.1k now, ~6.9k with ladder | the silence; users may misread "broken" unless labeled loudly |
| (b) vendored hls.js (light) | **everywhere** | **354KB vendored JS** | all | real dependency-in-spirit; maintenance; against the project's grain — explicit user call |
| (c) native HLS via `canPlayType` feature-detect | where supported: FF-Android ≥151, Chrome ≥142, Safari | none | all videos (HLS URL derivable from any v.redd.it URL) | desktop Firefox/Edge get no audio; support matrix is young [reported] |
| (d) poster-only + link-out | never | none | all | wastes 6.1k verified-playable URLs; worst UX |
| (e) dual `<video>`+`<audio>` JS-synced (poor-man's mux) | everywhere | none (~60 lines) | needs era-probing the audio name (`CMAF_AUDIO_128` → `DASH_AUDIO_128` → `DASH_audio`) | sync drift on stall/seek; per-era 403 probes; the jankiest path to maintain |

**Recommendation: (c) + (a) tiered, in one renderer.**

```text
openVideo(plan):
  if canPlayType('application/vnd.apple.mpegurl'):       # FF-Android, Chrome 142+, Safari
      <video controls playsinline poster src=plan.hls>   # full audio, native
      onerror → fallthrough
  if plan.fallback:                                       # stored DASH_/CMAF_*.mp4
      <video controls playsinline muted-by-nature poster src=plan.fallback>
      + visible "🔇 silent preview" tag + "▶ watch with sound on Reddit ↗" (plan.permalink)
  else (bare id, no native HLS):
      resolve via ladder: HEAD fetch (CORS *) CMAF_480.mp4 → DASH_480.mp4 → CMAF_720 → DASH_720
      → DASH_360 → DASH_240; first 200 wins (≤2 in flight); cache result on the DOM node
  ultimate fallback: poster + permalink link-out (never the iframe)
```

Rationale: audio lands on the platform the user actually watches on (Pixel 6 Firefox) with zero
dependencies; desktop Firefox gets an honest silent preview one labeled-click from sound; nothing
lies, nothing 543KBs the repo, and (b) remains a clean later upgrade because the renderer is
already plan-shaped (drop-in: `if (!nativeHls && window.Hls) … attachMedia`). RES itself ships the
same split (silent mp4 vs. heavyweight-library) [fetched §3.1] — we're choosing the same fork,
minus the bundled library.

The is_gif case (`is_gif:true` videos, no audio track at all): the HLS/fallback path plays them
fine; suppress the "silent preview" tag when `duration` is absent/short if it grates — P3 polish.

**Gate G1 (the audio question, decided by the user, not this doc):** accept tier-(c/a) as the
shipped state? Or pay 354KB vendored hls.light.min.js to get audio on desktop Firefox too?
Recommendation: ship (c/a), revisit after a week of real use; the upgrade is additive.

### 4.4 The rest of the long tail

- **imgur `.gifv` (406):** `.gifv→.mp4` swap → `<video muted loop playsinline>`; `onerror` → link-out (§3.5).
- **imgur direct images (2,052) + other direct-ext (249):** covered by the §4.1 extension test.
- **gfycat (1,097, dead host):** `kind:"dead"` → poster (914 have one) + "source offline · open link ↗";
  never attempt playback. redgifs (9): plain link-out.
- **crossposts (6):** nothing to do — `resolveMedia` reads `media_url`, which already points at the
  parent's v.redd.it id. (RES precedent: crosspost_parent_list[0] [fetched].)
- **youtube (15 typed):** untouched (existing thumb pipeline owns it).
- **The Reddit iframe (`openMedia`/`redditEmbedUrl`):** keep the function as the *manual* escape
  hatch behind the "Open on Reddit" links only — remove it from every automatic fallback chain.
  Do not delete in this pass (reddit.js thread view may still want it); just orphan it.

### 4.5 NSFW

Counts are tiny (§2.1) and both surfaces already gate reveal-before-open (app.js:825–826,
main.js:171–176, `createNsfw` core/media.js:132). No new design; verify the gallery/video paths
still route through the veil after the wiring change.

---

## 5. Where the code lives

**Single implementation in `static/core/media.js`** (it already exists and is Epic-13-aware — its
comments cite "Epic 13:344 native-embed pass"). Add: `resolveMedia()`, the tiered `openVideo`
upgrade inside `createLightbox`, the gallery counter/onerror, the `imageUrl` fix. Estimated growth:
+120–160 lines, no new files needed (option: split `core/media-video.js` if it crosses ~350 lines).

Consumers:

- **v3 browse** — already imports everything it needs (`main.js:9`); `openMediaFor` (main.js:183)
  shrinks to `lightbox.open(resolveMedia(item))`-shaped calls. `render.js` badges read
  `resolveMedia(...).kind` instead of `mediaType().cls` where it matters (the 🎬/🖼 glyphs).
- **v2 triage (`/triage`)** — classic script, can't `import`. Bridge: a 6-line inline module in
  `triage.html` that imports `core/media.js` and exposes `window.CHMedia = { resolveMedia, createLightbox … }`.
  Modules execute deferred, classic scripts first — **consume `window.CHMedia` lazily at
  click-time** (triage's handlers are all click-driven already), never at parse time. triage.js's
  duplicated `openGallery`/`mediaHtml` then delegate when `window.CHMedia` exists and keep the
  current inline-gallery markup as-is.
- **v2 inbox `/` (main branch)** — same bridge pattern *if* the fix is backported to main before
  v3 ships; on the v3 branch the inbox is already `browse/` and needs nothing. Recommendation:
  build on `feat/frontend-v3` (browse + triage), cherry-pick to main only if v3 stalls.
- **reddit.js (`/reddit`)** — out of scope this pass (classification only); add the bridge later
  if its thread view wants inline media.
- **PWA:** bump `sw.js` `CACHE` (now `ch-shell-v15`) — core/media.js is inside the cached shell.

Why core/ and not app.js: the user's standing plan retires v2 (Epic 20); duplicating the fix into
58KB app.js would be paying twice for code already scheduled for deletion.

---

## 6. Test / verification strategy

pytest cannot see the frontend; verification is measurement-based (frontend-design skill) plus
syntax/static gates:

1. **Syntax gate (every phase):** `node --check` on every touched `.js`
   (works for classic scripts; for the ESM core/media.js use `node --check --input-type=module < file`
   or `node -e "import('file:///K:/…/core/media.js')"` which also catches bad imports).
2. **Pure-logic unit tests without a browser:** `resolveMedia`, `imageUrl`, the gifv/durable-URL
   rewrites are pure functions — a tiny `node` script imports `core/media.js` (it must stay
   DOM-free above the `createLightbox` line; keep it that way) and asserts the kind/url plan for
   ~12 canned metadata fixtures **copied from §2.3's real samples**. This is the regression net.
3. **Claude Preview / browser measurement (per the claude-preview-verify + frontend-design skills):**
   against the live local app with the real DB —
   - pick known fullnames per shape (from §2.3: `t3_1tx02l2` stored-fallback video, `t3_1plfjv1`
     bare video, `t3_1tw28ks` 11-img gallery, `t3_100c6ir` untyped-gallery, `t3_146we0g` image,
     one gfycat item), search/jump to each, click the media slot;
   - assert **measurements, not presence**: `#media-body video` has `readyState ≥ 2` (HAVE_CURRENT_DATA
     = it actually decodes) and `videoWidth > 0`; gallery renders `imgs.length === metadata.gallery.length`
     and each `naturalWidth > 0`; zero console errors; **zero requests to `redditmedia.com`**
     (preview_network) on these flows;
   - audio check where native HLS exists: `video.audioTracks`/`mozHasAudio`/`webkitAudioDecodedByteCount > 0`
     after 2s play — on desktop preview (Chromium ≥142) the HLS tier should engage; log which tier ran.
4. **Honest-label check:** on a silent-tier video, the "🔇 silent preview" element is visible
   within the lightbox viewport rect.
5. **Corpus smoke (read-only, scriptable):** rerun `q2/q3/q4` — counts unchanged (the fix is
   frontend-only; any DB drift means someone ran enrich, not a bug).
6. **Mobile spot check (manual, user):** Pixel 6 Firefox — one video with sound (G1 evidence),
   one 11-image gallery scroll, NSFW veil intact. This is the only step that can't be automated here.

---

## 7. Phased build plan (ADHD-shaped; gates first)

### Decision gates — settle BEFORE phase 1

- **G1 · AUDIO (the gate).** Accept tiered native (HLS-where-supported / silent-elsewhere with
  honest label + Reddit link), or vendor `hls.light.min.js` (354KB) for audio-everywhere?
  **Default if no answer: tiered native.** The build is identical either way until phase 3;
  deciding now only changes whether phase 3 exists. ⏱ 5 min of user thought.
- **G2 · Where v2 gets the fix.** Triage-only via the `window.CHMedia` bridge on `feat/frontend-v3`
  (recommended), or also cherry-pick to main's `/` inbox? **Default: triage-only on v3 branch.**
  ⏱ 2 min.
- **G3 · Gallery counter.** Stacked scroll ships without a position counter (P2 add later)?
  **Default: yes, ship without.** ⏱ 1 min.

### Phase 1 — detection + images + galleries (the 90% by item-count)

⏱ **2–3 h** · ▶ *first action (10 min): open `core/media.js`, write `resolveMedia()` with the §4.0
order and the 12-fixture node test file next to the q-scripts; run `node` on it red-first.*
- `resolveMedia` + `imageUrl` media_url fix + `mediaType` reads media_url + gallery wiring through
  `openMediaFor` / triage bridge + `referrerpolicy` + durable-URL onerror + dead-host kind.
- sw.js cache bump.
- ✓ **done-when:** node fixture tests green; preview measurement (§6.3) passes for image/gallery/
  untyped-gallery fullnames; zero `redditmedia.com` requests; `node --check` clean.

### Phase 2 — video tier (c)+(a)

⏱ **3–4 h** · ▶ *first action (10 min): in `createLightbox.openVideo`, branch on
`canPlayType('application/vnd.apple.mpegurl')` and feed `plan.hls`; click `t3_1plfjv1` in the
preview and read which tier logged.*
- Tiered renderer + silent label + "watch with sound on Reddit ↗" + bare-id HEAD ladder (≤2
  concurrent, 6 candidates, result cached on the node) + gifv swap + poster-only ultimate fallback.
- ✓ **done-when:** stored-fallback video plays (readyState≥2, videoWidth>0); bare-id video resolves
  via ladder and plays; HLS tier verified once on a supporting browser (preview Chromium or the
  Pixel); silent tier shows the 🔇 label inside the modal rect; gfycat item renders poster+link, no
  spinner.

### Phase 3 — only if G1 chose vendoring

⏱ **1–2 h** · ▶ *first action: download hls.light.min.js into `static/vendor/`, add the
`window.Hls` branch (≈15 lines), CREDITS.md entry.* ✓ done-when: desktop-Firefox-profile preview
plays `t3_1plfjv1` **with** `audioDecodedByteCount > 0`; modal close destroys the Hls instance
(no leaked network in preview_network after close).

### Batch of tiny unblocks (one sitting, ⏱ 30 min total)

sw.js bump (if not done in P1) · `.gifv` probe of one live imgur URL · suppress silent-label for
`is_gif`-ish items · QA checklist update · local history / GitHub issue update with one-line
as-built note.

### Icebox (explicit, not now)

- Local media mirroring (download-on-keep) — kills the online dependency; big; revisit after usage.
- Re-enrich pass to upgrade the ~250 array-less galleries + 820 bare-id videos and to stamp true
  `media_type` (backend; rides the existing `enrich --scores` path — reactivate when the archives
  pipeline next runs anyway).
- Gallery captions (need `gallery_data` persisted, only 59 raw_json have it today).
- Dual-element audio sync experiment (e) — reactivate only if G1's tiered answer proves
  insufficient AND vendoring stays vetoed.
- `/reddit` thread-view inline media via the same bridge.

---

## 8. Sources

- RES vreddit/redditgallery/imgur/ireddit modules + package.json — fetched raw this session:
  https://github.com/honestbleeps/Reddit-Enhancement-Suite (lib/modules/hosts/…; local copies in
  `K:\Projects\overnight-20260612\res-src\`)
- caniuse — native HLS support matrix: https://caniuse.com/http-live-streaming [via WebFetch, paraphrased]
- hls.js dist sizes — measured via https://cdn.jsdelivr.net/npm/hls.js@1/dist/ downloads, 2026-06-12
- v.redd.it DASH separate-audio behavior (background): https://github.com/aledeg/xExtension-RedditImage/issues/4 ·
  https://getmediatools.com/blog/how-to-download-reddit-videos-with-audio/ [search snippets, paraphrased]
- hls.js project: https://github.com/video-dev/hls.js/
- Empirical probes (strongest evidence; commands reproducible): this file's §2.4, run 2026-06-12
  against v.redd.it / i.redd.it / preview.redd.it / external-preview.redd.it from this machine.
- Repo ground truth: `docs/reddit-media-refinement.md` · `archival/providers.py` ·
  `static/core/media.js` · `docs/backlog/epic-13-ui-bugs-quick-fixes.md`.
