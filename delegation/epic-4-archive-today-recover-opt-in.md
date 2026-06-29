# Epic 4 archive.today live smoke + /recover opt-in

## Goal

Make archive.today media-byte recovery safe to exercise and safe to expose in the app:

- Provide a live-smoke workflow that can be run manually against a copied DB, with explicit network/apply gates and useful output.
- Change `/recover` so archive.today is never contacted implicitly by a generic Recover click.
- Preserve the existing recovery split:
  - PullPush / Arctic-Shift: reddit-id-keyed JSON metadata recovery.
  - archive.today: URL-keyed HTML/media-byte recovery, per item only, post-chain only for `metadata.media_status='gone'`.
- Keep tests offline by using injected HTML fetchers and byte fetchers.
- Log enough to audit external calls and DB/media writes without turning logs into a privacy leak.

## Implementation status (2026-06-29)

- Branch `epic-4-archive-today-recover-opt-in` implemented the safety slice: generic `/recover` no longer contacts archive.today implicitly, archive.today media-byte recovery is per-item opt-in, and the live-smoke script has no-network default planning plus explicit live/apply gates.
- Archive.today remains **per-item only** and is still not wired into bulk recovery.
- Merge validation was offline/deterministic. No live archive.today network smoke was run during this merge; run the documented `CONTENT_HOARDER_ARCHIVE_TODAY_LIVE=1` smoke against a copied DB before trusting live recovery behavior.

## Confirmed current state

- `ArchiveTodayProvider` is a separate provider shape, not an `ArchiveProvider` subclass. It resolves `archive.ph/newest/<quoted original_url>` HTML and extracts `og:image` plus inline `<img src>` candidates (`src/content_hoarder/archival/providers.py:276-424`).
- `default_media_providers()` returns `[ArchiveTodayProvider(...)]` with a `2.0s` interval when throttled, or no interval when `throttle=False` (`src/content_hoarder/archival/providers.py:421-424`).
- `recover_one()` always runs the PullPush/Arctic metadata chain first, commits `hydrated_at`/recovered fields, and only then tries archive.today if `media_providers` is non-empty (`src/content_hoarder/archival/service.py:247-291`).
- `_try_archive_today()` itself is correctly gated on `metadata.media_status == 'gone'`; it stores bytes via `media_store`, then writes `metadata.archived_media` and `metadata.media_status='recovered_archive_today'` only when `apply_bytes=True` (`src/content_hoarder/archival/service.py:192-244`).
- The Flask route currently always passes `default_media_providers(..., throttle=False)` into `recover_one()` (`src/content_hoarder/web.py:594-609`). So any current `/items/<fullname>/recover` call can contact archive.today when the item is reddit media with `media_status='gone'`.
- Existing UI:
  - `triage.js` only shows the recover button for removed/deleted reddit text (`src/content_hoarder/static/triage.js:437-447`).
  - Clicking it posts to `/items/<fullname>/recover` with no JSON body and no archive.today opt-in (`src/content_hoarder/static/triage.js:739-763`).
  - `core/api.js` exposes `recoverItem(fullname)` with no request body (`src/content_hoarder/static/core/api.js:29-30`).
  - The v3 browse UI imports the shared API but has no recover action; media placeholders are in `browse/main.js` around `openMediaFor()` (`src/content_hoarder/static/browse/main.js:709-738`).
- Offline tests already cover the archive.today provider and `recover_one()` integration with injected fetchers (`tests/test_archive_today.py`). They assert:
  - bytes are stored and metadata flips when `media_status='gone'` and `apply_bytes=True`;
  - archive.today is skipped when media is live;
  - `apply_bytes=False` counts candidates without writing `archived_media` / `media_status`.
- Existing web tests assert the route wires a non-empty `media_providers` list, i.e. they currently lock in archive.today being live through the generic route (`tests/test_web.py:388-403`). These should be intentionally updated for opt-in semantics.
- `scripts/recover_archive_today.py` exists as a live-smoke harness with `--limit` and `--apply` (`scripts/recover_archive_today.py:1-85`). Important caveat: its help says dry-run writes nothing, but it calls `recover_one()` with default metadata providers, so even without `--apply` it can still run PullPush/Arctic and write `hydrated_at`/metadata before archive.today previewing. The Epic should fix this before relying on the script.
- `media_store.media_dir()` stores blobs beside the configured DB (`<dir-of-CONTENT_HOARDER_DB>/media`), so a smoke DB copy naturally writes media beside that copy when `CONTENT_HOARDER_DB` points at it (`src/content_hoarder/media_store.py:34-36`).

## Live smoke design

Design the smoke as an operator-driven script, not a CLI command that looks like a normal bulk workflow. It should be impossible to accidentally sweep many items or mutate the live DB.

Recommended script: evolve `scripts/recover_archive_today.py` into an explicit smoke harness, e.g. keep the filename but make its behavior stricter.

Modes:

1. `plan` / default — no network, no writes.
   - Select eligible rows only: reddit items with `json_extract(metadata, '$.media_status')='gone'` and at least one HTTP `metadata.media_url` or `metadata.gallery[]` URL.
   - Print item count, selected `fullname`s, source hostnames, media URL count, and whether any `archived_media` already exists.
   - Do not call PullPush, Arctic-Shift, archive.today, or byte fetchers.
2. `probe` — archive.today HTML network only, no DB writes, no byte fetch.
   - Requires `--probe` plus `CONTENT_HOARDER_ARCHIVE_TODAY_LIVE=1`.
   - Calls `ArchiveTodayProvider.recover_media()` through injected/default HTML fetcher.
   - Reports `snapshot_candidate_count`, status per original URL, and failure class.
   - Does not call `recover_one()` because that writes metadata-chain state; use a new public helper around `_try_archive_today()` or a dedicated preview helper.
3. `apply` — archive.today HTML network + byte fetch + DB/media writes.
   - Requires `--apply --yes` plus `CONTENT_HOARDER_ARCHIVE_TODAY_LIVE=1`.
   - Refuses if `CONTENT_HOARDER_DB` resolves to the canonical live `data/app.db` unless an extra `--allow-live-db` flag is present. Default instruction: copy the DB first.
   - Keeps the existing `DEFAULT_MAX_BYTES` cap from `media_archive.py` unless overridden lower/higher deliberately.

Candidate selection:

- Support `--fullname reddit:t3_x` for the safest single-item smoke.
- Support `--limit N`, but default to `1` and cap at a small number, e.g. `--max 10`, unless `--yes-many` is provided. This is still not a bulk feature.
- Exclude rows where `metadata.archived_media` is already non-empty unless `--retry-archived` is passed.
- Gallery rows should report each frame URL separately and throttle between snapshot lookups.

Config/env gates:

- `CONTENT_HOARDER_ARCHIVE_TODAY_LIVE=1` — required for any live archive.today request from the smoke script.
- `CONTENT_HOARDER_DB=<copy.db>` — preferred way to target a DB copy. The script should print the resolved DB and media directory before doing work.
- Optional: `CONTENT_HOARDER_ARCHIVE_TODAY_UA` to override the default archive user-agent for smoke only; otherwise use a stable content-hoarder UA.
- Optional: `CONTENT_HOARDER_ARCHIVE_TODAY_MAX_BYTES` if the script exposes a byte cap, but a CLI `--max-bytes` is clearer and easier to audit.

Output shape:

- Console: compact per-item status plus final summary.
- JSONL report beside the DB, e.g. `<db-dir>/archive-today-smoke.jsonl`, one row per attempted item:
  - `ts`, `mode`, `fullname`, `media_status_before`, `candidate_original_count`, `snapshot_candidate_count`, `bytes_archived`, `blob_ids`, `elapsed_ms`, `result` (`skipped`, `hit`, `miss`, `blocked`, `too_large`, `byte_fetch_failed`, `error`), and `error_kind`.
  - Prefer URL hostnames and stable hashes by default; include full URLs only with `--verbose-urls` because original media URLs can still be personal/sensitive.
- For `apply`, also print the media directory and a backup reminder: `data/media/` / `<db-dir>/media` is not in the DB and must be backed up separately.

Safety details:

- Never wire archive.today into `recover()` bulk recovery.
- Never make `probe` the default; a no-network `plan` is the default.
- Use a minimum `2s` throttle between archive.today snapshot lookups, even in smoke.
- Treat Cloudflare 403/429 as an expected miss class, not a crash.
- Apply commits per item, matching the existing media archiving pattern.

## /recover opt-in UX/API

Core API rule: `POST /items/<fullname>/recover` should remain a per-item endpoint, but archive.today must be off by default.

Proposed request body:

```json
{
  "metadata": true,
  "archive_today": "off",
  "confirm_external_archive_today": false
}
```

Allowed `archive_today` values:

- `off` / absent — metadata-only recovery. Do not construct `default_media_providers()` and do not contact archive.today.
- `preview` — explicitly contact archive.today to resolve candidate image URLs, but do not fetch bytes or write `archived_media`. This is still a live external request and must require `confirm_external_archive_today: true`.
- `apply` — explicitly contact archive.today, fetch candidate bytes, store blobs, and update metadata. Must require `confirm_external_archive_today: true`.

Response shape:

```json
{
  "recovered": true,
  "title": "...",
  "body": "...",
  "url": "...",
  "metadata_recovered": true,
  "archive_today": {
    "eligible": true,
    "attempted": true,
    "mode": "apply",
    "bytes_archived": 1,
    "result": "hit",
    "errors": []
  }
}
```

Route behavior:

- Default existing no-body calls become metadata-only. This preserves the text recovery button but removes implicit archive.today traffic.
- Only pass `media_providers=default_media_providers(...)` when `archive_today` is `preview` or `apply` and the confirmation field is true.
- Reject `archive_today` opt-in for non-reddit items, non-`gone` media, or missing media URLs with a clear 400 response. Do not silently do a network request that cannot help.
- Consider a small server-side rate limit for archive.today attempts, e.g. a process-global or settings-backed `archive_today_last_attempt_utc`, to prevent rapid repeated taps.
- Do not add any bulk API shape; if the body contains a list of fullnames or a bulk flag, reject it.

UX placement:

- Triage deck:
  - Rename the existing button to clarify it is metadata/text recovery, e.g. `↻ Recover text from archives`.
  - Keep it visible only for removed/deleted reddit text as today.
  - If the item also has `metadata.media_status='gone'`, show a separate secondary action after the metadata button: `Recover deleted media via archive.today`.
- Browse / reader / lightbox:
  - Add the media opt-in where the user actually encounters missing media:
    - media placeholder in `browse/main.js openMediaFor()` for gone image/gallery items;
    - reader media tile if it renders a missing-media state;
    - optionally row menu as an advanced action, but avoid cluttering normal actions.
  - The control should only render when the item is reddit, has `media_status='gone'`, and has `media_url` or `gallery[]`.
- Confirmation copy:
  - Tell the user this contacts archive.today with the original Reddit media URL.
  - Tell the user it is slow, may be blocked by Cloudflare, and has a low hit rate.
  - Tell the user it is one item only and will store recovered bytes locally if found.
  - Offer `Check only` (`preview`) and `Recover bytes` (`apply`) as separate actions if both are implemented.
- UI state after success:
  - Re-fetch the item (`fetchItem`) or merge returned metadata so `archived_media` and `media_status` are current.
  - If the local-media preference is enabled (`chArchiveMedia === "1"`), recovered media should immediately render through `/media/<blob>` via `core/media.js localUrl()`.
  - Show distinct messages: `Text recovered`, `Archive.today snapshot found`, `Recovered 1 image`, `No archive.today snapshot found`, `Blocked by archive.today / try later`.

Privacy/safety UX:

- Do not auto-run archive.today after a metadata recovery succeeds.
- Do not run archive.today during page load, card render, thumbnail tap, or missing-media placeholder render.
- Store the opt-in as per-click confirmation unless a future settings UI adds a durable enable switch; even with a durable switch, keep archive.today per-item, never bulk.

## Implementation plan

1. Split service semantics so preview/apply can be truly no-surprise.
   - Add a public helper around the existing `_try_archive_today()` path, e.g. `archive_today_recover_media(conn, fullname, providers, fetch_bytes, mode)`.
   - This helper should fetch the existing item, validate reddit + `media_status='gone'`, and call archive.today without running PullPush/Arctic metadata recovery.
   - Preserve `_try_archive_today()`'s injectable providers and byte fetcher.
   - Return structured status instead of only an integer count.
   - Keep `recover()` bulk unchanged and metadata-only.

2. Change `recover_one()` or route wiring.
   - Preferred: add explicit parameters to `recover_one()` such as `include_media=False` and `media_apply=True`, defaulting to metadata-only.
   - Alternative: leave `recover_one()` as metadata-only in the route and call the new media helper only when the request asks for archive.today.
   - In either case, generic `/recover` calls must not pass `media_providers` by default.

3. Fix the live-smoke script.
   - Stop calling `recover_one()` for no-write modes.
   - Add `plan`, `probe`, and `apply` modes with the gates described above.
   - Print resolved DB path and `media_store.media_dir()` before doing work.
   - Write a JSONL smoke report beside the DB.
   - Refuse broad/live operation by default.

4. Update Flask API.
   - Parse JSON body safely; no body means metadata-only.
   - Validate `archive_today` mode and `confirm_external_archive_today`.
   - Return 400 for invalid/non-eligible items; return 409 or 429 for rate-limit/cooldown if implemented.
   - Add audit logging for explicit archive.today attempts.

5. Update frontend API wrappers.
   - Change `recoverItem(fullname, body)` to accept an optional request body.
   - Keep existing metadata-only callers working.
   - Add a separate wrapper if clearer: `recoverArchiveToday(fullname, mode)`.

6. Update UI.
   - Triage: make existing recover button metadata-only and add explicit archive.today secondary action only for gone media.
   - Browse/lightbox/reader: add a missing-media opt-in control where gone media is surfaced.
   - Use a confirmation sheet/dialog rather than a one-click button for the external archive.today action.

7. Add audit/logging.
   - Use a JSONL file beside the DB, e.g. `<db-dir>/recover-audit.jsonl` or `<db-dir>/archive-today-audit.jsonl`.
   - Include `ts`, `op`, `fullname`, `mode`, `media_status_before`, `media_status_after`, `provider`, `result`, `bytes_archived`, `blob_ids`, `error_kind`, elapsed time, and URL host/hash summaries.
   - Avoid body/title text in audit logs; those are content, not operational metadata.
   - Include full URLs only if needed for local debugging and behind a verbose flag or debug setting.

8. Update docs after implementation.
   - README currently says the in-app Recover button probes archive.today. Update it to say archive.today is an explicit media recovery opt-in.
   - Add a short operator note near `archive-media` / recovery docs explaining the live-smoke script and DB-copy requirement.

## Tests and validation

All automated tests must remain offline. No test should call archive.today, PullPush, Arctic-Shift, or live byte URLs.

Service tests:

- `recover_one()` default is metadata-only: fake `ArchiveTodayProvider` should not be consulted unless the explicit media flag is set.
- New archive.today helper:
  - returns `eligible=false` without network for non-reddit, non-`gone`, missing URL, or already-recovered cases;
  - `preview` counts snapshot candidates and writes nothing;
  - `apply` stores bytes, updates `archived_media`, and flips `media_status`;
  - Cloudflare/403/429/provider exceptions return soft failure statuses;
  - byte fetch `(None, "too_large")` or non-image MIME is reported without flipping status.
- Regression: archive.today still does not subclass `ArchiveProvider`; default metadata providers remain PullPush/Arctic only.

Web/API tests:

- No-body `POST /items/<fullname>/recover` calls `recover_one()` metadata-only and passes no media providers.
- `archive_today: "preview"` without `confirm_external_archive_today` is rejected.
- `archive_today: "preview"` with confirmation calls the injected/fake media path with `apply_bytes=False`.
- `archive_today: "apply"` with confirmation calls the injected/fake media path with `apply_bytes=True`.
- Non-reddit and non-eligible gone-media cases return clear 400 JSON.
- If rate limiting is added, repeated archive.today attempts return the selected cooldown status without calling the provider.

Script tests:

- `plan` mode selects candidates and performs no network calls.
- `probe` refuses without `CONTENT_HOARDER_ARCHIVE_TODAY_LIVE=1`.
- `apply` refuses without both `--apply --yes` and the live env gate.
- Live-DB guard refuses canonical `data/app.db` unless `--allow-live-db` is present.
- JSONL report rows are written with URL hashes/hosts, not full URLs by default.

Frontend/UI tests:

- Lightweight JS/unit tests if available for the request body builder and missing-media eligibility helper.
- Manual QA or Playwright UI test for:
  - text recover button posts metadata-only;
  - archive.today action is hidden unless `media_status='gone'`;
  - confirmation is required before archive.today request;
  - success updates media state and message.

Suggested validation commands after implementation:

```sh
python -m pytest tests/test_archive_today.py tests/test_archival.py tests/test_web.py
python -m pytest -m "not ui"
```

For UI changes, also run the project UI suite when available:

```sh
python -m pytest -m ui --browser-channel chrome
```

Live smoke validation is manual and should not be part of automated tests:

```sh
CONTENT_HOARDER_DB=data/app.smoke.db python scripts/recover_archive_today.py --fullname reddit:t3_example
CONTENT_HOARDER_DB=data/app.smoke.db CONTENT_HOARDER_ARCHIVE_TODAY_LIVE=1 python scripts/recover_archive_today.py --fullname reddit:t3_example --probe
CONTENT_HOARDER_DB=data/app.smoke.db CONTENT_HOARDER_ARCHIVE_TODAY_LIVE=1 python scripts/recover_archive_today.py --fullname reddit:t3_example --apply --yes
```

## Risks / open questions

- Naming: `dry-run` is ambiguous because an archive.today `preview` still performs a live external request. Prefer `plan` for no-network and `probe` for live/no-write.
- Current script dry-run is not actually no-write because `recover_one()` commits metadata-chain state. Fix this before any smoke is run.
- Should archive.today web use require a durable setting in addition to per-click confirmation? Per-click confirmation is the minimum; a settings toggle would reduce accidental exposure further.
- How much URL detail should audit logs retain? Full URLs help debugging but may be sensitive. Host + hash by default is safer.
- If archive.today returns HTML with many tracking/icon images, extraction may overcount. Consider filtering candidates to archive.ph CDN, original media host, or image MIME after byte fetch.
- Cloudflare behavior may make live smoke flaky. Treat blocked as a valid result, not a failure of the feature.
- Gallery apply may recover only some frames. Decide whether `media_status` should become `recovered_archive_today_partial` versus the current single `recovered_archive_today` value.
- The API response should distinguish metadata recovery from media recovery; current `recovered` is too coarse once archive.today is opt-in.
- `archive.today` sees the original media URL during probe/apply. The UI should say this plainly.

## Suggested delegation slices

1. **Service/API semantics**
   - Implement metadata-only default, explicit archive.today mode, and structured result objects.
   - Update `tests/test_archive_today.py`, `tests/test_archival.py`, and `tests/test_web.py`.

2. **Live-smoke script hardening**
   - Convert `scripts/recover_archive_today.py` to `plan` / `probe` / `apply` modes.
   - Add env gates, live-DB guard, JSONL report, and no-network default.

3. **Triage UI opt-in**
   - Make existing recover button metadata-only.
   - Add confirmed archive.today media action for eligible gone-media items.
   - Update button labels/toasts and request bodies.

4. **Browse/reader missing-media UX**
   - Add archive.today opt-in action to gone image/gallery placeholders and reader media tile if applicable.
   - Refresh item state after successful apply so local media renders.

5. **Docs + manual QA**
   - Update README/docs language from automatic in-app archive.today probe to explicit opt-in.
   - Add QA checklist entries for metadata-only recovery, archive.today preview/apply, and no-network default behavior.