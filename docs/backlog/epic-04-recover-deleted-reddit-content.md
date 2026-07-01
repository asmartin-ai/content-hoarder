## Epic 4 — Recover deleted Reddit content  (`enhancement`, `area:recovery`)
*Motivation: many saved posts/comments are now `[removed]`/`[deleted]`.*

- [x] ~~**Port the RSM `archival/` package.**~~ Shipped: `content_hoarder/archival/` (PullPush.io +
  Arctic-Shift, stdlib-only, non-destructive overlay, resumable via `hydrated_at`) behind
  `enrich --source reddit --archives [--limit N] [--all]`. Targets `[removed]`/`[deleted]` items and
  un-hydrated comment bodies. Refs: [pullpush.io](https://pullpush.io),
  [ArthurHeitmann/arctic_shift](https://github.com/ArthurHeitmann/arctic_shift).
- [x] ~~**On-demand single-item recovery in the UI.**~~ Shipped: `archival.recover_one()` +
  `POST /items/<fn>/recover` + a "↻ Recover" button on `[removed]`/`[deleted]` reddit cards that
  patches the title/body in place (throttle off).
- [x] ~~**P3 — Refine media metadata from the same fetch.**~~ Shipped: the archive fetch
  (`enrich --source reddit --scores`) now extracts `post_hint`/`is_video`/`is_gallery`/`media`/`preview`/
  `thumbnail` and splits the catch-all `reddit_media` bucket (~85% of reddit items) into precise
  `image`/`reddit_video`/`gallery` with real thumbnails + `media_url`; `media_type` overrides the
  URL-heuristic value non-destructively, videos keep a navigable permalink. Spec + as-built notes:
  [`docs/reddit-media-refinement.md`](docs/reddit-media-refinement.md).
- [x] ~~**Inline gallery image arrays (from `media_metadata`).**~~ Shipped: the archive fetch now
  extracts ordered full-size gallery URLs (`providers._gallery` from `gallery_data` + `media_metadata`)
  into `metadata.gallery`; the browse media-modal renders them as an inline stacked lightbox
  (`openGallery` in `app.js`, routed via a `data-gallery` attribute). Populated for all gallery items
  on the next `enrich --source reddit --scores` pass. (Triage-card inline gallery still TODO.)
- [~] **P1 — Hoard the BYTES, not just the link: local media archiving.** ✅ **Infra + images + explicit video archiver DONE** (Epic 4: `media_store.py` blob store + `archive-media`/`scan-media` CLI + same-origin `/media/<blob>` route + prefer-local frontend, on main). **Live run 2026-06-22:** `scan-media` classified deletions (2,394 `gone`, 32 salvaged); galleries + salvageable archived; the bulk **images** pass archived **22,052 blobs (98.9% ok, 249 already-deleted)** → **`data/media/` = 32,506 blobs / 18 GB**, **25,706 items now carry a local copy** that survives remote deletion (frontend already prefers it + falls back on 404). **Video slice shipped 2026-06-29:** `archive-media --videos` is an explicit opt-in scope using lazy `yt-dlp`, streaming `media_store.store_path`, `metadata.archived_media_details`, skip/resume semantics, and offline downloader tests; no live representative `v.redd.it` download has been run yet, so runtime success still depends on local `yt-dlp`/`ffmpeg` availability. **Remaining:** (a) live video-archive smoke on a DB copy + then a supervised video pass if desired; (b) the deleted/non-image **tail** (~627, mostly unrecoverable → see archive.today / RedGifs / RepostSleuth items); (c) **at-save-time** archiving for *new* saves (catch deletions early). ⚠️ **`data/media/` is the ONLY copy** — gitignored, NOT in the metadata-only DB backups → **needs a separate backup.** *(User-requested 2026-06-20; images pass run 2026-06-22; video archiver 2026-06-29.)*
  **Problem (core to the "hoarder" mission):** we store *URLs*, not media. When reddit deletes an image the
  app shows reddit's "if you're looking for an image, it was probably deleted" placeholder and it's gone for
  good — confirmed 2026-06-20 on `reddit:t3_1u69n0s` (r/196 "rule"): `i.redd.it/9pxkje0ife7h1.jpeg` → 404
  (1048-byte placeholder), **every** `preview.redd.it` size also 404, PullPush has no record, Arctic-Shift has
  only metadata + the now-dead preview URLs, and the Wayback Machine never captured the bytes (only
  post-deletion redirects). Our DB backups are **metadata-only**, so they can't restore it either. The bytes
  were never on our disk. **Feature — an opt-in media-archiving pass** that downloads + stores the actual
  bytes for saved items so deletions are survivable:
  - **What to archive (phase order):** (1) reddit images (`i.redd.it`, direct image `url`/`media_url`), (2)
    gallery images (`metadata.gallery[*]`), (3) video posters/thumbnails; (4) *maybe later* full videos
    (`v.redd.it` DASH — large, separate opt-in). YouTube keeps its remote thumbnails (rarely deleted).
  - **Storage:** files on disk under e.g. `data/media/<sha256>.<ext>` (content-addressed → free dedup across
    reposts), NOT DB blobs (keeps the 500 MB DB lean + backups fast). Track in a `media_blobs` table or
    `metadata.archived_media` (original_url → local hash, bytes, mime, fetched_utc). Mind volume: tens of
    thousands of images = multi-GB; add a size cap / per-run `--limit` / skip-if-present (resumable, mirrors
    the enrich passes). `data/media/` must be gitignored.
  - **Serving + the SW win:** serve archived bytes from a **same-origin** route (`/media/<hash>` or
    `/media?url=<orig>`). Today the service worker **can't** cache reddit media because it skips cross-origin
    (`sw.js:40`); a same-origin media route flips that — the SW (and HTTP cache) will cache it, so the PWA
    works offline and survives remote deletion. Frontend (`core/media.js` `thumb()`/`imageUrl()` +
    `openGallery`/reader) prefers the local archived copy when present, and **falls back to it when the remote
    404s** (an `onerror` swap to `/media/<hash>`). This also unblocks Epic 12's OCR (needs local image bytes).
  - **When:** an `archive-media` CLI pass (enrich-style: dry-run, `--limit`, `--source`, resumable) the user
    runs over the backlog; later optionally at save/sync time for *new* saves (catch deletions early — the
    whole point). Keep it opt-in + throttled (respect the reddit de-risking rate floors).
  - **Recovery of EXISTING deleted items (partial, do first):** for items whose `i.redd.it` is already 404,
    `preview.redd.it` *sometimes* outlives the original — a recovery sub-pass can try the archive's preview
    URLs and Wayback, and archive whatever still resolves. Won't save `t3_1u69n0s` (all dead) but will save
    the subset caught in the preview-survival window. Scope it by first counting saved image items whose
    `i.redd.it` now 404s and how many have a still-live `preview.redd.it`.
  Relates to Epic 4 (recovery), Epic 12 P3 (OCR needs bytes), Epic 8 (infra/storage), and the SW
  cross-origin note in `sw.js`. Sizable — sequence: storage model + `/media` route + `archive-media` pass
  first; the remote-404→local fallback in the frontend second; full-video archiving last.

- [x] ~~**P2 — `archive.today` (archive.ph) as a recovery provider.**~~ ✅ Shipped in two slices
  (2026-06-24 + opt-in hardening 2026-06-29): `ArchiveTodayProvider` in `archival/providers.py` is
  URL-keyed (not id-keyed like PullPush/Arctic), HTML (not JSON), and uniquely recovers the **media
  bytes** the metadata archives never had. The generic `/recover` route is now metadata-only by
  default; archive.today is an explicit per-item opt-in via `archive_today:"preview|apply"` plus
  `confirm_external_archive_today:true`, surfaced on triage/missing-media placeholders with clear
  confirmation copy. `scripts/recover_archive_today.py` is a no-network planner by default and needs
  explicit live/apply gates for smoke runs against a DB copy. Still per-item only (Cloudflare-gated,
  no bulk API), offline-injected in tests, and non-destructive (only `archived_media`/`media_status`).
  **Live smoke still pending** against a copied DB with a real `gone` item; expect low hit-rate.
  Relates to Epic 4 P1 (hoard the bytes). Refs: [archive.today](https://archive.today).
- [x] ~~**P2 — RedGifs resolver for the ~1,090 dead Gfycat links.**~~ ✅ Shipped 2026-06-29:
  `resolve-redgifs` CLI resolves dead Gfycat ids against RedGifs behind an explicit `--redgifs-ok`
  network/NSFW gate and stays dry-run by default; `--apply` performs the metadata rewrite only after
  the opt-in. Offline tests cover id extraction, dry-run/apply behavior, and failure classes. **SFW
  Gfycat is still mostly gone** (Wayback-only if ever pursued); this closes the RedGifs migration lane.
  Relates to Epic 4 (recovery) + Epic 9 (NSFW handling). Refs:
  [redgifs API docs](https://redgifs.readthedocs.io/en/stable/migrating.html),
  [gallery-dl #874](https://github.com/mikf/gallery-dl/issues/874).
- [ ] **P3 — RepostSleuth reverse-image-hash recovery (spike).** *(Research 2026-06-22.)* Novel recovery angle
  for **already-deleted** images: even when the original `i.redd.it` is 404, a still-**live repost** of the same
  image elsewhere on Reddit can be found via perceptual-hash lookup against RepostSleuth's index (undocumented
  API at `repostsleuth.com`; the bot u/repostsleuthbot is the public face). For a `gone` item we can query by the
  original Reddit **submission id / url** (which RepostSleuth indexed before deletion) and, if it returns a live
  duplicate post, pull *that* post's still-live image and archive the bytes. **Spike first** — the API is
  undocumented + may have broken with Reddit's API changes, hashing is JPEG-compression-sensitive, and it only
  helps images popular enough to have been reposted — so validate hit-rate on a sample of `gone` items before
  building a provider. High upside for memes / popular images; nil for one-off personal uploads. Relates to
  Epic 4 (recovery) + Epic 6 (dedup already hashes). Refs:
  [RedditRepostSleuth (GitHub)](https://github.com/barrycarey/RedditRepostSleuth).
### 2026-06-30 archive.today route hardening

Archive.today media recovery can now run as a media-only path from the UI by sending
`metadata:false` with `archive_today:"apply"`. That keeps explicit archive.today retries from also
contacting PullPush/Arctic metadata providers, while preserving the existing confirmation gate and
local eligibility reasons for non-eligible items.
