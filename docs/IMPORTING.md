# Importing your real data

All imports are idempotent — re-running never duplicates or clobbers your triage state.

```bash
# from F:\content-hoarder, with the venv active:
python -m content_hoarder import <path>            # auto-detects the source
python -m content_hoarder import <path> --source X # or force a connector
```

---

## Reddit  ✅ done
Imported from a copy of `F:\reddit-saved-manager\data\app.db` — **64,615 items**.
To re-sync later (after the Reddit tool pulls new saves):
```bash
python -m content_hoarder import "F:\reddit-saved-manager\data\app.db"
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

## Hacker News (Materialistic app)

The app keeps saved stories in a `favorite` table inside `Materialistic.db`. On a **non-rooted**
phone you can't `adb pull` app-private storage — use **`adb backup`** instead.

**1. Install adb (Android platform-tools) on Windows:**
- Download "SDK Platform-Tools for Windows" from
  <https://developer.android.com/tools/releases/platform-tools>, unzip to e.g. `C:\platform-tools`.

**2. Confirm the phone is connected** (USB debugging on — you've done this):
```bash
cd C:\platform-tools
adb devices            # approve the "Allow USB debugging?" prompt on the phone
```

**3. Back up just Materialistic** (leave the on-phone backup password blank, then tap "Back up my data"):
```bash
adb backup -f materialistic.ab -noapk io.github.hidroh.materialistic
```

**4. Extract the `.ab`** (it's a 24-byte header + gzipped tar). In **Git Bash**:
```bash
( printf "\x1f\x8b\x08\x00\x00\x00\x00\x00" ; tail -c +25 materialistic.ab ) | tar xfvz -
# → creates apps/io.github.hidroh.materialistic/db/Materialistic.db
```

**5. Import + enrich** (enrich fills score/author from HN's free API):
```bash
python -m content_hoarder import "apps/io.github.hidroh.materialistic/db/Materialistic.db" --source hackernews
python -m content_hoarder enrich --source hackernews
```

> **Caveat:** `adb backup` is deprecated and **Android 12+ may produce an empty backup** if the OS
> or the app's `allowBackup` flag blocks it. If `materialistic.ab` is tiny/empty:
> fallbacks are (a) if you also *favorited* stories on the HN website, save
> `https://news.ycombinator.com/favorites?id=YOURNAME` as HTML and import that, or (b) export a
> plain list of HN item ids and import the `.txt`/`.json`. Tell me which and I'll wire it up.

---

## Google Keep  ⏳ (deferred — do later)
When ready: <https://takeout.google.com> → deselect all → select **Keep** → export → unzip, then:
```bash
python -m content_hoarder import "path\to\Takeout\Keep"
```
Repeat per account. (The unofficial `gkeepapi` is intentionally not used.)
