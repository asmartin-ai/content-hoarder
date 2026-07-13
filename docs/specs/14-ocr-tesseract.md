# Spec 14 — Image OCR via Tesseract (experimental)

**Status: PLAN on `feat/ocr-tesseract-experimental` (2026-07-12).**  
**Engine decision: Tesseract-first** (user lock-in). Local vision is icebox fallback only.  
**Branch is experimental** — no merge to `main` until the spike accuracy check + offline tests pass and the user reviews.

Related: GitHub #26, `docs/backlog/epic-12-search-operators-in-the-search-bar.md` (P3 OCR), bakeoff oracle CH-B3.

## Already shipped on main (do NOT re-implement)

The **search half** of #26 is done:

| Piece | Where | Behavior |
|---|---|---|
| `metadata.ocr_text` in search blob | `models._META_SEARCH_KEYS` + `build_search_text` | Non-empty `ocr_text` folds into `search_text` → FTS/trigram |
| `is:ocr` operator | `search_query.py` + `db.search_items(..., ocr=)` | Rows with truthy non-empty `json_extract(metadata,'$.ocr_text')` |
| Offline tests | `tests/test_ocr_search.py`, `tests/test_bakeoff_ch_b3_ocr_search.py` | Green on main |

**Gap:** nothing *writes* `metadata.ocr_text` yet. No CLI, no enrich pass, no engine binding.

## Goal

Opt-in, offline-testable OCR enrich pass:

1. Find items with **local image bytes** (prefer `metadata.archived_media` → `data/media/<blob>`).
2. Run Tesseract over each image (gallery = each frame).
3. Store extracted text on `metadata.ocr_text` (+ `metadata.ocr_at`, optional per-blob detail).
4. Rebuild `search_text` via existing `db` helpers so FTS picks it up.
5. Resumable: skip when `ocr_at` present and text non-empty (unless `--force`).

Bare queries then match words that only appear inside images. Cards stay free of OCR chrome (search-only) unless a later UI packet adds an affordance.

## Non-goals (this branch)

- Cloud OCR / uploaded images to a third party.
- Local vision / VLM path (icebox; only if Tesseract accuracy fails a documented sample).
- OCR of remote URLs without local archive (network + rate limits — later).
- Video OCR / subtitles.
- Redesigning search operators beyond optional `has:ocr` alias if useful.
- Touching live `data/app.db` during development — always a DB copy for apply smokes.

## Engine: Tesseract

| Choice | Detail |
|---|---|
| Binary | Tesseract 5.x on PATH (`tesseract --version`) |
| Python binding | `pytesseract` (optional extra, not a hard runtime dep) |
| Image decode | Pillow (`PIL.Image`) — optional extra |
| Language | `eng` default; `--lang` flag later |
| Config | `--psm 6` default for screenshots/blocks; allow override |
| Confidence | If mean confidence &lt; threshold (default ~40), store empty / skip stamp so retry is possible — exact threshold tuned in spike |

**Install (Windows, agent/user machine):**

```bash
# binary (pick one)
winget install --id UB-Mannheim.TesseractOCR
# or choco install tesseract

# python extras (proposed)
pip install -e ".[ocr]"
# where [ocr] = pytesseract + Pillow
```

Confirm: `tesseract --version` and `python -c "import pytesseract; print(pytesseract.get_tesseract_version())"`.

## Image byte source (decided for v1)

**Local archived blobs only.**

- Input: `metadata.archived_media` values that resolve via `media_store.path_for(blob)`.
- Include image-ish extensions: `.jpg/.jpeg/.png/.webp/.gif` (first frame of gif if trivial; else skip animated complexity in v1).
- **Exclude** `.mp4/.webm` (video path is separate).
- No network fetch in v1. Items without local media are skipped with reason `no_local_image`.

Rationale: Epic 4 already hoards bytes; OCR on CDN URLs would reintroduce deletion races and network flakiness. Matches local-first + offline tests.

## Data shape

On success (meaningful text after strip):

```json
{
  "ocr_text": "joined text from all frames…",
  "ocr_at": 1783890000,
  "ocr_engine": "tesseract",
  "ocr_engine_version": "5.x.x",
  "ocr_details": {
    "<blob-or-url-key>": {
      "blob": "abc….png",
      "chars": 120,
      "mean_confidence": 72.5,
      "lang": "eng"
    }
  }
}
```

Rules:

- `ocr_text` is the **only** field `build_search_text` / `is:ocr` care about (already true).
- `merge_upsert` must not clobber user triage fields (gotcha #2); OCR writes go through a dedicated helper similar to other metadata stamps (`db` merge that rebuilds `search_text`).
- Empty OCR (no glyphs / below confidence): do **not** set a truthy `ocr_text`; optionally set `ocr_at` + `ocr_skip_reason` so we don't hammer the same blob forever — or leave unset and rely on a "attempted" set. Prefer:

  - success with text → `ocr_text` + `ocr_at`
  - success with no text → `ocr_at` + `ocr_empty: true` (and `is:ocr` stays false because `ocr_text` absent/empty)
  - hard fail → count in run stats; no stamp (retry next run)

## Module / CLI sketch

```
src/content_hoarder/ocr.py          # pure-ish: candidate selection, run_ocr(path), apply
src/content_hoarder/cli.py          # `ocr` subcommand
pyproject.toml                      # optional-dependencies ocr = ["pytesseract", "Pillow"]
tests/test_ocr_enrich.py            # offline, fake engine injectable
fixtures/ocr/hello.png              # synthetic image with known text
```

### CLI

```bash
# dry-run (default): count candidates
python -m content_hoarder ocr --limit 20

# apply on a COPY
CONTENT_HOARDER_DB=data/app.ocr-smoke.db \
  python -m content_hoarder ocr --limit 20 --apply

# force re-OCR
python -m content_hoarder ocr --limit 5 --apply --force
```

Flags (mirror `archive-media` / enrich):

| Flag | Default | Meaning |
|---|---|---|
| `--limit N` | none | Cap items with work |
| `--apply` | off | Write metadata (dry-run default) |
| `--force` | off | Re-OCR even if `ocr_at` set |
| `--throttle` | 0 | Sleep between items (CPU politeness; usually 0) |
| `--min-confidence` | 40 | Drop results below this mean conf |
| `--lang` | eng | Tesseract language pack |

No `--yes` double gate needed: OCR is local CPU + metadata only (not external money/unsave). Still **never** develop against live DB without a copy for the first smokes.

### `ocr.py` responsibilities

1. `iter_candidates(conn, *, force=False)` → items with local image blobs and (if not force) missing/empty ocr.
2. `ocr_image(path, *, lang, min_confidence, engine=...) -> OcrResult` — injectable engine for tests.
3. `ocr_item(conn, fullname, ..., apply=False)` — load blobs, run engine, optionally `db` write + `search_text` rebuild.
4. `ocr_all(conn, **opts) -> stats` — batch with limit / fail_reasons.

**Connectors never touch the DB** still holds: this is a pipeline-adjacent service module (like `media_archive.py`), not a connector.

### Search_text rebuild

Use the same path other metadata writers use so FTS triggers fire:

- Prefer existing helper if one fits (`update_metadata` / merge that calls `build_search_text`).
- Do **not** hand-update `search_text` without going through `build_search_text`.
- FTS external-content gotcha (#1) does not apply to row updates via triggers — triggers already maintain `items_fts`. Don't run a full FTS rebuild for OCR.

## Implementation packets (branch order)

### P0 — Spike (half day, no product merge)

1. Install Tesseract + `pip install pytesseract Pillow`.
2. Hand-run on 10 local archived images (mix: screenshot, meme, UI capture, low-contrast).
3. Record a short table in this doc (or `docs/specs/14-ocr-spike-notes.md`): fullname, blob, chars, confidence, human "usable?" Y/N.
4. Gate: ≥7/10 usable for screenshot-like; meme text may be poor (document, don't block).

### P1 — Core enrich (main work)

1. Add `[project.optional-dependencies] ocr`.
2. Implement `ocr.py` with injectable `run_tesseract`.
3. CLI `ocr` dry-run / apply / limit / force.
4. Offline tests:
   - fixture PNG with known string "CONTENTHOARDER"
   - fake engine returns fixed text → metadata + `search_text` contains it
   - `is:ocr` returns the item
   - skip-if-present / `--force`
   - missing binary → clear error, no crash of other commands (lazy import)
5. `python -m pytest tests/test_ocr_enrich.py tests/test_ocr_search.py` green; full suite no regressions.

### P2 — Candidate quality

1. Skip tiny images (e.g. &lt; 80×80) as decorative.
2. Gallery: concatenate frame texts with newlines; cap total chars (e.g. 20k) to protect FTS.
3. Progress line on stderr; JSON summary like `archive-media`.

### P3 — Docs + NEXT (when ready to leave experimental)

1. README CLI table row for `ocr`.
2. Mark epic-12 OCR checkbox progress; note engine decision.
3. User runs first apply on DB copy, then live with `--limit`.

## Test plan (offline only)

```bash
python -m pytest tests/test_ocr_enrich.py tests/test_ocr_search.py tests/test_bakeoff_ch_b3_ocr_search.py
python -m pytest   # full unit suite; no network
```

UI tests: not required for P1 (no UI). Add later only if a "text from image" badge ships.

## Abort / defer criteria

- Tesseract install blocked on the machine → document winget failure; keep branch; don't invent a cloud fallback.
- Spike accuracy &lt; ~50% on screenshots → pause; consider `rapidocr`/`paddleocr` wheel or a narrow VLM retry path (new decision).
- Full-suite regressions in FTS → fix before any merge discussion.

## Security / privacy

- All local. No image bytes leave the machine.
- Fixtures must be synthetic (never real user screenshots in git).
- Smoke DB copies under `data/app.ocr-*.db` are gitignored via `*.db`.

## Literal first implementation step (when coding starts)

```bash
winget install --id UB-Mannheim.TesseractOCR
pip install pytesseract Pillow
tesseract --version
```

Then add `src/content_hoarder/ocr.py` skeleton + one failing test with a fake engine (TDD), before binding real pytesseract.

## Open items (non-blocking for P1)

1. `has:ocr` as alias of `is:ocr`? (nice-to-have)
2. Reader UI snippet "text found in image"? (separate frontend packet)
3. Auto-OCR after `archive-media` success? (default **no** — keep explicit CLI)
4. Non-English packs for specific subreddits? (later)

## Done-when (branch ready for review)

- [ ] Spike notes with sample accuracy
- [ ] `ocr` CLI dry-run + apply on DB copy
- [ ] Offline tests for enrich + existing search wiring green
- [ ] Lazy import: missing tesseract does not break `serve` / `init-db`
- [ ] This spec updated with any deviations
- [ ] User review before merge to `main`

## Spike note (2026-07-12)

Real Tesseract on fixture `fixtures/ocr/hello.png`:
- engine_version `5.4.0.20240606`
- text: `CONTENTHOARDER` (exact)
- mean_confidence: 69.0

Binary present at `C:\Program Files\Tesseract-OCR	esseract.exe`.
Full 10-image live-archive accuracy table still open (needs DB copy + sample pick).


## DB-copy smoke (2026-07-12)

```
CONTENT_HOARDER_DB=data/app.ocr-smoke-….db python -m content_hoarder ocr --limit 10 --apply
```

Result: **ocr_ok=8, empty=2, failed=0**. Live `data/app.db` mtime unchanged.
Sample recovered text includes meme/screenshot captions (e.g. ADHD meme, 4chan-style, Twitter screenshots).
Empty cases were photo-heavy posts with little glyph text (expected).
