# Spec 08 — Hydrate real titles for "(untitled)" Reddit comments

> ✅ **SHIPPED 2026-06-15** (Phase 1 local backfill + Phase 2 network recovery; merges `5ef7c9b` + `0fda16f`,
> on main). This doc is now the build record. Branch `feat/reddit-title-hydration` (off `staging/session-2026-06-14`).
> Supersedes the body-snippet stopgap committed as `73e16ab`.

BACKLOG: bug — inbox shows "(untitled)" Reddit items. Touches: `data/app.db` (one-time
backfill), `static/browse/render.js`, `static/triage.js`, `static/browse/main.js`,
optionally `connectors/reddit.py` (forward-fix) + a new CLI for phase 2.

## Goal

The "(untitled)" Reddit inbox items are **saved comments**, not posts — a comment has no
`title`, so ingestion left it empty. The meaningful title is the **post the comment is on**
(`submission_title`). Restore real titles so each item reads: **real post title on top, the
saved comment text as the snippet beneath** (normal layout — no body-as-title).

## The data (profiled 2026-06-14, live DB — 147 title-less reddit items: 129 inbox + 18 archived)

| Bucket | Count | Source of truth | Recovery |
|---|---|---|---|
| Legacy (mislabeled `t3_`/`kind=post`, custom import shape) | **106** | `raw_json.submission_title` present | **Local backfill** — instant, offline |
| Proper `t1_` comments (cleaner import, 18 in decay system) | 41 | `metadata.permalink` only (slug is a `_` placeholder); no `raw_json` | **Network re-fetch** of `link_title` |
| Truly empty (no title-source, no body) | 3 | — | Deleted; leave "(untitled)" |

Dry-run of the 106 was clean: 51 subreddits, all genuine titles (min len 3 `"Yes"`, max 273,
avg 62; 12 repeats = multiple comments saved off one thread). List: `O:\Temp\ch_title_dryrun.tsv`
(ephemeral — regenerate from `raw_json.submission_title`). `submission_title` appears **nowhere
in src** → legacy import (likely Karakeep per `metadata.karakeep_id` merge logic), so **no active
code path regenerates these** and the backfill won't be undone by a harvest.

## Phase 1 — local backfill (106) + render revert  ← the recommended first cut

1. **Back up first** — `data/app.db` → timestamped copy (mirror `cmd_delete`'s `conn.backup()`).
   High-blast: writes `title` on live user data; the backup is the rollback.
2. **Backfill (idempotent, additive):** for each `source='reddit'` row with `trim(title)=''`
   and a non-empty `json_extract(raw_json,'$.submission_title')`, set `title` = that value.
   **Only fills empty titles — never overwrites.** ~106 rows.
3. **Revert the `73e16ab` body-snippet hack** (now redundant — titles are real):
   - `browse/render.js`: drop the `displayTitle` body-snippet branch (keep `title` → `"(untitled)"`);
     remove the `snippet()` suppression guard so the comment body shows as the snippet again.
   - `triage.js` `cardHtml`: drop the `snip` title fallback (`:242-243`); remove the
     `tcard-snippet` suppression guard (`:263`) so body shows beneath the real title.
   - `browse/main.js` surprise (`:369`): `displayTitle(it)` → `it.title || "(untitled)"`.
   - Bump `sw.js` cache (`ch-shell-vNN`).

## Phase 2 — network backfill (41), optional follow-up

A `reddit-hydrate-titles` CLI: for `t1_` comments with empty title + a permalink, fetch the
submission's `link_title`. Reuse the archive providers (`archival/providers.py`,
spec 03 / `254cb91`) — often authless, and recover deleted threads too. Key on the base36
submission id in `metadata.permalink`. Back up the DB first; fill empty titles only.

## Forward-fix (only if a live path ever produces title-less comments)

`connectors/reddit.py:149` `child_to_item` sets `title=d.get("title") or _title_from_permalink(permalink)`.
For comments add the standard Reddit field: `... or d.get("link_title") or d.get("submission_title") ...`
before the permalink fallback. (Current standard-API saved comments DO carry a permalink, so they
get a slug title today, not "(untitled)" — verify before changing; the 147 are legacy, not from this path.)

## Verification
- Backfill: assert N rows updated == count of (empty-title reddit with submission_title); re-query
  a sample and confirm `title` now equals the expected `submission_title`; confirm 0 rows had a
  non-empty title overwritten.
- Render: preview-verify (`claude-preview-verify`, DB copy) — a hydrated comment shows the post
  title in `.title` AND its body in `.snippet`/`.tcard-snippet` (both present, not duplicated).
- pytest full-suite green vs baseline.

## Gotchas
- Back up `data/app.db` before any write (the running 8788 server holds it; WAL + `busy_timeout`).
- Idempotent: re-running must not double-apply or touch already-titled rows.
- The 3 truly-empty items intentionally stay "(untitled)" — that's correct, not a miss.
- Long titles (max 273) rely on CSS clamp for display; full value preserved in data.
