# Epic 9 bulk-unsave by tag

## Goal

Ship a safe, end-to-end flow for removing a tag-defined set of Reddit items from the user's real Reddit Saved list, starting with the `nsfw_erotic` migration use case and keeping `nsfw_talk` or other tags as explicit follow-up choices.

The feature should reuse the existing `reddit_unsave` queue/drain architecture:

1. Select saved Reddit items by tag.
2. Preview the exact local queue scope.
3. Queue only after explicit confirmation.
4. Drain to Reddit only through the existing live-write path, with a separate explicit live confirmation.
5. Preserve auditability, reversibility before drain, and the `is_saved` invariant for bulk paths.

Done-when criterion: a user can preview `tag=nsfw_erotic`, confirm a local enqueue, review the drain plan, then run a capped live drain with explicit double confirmation; every live Reddit mutation is audited and all tests remain offline/deterministic.

## Confirmed current state

Confirmed from the current codebase:

- `docs/reddit-unsave.md` defines the architecture: marking Reddit items Done enqueues locally; a separate drain mutates Reddit; success marks queue rows `done`, sets `items.is_saved = 0`, and appends `data/unsave-audit.jsonl`. It also states that `is_saved` means “still in your Reddit Saved list” and is flipped only after confirmed unsave in normal drain paths.
- `src/content_hoarder/db.py` has the `reddit_unsave` table and helpers:
  - `enqueue_unsave(conn, fullname)` queues one Reddit `t1_`/`t3_` item idempotently.
  - `dequeue_unsave(conn, fullname)` cancels still-pending unsaves.
  - `enqueue_existing_done(conn)` backfills Done Reddit items.
  - `preview_unsave_by_tag(conn, tag)` already previews by tag with mutually exclusive skips: `non_reddit`, `already_unsaved`, `invalid_id`, `already_queued`.
  - `enqueue_unsave_by_tag(conn, tag, dry_run=False)` already queues matching eligible rows locally and does **not** contact Reddit.
- `src/content_hoarder/reddit_unsave.py` has the drain implementation:
  - `drain(..., dry_run=True)` returns a machine-readable plan with `selected`, `by_subreddit`, and a sample.
  - Live drain selects pending rows, sends `/api/unsave` or OAuth save-scope writes, marks `reddit_unsave.state='done'`, flips `items.is_saved=0`, commits per item, and audits each successful unsave.
  - Auth/network failures leave queue rows intact; per-item failures increment attempts and can park rows as `failed`.
- CLI drain is already mostly aligned with the money-action safety pattern:
  - `python -m content_hoarder reddit-unsave --drain` is dry-run by default.
  - `--live` without `--yes` refuses after printing the dry-run plan.
  - `--live --yes` is required for the live bulk drain.
  - `--trickle` is a separate bounded, opted-in lane for scheduled small drains.
- Web routes already include:
  - `GET /reddit/unsave/status`
  - `POST /reddit/unsave/auth`
  - `POST /reddit/unsave/enable`
  - `POST /reddit/unsave/drain`
  - `POST /reddit/unsave/enqueue-by-tag`
  - `POST /reddit/items/<fullname>/unsave`
  - `POST /reddit/items/<fullname>/undo`
- `/reddit/unsave/enqueue-by-tag` currently defaults to dry-run unless the request has `confirm`, `apply`, or `dry_run: false`; confirmed apply calls `db.enqueue_unsave_by_tag` and returns a message saying Reddit is not contacted until drain.
- `/reddit` UI already has a “Queue tag unsaves” button. `src/content_hoarder/static/reddit.js` requires exactly one selected tag, previews `/reddit/unsave/enqueue-by-tag`, uses `window.confirm`, then applies local queueing.
- Tests already exist for partial bulk-by-tag behavior:
  - `tests/test_unsave_by_tag.py` covers DB preview/apply/idempotency and skip buckets.
  - `tests/test_reddit_view.py::test_unsave_by_tag_route_previews_then_confirms` covers the route default preview and confirm path.
  - `tests/test_reddit_unsave.py` covers drain dry-run, live drain, auth/network errors, audit, OAuth preference, retry/backoff, and resave.
  - `scripts/smoke_test.py` has a read-only in-memory “Unsave-by-tag preview” smoke check.

Important confirmed gaps / footguns:

- The web drain route `POST /reddit/unsave/drain` currently performs a live drain immediately, with a capped request size and audit, but without the same dry-run/default + double-confirm gate as the CLI.
- `src/content_hoarder/static/triage.js` calls `/reddit/unsave/drain` directly from the “Unsave queued” button. That means a UI click can mutate Reddit without an explicit preview/double-confirm in the request shape.
- `src/content_hoarder/static/core/api.js` exposes `unsaveDrain(limit)` as a live POST helper, also without a safety-gated body shape.
- The per-item `/reddit/items/<fullname>/unsave` route optimistically flips `is_saved=0` at enqueue time for UI state. Do **not** copy this pattern into bulk-by-tag. Bulk queueing must leave `is_saved=1` until a confirmed drain succeeds.
- The current by-tag queue rows do not carry a durable `batch_id`/selector. Immediate UI undo can be built from the response, but durable “cancel this bulk batch later” needs either schema metadata or a conservative cancel-by-selector flow.

## Safety model

Apply the money-action safety pattern to the external Reddit mutation path, with the local queue treated as reversible intent and drain treated as the live action.

### Two-stage action model

1. **Local queue stage — reversible, no network**
   - Default behavior is preview only.
   - Confirmed queueing writes only to SQLite.
   - It must never contact Reddit.
   - It must never flip `items.is_saved` for bulk-by-tag.
   - It should return machine-readable counts, skip buckets, and a sample/list.

2. **Live drain stage — mutates real Reddit Saved list**
   - Default behavior is dry-run preview.
   - Live execution requires two explicit confirmations, matching CLI semantics:
     - CLI: `--live --yes`
     - HTTP: body fields such as `{ "live": true, "confirm": true }` or `{ "live": true, "yes": true }`
   - `live` without `confirm/yes` must refuse with non-2xx or explicit `ok:false`, while returning the same dry-run plan.
   - No blocking stdin/browser-prompt-only gate should be the only safety mechanism; requests must be self-describing and safe if replayed without both live flags.

### Blast-radius bounds

- Enqueue preview should show:
  - tag
  - matched local rows
  - eligible rows
  - skipped counts
  - first N sample rows with `fullname`, `reddit_id`, `title`, `subreddit`, `kind`, and maybe `created_utc`/`saved_utc`/`first_seen_utc`
  - whether the list is truncated
- Enqueue apply should support a maximum cap for large tags, e.g. `max=500` initially, or at least refuse/require stronger confirmation above a threshold.
- Live drain should keep the existing hard cap per web request and should prefer smaller default batches. Current web route caps at 500; keep or reduce default to 50, but require explicit `limit/max` in UI for larger runs.
- Do not auto-drain after by-tag enqueue. The user must initiate each live drain batch separately.
- Do not silently include all tags if multiple tags are selected. For Epic 9, require exactly one tag unless a future design explicitly adds OR/AND semantics.

### Audit and machine-readable results

- Keep existing per-live-unsave audit records in `data/unsave-audit.jsonl`.
- Extend audit records if needed with queue provenance fields when available: `batch_id`, `queued_reason`, `selector`, or `tag`.
- Add a local queue audit trail for bulk enqueue operations, either:
  - append `queue_preview` / `queue_apply` records to a separate `unsave-queue-audit.jsonl`, or
  - add a small `reddit_unsave_batches` table and include `batch_id` on queue rows.
- Every route/CLI path should return JSON/dicts with stable keys; UI should render from those keys, not parse prose.

### Human approval and no stdin prompts

- CLI should never call `input()` for this feature.
- Web UI may use a dialog/modal for ergonomics, but the server must still require explicit confirmation fields.
- Approval for queueing a tag does not imply approval for draining it.
- Approval for one drain batch does not imply approval for later batches.

## Proposed UX/API

### Selection semantics

Use local tag membership from `metadata.tags`:

- Initial scope: exactly one tag, exact match against `json_each(metadata, '$.tags')`.
- Eligible rows:
  - `source='reddit'`
  - `is_saved=1` according to the local DB
  - `source_id` starts with `t1_` or `t3_`
  - no existing `reddit_unsave` queue row, or only no active pending row if the implementation chooses to distinguish done/failed states later
- Skip rows:
  - non-Reddit
  - locally already unsaved (`is_saved != 1`)
  - invalid Reddit thing id
  - already queued
- Sorting: deterministic, e.g. newest saved/synced first or existing DB order. Use the same order in preview and apply so the preview is the confirmation surface.
- Staleness note: `is_saved=1` means “locally believed saved.” A user who wants maximum accuracy before a large run should run Reddit sync/reconcile first; drain itself remains idempotent because Reddit unsave of an already-unsaved item is a no-op.

### Reddit management UI (`/reddit`)

Keep the current basic flow, but strengthen it:

1. User selects exactly one tag in the tag filter.
2. “Queue tag unsaves” opens a real preview panel/modal rather than only `window.confirm`.
3. Preview panel shows:
   - “This queues locally only. Reddit will not be contacted.”
   - tag name
   - eligible count
   - skipped counts
   - sample of items
   - warning that `is_saved` will not change until drain succeeds
4. Confirm button sends `POST /reddit/unsave/enqueue-by-tag` with an explicit apply field.
5. Result panel shows:
   - enqueued count
   - pending total
   - batch id if implemented
   - “Cancel this queued batch” while pending
   - “Review drain preview” as a separate next action
6. Drain preview requires a separate button/action and shows the pending queue scope using `/reddit/unsave/drain` dry-run mode.
7. Live drain requires another explicit confirmation. Prefer a modal with a typed phrase for large batches, but the server gate should be `{live:true, confirm:true}` regardless of UI.

### Triage UI

Current triage “Unsave queued” button is convenient but unsafe as a direct live-write trigger.

Plan:

- Change its first click to request a drain dry-run preview.
- Display selected count, sample, and pending total.
- Require an explicit second action to live-drain the current capped batch.
- Send `{live:true, confirm:true, max:N}` only after confirmation.
- If user cancels, nothing is sent.
- If auth fails, keep queue intact and show the existing session-expired message.

### CLI shape

Keep existing drain CLI exactly as the live mutation path:

```bash
python -m content_hoarder reddit-unsave --drain                 # dry-run plan
python -m content_hoarder reddit-unsave --drain --live          # refuse, print plan
python -m content_hoarder reddit-unsave --drain --live --yes    # live drain
```

Add a local-only by-tag queueing CLI, reusing the same subcommand:

```bash
python -m content_hoarder reddit-unsave --enqueue-by-tag nsfw_erotic
python -m content_hoarder reddit-unsave --enqueue-by-tag nsfw_erotic --apply --yes
```

Recommended semantics:

- Bare `--enqueue-by-tag TAG` = preview only, exit 0, JSON output if `--json` exists or default pretty JSON.
- `--apply` without `--yes` = refuse after printing preview.
- `--apply --yes` = local queue only, no Reddit network, no `is_saved` flip.
- Do not add a one-command “enqueue and live-drain tag” shortcut for Epic 9. Keeping queue and live drain separate is the safer interface.

Optional later convenience, only if truly needed:

```bash
python -m content_hoarder reddit-unsave --enqueue-by-tag nsfw_erotic --apply --yes
python -m content_hoarder reddit-unsave --drain --limit 50 --live --yes
```

### HTTP/API shape

#### Existing by-tag route

Keep route name:

```http
POST /reddit/unsave/enqueue-by-tag
```

Recommended request/response:

```json
{
  "tag": "nsfw_erotic",
  "dry_run": true,
  "max": 500
}
```

```json
{
  "dry_run": true,
  "confirmed": false,
  "tag": "nsfw_erotic",
  "matched": 123,
  "eligible": 100,
  "enqueued": 0,
  "skipped": {
    "non_reddit": 2,
    "already_unsaved": 10,
    "invalid_id": 1,
    "already_queued": 10
  },
  "sample": [...],
  "fullnames": [...],
  "truncated": false,
  "message": "This only queues local unsaves. Reddit is not contacted until drain."
}
```

Confirmed apply:

```json
{
  "tag": "nsfw_erotic",
  "apply": true,
  "yes": true,
  "max": 500
}
```

or keep current `{ "confirm": true }`, but document it and test that `dry_run:false` alone is not too easy to trigger accidentally. Prefer requiring `apply && yes` for CLI parity.

#### Web drain route

Change the route to safe-by-default:

```http
POST /reddit/unsave/drain
```

Default request or `{ "dry_run": true }` returns preview only.

```json
{
  "dry_run": true,
  "selected": 50,
  "by_subreddit": { "example": 12 },
  "sample": [...],
  "remaining": 250,
  "live_required": ["live", "confirm"]
}
```

Live request:

```json
{
  "live": true,
  "confirm": true,
  "max": 50
}
```

`live:true` without `confirm:true` should refuse while returning the plan.

### Undo / cancel path

Before drain:

- Pending queue rows are reversible. Existing `dequeue_unsave` supports item-level cancellation.
- For bulk-by-tag, add a durable cancel mechanism rather than relying only on current tag selection.

Recommended additive design:

- Add nullable queue provenance to `reddit_unsave` rows:
  - `batch_id TEXT`
  - `queued_reason TEXT` such as `tag`
  - `queued_selector TEXT` JSON such as `{ "tag": "nsfw_erotic" }`
- `enqueue_unsave_by_tag` assigns one `batch_id` to newly inserted rows and returns it.
- Add `db.cancel_unsave_batch(conn, batch_id)` that deletes only `state='pending'` rows for that batch and returns `{cancelled, already_drained, missing}`.
- Add route `POST /reddit/unsave/cancel-batch` with `{batch_id}`.
- UI shows “Cancel this queued batch” after enqueue until any drain starts.

If schema changes are deferred, minimum safe fallback:

- Return the newly enqueued `fullnames` from apply.
- UI can immediately call an item-list cancel endpoint for those fullnames.
- Do **not** implement “cancel all pending with this tag” unless the preview clearly distinguishes rows from previous/manual queues and requires confirmation; otherwise it may cancel unrelated Done-generated pending unsaves.

After drain:

- Existing undo/resave path is best-effort live re-save for rows with `reddit_unsave.state='done'`.
- Bulk UI should not promise full undo after drain; phrase it as “already drained items require live re-save and may fail if auth expired.”

## Implementation plan

No code should be implemented until this plan is accepted. Suggested implementation sequence:

1. **Lock the contract with tests first**
   - Add failing tests for the current web drain safety gap:
     - bare `POST /reddit/unsave/drain` returns dry-run and sends no network
     - `{live:true}` without confirm refuses and sends no network
     - `{live:true, confirm:true}` drains with injected fake transport and audits successes
   - Add route tests for by-tag requiring explicit apply confirmation if changing from `confirm` to `apply+yes`.
   - Add regression that bulk-by-tag enqueue does not update `items.is_saved`.

2. **Harden `/reddit/unsave/drain`**
   - Make dry-run the default for HTTP, matching CLI.
   - Accept `max` and/or `limit`; normalize to one bounded integer.
   - Require both live fields for actual drain.
   - Return plan/refusal JSON on missing confirmation.
   - Keep audit appender on live path.
   - Update `core/api.js` so callers must pass an explicit body; avoid a helper that defaults to live.

3. **Clean up by-tag enqueue API**
   - Decide whether to keep current `{confirm:true}` or move to `{apply:true, yes:true}`.
   - Keep existing DB helpers if sufficient; they already cover most selection semantics.
   - Add preview sample rows beyond `fullnames` so the confirmation surface is useful.
   - Add optional `max`/cap support if large tags are expected.
   - Ensure preview and apply share the same deterministic selection order.
   - Keep local enqueue idempotent and no-network.

4. **Add batch provenance/cancel if in scope**
   - Add nullable schema columns or a small batch table.
   - Return `batch_id` from confirmed by-tag enqueue.
   - Add DB and route helper to cancel pending rows for that batch only.
   - Add UI “Cancel queued batch” action.

5. **Update `/reddit` UI flow**
   - Replace `window.confirm`-only preview with a visible panel/modal or at least richer inline confirmation.
   - Show eligible/skipped/sample and “local queue only” copy.
   - After queue, offer “Review drain preview” but do not auto-drain.
   - Update button disabled/loading states and error handling.

6. **Update triage drain flow**
   - Make “Unsave queued” open/retrieve a dry-run preview first.
   - Require a second explicit confirmation before live drain.
   - Send `{live:true, confirm:true, max:N}` only from the confirmed action.
   - Keep auth/network failure handling as-is, but make clear that queue remains pending.

7. **Add CLI by-tag queueing**
   - Add `reddit-unsave --enqueue-by-tag TAG` preview.
   - Add `--apply --yes` for local queue apply.
   - Print JSON summary; no stdin prompts.
   - Do not combine with live drain in the same command.

8. **Documentation cleanup**
   - Update `docs/reddit-unsave.md` with by-tag flow:
     - preview
     - local queue confirmation
     - drain preview
     - live drain confirmation
     - cancel-before-drain behavior
   - Update README CLI table if adding `--enqueue-by-tag`.
   - Update `docs/reddit-management.md` if route list/semantics change.
   - Note that no live drain should be run in tests or delegated work.

## Tests and validation

All automated tests should stay offline and deterministic. Do not run live Reddit unsave/drain actions during implementation validation.

### Unit / route tests

Add or update tests around:

- `tests/test_unsave_by_tag.py`
  - exact tag selection
  - one eligible saved Reddit item enqueued
  - non-Reddit skipped
  - `is_saved=0` skipped
  - invalid ids skipped
  - already queued skipped
  - dry-run sends no writes
  - apply is idempotent
  - bulk enqueue does not flip `is_saved`
  - optional cap/truncation semantics
- `tests/test_reddit_view.py`
  - `/reddit/unsave/enqueue-by-tag` preview default
  - confirmed apply requires explicit confirmation shape
  - missing tag returns 400
  - route response includes message/sample/batch id if implemented
  - cancel batch removes only pending rows from that batch
- `tests/test_reddit_unsave.py`
  - existing drain tests should continue to pass
  - add HTTP-route coverage elsewhere for web drain dry-run default/refusal/live confirm
  - live route tests must use injected/fake transport, never real Reddit
- `tests/test_reddit_autosync.py` or related sync tests, if any `is_saved` semantics change:
  - ensure reconcile still flips `is_saved=0` only after confirmed absent-from-complete-walk logic
  - ensure merge/upsert still preserves `is_saved`

### UI tests

Because `/reddit` is a UI surface and project rules call out mobile/PWA verification for UI changes:

- Add at least one Playwright/UI regression if practical:
  - select one tag
  - click “Queue tag unsaves”
  - verify preview appears and no queue row is created until confirm
  - confirm queue and verify status text
  - click drain preview and verify no live drain request is sent without the live confirmation body
- If Playwright setup is unavailable locally, record that explicitly and run the Python route/unit tests.

### Suggested validation commands

Targeted first:

```bash
python -m pytest tests/test_unsave_by_tag.py tests/test_reddit_view.py tests/test_reddit_unsave.py
```

If web drain route/UI changes touch broader app behavior:

```bash
python -m pytest
```

If UI changes are made and Playwright is available:

```bash
python -m pytest -m ui
```

Optional read-only smoke, safe because it uses an in-memory copy for the by-tag preview section:

```bash
python scripts/smoke_test.py
```

Do **not** validate with:

```bash
python -m content_hoarder reddit-unsave --drain --live --yes
```

unless the user explicitly approves a specific live drain after reviewing a dry-run plan.

## Risks / open questions

- **Web drain route is the biggest immediate safety gap.** It currently mutates Reddit on bare POST. Fix before presenting bulk-by-tag as production-ready.
- **`is_saved` staleness cuts both ways.** If the local DB says `is_saved=1` but Reddit was already unsaved elsewhere, the drain is harmless/no-op and will reconcile local state after success. If the local DB says `is_saved=0` but Reddit is actually still saved, by-tag preview will skip it. Recommend running Reddit sync/reconcile before large migrations.
- **Per-item optimistic `is_saved=0` is an existing exception.** Bulk-by-tag should not repeat it. Consider a future cleanup to separate “queued for unsave” UI state from “confirmed unsaved on Reddit.”
- **Batch cancel needs provenance.** Without `batch_id`, a cancel-by-tag operation can accidentally remove pending queue rows from Done triage or older queue batches. Prefer batch metadata before shipping a durable cancel button.
- **Large tags may create long drains.** Keep web drain capped and resumable. Let users repeat approved batches rather than one unbounded request.
- **Current `already_queued` check treats any queue row as already queued.** This is safe/idempotent, but it means failed/done historical rows may block requeue in unusual stale states. Confirm desired behavior before changing; `resave` currently deletes completed queue rows on successful re-save.
- **OAuth vs cookie transport.** Existing drain chooses OAuth when configured and cookie otherwise. No by-tag code should bypass this; only the drain should choose transport.
- **Audit granularity.** Existing live audit logs each successful unsave but may not record the originating tag. Decide whether tag/batch provenance is worth adding now or later.
- **Confirmation wording.** Browser `window.confirm` is quick but weak for a high-impact action. A modal with counts/sample is safer and more accessible.

## Suggested delegation slices

1. **Safety gate slice: web drain parity with CLI**
   - Add tests proving bare `/reddit/unsave/drain` is dry-run and live requires double confirmation.
   - Implement only the route/helper changes needed for parity.
   - No UI work, no live Reddit.

2. **By-tag contract slice: DB/API cleanup**
   - Keep existing `preview_unsave_by_tag` / `enqueue_unsave_by_tag` and add missing sample/cap/is_saved tests.
   - Optionally add `batch_id` provenance and cancel helper.
   - No UI work, no live Reddit.

3. **Reddit UI slice: queue preview panel**
   - Replace `window.confirm` flow with visible preview/result UI on `/reddit`.
   - Wire cancel/review-drain affordances if backend exists.
   - Add route/UI tests where feasible.

4. **Triage UI slice: safe drain confirmation**
   - Update “Unsave queued” to preview first and require a second explicit live confirmation.
   - Ensure request body includes `live:true` and `confirm:true` only after user approval.
   - Add regression coverage for no live POST on first click.

5. **CLI/docs slice**
   - Add `reddit-unsave --enqueue-by-tag TAG` preview and `--apply --yes` local enqueue.
   - Update README and `docs/reddit-unsave.md`.
   - Validate with targeted offline tests only.
