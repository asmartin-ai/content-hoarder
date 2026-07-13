# NEXT.md — content-hoarder session focus

Checkout: **`feat/lightbox-caption-blurbs`** (clean). `main` tracks origin/main (spec 13 tip).  
Open PRs (public): **#75** OCR experimental · **#76** #74 reader fix · **#77** captions/blurbs.

## Just done (this session)

### Ops / decisions
- Media mirror dest **`F:\Backups\content-hoarder\media`**: `scripts/mirror-media.bat` + verify.
- Video archive smoke **passed** (DB copy, OAuth, limit 1). Live DB untouched.
- **#19** app icon redesign **cancelled** (issue closed).
- Keyboard rework (#14): ignore. Design side plan: `docs/design/SIDE-DESIGN-PLAN.md`.

### Code / PRs
| PR | Branch | What |
|---|---|---|
| #75 | `feat/ocr-tesseract-experimental` | OCR CLI + splash + browse gaps + mirror scripts |
| #76 | `fix/74-comment-reader-empty` | Honest empty/auth reader + t3 dual-key cache + seed comment |
| #77 | `feat/lightbox-caption-blurbs` | #32 caption, #31 blurbs, #39 guard/chip |

### Investigations
- #30 video — needs repro: `docs/bugs/30-video-not-fetching.md`
- #46 scrollbar — spec-ready: `docs/bugs/46-mobile-scrollbar.md`
- #70 user_tags — design note: `docs/bugs/70-user-tag-table.md`
- #39 — mostly fixed: `docs/bugs/39-text-post-play-button.md`

Local smoke DBs (gitignored, deletable): `data/app.ocr-smoke-*.db`, `data/app.videosmoke-*-min.db`.

## Next 1–3 actions
1. Review/merge PRs: **#76** → **#77** → **#75**.
2. Optional solo: **#46** fastscroll from `docs/specs/mobile-scrollbar.md`.
3. **#30** only after a failing fullname is provided.

## Explicitly out
App icon · keyboard map · unlimited live video archive without gate · live OCR apply without DB copy.

## Icebox
Life-OS fixtures · engagement Phase 1 · local-vision OCR · full user_tags until go-ahead.
