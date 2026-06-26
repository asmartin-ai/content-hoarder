# Importing your real data

All imports are idempotent — re-running never duplicates or clobbers your triage state.

```bash
# from /path/to/content-hoarder, with the venv active:
python -m content_hoarder import <path>            # auto-detects the source
python -m content_hoarder import <path> --source X # or force a connector
```

---

## Reddit  ✅ done
Imported from a copy of `/path/to/reddit-saved-manager/data/app.db` — **64,615 items**.
To re-sync later (after the Reddit tool pulls new saves):
```bash
python -m content_hoarder import "/path/to/reddit-saved-manager/data/app.db"
```

### Recovering removed / un-hydrated Reddit content
Saved posts/comments that are now `[removed]`/`[deleted]`, plus saved **comments whose body was
never captured**, can be refilled from public web archives (PullPush.io → Arctic-Shift fallback).
It's **non-destructive** (triage state is never touched) and **resumable** (every attempt is stamped,
so re-runs continue where they left off).
```bash
python -m content_hoarder enrich --source reddit --archives             # recover everything eligible
python -m content_hoarder enrich --source reddit --archives --limit 200 # one chunk at a time
python -m content_hoarder enrich --source reddit --archives --all       # re-attempt already-tried items
```
It first prints how many items are eligible (your data: ~9.5k, mostly un-hydrated comment bodies).
Bulk runs are throttled to be polite to the archives (~4 s between PullPush requests), so a full pass
takes a while — use `--limit` to do it in sessions. Network-only; offline just no-ops gracefully.

---

## YouTube playlists (WL2 / WL3)

**You need the *playlist* URL, not a video URL.** The link you sent
(`https://youtu.be/7aWL2iEb6y4`) is a single video ("Why Crows Are as Smart as 7 Year Old
Humans"). A playlist URL contains `list=PL…`.

**Get the playlist URL:** open YouTube on desktop → left sidebar → click the **WL2** playlist →
copy the address bar URL. It looks like `https://www.youtube.com/playlist?list=PLxxxxxxxx`.
(Your main **"Watch Later" can't be exported** — Google removed API access — but WL2/WL3 are
regular playlists, so they work.)

**Then dump + import** (yt-dlp is already installed in the venv):
```bash
python -m yt_dlp --flat-playlist --dump-single-json "https://www.youtube.com/playlist?list=PLxxxx" > wl2.json
python -m content_hoarder import wl2.json
```
- If the playlist is **Private**, either set it to **Unlisted** temporarily, or add
  `--cookies-from-browser firefox` to the yt-dlp command.
- Repeat for WL3. Send me the `list=PL…` URLs and I can run this for you.

---

## Hacker News

> **Migrated 2026-06-22: Materialistic → [Harmonic](https://github.com/SimonHalvdansson/Harmonic-HN).**
> Materialistic (abandoned ~2022) keeps saves **local-only** — they never reach your HN account, so
> syncing them needs the phone + a cable + a per-device `adb backup`. Harmonic (actively maintained)
> **favorites stories to your HN account server-side**, which makes HN saves **remotely pullable like
> Reddit's** — no phone, no cable. All prior Materialistic saves are **already imported** (7,367 items,
> 2026-06-22), so nothing was lost in the switch.

### Current path — Harmonic → HN-account favorites
1. In **Harmonic** (logged into your HN account), **favorite** the stories you want to keep. They land
   on your account at `https://news.ycombinator.com/favorites?id=<YOURNAME>` (public, keyless).
2. **One-time confirm** Harmonic favorites server-side: favorite one story, then open that favorites URL
   in a browser — it should appear there. (HN's API is read-only; favoriting works by driving the HN
   website, same as voting — so it must be confirmed once.)
3. **Import** (manual, until the auto-scraper lands — see BACKLOG Epic 7 P2): save the favorites page as
   HTML and import it — the HN connector already parses `item?id=`/`athing` out of HN HTML (and bare-id
   `.txt`/`.json` lists):
   ```bash
   python -m content_hoarder import "path/to/favorites.html" --source hackernews
   python -m content_hoarder enrich --source hackernews   # fills score/author/og:image from HN's free API
   ```
   The planned **favorites-page scraper** (`favorites?id=<user>`, paginated `&p=N`) turns this into a
   keyless, server-side, scheduled sync — the HN analogue of the Reddit auto-sync.

### Legacy — Materialistic app DB (reference only; being retired)
Older saves came from the Materialistic Android app's local DB via `adb backup` (a non-rooted phone
can't `adb pull` app-private storage). Keep this only for other-device / historical data. The saved
table is **`saved`** (newer Room builds, e.g. v3.3) or `favorite` (older); a `read` history table also
imports (as `hn_list=read`, archived). Clear the phone's saved list with the app's own ⋮ → **Clear all**
(no ADB write-back is possible on a non-rooted phone).
```bash
adb backup -f materialistic.ab -noapk io.github.hidroh.materialistic   # tap "Back up my data", blank password
( printf "\x1f\x8b\x08\x00\x00\x00\x00\x00" ; tail -c +25 materialistic.ab ) | tar xfz -
python -m content_hoarder import "apps/io.github.hidroh.materialistic/db/Materialistic.db" --source hackernews
```
> `adb backup` is deprecated but **still worked on Android 16** (2026-06-22) when `allowBackup` is set —
> the old "Android 12+ may be empty" warning didn't bite. On Windows/**Git Bash**, prefix any adb command
> with a `/sdcard/...` device path with `MSYS_NO_PATHCONV=1`, or the path gets mangled to a Windows path.

---

## Firefox tabs (Export Tabs URLs)  ✅ done
Install the **"Export Tabs URLs"** add-on, export in **Rich format** to a `.txt`, then:
```bash
python -m content_hoarder import "path\to\tabs.txt"
```
Each tab → a `firefox:<url-hash>` item (de-duped across overlapping daily exports).

**YouTube tabs are promoted automatically.** A tab whose URL is a YouTube video (`watch?v=` /
`youtu.be` / `/shorts/`) becomes a real `youtube:<vid>` item instead — cleaned title, thumbnail, and an
`open_in_firefox` marker — so it merges with anything already in Watch Later and is enrichable. Browse
the batch with the **"📑 Firefox tabs"** filter on the home page.

To migrate tabs imported *before* this behavior existed (one-time reconciliation):
```bash
# dry run first — and always against a COPY of the DB
python -m content_hoarder migrate-firefox-tabs
python -m content_hoarder migrate-firefox-tabs --apply
```
This re-keys YouTube `firefox:` rows to `youtube:<vid>` (collapsing any Watch-Later duplicates) and
removes the superseded tab rows. Afterwards run `enrich --source youtube` to fill real
titles/durations. (OneTab / `recovery.jsonlz4` remain future inputs.)

---

## Twitter / X bookmarks

Use a browser-side bookmark exporter that writes JSON or CSV, then import the file:
```bash
python -m content_hoarder import "path\to\x-bookmarks.json" --source twitter
```

The connector stores each tweet as `twitter:<tweet_id>` with tweet text, author handle/display
name, canonical permalink, creation time when present, and media URLs (`pbs.twimg.com` images are
normalized to `?name=orig`). It does not call the X API and it does not invent a bookmark timestamp;
exports that include only ordering get `metadata.bookmark_index` instead.

When present, quote/reply context is retained in `metadata.quote_tweet`,
`metadata.conversation_id`, `metadata.in_reply_to_status_id`, and
`metadata.in_reply_to_screen_name`. Video exports keep the highest-bitrate MP4 URL plus the poster
thumbnail when X includes one.

Outbound links are stored in `metadata.outlinks`. Tweets that link to YouTube videos can be folded
into canonical `youtube:<id>` rows with the shared migration:
```bash
python -m content_hoarder consolidate --apply
```

To cache imported tweet images and videos locally for offline/survivable viewing:
```bash
python -m content_hoarder archive-media --twitter --apply
```

---

## Google Keep  ⏳ (deferred — do later)
When ready: <https://takeout.google.com> → deselect all → select **Keep** → export → unzip, then:
```bash
python -m content_hoarder import "path\to\Takeout\Keep"
```
Repeat per account. (The unofficial `gkeepapi` is intentionally not used.)
