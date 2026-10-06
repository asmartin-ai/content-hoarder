> **Historical snapshot (2026-07-12):** branch status, check results, and task availability below are no longer current. The project now uses Bun/TypeScript; current setup and commands are in [`README.md`](../README.md), and the current offline check is `bun run check`.

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
| Media mirror scripts | **Done** — `/path/to/backup/media` |
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
bun run check
# focused:
bun test tests/ocr.test.ts tests/connectors.test.ts
```

## Locked decisions

| Topic | Decision |
|---|---|
| Media mirror | `/path/to/backup/media` |
| OCR engine | Tesseract-first |
| Video auth | OAuth |
