# Spec 11 — Video-archive smoke procedure (no live run)

**Status: PROPOSED 2026-07-03.** Plan-only per DIRECTION §5 P1.3 (T2). The
first live `archive-media --videos` run is **user-gated** (DIRECTION §7);
this document is the procedure. Execution needs the user at the keyboard.

**Context:** `archive-media --videos` opts into downloading `v.redd.it`
video bytes via `yt-dlp` (lazy-imported) + `ffmpeg` mux to `.mp4`, stored as
content-addressed blobs (up to `DEFAULT_MAX_VIDEO_BYTES = 512 MB` each). The
path exists and is unit-tested offline with an injected fake downloader, but
it has never run against real Reddit media on this machine. Smoke first.

## Pre-flight (all must pass before any DB copy)

1. **Tool presence** — both must resolve via `shutil.which`:
   ```bash
   yt-dlp --version
   ffmpeg -version | head -1
   ```
   If either is missing: stop, install, re-check. `media_archive.default_video_downloader`
   already returns `missing_ffmpeg_or_mux_failed` on absence — confirm the
   error string appears in the dry-run, not just a generic failure.

2. **Auth/cookie posture** — Reddit video often needs auth. Confirm either:
   - `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` + OAuth token present
     (preferred; `reddit_oauth.py`), OR
   - `cookies.txt` path configured.
   Without one, expect `extractor_error` on most candidates — not a bug,
   that's Reddit gating.

3. **Drive headroom** — `data/media/` is ~18 GB images today; videos will
   add GBs. Confirm ≥ 20 GB free on the data drive.

4. **A representative candidate picked** — one item where:
   - `metadata.reddit_video.fallback_url` or `hls_url` is set (a real
     `v.redd.it` id, not blank), and
   - `metadata.archived_media` does NOT yet have a video entry (genuinely
     un-archived), and
   - The post is recent enough that Reddit still serves it (older deletes
     404 — that's fine, but pick one that WON'T 404 for the smoke).
   Find one:
   ```bash
   python -c "from content_hoarder import db, media_archive; c=db.connect('data/app.db');
   [print(r['fullname'], r['url']) for r in c.execute(
     \"SELECT fullname, url, metadata FROM items WHERE metadata LIKE '%v.redd.it%' LIMIT 5\")]"
   ```

## DB copy (mandatory — never run on `data/app.db` directly)

The `--videos` flag is additive (writes blobs + updates metadata), but a
botched run that half-writes is annoying to undo on the live DB. Copy first:

```bash
# from project root
python -c "import shutil, time; shutil.copy2('data/app.db', f'data/app.videosmoke-{time.strftime(\"%Y%m%d-%H%M%S\")}.db')"
DBCOPY=data/app.videosmoke-<timestamp>.db
```

Run the smoke against `$DBCOPY` via `CONTENT_HOARDER_DB`:

```bash
CONTENT_HOARDER_DB=$DBCOPY python -m content_hoarder archive-media --videos --limit 1 --apply --yes
```

`--limit 1` is the smoke guard: at most one item. `--apply --yes` is the
explicit gate (no dry-run). The shared `media_store` writes to
`data/media/` (NOT a copy) — that's correct: blobs are content-addressed and
dedup, so a smoke blob in the real store is harmless and reused on the real
run.

## Expected artifacts on success

- One new blob under `data/media/<sha256>.mp4`.
- The copied DB's row for that item has
  `metadata.archived_media["<original_v.redd.it_url>"] == "<sha256>.mp4"`.
- `metadata.media_status` unchanged (videos don't flip `gone`/`recovered`).
- The command prints a one-line summary: `videos: 1 archived, 0 skipped, N bytes`.
- Exit code 0.

Verify each explicitly:
```bash
python -c "
from content_hoarder import db
import json
c = db.connect('$DBCOPY')
r = c.execute('SELECT metadata FROM items WHERE fullname=?', ('<fn>',)).fetchone()
md = json.loads(r['metadata'])
print('archived_media:', md.get('archived_media'))
print('media_status:', md.get('media_status'))
"
ls -la data/media/<sha256>.mp4   # confirm size is sane (not 0, not > 512 MB)
```

## Abort criteria (any of these → stop, do not escalate to a larger run)

- `extractor_error` on the picked candidate that ISN'T a 404 (i.e., yt-dlp
  found the URL but couldn't extract) → likely yt-dlp version skew; upgrade
  yt-dlp (`pip install -U yt-dlp`) before retrying.
- `missing_ffmpeg_or_mux_failed` → ffmpeg not on PATH for the subprocess
  (Windows: check it's on the SYSTEM PATH, not just user PATH).
- `timeout` at the default 15 min → network too slow OR Reddit throttling;
  retry once, then stop and lower `--video-timeout` expectation.
- `too_large` (> 512 MB) — expected for some; not an abort on its own, but
  if EVERY candidate is too_large the cap needs revisiting (user decision).
- **Any DB write outside the expected row** → check `git diff` is empty
  post-run and the live `data/app.db` mtime is unchanged (you ran against
  the copy, so this should hold by construction).

## What "smoke passed" unlocks

Once one item round-trips cleanly, the same command WITHOUT `--limit 1`
against the live `data/app.db` is the real run. Still user-gated (§7) — do
not auto-escalate. The smoke proves the path; the full run is a separate,
deliberate decision.

## Open user decisions

1. Pick the representative item (the `LIMIT 5` query above is the menu).
2. Confirm OAuth OR cookie posture is the one to use.
3. Time window — the run is network-bound; pick a window where the LAN/host
   isn't doing other heavy work.

## Next concrete action (literal first step)

```bash
yt-dlp --version && ffmpeg -version | head -1
```
Both must succeed. Stop and install if either fails.
