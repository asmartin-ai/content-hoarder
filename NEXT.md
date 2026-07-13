# NEXT.md — content-hoarder session focus

Branch tip work is on **`feat/ocr-tesseract-experimental`** (uncommitted + this session's ready-to-code packet). Suite: **unit green** after OCR + splash + frontend static guards (2026-07-12).

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
1. **Review + commit** this branch (or split ops/docs vs OCR vs frontend if preferred).
2. **OCR real-engine spike** on 10 live archived images (`ocr --limit 10 --apply` on a DB copy) — record accuracy in spec 14.
3. **Full live `archive-media --videos`** only if you gate it (smoke already passed).

## Open / user-gated
- Unlimited live video archive.
- Pixel-6 / iPhone real-device QA.
- Merge experimental OCR branch after spike.

## Explicitly out
- App icon redesign (#19) — cancelled.
- Keyboard map rework (#14) — ignore.

## Icebox
- Life-OS fixtures; engagement Phase 1; local-vision OCR fallback; PKMS bakeoff.
