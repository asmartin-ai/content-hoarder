# Spec 07 — Import the remaining Firefox TabExports (data job)

> ✅ **DONE 2026-06-14** — verified no-op (`254cb91`-era): all 163 files were already imported in a prior session, 0 new rows, backup retained. Dossier kept for history.

BACKLOG: Epic 7 #135. Branch: `chore/import-tabexports`. Touches: NO product code (a CLI data job) —
but it **writes the live `data/app.db`**, so back up first. RUN LAST and separately from the code specs.

## Goal
Import the ~163 daily Firefox TabExport files into the live DB. They overlap heavily and dedup by URL,
so this is idempotent — the point is to fold in tabs from files never imported (only 1 sample was imported originally).

## Confirmed facts
- Files: **`C:\Users\Kenja\Downloads\TabExports\`** — **163** `*_ExportTabsURLs.txt` files (2023-05 → 2026-02).
  Filenames contain spaces — quote/escape paths.
- The firefox connector is **single-file only**: `can_import` requires `p.is_file()` + the header
  `"Export Tabs URLs"` (`firefox.py:95-103`); `import_file` reads one `.txt` (`:105-130`). So a directory
  import is NOT walked by the connector — **loop per-file**.
- Dedup is automatic: non-YouTube tabs → `source_id = sha1(_norm_url(url))[:16]` (`firefox.py:132-150`);
  `_norm_url` lowercases scheme+host, strips trailing slash + `#fragment`, keeps query (`:31-38`). YouTube
  tabs promote to `youtube:<vid>`. Overlapping URLs collapse to the same `fullname` →
  `db.merge_upsert` treats repeats as non-destructive updates (`db.py:340-407`), never touching
  `status`/`is_saved`/`first_seen_utc`.
- `import` writes live with no dry-run and **no built-in backup** (`cli.py:28-37`).

## Acceptance criteria
- A timestamped backup of `data/app.db` exists BEFORE any import (mirror `cmd_delete`'s `conn.backup()`).
- All 163 files imported via `import <file> --source firefox` (looped); per-file and total
  imported/skipped/errors counts reported.
- Spot-check: total item count rises by the number of genuinely-new unique tabs; re-running a file a
  second time imports 0 new (idempotent). No `status`/`is_saved` regressions on pre-existing items
  (merge_upsert guarantees this — verify with a before/after count of non-inbox items).
- The live DB is intact and openable after.

## Procedure (the overnight run executes this)
1. **Backup:** copy `cmd_delete`'s pattern (`cli.py:287-292`) — `conn.backup()` to
   `data/app.backup-pre-tabexports-<stamp>.db`. Record the byte size + an item count.
2. **Baseline:** `python -m content_hoarder stats` (or a count query) — record total items + saved count.
3. **Import loop** (PowerShell, paths quoted):
   `Get-ChildItem "C:\Users\Kenja\Downloads\TabExports\*_ExportTabsURLs.txt" | ForEach-Object {
     python -m content_hoarder import $_.FullName --source firefox }`
   Capture stdout (each line `imported=… skipped=… errors=…`); sum them.
4. **Verify:** re-run `stats`; confirm the delta is plausible (new uniques), errors≈0; open the app
   (`serve`) and confirm the Firefox source tab shows the imported tabs. Re-import ONE file → expect
   `imported=0` (idempotency proof).
5. Report totals + the backup path. Do NOT delete the backup.

## Gotchas
- This is the ONLY spec that mutates live data — keep it last, after the code branches are done, so a
  code failure never leaves a half-imported DB.
- Some old files may have a slightly different timestamp format in the name (space vs underscore) — the
  glob `*_ExportTabsURLs.txt` matches all; the connector keys on the header, not the filename.
- If any file errors (encoding/format), log it and continue; don't abort the whole loop.
- Don't enrich during import (skip `--enrich`) — keep it a pure, fast fold-in; enrich later if wanted.
