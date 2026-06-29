# Epic 4 v.redd.it video archiving

## Goal

Add an opt-in, resumable archiving path for Reddit-hosted `v.redd.it` videos so saved videos survive remote deletion and can be played from the local same-origin media store.

Non-goals for this slice:

- No live downloads or probes during planning.
- Do not fold archive.today into this path; archive.today remains URL-keyed HTML/image-byte recovery for already-gone media.
- Do not make video archiving run by default. Full videos are storage-heavy and must remain an explicit scope.

Done-when criterion for the eventual implementation: `archive-media --videos --apply` can archive a representative `v.redd.it` item into `data/media/<sha>.mp4`, stamp a backward-compatible `metadata.archived_media` entry, skip the item on the next run, and let the existing `/media/<blob>` route serve a locally playable video without mutating triage/user state.

## Confirmed current state

Confirmed from code/docs inspection only; no network probes were run.

- `media_archive.py` currently archives byte URLs for scopes `salvageable`, `galleries`, `images`, and `twitter`; default scope is `salvageable + galleries`. It is dry-run by default, injectable-fetch for offline tests, per-item committed, and skips URLs already present in `metadata.archived_media`.
- `media_archive.py` stores `metadata.archived_media` as a simple map: `{original_url: blob_id}`. Existing frontend logic expects values to be blob-id strings.
- `media_archive.py` has a `DEFAULT_MAX_BYTES = 15 MB`, appropriate for images but too small for full videos.
- `media_store.py` already supports `.mp4`, `.webm`, and `.mov` MIME/extension mapping and stores bytes content-addressed under `data/media/<sha256>.<ext>`.
- `web.py` serves local blobs from `/media/<blob>` after validating blob IDs via `media_store.path_for`, with immutable cache headers.
- `static/core/media.js` has local archive preference (`localUrl(item, url)`), v.redd.it HLS derivation (`hlsManifestUrl`), and lazy-loaded vendored `hls.js` from `/static/vendor/hls.min.js` for remote HLS playback.
- `media_scan.py` currently detects/probes image/gallery media only. `media_type='reddit_video'` is not classified by `is_media()`, and `best_and_preview()` has no video-specific target selection.
- `connectors/reddit.py` marks URLs containing `v.redd.it` as `metadata.media_type='reddit_video'`, stores the raw media URL in `metadata.media_url`, and keeps the clickable item URL as the Reddit permalink because bare `v.redd.it/<id>` is not a useful page.
- `archival/providers.py` normalizes archive records so `media.reddit_video.fallback_url` or `secure_media.reddit_video.fallback_url` becomes `metadata.media_url`, and `_media_type()` emits `reddit_video` for `is_video`, `media.reddit_video`, or `post_hint='hosted:video'`.
- `archival/service.py` intentionally does **not** overwrite the item `url` with a bare `v.redd.it` URL for videos; it keeps the permalink and puts the stream URL in metadata.
- `tests/test_media_archive.py`, `tests/test_media_scan.py`, `tests/test_archival.py`, and `tests/test_archive_today.py` establish the current pattern: offline/deterministic tests, injected transports/downloaders, no real network.
- `pyproject.toml` has `yt-dlp` only as the optional `youtube` extra, and existing code uses `shutil.which("yt-dlp")` / `subprocess.run(...)` rather than importing it globally.
- `BACKLOG.md` says the image/galleries media archive infrastructure is done, `data/media/` is already large and is the only copy of archived bytes, and `v.redd.it` videos remain the unstarted phase.

## v.redd.it media shapes to support

Support these normalized source shapes without requiring live Reddit API access:

1. **Bare v.redd.it ID URL**
   - Example shape: `https://v.redd.it/<id>`.
   - Often comes from older imports or heuristic connector metadata.
   - Not directly playable as a native `<video>` source.
   - Canonical ID is extractable from the first path segment.

2. **Fallback MP4 URL**
   - Example shapes: `https://v.redd.it/<id>/DASH_720.mp4?source=fallback`, `.../CMAF_1080.mp4?source=fallback`.
   - Directly downloadable/playable as video-only in many cases, but historically silent because Reddit separates audio.
   - Should be treated as evidence for the same canonical `v.redd.it` ID, not as a separate video.

3. **HLS playlist URL**
   - Example shape: `https://v.redd.it/<id>/HLSPlaylist.m3u8` or signed variants from Reddit metadata.
   - Carries audio+video renditions when played through HLS support/hls.js.
   - Storing only a remote playlist is not sufficient for local archiving because it references remote child playlists/segments.

4. **DASH manifest URL**
   - Example shape: `https://v.redd.it/<id>/DASHPlaylist.mpd` or signed `dash_url` from Reddit metadata.
   - Carries separate audio/video adaptation sets.
   - Same issue as HLS: robust local archival requires either downloading and rewriting an entire manifest graph or muxing into one local file.

5. **Archive-refined Reddit metadata**
   - `media.reddit_video` can contain `fallback_url`, `dash_url`, `hls_url`, `has_audio`, `is_gif`, `duration`, dimensions, and transcoding status.
   - Current normalizer only preserves `fallback_url` as `metadata.media_url`; this is enough to identify many videos, but preserving a small `metadata.reddit_video` subobject would improve future selection/reporting.

6. **Poster/thumbnail URL**
   - Often `metadata.thumbnail` on `b.thumbs.redditmedia.com`, `external-preview.redd.it`, or `preview.redd.it`.
   - Poster bytes are not the same as video bytes, but are cheap and useful to archive alongside videos when missing from `archived_media`.

## Proposed approach

Use `yt-dlp` as the optional downloader/muxer for full `v.redd.it` video archiving; do not implement a custom stdlib DASH/HLS downloader for v1.

Rationale:

- The existing project rule prefers stdlib `urllib` for HTTP, but allows existing optional tools like `yt-dlp` when they are already the project pattern.
- Reddit-hosted video audio is split from video in DASH/HLS. Archiving only `fallback_url` produces a silent local video and is not robust enough as the default.
- A correct custom implementation would need manifest parsing, variant selection, segment downloading, playlist rewriting or MP4 muxing, retries, and audio/video sync handling. That is a large media pipeline and easy to get subtly wrong.
- `yt-dlp` already knows Reddit/v.redd.it extractors and can choose video+audio formats and invoke `ffmpeg` for muxing when available.
- Keeping it optional preserves the current lightweight app: missing `yt-dlp` should only make `archive-media --videos --apply` report `missing_downloader`, not break import/search/serve/tests.

Recommended behavior:

- Add a new explicit archive scope: `videos` / CLI flag `archive-media --videos`.
- Default scopes stay unchanged (`salvageable + galleries`). Videos never run unless explicitly requested.
- Candidate detection should be pure DB/metadata inspection; dry-run should count candidates and already-archived skips without invoking network/downloader.
- Apply mode should require `yt-dlp` on PATH. Prefer a fully muxed MP4 output. If `yt-dlp` cannot mux due missing `ffmpeg` or missing audio/video formats, count a failure and do not stamp `archived_media`.
- Do **not** store silent fallback MP4 as the default success path. If a future user explicitly wants video-only archival, add a separate opt-in such as `--allow-silent-video`, and mark it clearly in metadata.
- Prefer feeding `yt-dlp` the Reddit permalink when available, because the extractor can use post context. Fallback inputs: `metadata.media_url`, canonical `https://v.redd.it/<id>`, then `item.url` if it itself is a v.redd.it URL.
- Keep archive.today separate. It is HTML/image-byte recovery for `media_status='gone'` and should not become a video downloader.

URL normalization:

- Add a small pure helper conceptually equivalent to `reddit_video_id(url) -> str | None`.
- It should extract `<id>` from:
  - `https://v.redd.it/<id>`
  - `https://v.redd.it/<id>/DASH_720.mp4?source=fallback`
  - `https://v.redd.it/<id>/CMAF_1080.mp4?...`
  - `https://v.redd.it/<id>/HLSPlaylist.m3u8?...`
  - `https://v.redd.it/<id>/DASHPlaylist.mpd?...`
- Canonical URL: `https://v.redd.it/<id>`.
- Canonical HLS URL: `https://v.redd.it/<id>/HLSPlaylist.m3u8`.
- Dedup key for an item should be the URL the frontend will ask `localUrl()` about first: usually `metadata.media_url`. Store a parallel canonical ID in metadata details for reporting/dedup clarity.

Downloader shape:

- Introduce an injectable downloader function for tests, separate from `default_fetch`:
  - Input: item/candidate metadata, temp output directory, max bytes, timeout.
  - Output success: path to a muxed media file plus MIME/details.
  - Output failure: reason string, no DB mutation.
- Real downloader uses `shutil.which("yt-dlp")` inside the video code path and `subprocess.run(...)` with bounded timeout.
- Download into a temp directory/file, then hand the finished file to `media_store`.
- Avoid reading large videos fully into memory. Add/plan a `media_store.store_path(path, mime, url)` helper that hashes/copies in chunks and atomically places `<sha256>.mp4`.

Suggested `yt-dlp` intent, not exact final command:

```text
yt-dlp \
  --no-playlist \
  --format "bv*+ba/b" \
  --merge-output-format mp4 \
  --paths <temp-dir> \
  --output "%(id)s.%(ext)s" \
  --print after_move:filepath \
  <best input URL>
```

Implementation should capture stderr and classify common failures (`missing_downloader`, `missing_ffmpeg_or_mux_failed`, `timeout`, `extractor_error`, `too_large`, `disk_error`) without raising out of the whole run.

## Metadata / storage design

Storage target:

- Store one muxed MP4 blob per successfully archived Reddit video under `data/media/<sha256>.mp4`.
- Continue serving through the existing same-origin `/media/<blob>` route.
- Preserve content-addressed dedup: identical final bytes across reposts share the same blob.
- For large files, use a streaming path-based store helper rather than `store(data: bytes)`.

Backward-compatible metadata:

```json
{
  "media_type": "reddit_video",
  "media_url": "https://v.redd.it/abc123/DASH_720.mp4?source=fallback",
  "archived_media": {
    "https://v.redd.it/abc123/DASH_720.mp4?source=fallback": "<sha>.mp4",
    "https://v.redd.it/abc123": "<sha>.mp4"
  },
  "archived_media_details": {
    "https://v.redd.it/abc123": {
      "kind": "reddit_video",
      "blob": "<sha>.mp4",
      "canonical_url": "https://v.redd.it/abc123",
      "source_url": "https://www.reddit.com/r/.../comments/.../.../",
      "downloader": "yt-dlp",
      "container": "mp4",
      "has_audio": true,
      "bytes": 12345678,
      "fetched_utc": 1782690000
    }
  }
}
```

Important compatibility rules:

- Keep `metadata.archived_media` as `dict[str, str]`. Do **not** put nested objects in it unless `static/core/media.js localUrl()` is updated first; current code concatenates values into `/media/<blob>`.
- Store the muxed blob under both the exact `metadata.media_url` key and the canonical bare `https://v.redd.it/<id>` key when they differ. This lets current/future `localUrl(item, src)` calls find the local blob whether the frontend starts from the fallback URL or bare ID.
- Put rich metadata in a separate `metadata.archived_media_details` object keyed by canonical URL (or blob ID). This avoids breaking existing image/gallery archive semantics.
- If archiving the poster, keep using the same `archived_media` map: `{thumbnail_url: poster_blob}` and optionally details kind `poster`. This allows existing `thumb()` + `localUrl()` behavior to work.
- Only stamp metadata after the blob is fully written and `media_store.path_for(blob)` can find it.
- Never update `status`, `processed_utc`, `status_prev`, `is_saved`, `first_seen_utc`, or `last_seen_utc` for media archive writes.

Potential metadata extraction improvement:

- Extend `archival/providers.py::_norm_post` to preserve a compact `metadata.reddit_video` subobject from Reddit archive records:

```json
{
  "fallback_url": "...",
  "dash_url": "...",
  "hls_url": "...",
  "has_audio": true,
  "is_gif": false,
  "duration": 94,
  "height": 1080,
  "width": 1920,
  "transcoding_status": "completed"
}
```

This is not required for `yt-dlp`-based archiving, but it improves reporting and future fallback logic. Keep literal Reddit field names where preserved inside the subobject to avoid schema drift.

## Implementation plan

Size estimate: medium-large, roughly 1-2 focused days including tests. The risky part is not candidate SQL; it is downloader failure handling, temp-file cleanup, and preserving audio.

One concrete next action for implementation: add offline unit tests for URL normalization and video-candidate selection before touching downloader code.

1. **Add pure URL/candidate helpers**
   - `is_vreddit_url(url)` / `reddit_video_id(url)` / `canonical_vreddit_url(url)`.
   - Candidate selector for `source='reddit'` rows where metadata or URL evidence contains `v.redd.it` or `media_type='reddit_video'` with a v.redd.it `media_url`.
   - Exclude rows where the selected key is already in `archived_media` and the blob exists.
   - Treat missing blob as stale metadata and eligible for re-archive/report.

2. **Add the explicit archive scope**
   - Extend `SCOPES` with `videos`.
   - Add CLI flag `archive-media --videos`.
   - Keep existing default scopes unchanged.
   - Dry-run should count `items`, `urls`/`videos`, `already_archived`, estimated unknowns, and missing prerequisites if cheaply detectable, but should not call `yt-dlp`.

3. **Add streaming blob storage**
   - Add `media_store.store_path(path, mime='video/mp4', url='') -> blob_id`.
   - Hash in chunks and atomically place into `data/media`.
   - Keep `store(data, ...)` unchanged for existing image tests/callers.

4. **Add injectable video downloader**
   - Define a downloader callable used only by the `videos` scope.
   - Real implementation checks `yt-dlp` lazily with `shutil.which` and shells out with timeout.
   - Test implementation returns tiny fixture `.mp4` files from `tmp_path`.
   - Clean temp files/directories on success and failure.

5. **Stamp metadata after success only**
   - Load current metadata, merge `archived_media` string mappings, merge `archived_media_details`, then `json_set`/`json_patch` similar to current `media_archive.py`.
   - Commit per item.
   - Never stamp failed downloads as archived.

6. **Preserve frontend playability**
   - Verify `playableVideoSrc()` + `localUrl()` behavior with archived muxed MP4.
   - If archive preference is on, local muxed MP4 should be used. Since it has audio, this is desirable and avoids hls.js/network entirely.
   - If only a silent fallback were ever archived under an explicit future flag, metadata details must mark `has_audio=false`, and UI should label it. Do not silently regress from remote HLS-with-audio to local silent-video.

7. **Optional poster companion**
   - Archive `metadata.thumbnail` for video candidates when present and not already archived.
   - This can reuse `default_fetch` with image byte caps.
   - Do not make poster failure fail the video archive.

8. **Docs/backlog updates later**
   - Not part of this planning-only task, but implementation should update README CLI docs/backlog after code lands.
   - Call out that `data/media/` backups now include potentially large videos.

## Tests and validation

All tests should be offline/deterministic. No real `yt-dlp`, Reddit, CDN, HLS, or archive.today calls.

Unit tests to add or extend:

1. **URL normalization**
   - Bare URL -> `abc123`.
   - `DASH_720.mp4?source=fallback` -> same ID.
   - `CMAF_1080.mp4?...` -> same ID.
   - `HLSPlaylist.m3u8` and `DASHPlaylist.mpd` -> same ID.
   - Non-v.redd.it URLs return no ID.

2. **Candidate selection**
   - `media_type='reddit_video'` + fallback `media_url` is selected.
   - `media_type='reddit_media'` + `media_url` containing `v.redd.it` is selected.
   - Bare `media_url=https://v.redd.it/<id>` is selected.
   - Text Reddit permalink with no v.redd.it metadata is not selected.
   - Existing `archived_media[media_url]` with present blob skips.
   - Existing metadata with missing blob is reported as stale/eligible.

3. **Archive success path**
   - Fake downloader writes a tiny `.mp4` fixture.
   - `archive(conn, scopes=['videos'], apply=False, downloader=fake)` counts only; fake not called.
   - Apply stores via `media_store`, stamps `archived_media` string keys, stamps details, and commits.
   - Second apply run skips and does not call downloader again.

4. **Failure handling**
   - Missing downloader returns `failed=...`, reason `missing_downloader`, no metadata write.
   - Downloader timeout/error returns failure, no metadata write.
   - Too-large output is deleted and not stamped.
   - Disk/store failure does not leave a partial `.tmp` or metadata entry.

5. **Path-based media_store**
   - `store_path` dedups identical files.
   - Extension comes from MIME or source URL.
   - Large-ish fixture hashes in chunks; no need for a huge file.
   - `path_for(blob)` finds the stored file and rejects traversal.

6. **Provider metadata extraction, if added**
   - `_norm_post` preserves `reddit_video.{fallback_url,dash_url,hls_url,has_audio,is_gif,duration,width,height}`.
   - `service._overlay_fields` merges the subobject without clobbering existing triage state.
   - Existing tests that assert `media_url == fallback_url` keep passing.

7. **Frontend compatibility smoke, preferably pure JS**
   - Given an item whose `archived_media[metadata.media_url] = '<sha>.mp4'`, `playableVideoSrc(item)` returns `/media/<sha>.mp4` when archive preference is on.
   - Given no archive mapping, v.redd.it still derives remote HLS path as today.
   - Ensure `archived_media_details` does not affect `localUrl()`.

Validation commands for implementation:

```text
python -m pytest tests/test_media_archive.py tests/test_media_store.py tests/test_archival.py
python -m pytest
```

If frontend helper tests are added:

```text
node --check src/content_hoarder/static/core/media.js
```

Manual/live validation should be separate from unit validation and run only on a copy of `data/app.db` first. The planning task explicitly did not run it.

## Risks / open questions

- **Storage volume:** videos can dwarf the current 18 GB image archive. Add `--limit`, `--max-video-bytes`, and possibly `--max-total-bytes` before any broad run.
- **Audio correctness:** fallback MP4 is often video-only. The default success path should be muxed audio+video. Do not mark a silent fallback as a normal successful archive.
- **`ffmpeg` dependency:** `yt-dlp` can download, but muxing generally requires `ffmpeg`. Decide whether to document `ffmpeg` as required for `--videos` or allow explicit silent/video-only fallback.
- **Downloader trust/scope:** `yt-dlp` is optional and external. It should be invoked only for explicit `--videos --apply`, with bounded timeout and captured output.
- **Dry-run estimates:** candidate counts are cheap; accurate size estimates require network/extractor calls. Keep default dry-run network-free and add any future size probe as an explicit opt-in.
- **Manifest bundle alternative:** storing HLS/DASH playlists + segments would preserve adaptive playback, but requires URL rewriting and many blobs per item. A muxed MP4 is simpler for same-origin serving and offline use.
- **Frontend local preference:** existing `localUrl()` can turn a remote v.redd.it source into a local MP4 when archive preference is enabled. This is good only if the local MP4 has audio. Metadata should track `has_audio` for future UI honesty.
- **Already-deleted videos:** if the remote video is already gone and `yt-dlp` cannot extract/download it, this path cannot recover bytes. archive.today is currently image-oriented and should not be assumed to recover video.
- **Rate limiting/politeness:** videos should use a larger throttle than images, probably default 1-2 seconds per item, plus `yt-dlp` retries configured conservatively.
- **Backups:** `data/media/` is gitignored and the only copy of archived bytes. Video rollout must include a backup reminder before broad apply runs.

## Suggested delegation slices

1. **Slice A — URL/candidate design + tests**
   - Size: small.
   - First action: write tests for `reddit_video_id()` using bare, DASH, CMAF, HLS, and non-v.redd.it URLs.
   - Done when: candidate dry-run counts synthetic video rows and skips already-archived rows without network/downloader calls.

2. **Slice B — `media_store.store_path`**
   - Size: small-medium.
   - First action: add a test that stores a temp `.mp4` fixture and verifies `path_for()` + dedup.
   - Done when: existing image archive tests still pass and path-based video storage never reads the whole file into memory.

3. **Slice C — video archive scope with fake downloader**
   - Size: medium.
   - First action: add a fake downloader fixture to `tests/test_media_archive.py` and drive `archive(... scopes=['videos'])` red-first.
   - Done when: dry-run/apply/idempotency/failure tests pass without real `yt-dlp`.

4. **Slice D — real `yt-dlp` integration**
   - Size: medium-risk.
   - First action: implement the real downloader behind the injected interface and unit-test missing-binary behavior by monkeypatching `shutil.which`.
   - Done when: missing `yt-dlp`, timeout, nonzero exit, and successful fake subprocess output are classified cleanly.

5. **Slice E — frontend compatibility check**
   - Size: small.
   - First action: add a pure JS or minimal browser test around `localUrl()` / `playableVideoSrc()` with archived video metadata.
   - Done when: archived muxed MP4 resolves to `/media/<blob>` and unarchived v.redd.it keeps the existing remote HLS behavior.

6. **Slice F — guarded live rehearsal later**
   - Size: manual/operational, not for this planning task.
   - First action: copy `data/app.db`, run a dry-run candidate count, then apply `--limit 1` only after confirming `yt-dlp` and `ffmpeg` are available.
   - Done when: one known video archives into `data/media`, plays locally with audio, and the original DB remains untouched during rehearsal.
