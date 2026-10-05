# Spec 14 — Image OCR via Tesseract

**Status: shipped** in the Bun + TypeScript runtime. The former Python implementation notes and private-database accuracy sample have been removed; tests and fixtures use synthetic images and temporary databases only.

## Behavior

The `ocr` command extracts text from local archived images. It does not fetch remote media. Candidates are `items` rows with valid image blobs in `metadata.archived_media`; video blobs are excluded. By default, an item with `ocr_at` and either non-empty `ocr_text` or `ocr_empty` is skipped. `--force` retries it.

Tesseract reads the first frame after ImageMagick converts the image to a temporary PNG. Images with a side shorter than 80 pixels are skipped. Text below the mean-confidence threshold is treated as empty. Text from qualifying blobs is joined, capped at 20,000 characters, and written to `metadata.ocr_text`; an empty result is stamped with `ocr_empty`. OCR also stores `ocr_at`, engine/version, and per-blob details. Updating the metadata rebuilds `search_text`, so OCR text is searchable and `is:ocr` can select items with OCR text.

The default engine uses `tesseract` and `magick` executables found on `PATH`. The process uses argument arrays, not a shell. Temporary conversion files are removed after each image. No OCR service, Python runtime, Pillow, or `yt-dlp` is used.

## CLI

```sh
bun run src/cli.ts ocr --limit 20
bun run src/cli.ts ocr --limit 20 --apply
bun run src/cli.ts ocr --limit 5 --apply --force --lang eng --min-confidence 40
```

The default is dry-run. `--apply` writes OCR metadata; `--force` retries previously processed items; `--limit` caps items that need OCR; `--lang` defaults to `eng`; `--min-confidence` defaults to `40`; and `--throttle` defaults to `0` seconds and applies only during an apply run. JSON results are printed to stdout, a dry-run/apply summary to stderr, and the command exits nonzero when any item fails.

Install Bun as described by the [project quickstart](../../README.md). OCR also requires Tesseract and ImageMagick on `PATH`; without either executable, processing reports failures and the CLI returns nonzero.

## Implementation and coverage

- `src/ocr.ts` owns candidate selection, Tesseract TSV parsing, conversion, metadata updates, and batch results.
- `src/cli.ts` exposes `ocr` and its flags.
- `tests/ocr.test.ts` covers TSV parsing, threshold/empty behavior, metadata/search updates, and resumability using temporary SQLite and synthetic fixtures.
- `fixtures/ocr/` contains synthetic test images; do not add personal screenshots or live database samples.

OCR remains an explicit command; archiving media does not start OCR automatically. Remote images, video/subtitle OCR, cloud engines, UI OCR badges, and additional language-pack management are outside this feature.
