# SPEC — RedGifs resolver dry-run wiring

> Snapshot as of 2026-06-28.

**Task ID:** `redgifs-resolver-dryrun`  
**Tier:** T2; suitable for headless Aider/DeepSeek after tests are treated as the oracle.  
**Status:** Implemented; targeted RedGifs oracle passes.  
**Source backlog:** `BACKLOG.md` Epic 4, `P2 — RedGifs resolver for the ~1,090 dead Gfycat links`.

## As-built outcome

`src/content_hoarder/redgifs_resolver.py` already existed before Batch B, and Batch B wired it into the CLI.
The shipped path includes:

- `extract_gfycat_id()`
- `gfycat_to_redgifs_id()`
- `_get_token()` using RedGifs temporary anonymous auth
- `resolve_gfycat()` against `/v2/gifs/<id>`
- `rewrite_item()` metadata rewrite
- `resolve_all()` scanning `metadata.media_url LIKE '%gfycat.com%'`
- `resolve-redgifs` CLI wiring in `src/content_hoarder/cli.py`
- README CLI documentation
- explicit `--redgifs-ok` network opt-in plus separate `--apply` write gate

Targeted oracle: `tests/test_redgifs_resolver.py` passes after the Batch B merge.

## User decisions

1. v1 is **metadata-only**. Do not archive bytes in this task.
2. v1 is **dry-run by default**.
3. Any live RedGifs API lookup requires an explicit opt-in flag such as `--redgifs-ok` / `--nsfw-ok`.
4. `--apply` is separate from lookup opt-in. A safe live preview is allowed with `--redgifs-ok` and no `--apply`.

## Files in scope

Expected:

- `src/content_hoarder/redgifs_resolver.py`
- `src/content_hoarder/cli.py`
- `tests/test_redgifs_resolver.py`
- `README.md` CLI table, if adding a user-facing command
- `BACKLOG.md` only if T1 asks you to update status wording after implementation

Do **not** touch:

- archive.today provider or `archival/service.py`
- `media_archive.py` byte storage
- `data/media/`
- live DB files
- unrelated import/recovery code

## Implemented CLI

```bash
python -m content_hoarder resolve-redgifs [--limit N] [--redgifs-ok] [--apply]
```

Behavior:

1. Without `--redgifs-ok`, do **no network**. Return/count candidate rows and print a refusal/next-step message.
2. With `--redgifs-ok` and without `--apply`, do live RedGifs lookups and report would-change samples, but do not write.
3. With both `--redgifs-ok --apply`, rewrite metadata for resolved rows only.
4. Keep metadata-only writes:
   - `metadata.media_url`
   - `metadata.media_type = "redgifs_video"` or existing module value
   - `metadata.thumbnail` if poster exists
   - `metadata.redgifs_url`
   - `metadata.gfycat_id`
   - `metadata.media_resolved_at`
   - `metadata.media_resolved_from = "redgifs"`
5. Preserve triage/user state and all unrelated metadata keys.
6. Return JSON summary with at least `total`, `resolved`, `failed`, `dry_run`, and `samples`.

## Hardening shipped

- Existing monkeypatch seams were sufficient; tests stay offline.
- Tests prove:
  1. CLI/parser exposes the command.
  2. No `--redgifs-ok` means no network function is called.
  3. Dry-run with opt-in does not rewrite item metadata.
  4. `--apply --redgifs-ok` rewrites only intended metadata keys while preserving triage/user state.
  5. Existing RedGifs resolver tests still pass.
- No `requests`/`httpx` dependency was added; project convention remains stdlib `urllib`.

## Validation

Run:

```bash
python -m pytest tests/test_redgifs_resolver.py -q
python -m pytest -q -m "not ui"
```

If the broad suite hits the known Windows UNC SQLite failures, report them separately and prove the targeted RedGifs tests pass.

## Delegation lesson

This task was a good headless/delegated-executor shape because it had a tight offline oracle and a small write set.
The safer split remains the pattern for future similar tasks:

1. T1 writes/locks failing tests for the desired CLI behavior.
2. A weaker executor implements only the bounded source/docs changes until the tests pass.
3. T1 verifies applied edits, git status scope, oracle integrity, and targeted tests before merging.
