# READY-TO-CODE — startable engineering work

Snapshot: **2026-07-12** after the ready-to-code sweep on `feat/ocr-tesseract-experimental`.

## Shipped this sweep (branch)

| Packet | Status |
|---|---|
| iOS splash screens | **Done** — `static/splashes/*`, head links, v120 |
| Spec 04 HN author in browse | **Done** (article chip was already on main) |
| Spec 05 reddit image → thread | **Done** |
| Spec 06 Sync newest header control | **Done** (settings control already existed; triage drain N/A post-P3.5) |
| OCR Tesseract enrich P1 | **Done offline** — `ocr` CLI + tests; real-image accuracy spike still open |
| Media mirror scripts | **Done** — `F:\Backups\content-hoarder\media` |
| Video smoke | **Passed** (limit-1, DB copy) |

## Do not pick up

| Item | Status |
|---|---|
| App icon redesign (#19) | Cancelled |
| Keyboard map rework (#14) | Ignore |

## Still ready / next

| Task | Notes |
|---|---|
| OCR accuracy spike (P0 notes) | Run real Tesseract on ~10 archived images; update spec 14 |
| Commit/split branch | Ops + frontend + OCR currently one branch |
| Full video archive | User-gated |
| Real-device QA | Pixel-6 / iPhone |

## Verification

```bash
python -m pytest
# focused:
python -m pytest tests/test_ocr_enrich.py tests/test_browse_ready_static.py
```

## Locked decisions

| Topic | Decision |
|---|---|
| Media mirror | `F:\Backups\content-hoarder\media` |
| OCR engine | Tesseract-first |
| Video auth | OAuth |
