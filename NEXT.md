# NEXT.md — content-hoarder session focus

Branch **`feat/ocr-tesseract-experimental`** pushed (`bd84c0f`+). Suite green. Docs follow-ups: OCR accuracy table, README `ocr` row, #74 diagnosis, design side plan.

## Just done (2026-07-12 — ready-to-code sweep)

### Ops (earlier same day)
- Media mirror dest **`F:\Backups\content-hoarder\media`** — `scripts/mirror-media.bat` + verify script.
- Video archive smoke **PASSED** (DB copy, OAuth, limit 1) → `8ef9217d…531e.mp4`.
- Specs 10/11 status updated; `docs/READY-TO-CODE.md` written.

### Code (this sweep)
- **iOS splash screens** — 11 PNGs under `static/splashes/` + `apple-touch-startup-image` links in `index.html`.
- **Spec 04 gap** — browse `metaHtml` now links HN (and reddit) author; article chip already on main.
- **Spec 05** — reddit image + permalink → reader/thread (not bare image) in `openMediaFor`.
- **Spec 06 gap** — header `#btn-sync-newest` + `api.redditSync`; settings "Sync newest" shared `runSyncNewest`. Triage drain relabel N/A (P3.5 retired `/triage`).
- **OCR P1** — `src/content_hoarder/ocr.py`, CLI `ocr`, optional `[ocr]` extra, offline tests with injectable engine. Plan: `docs/specs/14-ocr-tesseract.md`.
- Cache bump **v119 → v120** (`sw.js` + `APP_VERSION`).

## Next 1-3 actions
1. **Review + merge PR** for `feat/ocr-tesseract-experimental` when ready.
2. **#74 fix P0** — honest reader empty/auth states (`docs/bugs/74-reddit-comments-empty-reader.md`).
3. **Full live `archive-media --videos`** only if you gate it (smoke already passed).

## Open / user-gated
- Unlimited live video archive.
- Pixel-6 / iPhone real-device QA.
- Merge experimental OCR branch after spike.

## Design side-track
See `docs/design/SIDE-DESIGN-PLAN.md` — weekly 45‑min decision slots; no design thrash on ship branches.

## Explicitly out
- App icon redesign (#19) — cancelled.
- Keyboard map rework (#14) — ignore.

## Icebox
- Life-OS fixtures; engagement Phase 1; local-vision OCR fallback; PKMS bakeoff.
