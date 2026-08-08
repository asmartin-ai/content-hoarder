# NEXT.md — content-hoarder session focus

`main`. Suite: non-UI suite green (see `gh run list` for CI).
Last wrapup: 2026-08-07 (implement round: #13 drag-to-bucket, #25 auto-archive, #40 reader triage-enter — see blocks below).

## Just done (2026-08-07 — promote action + user_tags MERGED into main, review fixes landed)
- **`feat/promote-action` + `feat/user-tags` merged to `main`** (clean 3-way, both behind by 8
  main commits — no conflicts). Fixed points: Spec
  [docs/specs/15-promote-action.md](docs/specs/15-promote-action.md) + issue #70 + Epic 26.
- **Review fixes landed on top of the merges (one commit):**
  - `promoteItem` handler + `core/api.js` wrapper (frontend dispatch previously threw
    ReferenceError — dead UI), `[hidden]` honored in relay CSS (hide-after-receipt + Unsave
    visibility were silently no-ops), `_note_name` no longer stores non-✓ 2xx bodies as
    `delivery_ref`, dead `_SAVED_PREFIX` removed, SW cache/APP_VERSION v128→v129.
  - New regression tests: `tests/ui/test_promote_action.py` (unconfigured toast + configured
    snackbar + hide-after-receipt; self-heals its row vs the shared UI seed DB) + 2 offline
    bridge tests. Unit suite + full UI suite (79) green at merge tip.
- **Trackers:** PKMS issue #3 (Save→promote handoff shape) closed — ADR 0027 + Spec 15 chose
  the transport and it is shipped; CH #70 closed — Epic 26 P3 shipped (registry + CLI). Both
  closing comments carry the AI-triage disclaimer. PKMS main already contained the
  promotion-ingest build (re-applied with review fixes in a later session) — its old
  `feat/promotion-ingest-{spec,build}` + `fix/public-ci-mirror-leaks` branches were archived
  (tags) and deleted, remote refs removed.
- **Remotes:** `private` pushed to this tip. `origin` (public) NOT pushed — the public repo is
  the tracker; publish via the usual gate when Kenja says go. PKMS `canonical/main` updated.

## Just done (2026-08-07 — implement round: #13 drag-to-bucket, #25 assist-auto-archive, #40 reader triage-enter)
- **Remotes in sync.** Both `origin` (public) and `private` (canonical mirror) at the current
  `main` tip. Check actual sync with `git rev-list --left-right --count origin/main...main`
  (and `private/main...main`), never a frozen claim here.
- **#13 — drag-and-drop to status buckets SHIPPED.** Vanilla HTML5 DnD (SortableJS rejected —
  repo no-runtime-deps standard), desktop-only (mobile keeps swipe); rows + deck cards
  draggable onto the 4 status folders; list drops reuse `act()`, deck drops route through
  `deck.commit` (queue advance + undo). APP_VERSION/CACHE v126→v127.
- **#25 — `assist-auto-archive` SHIPPED.** Loads the persisted triage model, lists high-skip
  `sub:` buckets (dry-run default), `--apply` archives each via `db.decay(label='auto-archive')`
  — wave-stamped, `is:decayed`-queryable, reversible. sk/chan/media/cat/age buckets informational
  only (no decay selector / range mismatch — documented). APP_VERSION unchanged (backend-only).
- **#40 — reader triage swipe-up enter/exit SHIPPED.** Deck ↑ gesture → `triageEnter: true`;
  forced reflow so the `translateY(100%)` start paints before `.show` (class was dead code);
  close keeps `.triage-enter` through the exit (slides back down), clears it via a
  `fired`-guarded fin. Overlay coordination (pushOverlay) preserved. APP_VERSION/CACHE v127→v128.
- **Backlog triage cleanup:** #18 (Karakeep bridge) and #55 (one unified surface) CLOSED as
  already-implemented; #66 (blocked on #65 gate) + #44 (deferred) relabeled `ready-for-human`;
  #40 relabeled `ready-for-human` (real-device QA pending). Remaining `ready-for-agent`: #24,
  #28 (both research — memos exist), #56, #59, #67, #68, #70.
- All three issues carry implementation comments (AI-triage disclaimer); epic-05/08/10/16
  backlog files updated to shipped.

## Just done (2026-08-07 — pushes, backlog audit, agent-doc v3 rewrite + review fixes)
- **Both remotes in sync.** Pushed the 5 pre-session commits (Keep Takeout
  parsing, multi-value filter fixes, OCR note, watchdog, NEXT.md) + this session's work to
  `origin` (public) and `private` (canonical mirror). Pre-push `publish_safety_check.py`
  clean (exit 0); the watchdog's ntfy topic + `K:/Projects` paths match what's already
  public in `run-video-archive.ps1`/`bakeoff_arm.py` — same sensitivity class.
- **Backlog migration verified complete + clean.** All 61 `docs/backlog/github-issues.json`
  items are live on public origin (11–78). Audited all 65 live issue bodies: no sensitive
  content (only the embedded "This repository is public" disclaimer + benign path refs).
  The 8 epics with no migrated issues (1,2,3,6,14,19,23) are all **fully shipped**. 3
  unmigrated sub-notes are covered by parent issues #16/#20/#66. Private repo has 0 issues
  by design.
- **Agent docs rewritten to v3 reality**: AGENTS.md layout map + both
  `frontend-design` SKILL.md (`.agents/` + `.claude/`) no longer claim legacy /triage +
  /reddit pages or the v2 teal token system — those are 302 redirects / deleted (P3.5
  2026-07-04). Corrected to the single v3 apricot system (`static/core/tokens.css`).
- **Review fixes**: post-commit code-review caught + fixed 4 stale-v2 carries —
  nonexistent `--danger` token, nonexistent `static/icons/` dir, dead `.card-stack` class
  (deck uses `.deck-host`/`.deck-card`), dangling "reddit inlines its own SVG where legacy".
- **Triage state roles applied** to the open backlog (needs-triage / ready-for-agent /
  ready-for-human) — see issue labels.

## Just done (2026-07-27 — Keep Takeout parsing + multi-value filter fixes)
- **Push routing remains the open decision** carried from the 2026-07-19
  audit: `origin` is public, `private` is the canonical mirror. Check actual
  sync with `git rev-list --left-right --count origin/main...main`, never a
  frozen claim here.
- **`_epoch_to_utc` now parses ISO-8601 timestamps.** The 2026-07-26 session
  assumed modern Takeout always uses microsecond-epoch ints; it also emits
  ISO-8601 strings (`Z` and offset forms). Those hit `int()`, raised, and
  returned 0 — so affected notes silently lost their real created/saved
  times. The ISO branch runs only where `int()` already failed, so the
  numeric ms-vs-µs magnitude detection is untouched.
- **Checklist `checked` honored.** Modern Takeout uses `checked`; the
  connector only read legacy `isChecked`, so completed checklist items
  imported as unchecked — a silent meaning change in the note body that
  feeds search and triage. Legacy `isChecked` still wins when both exist,
  tested by membership not truthiness so `isChecked=False` is respected.
- **Multi-value `subreddit:` / `author:` filters were silently
  case-sensitive.** `expr IN (...) COLLATE NOCASE` applies NOCASE to the
  boolean *result* of `IN`, not to each comparison, so
  `author:spez,kn0thing` missed rows stored as `Spez` while the
  single-value branch matched fine. Collation moved to the left operand.
- **Verified:** 1062 passed, 75 deselected (UI suite excluded by `addopts`).

## Just done (2026-07-26 — Keep connector extended for modern Takeout)
- **Google Keep as a CH source channel — wired.** The `connectors/keep.py`
  Takeout path already existed and tested. This session extends it for the
  modern Takeout format (`timestamps.createTime` in microsecond-epoch) with
  an epoch-magnitude auto-detect helper (`_epoch_to_utc`), and adds a
  `sync()` skeleton that points users at PKMS for live gkeepapi (life-os
  ADR 0028 has PKMS as the canonical master-token-bearing surface). New
  tests: `test_keep_modern_takeout_format_with_timestamps` (modern format
  parses) and `test_keep_sync_raises_with_clear_message` (sync skeleton
  points at PKMS). All 7 keep dispatch tests green.
- **Flow for users with pre-existing Keep history:**
  1. `pkms ingest keep-takeout <takeout.zip>` — bulk import into PKMS vault
     (ADR 0028 path; attachments mirrored to `K:\MediaMirror\keep\`)
  2. `ch import <extracted-keep-dir>` — bulk triage import into CH
     (the connector here; uses the same Takeout JSON files but the
     *extracted* directory, not the ZIP)
  3. (Optional) `pkms ingest keep` + scheduled pull — live incremental
     capture in PKMS
- **Not changed in this session:** triage/promote workflow. Keep items in
  CH follow the same Triage path as Reddit/HN. The promotion-card fixture
  (CH#72, closed 2026-07-20) still applies.

## Just done (2026-07-20 — orchestration session: issues, PR unblock, ADRs, scouts)
- **Issue #71 CLOSED (ai_ml tagging).** Audit: 0 reddit items tagged `ai_ml` (HN 154,
  Firefox 3); root cause: `_SUBREDDIT_TAGS` only had legacy ML subs. Fix delegated to
  aider (deepseek executor), reviewed + merged: 9 LLM-era subs (localllama, claudeai,
  openai, chatgpt, artificial, singularity, stablediffusion, ollama, mistralai) →
  `ai_ml`; new test `test_ai_ml_subreddit_tag_map`. Optional operator follow-up: backfill
  retag of existing rows (new saves tag correctly already).
- **Issue #72 CLOSED (Life-OS fixture).** Promotion-card fixture click-tested
  end-to-end in life-os; substrate ADRs 0016/0017/0022/0025/0026 flipped Accepted.
- **PR #77 LANDED via `rebase/pr-77`** (lightbox captions + text blurbs): conflicts
  from the #76 squash resolved; SW/APP_VERSION unified to **v125**; PR closed.
- **PR #75 LANDED via `rebase/pr-75`** (OCR enrich, splashes, browse packets, media
  mirror docs): SW/APP_VERSION unified to **v126**; kept main's 11-size
  apple-touch-startup-image set and `K:\MediaMirror` dest over the branch's older
  splash/`F:\Backups` variants; reddit-image→thread guard combined with #77's
  `withCap(opts)`; stale `test_app_version_v120` bumped. PR closed. **Note:** both
  head branches (`feat/lightbox-caption-blurbs`, `feat/ocr-tesseract-experimental`)
  are now superseded — safe to delete on origin.
- **Scout memos** (UNVERIFIED — source-check before load-bearing use) committed under
  `docs/research-scout/`: smart-sort (#24), deck architecture (#65), thumbnail crop (#28).
- **Onramps direction recorded:** life-os ADR 0027 (**Accepted 2026-07-28**)
  — Option C hybrid: save stays save; promote via triage sprint on resurface
  cards; unsave-on-source deferred behind `action_receipt`; Keep stays
  notes-only (YouTube links route here). Boundary stays modular so A/B remain
  swappable. CH implication: a real `promote` action wired to the resurface
  card is the next integration slice — spec lives in
  `K:\Projects\PKMS\docs\delegation-roadmap.md`.


## Just done (2026-07-19 a.m. session — iOS splash + media mirror + Spec 10/11)
- **iOS splash screens SHIPPED** on `main` (merged `e48c47e`, CI green on `8067e1b`):
  - `scripts/gen_splash_screens.py` (new): reads `manifest.webmanifest::background_color`
    (#0f1115) and emits 11 solid-color `apple-touch-startup-image-<WxH>.png` files
    for every shipping iPhone + iPad (~133 KB total).
  - `templates/index.html`: 11 `<link rel=apple-touch-startup-image media=...>`
    tags with device-width/height/dpr queries so iOS picks the right one.
  - `static/sw.js`: SHELL gains 11 splash URLs; CACHE v123→v124 in lockstep.
  - `static/browse/main.js`: APP_VERSION v123→v124.
  - `tests/test_pwa_meta.py`: 4 new regression tests (link tags present, media
    query has `-webkit-device-pixel-ratio`, served images at correct pixel
    dimensions via stdlib `struct` PNG IHDR decode, on-disk images match
    `manifest::background_color` at corner+center via Pillow).
  - `tests/test_service_worker.py` + `tests/test_subreddit_facet.py`:
    version-bump guards updated to v124.
  - `pyproject.toml`: added `Pillow` to `[project.optional-dependencies].dev`
    (CI fix in `8067e1b` — the color-mismatch test needs Pillow; the IHDR
    decode test uses stdlib only).
- **Media mirror SET UP** (Spec 10 implementation):
  - `K:\MediaMirror\content-hoarder\media\` is the chosen `<DEST>`.
  - `scripts/mirror-media.bat` (robocopy /MIR /MT:16 /R:2 /W:5, append log).
  - `scripts/verify-mirror-media.bat` re-hashes every dest file and compares to
    its filename (filename IS sha256; free integrity check).
  - Tradeoff accepted: same-drive mirror protects against accidental delete /
    corruption, not drive failure (user's stated threat model).
  - `docs/specs/10-media-backup.md`: DEST marked CHOSEN.
- **Spec 11 OAuth + rate-limit decisions** (per user direction):
  - OAuth for user-list-driven ops; `REDDIT_OAUTH_CLIENT_ID` configured.
  - yt-dlp + browser cookies for `archive-media --videos` smoke (public
    `v.redd.it` URLs don't need auth).
  - **No new `--video-throttle` flag** — operator passes
    `archive-media --throttle 2.0` for video runs (default 0.3s is for images).
  - `docs/specs/11-video-archive-smoke.md`: decisions #2 (auth) and #3
    (rate-limit) marked CHOSEN.
- **#46 mobile fastscroll** (also done this session, before splash):
  - Merged to main (`90cc660`, `--no-ff`); issue closed; rAF-deferred
    `onScroll` handle transform shipped in `b24903a`.

## Just done (2026-07-19 p.m. session — verify-mirror test + Spec 11 video smoke)
- **Spec 11 video-archive smoke PASSED** against a DB copy of `data/app.db`:
  - Pre-flight: `yt-dlp 2026.06.09` + `ffmpeg 8.1.1` both on PATH; 2.6 TB free on K:.
  - Selected candidate: `reddit:t3_100ekup` from r/hoggit (the candidates SQL has
    no `ORDER BY created_utc DESC`, so it picked the first physical-order row —
    a 2018 post, `v.redd.it/y7etx8k3xd9a1`, Reddit's CDN still serves it via
    yt-dlp). User-chosen representative candidates in the spec's menu (e.g.
    `reddit:t3_1v0nyf1`, the Fable/ClaudeCode post) would be equally valid;
    the smoke proves the path regardless of which specific item is picked.
  - Command: `CONTENT_HOARDER_DB=data/app.videosmoke-…db python -m
    content_hoarder archive-media --videos --limit 1 --throttle 2.0 --apply`
    → 1 item, 1 URL, 1 archived, 0 failed, 7,316,767 bytes, ~5 s, exit 0.
  - DB row updated: `metadata.archived_media` set to
    `{'https://v.redd.it/y7etx8k3xd9a1/DASH_720.mp4?source=fallback':
     '969d0905c35fc98b8989be2d83367bce837b791a85e3afaa926000c7881b8161.mp4',
     'https://v.redd.it/y7etx8k3xd9a1': '…161.mp4'}`;
    `metadata.archived_media_details[…v.redd.it/y7etx8k3xd9a1] = {kind:
    'reddit_video', blob: '…161.mp4', canonical_url, source_url, downloader:
    'yt-dlp', container: 'mp4', has_audio: True, bytes: 7316767, fetched_utc}`.
  - `media_status` NOT flipped (videos don't — spec contract).
  - DB copies cleaned up; live `data/app.db` mtime untouched.
  - **Spec 11 is now ready to escalate to a full un-`--limit`'d run** (still
    user-gated; smoke proved the path).
- **verify-mirror-media refactor + synthetic-corruption tests**:
  - Extracted the verification logic from `scripts/verify-mirror-media.bat`
    (cmd-internals-heavy, untestable) into `scripts/verify_mirror_media.py`;
    the .bat is now a 12-line shim that calls the Python helper.
  - `tests/test_verify_mirror_media.py` (new, 6 tests):
    - `test_verify_mirror_reports_mismatch_when_one_byte_flipped` — the
      headline regression (1-byte corruption → MISMATCH + count).
    - `test_verify_mirror_exits_nonzero_on_mismatch_via_subprocess` — the
      CLI contract (exit 1 on mismatch, "MISMATCH" + "FAILED:" in stdout).
    - `test_verify_mirror_passes_on_all_good_blobs_in_process` — sanity
      (3 good blobs → 0 mismatches).
    - `test_verify_mirror_passes_via_subprocess_on_all_good_blobs` — the
      same through `subprocess.run`, confirms "OK: all blobs verified."
      + "files checked: 3" in stdout.
    - `test_verify_mirror_skips_non_blob_housekeeping_files` — `Thumbs.db`,
      `garbage.txt` etc. are not flagged as MISMATCH (only 64-hex-stem files
      are checked; first 20 non-blobs echoed to stderr, more summarised).
    - `test_verify_mirror_missing_dest_returns_nonzero_via_subprocess` —
      missing dest → exit 1 + "ERROR"/"dest does not exist" in stderr.
  - `.bat` accepts `VERIFY_MIRROR_DEST` env override so a staging mirror
    can be verified without editing the file.
- **Spec 10 tailnet peer mirror** ICEBOXED per user direction (same-drive
  mirror + verify-mirror covers the stated threat model).

## Just done (2026-07-19 late-p.m. session — PR #76 review/merge + audits)
- **PR #76 (`fix/74-comment-reader-empty`) MERGED into main** as
  `55a775f`. Review found 1 P2 + 4 P3 findings; fixed the P2
  (seed-pane duplication on render) + 2 cheap P3s (not_found copy,
  stale `renderComments()` callers), documented the remaining 2 P3s
  as TODO follow-ups in the module docstring. Added 3 regression
  tests for the fixes. Rebased onto main (v124 cache bump) before
  force-push; CI green on the post-fix commit. Issue #74 was closed
  by the squash-merge's `Closes #74` footer.
- **PR #76 squash-merge caveat (this session's process mistake):**
  the worktree's `fix/74-comment-reader-empty` was rebased onto
  *local* main (which had 3 unpublished commits) rather than
  `origin/main`. The squash-merge on GitHub therefore bundled the
  3 local commits' content with the PR's 2 commits. The code is
  correct (all 8 tests + 1054 unit suite pass) but the squash-merge
  commit message only says "Fix #74" — the corruption-test
  refactor, the video-archive launcher, and the Spec 10 cadence
  closeout are now invisibly inlined into that one commit. If
  clean history matters, the next session can revert + redo as
  separate commits; if not, the code is correct and tests pass.
- **Public/private audit (2026-07-19 late-p.m.):** `origin/main`
  and `private/main` were at the same commit (`3669b6e`) at
  session start; local main was 3 commits ahead with the
  corruption-test / launcher / cadence work. After the PR #76
  merge + local rebase, local main and origin/main are now in
  sync at `55a775f` (the squash-merge). The private remote
  remains 1 commit behind. **Decision needed:** push `55a775f`
  to `private` (canonical-public model says yes; user-gated).
- **Doc audit (initial pass):** 83 product docs in `docs/`; many
  are post-implementation retrospectives that could be folded or
  moved (e.g. `app-css-audit-2026-06-26.md` for deleted `app.css`,
  `epic-19-backend-hardening.md` every-checkbox-done archive,
  `parallel-run-2026-06-12.md` one-off session notes,
  `thread-hydration-feasibility.md` planning doc for shipped
  feature, `bakeoff/RESULTS.md` etc.). Full audit table below.
- **Video-archive run update (HEARTBEAT):** at the late-p.m.
  audit point, 200/7,135 = 2.8% complete in ~24 min. Actual
  per-item time is ~7-8 s (yt-dlp download + mux dominates the
  2 s throttle), not the 2 s I estimated. **Full run estimate
  revised: ~14 hours, not 2-3.** Resumable; can be paused/restarted.

## Next 1-3 actions (in order)
1. **Spec 11 full video-archive run** (user-gated, smoke PASSED 2026-07-19
   p.m.): same command without `--limit 1` against the live `data/app.db`:
   ```
   python -m content_hoarder archive-media --videos --throttle 2.0 --apply
   ```
   Per the spec, do NOT auto-escalate. The user runs the un-`--limit`'d
   pass. Estimated size: ~7 MB × 7,135 candidates = ~50 GB; budget time
   for ~2-3 hours at 2 s throttle.
2. **Real-device Pixel-6 + iPhone QA**: deck gestures, subreddit facet,
   redirects, iOS splash screens (the new feature — first launch on a real
   device). User-gated.
3. **First media mirror** (user-gated): `scripts\mirror-media.bat` against
   `K:\MediaMirror\`, then `scripts\verify-mirror-media.bat`. Re-runnable.

## Open decisions (need user)

### Spec 11 — Video archive smoke (smoke PASSED 2026-07-19 p.m.)
- ✅ **OAuth vs cookies** — CHOSEN 2026-07-19 (OAuth for user-list; yt-dlp +
  browser cookies for `--videos` smoke — public v.redd.it URLs don't need
  auth).
- ✅ **Rate-limit posture** — CHOSEN 2026-07-19: keep the existing throttle
  contract, no new flag. Operators pass `--throttle 2.0` for video runs.
- ✅ **Pre-flight** — CHOSEN 2026-07-19: yt-dlp 2026.06.09 + ffmpeg 8.1.1
  installed; 2.6 TB free.
- ✅ **First smoke candidate** — `reddit:t3_100ekup` (r/hoggit, 2018
  `v.redd.it/y7etx8k3xd9a1`); the user-recommended `reddit:t3_1v0nyf1`
  (Fable/ClaudeCode) is also valid; the smoke command takes any v.redd.it
  item, the path proves itself either way.

### Spec 10 — Media mirror (DEST + cadence CHOSEN 2026-07-19)
- ✅ **Pick `<DEST>` drive** — CHOSEN: `K:\MediaMirror\content-hoarder\media\`.
- ✅ **Manual-after-archive cadence** — CHOSEN 2026-07-19: operator runs
  `scripts\mirror-media.bat` (then `scripts\verify-mirror-media.bat`)
  after a meaningful `archive-media` batch. Matches the existing
  user-gated posture; no Task Scheduler entry. Same-drive mirror covers
  the stated threat model (accidental delete / corruption, not drive
  failure).
- **Second mirror to a tailnet peer** — ICEBOXED 2026-07-19 p.m. per user
  direction.
- Tier-2 escalation (separate physical drive / external USB-C SSD) is
  available if the threat model widens.

### Ongoing
- Real-device Pixel-6 + iPhone QA for mobile changes (now including the new
  iOS splash screens).

## Recently obsoleted
- **Update `aider-headless-delegate` skill with the bakeoff's delegation lanes**
  (was Next #3) — skill was already current (verified 2026-07-19; lines 22-23,
  462-473, M19). The LLM-dev routing-table note
  (`C:/Users/Kenja/Documents/LLM-dev/bakeoffs/Content-Hoarder-Bakeoff-Routing-2026-07-19.md`)
  is the audit trail / decision rationale; the skill has the operational defaults.
- **`aider-delegate` MCP delegation for the splash + jitter work** (a 2026-07-14
  issue) — known to time out (M23); LM Studio had no models loaded; per the
  2026-07-14 delegation-worthiness gate, this is a deterministic transform
  (exact bytes known) → edited directly. Decision validated by the same task's
  history (3 dead sessions on #46 fastscroll; direct took minutes).
- **Synthetic-corruption test for verify-mirror-media.bat** (was Next #4) —
  shipped 2026-07-19 p.m. as 6 tests in `tests/test_verify_mirror_media.py`,
  refactored the .bat into a Python helper as part of the same change.

## Cherry-pick audit (2026-07-11) — no-op, already landed
The 4 bakeoff oracle features were committed **directly to main** during the
bakeoff session (commits `dcccc2c`, `248be11`, etc.), not left on run branches.
All 21 oracle tests pass on main. Nothing to cherry-pick. Cleaned up 7 stale:
`delegated/run-*` local branches (all from a later LM-Studio qwen3-coder
experiment, not the cloud bakeoff winners).

## Icebox
- #72 Life-OS fixtures — real T1, needs Life-OS contract work; defer.
- P2.1/P2.2 engagement Phase 1 — depends on user flipping `learn-triage --apply`
  (their switch, deferred once already).
- iPhone PWA real-device test — deferred; user will test when ready.
- **Spec 10 — second mirror to a tailnet peer** (deferred 2026-07-19 p.m.
  per user direction; same-drive mirror + verify-mirror-media.bat covers
  the stated threat model).
- Cross-substrate bakeoff check (PKMS) — pending PKMS verdict.

---

## Session archive (one line each, by date)

| Date | Session summary | Spec / ref |
|---|---|---|
| 2026-07-19 (p.m.) | Spec 11 video-archive smoke PASSED (r/hoggit 2018 post, 7.3 MB, 5 s); verify-mirror-media.bat → Python shim + 6 corruption tests; peer mirror ICEBOXED | this file's "Just done (p.m.)" |
| 2026-07-19 (a.m.) | iOS splash screens + media mirror + Spec 10/11 decisions + #46 merge + CI Pillow fix | this file's "Just done (a.m.)" |
| 2026-07-19 | #46 mobile fastscroll merged (rAF-deferred onScroll handle transform) | `docs/bugs/46-*.md`, `docs/specs/46-*.md` |
| 2026-07-14 | #46 fastscroll fix + port (track-offset bug, scrub-load cascade pause) | `docs/specs/46-fastscroll-scrub-loads-plan.md` |
| 2026-07-12 | iOS PWA installability (Spec 13): 5 Apple meta tags, /sw.js root-scope, --tls flag, mkcert setup | `docs/specs/13-ios-pwa-installability.md` |
| 2026-07-11 | Public/private remote sync (135 commits), `publish_safety_check.py` test-fixture exclusion | `PUBLISH-SAFETY.md` |
| 2026-07-11 | Fix 2 pre-existing RED UI tests (subreddit facet + relay menu labels) — `desktop_page` switch + 480px compact breakpoint | `tests/ui/test_subreddit_facet.py`, `browse.css` |
| 2026-07-07 | Wrap-up hygiene: bakeoff WIP archived; pre-existing UI failures kept out of P3.5 | `archive/bakeoff-arm-wip` |
| 2026-07-05 | content-hoarder bakeoff complete: 80 runs / 4 tasks / 10 models, T3 winner `minimax/minimax-m3` (q2c=347), Pro tier not worth ~3× | `bakeoff/RESULTS.md`, `bakeoff/STATUS-REPORT.md` |
| 2026-07-04 | P3.5 legacy retirement: /triage + /reddit page routes → 302 redirects; CSS+JS deleted; v3 is one surface | `docs/specs/12-unify-one-surface.md` |
