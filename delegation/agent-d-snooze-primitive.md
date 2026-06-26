# Agent D — Snooze backend primitive (`metadata.snoozed_until`) + escalation

> **Sandbox-safe.** Backend only; no network, no external APIs, no live DB. `:memory:` SQLite +
> synthetic fixtures. Mirrors the shipped `decay`/`undecay` wave machinery.

## Context (from BACKLOG.md Epic 5 #184 + Epic 20 #1245)

A first-class **Snooze** triage action: "I don't want to decide right now." This is the
**backend primitive** — the data model, the search operator, the batch exclusion, and the
decay escalation. The *gesture binding* (long-left swipe) and the *UI button* are **separate,
visual-review-gated items — do NOT build them**; this agent ships the backend they'll call.

Two distinct behaviors the backlog splits (build both primitives; the UI decides which to
wire):
- **Snooze** = a *timed* deferral that hides the item from triage batches for a window
  (`metadata.snoozed_until`), then quietly resurfaces it.
- **Repeated snoozes are themselves a decision:** after N snoozes (~3) the item flows into the
  Epic 21 guilt-free decay path (auto-archive + stamp, reversible, no guilt copy).

Honors the project guardrails: **friction-asymmetry** (snooze is priced above Done/Archive,
never the cheapest gesture — that's a UI concern, but the backend must make repeat-snooze
*visible* so the UI can price it), and **no guilt mechanics** (no "snoozed 3×!" badges — the
backend stores a count but never mandates a badge; the escalation is silent decay).

## Write scope (only these)

- `src/content_hoarder/db.py` — `snooze()` / `unsnooze()` primitives + snooze-exclusion in
  batch selection + snooze-count bookkeeping
- `src/content_hoarder/search_query.py` — `is:snoozed` operator
- `src/content_hoarder/resurface.py` — the escalation hook (after N snoozes → decay)
- `src/content_hoarder/cli.py` — **one** new subcommand `snooze` mirroring the `decay` CLI's
  money-action safety shape. **Append your argparse setup at the END** of the existing
  argparse block (Agent B also adds a subcommand; both append-disjoint, land one before the
  other if editing the same working copy).

**Do not touch** any frontend file, `web.py` routes (a route can be a thin follow-up — out of
scope here), connectors, or `note_youtube.py`. The model is `metadata`-only (no schema change,
per the Epic 21 precedent: decay stamps metadata, never a new column).

## What exists (verified anchors — read these first — MIRROR these patterns)

- `db.py` `decay(conn, *, tags, subreddits, before_utc, source, label, apply, …)` (~line 1382)
  and `undecay(conn, *, decayed_after, decayed_before, …)` (~line 1487) — **the template for
  snooze.** Read both fully. Key invariants to copy:
  - **Unique monotonic stamp** via `_allocate_decay_wave` (NOT bare `now`) so two snooze-waves
    in the same second are independently reversible. Add an equivalent `_allocate_snooze_wave`
    (or reuse the decay-wave allocator if it's truly generic — read it).
  - **Direct UPDATE, never `bulk_set_status`** — so a mass snooze can never enqueue a live
    Reddit unsave (the decay-safety invariant, oracle-pinned). Snoozing does NOT change
    `status`; it only stamps metadata and excludes from batches. Snoozed items stay `inbox`.
  - Dry-run default; `--apply` gate; returns the same shape dry + applied.
- `db.py` `_STRIP_DECAY_SQL` (~line 1232) = `"json_remove(metadata, '$.decayed_at',
  '$.decay_label')"`. Snooze needs the equivalent: on any **manual** status transition (per-item
  ↩, set_status, bulk) the snooze marks must be stripped (a rescued/decided item must not
  reappear as snoozed). Mirror how decay marks are stripped on manual transitions — find every
  site that strips decay marks and add snooze stripping there too.
- `db.py` `get_random_batch(...)` (~line 913) — the triage batch selector. **Snoozed items
  must be excluded** (`snoozed_until` in the future). Add the exclusion here (and anywhere
  else inbox batches are pulled — grep for `status='inbox'` batch queries).
- `search_query.py` — the `is:` operator family. `is:decayed` (~line 247) and `is:swept`
  (~line 248) are the exact template. Add `is:snoozed`. `ParsedQuery` (dataclass ~line 39)
  gets a `snoozed: bool = False` field; the parser sets it; `db.search_items` adds the filter
  (`json_extract(metadata, '$.snoozed_until') > <now>`). Mirror the decayed/swept wiring
  end-to-end (parser → ParsedQuery → search_items filter → operator autocomplete vocab in
  `static/browse/operators.js` is **frontend — do NOT touch**; leave a note for the follow-up).
- `resurface.py` `letgo()` / `undo_letgo()` (~line 152/166) — the decay entry points. The
  snooze-escalation hook: after N snoozes, call into the decay path. Read how `letgo` stamps
  `metadata.decayed_at` so your escalation produces the same reversible shape.
- `cli.py` `cmd_decay` / `cmd_purge_done` — the money-action CLI shape (dry-run default,
  `--apply` + `--yes` gate, auto-backup, audit jsonl). Mirror it for `snooze`.

## Build

### 1. `db.py` — snooze primitives

- `def snooze(conn, *, fullnames: list[str], until_utc: int, window_days: int = 7,
  escalate_after: int = 3, apply: bool = False) -> dict`:
  - Stamps `metadata.snoozed_until = until_utc` and increments `metadata.snooze_count` (starts
    at 0/missing → 1) on each of `fullnames`. Refuses an empty list. Only `inbox` items
    (snoozing a non-inbox item is a no-op or error — pick error, document it).
  - **Escalation:** if `snooze_count >= escalate_after` for an item, route it to decay instead
    (call the decay path with a snooze-specific `label='snooze-escalated'` so it's
    distinguishable + reversible + queryable). Do NOT enqueue unsaves (decay invariant). The
    item leaves inbox via the decay path; record it in the return shape
    (`escalated: [fullnames…]`).
  - **Wave id:** unique monotonic (mirror `_allocate_decay_wave`) so `unsnooze` reverses one
    wave, not everything in a time window. Stamp `metadata.snoozed_at = <wave>`? No — the
    reversal key is the *count + until*, but to support "undo the snooze I just did" you need
    a wave id like decay. Decide + document: simplest reversible shape is a `snoozed_wave`
    stamp mirror of `decayed_at`. Read how `undecay` selects by wave and mirror it.
  - Dry-run default; `apply` does the writes. Returns `{total, applied, until_utc,
    window_days, escalated: [...], sample: [...]}`.
- `def unsnooze(conn, *, snoozed_wave: int | None = None, fullnames: list[str] | None = None,
  apply: bool = False) -> dict`: reverses one wave (by `snoozed_wave`) OR specific fullnames.
  Clears `snoozed_until` (and decrements `snooze_count`? — decide + document; probably
  **don't** decrement, the count is a cumulative signal, only manual status transition fully
  resets it). Mirror `undecay`'s safety (never enqueue unsaves).
- **Batch exclusion:** in `get_random_batch` (and any other inbox-batch query), add
  `AND (json_extract(metadata, '$.snoozed_until') IS NULL OR json_extract(metadata,
  '$.snoozed_until') <= ?)` with `now`. So snoozed items don't appear in triage until their
  window passes. **An item whose `snoozed_until` is now in the past should naturally
  resurface** — clear `snoozed_until` lazily when it's selected again, or leave it and let the
  operator filter handle it. Decide + document; lazy-clear on next batch select is cleanest.
- **Strip on manual transition:** everywhere decay marks are stripped (`_STRIP_DECAY_SQL`
  sites + any `status_prev`/`set_status` paths), also strip `snoozed_until` (keep
  `snooze_count` — it's a historical signal, or strip it too if the item is decisively
  processed; match what decay does with its own marks on manual transition).

### 2. `search_query.py` — `is:snoozed`

- `ParsedQuery.snoozed: bool = False`; parser recognizes `is:snoozed`; `db.search_items`
  filter: `snoozed_until > now` (currently-snoozed). Add a sibling `is:snoozed-ever`? No — keep
  it to the one operator the backlog asks for; the count is exposed via metadata if needed.

### 3. `resurface.py` — escalation wiring

- A function (e.g. `escalate_snoozed(conn, *, now, apply)`) that scans for items whose
  `snooze_count >= escalate_after` and routes them through the decay path with
  `label='snooze-escalated'`. This is the "repeated snoozes are a decision" hook. It can be
  called from the `snooze` CLI as a separate `--escalate` pass or inline during `snooze`
  (step 1 above already does per-item escalation; this is the bulk sweep for items that
  reached the threshold across multiple snooze calls). Keep it reversible + no-guilt (silent).

### 4. `cli.py` — `snooze` subcommand

- `python -m content_hoarder snooze [--fullname FN …] [--until <utc>|--window-days N]
  [--escalate-after N] [--apply] [--yes] [--undo --wave <id>]` — mirror `decay`'s safety
  shape: dry-run default, `--apply` + `--yes` double-gate, auto-backup before apply,
  `data/snooze-audit.jsonl`. `--undo` reverses a wave (calls `unsnooze`).
- Append the argparse subparser at the **end** of the existing argparse block.

## Guardrails (AGENTS.md — load-bearing)

- **merge_upsert is non-destructive** (gotcha #2): a re-import must not clobber
  `snoozed_until` / `snooze_count`. These are user/triage-state metadata keys — add them to
  whatever set `merge_upsert` preserves across re-imports (find where `decayed_at` /
  `decay_label` are preserved and add the snooze keys there). **This is the #1 risk** — a
  later reddit sync must not wipe a user's snooze.
- **Direct UPDATE, never `bulk_set_status`** — the decay-safety invariant (a mass snooze /
  escalation must never enqueue a live Reddit unsave). Oracle-pinned for decay; mirror it.
- **No new schema column** — metadata-only, like decay.
- **Synchronous** — plain functions, no async.
- **No network**, no live DB in tests.
- Snoozing does **not** change `status` (items stay `inbox`); it's a within-inbox visibility
  flag. Escalation *does* change status (via the decay path → `archived`).

## Tests (the oracle)

Add `tests/test_snooze.py` (`:memory:` SQLite, synthetic rows via `models.new_item`, mirror
`tests/test_decay*.py`):

1. `snooze(apply=False)` → dry-run, **writes nothing**, returns the planned shape.
2. `snooze(apply=True)` on N inbox items → each gets `snoozed_until` + `snooze_count=1`; items
   **excluded** from `get_random_batch` until the window passes; **status still `inbox`**.
3. **Window expiry:** with `now` advanced past `snoozed_until`, the item reappears in
   `get_random_batch` (lazy-clear works, or the filter lets it through — assert the behavior
   you implemented).
4. **Wave reversal:** `snooze` twice (two waves), `unsnooze(wave=first)` → only the first
   wave's items un-snoozed; second wave intact (mirrors the decay-wave oracle test,
   `db.decay` B1 fix).
5. **Escalation:** an item snoozed `escalate_after` times → routed to decay
   (`status='archived'`, `metadata.decayed_at` set, `decay_label='snooze-escalated'`);
   reversible via the decay `undecay` path. **No `reddit_unsave` row enqueued** (the
   invariant — assert the `reddit_unsave` table is empty after escalation).
6. **Strip on manual transition:** a snoozed item, set to `done` via the normal status path →
   `snoozed_until` stripped (decided items don't resurface as snoozed). Mirror the decay-strip
   test.
7. **merge_upsert survives re-import:** snooze an item, then `merge_upsert` the same
   `fullname` with fresh incoming metadata → `snoozed_until`/`snooze_count` **preserved**
   (gotcha #2 — the #1 risk).
8. `is:snoozed` search operator: only currently-snoozed items match; expired/expired-snoozed
   don't.

`python -m pytest` stays green vs baseline.

## Out of scope (do not build)

- The swipe gesture (long-left = Snooze) — Epic 20 #1245, visual-review-gated.
- The Snooze UI button + keyboard key — Epic 5 #184 frontend half.
- The "timed Defer" UI surface / quiet resurface marker — Epic 5/16 frontend.
- A web route (`POST /items/<fn>/snooze`) — thin follow-up once the primitive is reviewed; not
  needed for the backend to be correct + tested.
- The 4-directional vertical-axis gestures (Epic 20 #1256) — separate.

## Done when

- `db.snooze` / `db.unsnooze` exist, mirror `decay`/`undecay`'s safety (direct UPDATE,
  monotonic wave, dry-run default, reversible), and exclude snoozed items from triage batches.
- `is:snoozed` works on browse + `/reddit` (parser → search_items); frontend autocomplete is
  noted as a follow-up, not built.
- Escalation after N snoozes routes through decay (`snooze-escalated` label), reversible, no
  unsave enqueued.
- `merge_upsert` preserves snooze state across re-import (oracle test #7 — the #1 risk).
- `snooze` CLI in the money-action shape; `snooze-audit.jsonl`.
- New tests + full suite green vs baseline.
- Committed on `feat/snooze-primitive`; not pushed/merged.
