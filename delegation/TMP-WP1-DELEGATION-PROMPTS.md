# TMP-WP1 — Delegation prompts (agent with live data + DB access)

Agent profile: can query the live database at `K:\Projects\content-hoarder\data\app.db`, hit live websites/APIs, and run dry-run passes against the real corpus. **Cannot** edit repo code. These are research/verification/data-gathering prompts — each is self-contained and copy-pasteable into a fresh agent session.

## Project context every prompt assumes

- DB path: `K:\Projects\content-hoarder\data\app.db` (SQLite, WAL). **Always back up before any write**: `copy data\app.db data\app.backup-<YYYYMMDD-HHMM>.db`.
- Schema: one generic `items` table. PK `fullname = "<source>:<source_id>"`. Columns: `source, source_id, kind, title, body, url, author, created_utc, saved_utc, is_saved, first_seen_utc, last_seen_utc, hydrated_at, status, processed_utc, status_prev, search_text, metadata (JSON), raw_json`. Side tables: `settings`, `reddit_threads`, `reddit_unsave` (queue), `media_blobs`.
- **GOTCHA (critical):** when reading `items.metadata`, `SELECT` the FULL column and `json.loads()` it in Python — never `substr(metadata,1,N)`. JSON keys sort alphabetically, so truncation hides late keys (`gallery`, `media_type`, `media_url` sit after `author`/`body`) and makes a populated row look empty.
- Triage state: `status ∈ {inbox, keep, archived, done}`; `processed_utc` set on leaving inbox; `status_prev` enables one-step undo.
- `merge_upsert` is non-destructive (overlay non-empty incoming fields only; never overwrite user/triage state).
- Rate-limit floor: `_http.MIN_THROTTLE = 0.6s` on Reddit hydrate/drain/sync; OAuth has ~4× headroom under Reddit's 100 QPM budget.
- The recovery chain: PullPush/Arctic-Shift are reddit-id-keyed + JSON + metadata-only; `archive.today` is URL-keyed + HTML + media-bytes, post-chain, runs only when `media_status='gone'`.

Run `python` queries with `python -u -c "..."` or a scratch `.py` (Windows: avoid embedded `"` in PowerShell — write the script to a file). Use the project venv at `K:\Projects\content-hoarder\.venv` if importing project modules.

---

## Prompt 1 — filmot.com YouTube deleted-title recovery (Epic 3)

**OBJECTIVE:** Validate filmot.com as a second recovery provider for `[Private video]` / `[Deleted video]` YouTube items, alongside the shipped Wayback path (`youtube_recover.py`, 1/3 live hit-rate).

**BACKGROUND:** `youtube_recover.py` already has an injectable HTTP fetcher. filmot.com is noted in the backlog as a future provider "needs an API key." Today the Wayback path recovers once-public *deleted* titles but nil for *private* videos.

**WHAT TO DO:**
1. Read filmot.com's API terms (free tier? rate limits? key acquisition?). Refs: filmot.com, github.com/phloof/youtube-recovery-tool.
2. Count the affected items:
   ```sql
   SELECT count(*) FROM items
   WHERE source='youtube'
     AND (title LIKE '[Private video]%' OR title LIKE '[Deleted video]%');
   ```
3. Sample 30 `source_id` values (these are YouTube video ids) from that set. If you have an API key (ask the user), hit filmot's lookup endpoint for each; otherwise document the exact request shape + auth for a future keyed run.
4. Report the hit-rate on the sample and which kind (deleted vs private) it recovers.

**REPORT BACK:** API key requirement + cost/terms, sample hit-rate (deleted vs private), a go/no-go recommendation, and the exact HTTP request shape so WP2 can build the provider.

**CONSTRAINTS:** Read-only against the DB. Respect filmot rate limits. Non-destructive.

---

## Prompt 2 — RepostSleuth reverse-image-hash recovery spike (Epic 4 P3)

**OBJECTIVE:** Spike whether RepostSleuth's undocumented API can recover already-deleted reddit images by finding still-live reposts. **Spike first** — the API is undocumented and may have broken with Reddit's API changes.

**BACKGROUND:** For `gone` image items (the original `i.redd.it` is 404), a still-live repost of the same image elsewhere on Reddit can be found via perceptual-hash lookup against RepostSleuth's index. High upside for memes/popular images; nil for one-off personal uploads.

**WHAT TO DO:**
1. Inventory the target set:
   ```sql
   SELECT fullname, source_id, url,
          json_extract(metadata,'$.media_url') AS media_url,
          json_extract(metadata,'$.media_status') AS ms
   FROM items
   WHERE source='reddit'
     AND json_extract(metadata,'$.media_status')='gone'
   LIMIT 50;
   ```
   (Get the full count too.)
2. Reverse-engineer the RepostSleuth API (`repostsleuth.com`). The bot u/repostsleuthbot is the public face; check github.com/barrycarey/RedditRepostSleuth. Find the endpoint that accepts a reddit submission id or url and returns duplicate posts.
3. For 20 `gone` items, query by the original Reddit submission id (the `source_id` base36) / url. Record whether the API responds at all, and whether it returns a live duplicate post with a still-loadable image.

**REPORT BACK:** Does the API still work post-Reddit-API-changes? Hit-rate on the 20-item sample. A go/no-go recommendation. Note: hashing is JPEG-compression-sensitive — report precision caveats.

**CONSTRAINTS:** Read-only. Read the `metadata` column in full (gotcha above). This is a spike — do NOT build a provider.

---

## Prompt 3 — RedGifs resolver validation for dead Gfycat links (Epic 4 P2)

**OBJECTIVE:** Validate the RedGifs v2 API + temp-token auth flow so WP2 can build the resolver. Confirm the lowercase→CamelCase id-mapping resolves real dead Gfycat links.

**BACKGROUND:** Gfycat shut down 2023-09-01 (all bytes deleted). ~1,090 `gfycat.com` `media_url` items are dead. Gfycat's NSFW content migrated to RedGifs under the same id (`lazyfatcat` → `LazyFatCat`). RedGifs has a v2 API + temporary-token auth. SFW Gfycat is mostly gone (Wayback only). Refs: redgifs.readthedocs.io/en/stable/migrating.html.

**WHAT TO DO:**
1. Inventory:
   ```sql
   SELECT fullname, source_id, url,
          json_extract(metadata,'$.media_url') AS media_url,
          json_extract(metadata,'$.media_type') AS mt
   FROM items
   WHERE source='reddit'
     AND (url LIKE '%gfycat.com%'
          OR COALESCE(json_extract(metadata,'$.media_url'),'') LIKE '%gfycat.com%')
   LIMIT 50;
   ```
2. Read the RedGifs v2 API docs (the temp-token flow: `GET /temporary/tokens`, then `GET /v2/gifs/<id>`).
3. Extract the Gfycat id from 20 dead URLs. Resolve each on RedGifs with the CamelCase transform. Record which resolve to a live gif with a playable media URL.

**REPORT BACK:** Token flow works end-to-end? Id-mapping accuracy (how many resolve). The NSFW-domain gating requirement (RedGifs is NSFW — gate behind the same opt-in as `nsfw_*` tooling). Exact API request shapes so WP2 builds the resolver.

**CONSTRAINTS:** Read-only. RedGifs is an NSFW domain — confirm the gating model with the user before any UI wiring.

---

## Prompt 4 — `data/media/` backup strategy (Epic 4 P1)

**OBJECTIVE:** Design a real backup for the ONLY copy of the archived media. This is urgent — `data/media/` is gitignored, NOT in the metadata-only DB backups, and deletions are now unrecoverable if the disk fails.

**BACKGROUND:** Live run 2026-06-22: `data/media/` = 32,506 blobs / 18 GB, content-addressed (`<sha256>.<ext>`), 25,706 items now carry a local copy. Blobs are served same-origin via `/media/<blob>`. DB backups are metadata-only.

**WHAT TO DO:**
1. Measure the real numbers:
   - `dir data\media\` blob count + total size.
   - Largest blobs, size distribution (how many >5MB? >50MB?).
   - Growth rate proxy: items without `metadata.archived_media` still pending.
2. The blobs are content-addressed + dedup'd — ideal for incremental/rsync-style backup. Evaluate options against this machine: (a) `F:\Backups\content-hoarder\` (the existing backup root — is it on a separate physical disk?); (b) an external drive; (c) restic/borg content-defined chunking on top of already-dedup'd blobs (overkill?); (d) cloud (against the local-first rule).
3. Decide frequency (the backlog notes at-save-time archiving is coming — growth will accelerate).

**REPORT BACK:** Concrete recommendation: destination medium, tool (`robocopy /MIR`? `restic`? plain rsync-equivalent), frequency, a verification step (how to confirm a restore), and the exact one-command invocation. Note the disk topology you found (same physical disk = not a real backup).

**CONSTRAINTS:** Don't move or delete anything. This is a design + measurement task only.

---

## Prompt 5 — `v.redd.it` video archiving scope (Epic 4 P1, phase 4)

**OBJECTIVE:** Scope phase-4 video archiving before building. Decide the size cap and DASH-vs-HLS approach against real data.

**BACKGROUND:** 7,012 `v.redd.it` video items are not yet archived (the images pass is done; videos are phase 4, not started). Reddit video is DASH (separate audio+video renditions) — large. `archive-media` is resumable with `--limit`.

**WHAT TO DO:**
1. Inventory:
   ```sql
   SELECT count(*) FROM items
   WHERE source='reddit'
     AND COALESCE(json_extract(metadata,'$.media_type'),'')='reddit_video';
   -- and how many already have archived_media:
   SELECT count(*) FROM items
   WHERE source='reddit'
     AND json_extract(metadata,'$.media_type')='reddit_video'
     AND json_extract(metadata,'$.archived_media') IS NOT NULL;
   ```
2. Sample 10 `v.redd.it` items. For each, resolve the HLS manifest (`<media_url>/HLSPlaylist.m3u8`) and the DASH MPD if present. Measure: how many renditions, the largest rendition byte-size (HEAD request), total bytes if you fetched all.
3. Extrapolate: (sum of largest-rendition bytes across sample / sample size) × 7,012 = estimated total volume.
4. Read how `media_archive.py` + `media_store.py` currently work (the content-addressed blob store) and whether a video path fits.

**REPORT BACK:** Estimated total volume (GB) for the largest-rendition-only approach (recommended — full DASH multi-rendition is wasteful). A recommended size cap per video and a `--limit`/throttle plan. Whether HLS single-rendition download is feasible with stdlib urllib or needs ffmpeg/yt-dlp. Go/no-go.

**CONSTRAINTS:** Read-only except a few HEAD requests. Do NOT download 7,012 videos. Respect Reddit rate floors.

---

## Prompt 6 — At-save-time archiving hook design (Epic 4 P1, item c)

**OBJECTIVE:** Decide where to hook archiving for NEW saves so deletions are caught early (the whole point of the hoarder mission), instead of relying on a periodic batch CLI pass.

**BACKGROUND:** Today `archive-media` is a manual CLI enrich-style pass. The goal: archive new saves at sync time, before Reddit deletes them. Must respect the de-risking rate floors (`MIN_THROTTLE` 0.6s; jittered).

**WHAT TO DO:**
1. Read `reddit_sync.py` (the cookie incremental sync — `POST /reddit/sync`, `reddit-sync` CLI) and `reddit_oauth.py`. Identify the post-upsert point where a freshly-synced item exists in the DB with its `media_url`/`gallery`.
2. Read `media_archive.py` + `media_scan.py` to see the existing fetch+store path (`media_store` blob store).
3. Evaluate hook options: (a) inline in `reddit_sync` after upsert (couples archiving to sync rate); (b) a queue + drain mirroring `reddit_unsave` (decouples, throttle-safe); (c) a scheduler/cron on `archive-media --since-last-sync`.
4. Assess the rate budget: archiving a save = 1+ image fetch. Sync already throttles. Adding archiving inline doubles the per-save request count — does it stay under the rate floor with jitter?

**REPORT BACK:** Recommended hook point (a/b/c) with rationale. The throttling story vs. de-risking floors. Whether it should be opt-in (a settings flag) or always-on. A concrete integration sketch (which function, what signature).

**CONSTRAINTS:** Design only — no code changes. Mind: `merge_upsert` preserves state across re-imports; don't re-archive already-archived items (the `metadata.archived_media` check).

---

## Prompt 7 — HN favorites empirical verification (Harmonic) (Epic 7 P2)

**OBJECTIVE:** Confirm ONE assumption that the entire HN favorites auto-sync path depends on: does favoriting a story in Harmonic make it appear on the public `news.ycombinator.com/favorites?id=<user>` page (server-side)?

**BACKGROUND:** Materialistic's "save" was local-only (per-device `adb backup`). The user migrated to Harmonic. Harmonic's README groups "favorites" under account actions (vote/comment/submit/see-upvoted), implying server-side — but this is UNVERIFIED. HN's API is read-only, so favoriting is a website action. The whole `favorites?id=<user>` scraper plan is gated on this.

**WHAT TO DO:**
1. This needs a manual step: ask the user to (a) provide their HN username, and (b) favorite one specific story in Harmonic right now.
2. Immediately fetch `https://news.ycombinator.com/favorites?id=<username>` and check whether the just-favorited story appears. (Use stdlib urllib; the page is public HTML — the connector's existing `item?id=`/`athing` parsers already read this shape.)
3. If it appears → confirmed server-side. If not → re-check after a short delay (propagation?), then report not-confirmed.

**REPORT BACK:** Confirmed server-side (yes/no), the test story + timestamp, and whether the existing `connectors/hackernews.py` HTML parser can read the favorites page unchanged. If confirmed, this unblocks the `hn-sync` build (WP2 territory).

**CONSTRAINTS:** Read-only fetch of a public page. Needs the user's HN username + a live favorite action — coordinate with the user.

---

## Prompt 8 — Twitter/X media archiving integration (Epic 7 P2)

**OBJECTIVE:** Assess how to fold `pbs.twimg.com` / `video.twimg.com` media into the `archive-media` pass, since X media is as ephemeral as Reddit's (purged within days of a tweet's deletion).

**BACKGROUND:** The planned Twitter/X connector (Epic 7 P2, blocked on Q9) would ingest `twitter:<tweet_id>` items with media URLs. X media CDNs purge aggressively on deletion. The `archive-media` pass + `media_store` content-addressed blob store is source-agnostic.

**WHAT TO DO:**
1. Check whether ANY twitter items exist yet (the connector isn't built):
   ```sql
   SELECT count(*) FROM items WHERE source='twitter';
   ```
2. Read `media_archive.py` + `media_store.py` + the `/media/<hash>` route to confirm the archive path is host-agnostic (it should be — it fetches any URL and stores by sha256).
3. Assess X-specific gotchas: `?name=orig` for full-res images; `video.twimg.com` variants/renditions; rate-limiting/anon-access on `pbs.twimg.com` (does it need a cookie/referrer?); the multi-image tweet case.
4. Decide: does the archive pass need ANY twitter-specific code, or does it "just work" once the connector populates `metadata.media_url`/`media_type` in the right shape?

**REPORT BACK:** Whether the existing archive pass is twitter-ready as-is or needs a host-allowlist/cookie tweak. The exact media-URL shape the connector should populate. A note on `?name=orig` and video renditions.

**CONSTRAINTS:** Read-only. This is design/assessment — the connector itself is Q9-blocked (WP2).

---

## Prompt 9 — Reddit untagged-tail coverage inventory (Epic 9 P2)

**OBJECTIVE:** Inventory what's actually in the ~57% untagged reddit tail so `categorize.py` seed maps can be extended with real-data confidence.

**BACKGROUND:** `categorize.py` tags ~43% of reddit items into `metadata.tags` (keyless heuristics: subreddit map + title keywords). ~57% are untagged — much is gaming (no bucket by choice) + general subs (AskReddit, worldnews) + the long tail of ~2,900 subs. Extending seed maps should be corpus-confirmed, not guessed.

**WHAT TO DO:**
1. Inventory the untagged inbox tail by subreddit:
   ```sql
   SELECT json_extract(metadata,'$.subreddit') AS sub, count(*) AS c
   FROM items
   WHERE source='reddit'
     AND status='inbox'
     AND ( json_extract(metadata,'$.tags') IS NULL
           OR json_extract(metadata,'$.tags') = '[]' )
   GROUP BY sub ORDER BY c DESC LIMIT 60;
   ```
2. For the top ~30 untagged subs, sample a title or two each and propose which existing bucket (`memes`, `coding`, `science`, `defense`, `anime`, `tips`, `investing`, `gaming`, …) each maps to, or "no bucket (general)" if it's genuinely un-bucketable (AskReddit, worldnews).
3. Read `categorize.py`'s current subreddit map + title-keyword maps to see what's already covered.

**REPORT BACK:** A table: subreddit → volume → proposed bucket (or "general/no-bucket"). A recommended set of subreddit→tag additions for `categorize.py` (the high-volume, high-confidence ones). Flag any subs the user should decide on (e.g. borderline-NSFW, identity content).

**CONSTRAINTS:** Read-only. Don't propose tagging identity content (vtubers/anime/memes are already identity buckets; don't force-generalize them). Respect the Epic 21 design language (don't tag for guilt).

---

## Prompt 10 — `nsfw_erotic` bulk-unsave dry-run (Epic 9 P2)

**OBJECTIVE:** Dry-run the real counts and design the confirm surface BEFORE any live destructive unsave. The user wants to pull the `nsfw_erotic` set out of Reddit Saved (migrate to a separate account).

**BACKGROUND:** Export-by-tag is done (`GET /export` + `export --tag X`). The remaining half is bulk-unsave: enqueue every `nsfw_erotic` item into `reddit_unsave` queue (`db.enqueue_unsave`) and drain (cookie/OAuth path). Reversible until drained. `nsfw_talk` is a separate optional target. Reddit unsaves are real money-action (Epic 25 F6: writes are elevated risk).

**WHAT TO DO:**
1. Count the targets (tags live in `metadata.tags` array):
   ```sql
   SELECT
     sum(CASE WHEN EXISTS (SELECT 1 FROM json_each(json_extract(metadata,'$.tags')) WHERE value='nsfw_erotic') THEN 1 ELSE 0 END) AS erotic,
     sum(CASE WHEN EXISTS (SELECT 1 FROM json_each(json_extract(metadata,'$.tags')) WHERE value='nsfw_talk') THEN 1 ELSE 0 END) AS talk
   FROM items WHERE source='reddit';
   ```
2. Of the `nsfw_erotic` set, how many are still `is_saved=1` (actually in Reddit Saved) vs already unsaved?
3. Read `reddit_unsave.py` (the queue + drain) and the money-action safety shape (`--live --yes` gate, `unsave-audit.jsonl`).
4. Design the confirm surface: a count + per-subreddit breakdown + the explicit `--live --yes` gate. NEVER drain without it.

**REPORT BACK:** Real counts (`nsfw_erotic`, `nsfw_talk`, `is_saved` subset). The confirm-step design. A recommendation on whether `nsfw_talk` should be a separate drain. The exact dry-run command the user would run.

**CONSTRAINTS:** READ-ONLY. Do NOT enqueue or drain anything. Unsaving is a real, hard-to-reverse Reddit-side action — dry-run only, present to the user for explicit approval.

---

## Prompt 11 — Note standalone-vs-document threshold (Epic 11 P2)

**OBJECTIVE:** Find the byte/token threshold that cleanly separates "standalone YouTube link" notes (→ promote to `youtube:<id>`) from "documents with an embedded video" (→ note-with-video reader).

**BACKGROUND:** `note_youtube.py` + `migrate-note-youtube` shipped 2026-06-25. It extracts YouTube ids from Keep/Obsidian note bodies and promotes standalone links (no meaningful surrounding prose) to canonical `youtube:<id>` items. Multi-video notes are excluded (they go to the multi-video reader). The standalone-vs-document heuristic: after stripping the YouTube URL(s) + title, remaining body text below a threshold → standalone; else document. **The exact threshold is OPEN — pick after sampling real notes.**

**WHAT TO DO:**
1. Pull Keep/Obsidian notes that contain a YouTube link:
   ```sql
   SELECT source, source_id, title, length(body) AS blen, body
   FROM items
   WHERE source IN ('keep','obsidian')
     AND (body LIKE '%youtube.com/watch%' OR body LIKE '%youtu.be/%')
   LIMIT 40;
   ```
2. For each, compute the "residual" length: strip all YouTube URLs (all host forms) + the title, measure remaining non-whitespace characters.
3. Sort by residual length. Find the natural gap — the threshold below which notes are clearly "just a link" and above which they're "a document with a video in it."
4. Check single-video vs multi-video distribution (multi-video notes are excluded from promotion — they're the reader's domain).

**REPORT BACK:** The residual-length distribution (a small histogram or sorted list). The recommended threshold (in chars). Edge cases (notes with a link + 1 sentence of context — promote or document?). Confirm `note_youtube.py`'s current threshold and whether it matches.

**CONSTRAINTS:** Read-only. Don't run the migration. Report the threshold so WP2 can tune `note_youtube.py`.

---

## Prompt 12 — Video/gallery repro verification (Epic 13 P2)

**OBJECTIVE:** Check the live DB rows for two reported UI bugs to determine whether they're still broken or already fixed by shipped work.

**BACKGROUND:** Two open reports:
- **Gallery thumbnail missing:** `reddit.com/r/TankPorn/comments/1u3tphi/...` — gallery card shows no thumbnail; re-reported 2026-06-19 as "doesn't render properly in the reader" but user suspects it may already be fixed. The shipped gallery lightbox (Epic 13 P1 / Epic 4 inline-gallery) may have resolved it.
- **Video not fetching:** terse 2026-06-19 report, no repro item. Likely the `v.redd.it` HLS path or YouTube enrich. Needs a specific permalink.

**WHAT TO DO:**
1. Pull the gallery repro row (READ FULL metadata — gotcha):
   ```sql
   SELECT fullname, title, metadata FROM items
   WHERE source='reddit' AND source_id LIKE '%1u3tphi%';
   ```
   Check: does `metadata.gallery` exist and is it populated? Is there a `thumbnail`? Is there a `gallery_preview`? Are the gallery URLs still live (HEAD request a couple)?
2. For the video bug: find candidate `v.redd.it` items in inbox:
   ```sql
   SELECT fullname, source_id, title, json_extract(metadata,'$.media_url') AS mu,
          json_extract(metadata,'$.media_type') AS mt
   FROM items
   WHERE source='reddit'
     AND json_extract(metadata,'$.media_type')='reddit_video'
     AND status='inbox' LIMIT 10;
   ```
   For a couple, resolve the HLS manifest URL and confirm it returns a valid m3u8. This isolates whether the bug is data (missing/bad `media_url`) or frontend.
3. Ask the user for the specific video repro permalink if the data looks healthy.

**REPORT BACK:** Per repro: the live row's actual state (gallery populated? thumbnail present? URLs live?), and a verdict (already-fixed / still-broken-data / still-broken-frontend). For the video bug: the candidate items + whether their HLS manifests resolve.

**CONSTRAINTS:** Read-only + a few HEAD requests. Don't fix anything — diagnose only.

---

## Prompt 13 — Defense bucket pre-decay review (Epic 21 P2)

**OBJECTIVE:** Review the `defense` tag bucket (5.8k items, includes aviation + Ukraine-war subs) before any decay sweep, to decide which subs are time-sensitive (decay candidates) vs evergreen (keep).

**BACKGROUND:** Future decay waves target `anime` (5.9k), `vtubers` (2.8k), `minecraft` (2.2k), `defense` (5.8k). The defense bucket explicitly needs review before sweeping — it mixes evergreen defense-tech with time-sensitive war reporting. `japan` is excluded (resurfacing cluster, user decision). Each wave is one command: `decay --tag <bucket> --before <date> --label swept [--apply]`.

**WHAT TO DO:**
1. Break down the defense bucket by subreddit:
   ```sql
   SELECT json_extract(metadata,'$.subreddit') AS sub, count(*) AS c
   FROM items
   WHERE source='reddit'
     AND EXISTS (SELECT 1 FROM json_each(json_extract(metadata,'$.tags')) WHERE value='defense')
   GROUP BY sub ORDER BY c DESC LIMIT 40;
   ```
2. Classify each top sub: **evergreen** (defense tech, military hardware, aviation engineering — e.g. WarplanePorn, MilitaryPorn, engineeringporn) vs **time-sensitive** (Ukraine-war reporting, news — value decays with the news cycle). Sample a title or two per sub to classify.
3. Decide the decay split: which subs are safe to sweep (older than ~90 days), which should stay regardless of age.

**REPORT BACK:** A table: defense sub → volume → classification (evergreen / time-sensitive) → decay recommendation (sweep-after-90d / keep). The concrete `decay` command(s) that would target only the time-sensitive subset (e.g. via `--tag defense --subreddit <list> --before <date>`, or a new decay label).

**CONSTRAINTS:** Read-only. Decay is reversible (`undecay`) but sweeping identity/evergreen content violates the design language — be conservative. Don't apply anything; present the plan for user sign-off.

---

## How to use these prompts

Each prompt is independent — run them in parallel or any order. Each produces a REPORT BACK that feeds a WP2 build task (the API shape, the threshold, the counts, the verdict) or a user decision (the defense split, the confirm surface). When an agent returns, route its findings: code shapes → WP2; user-decision outputs → the orchestrator.

**Safety reminders for every prompt:**
- Back up `data/app.db` before any write (most prompts here are read-only).
- Read the FULL `metadata` column (gotcha #6).
- Respect Reddit rate floors (`MIN_THROTTLE` 0.6s, jittered).
- Money actions (unsave) are dry-run + explicit `--live --yes` only.
- Never widen scope on destructive ops.
