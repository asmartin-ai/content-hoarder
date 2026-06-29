# Next delegation plan

Snapshot: 2026-06-29 after GitHub Issues migration.

## Current state

- Active backlog work now lives in GitHub Issues: <https://github.com/asmartin-ai/content-hoarder/issues>
- `BACKLOG.md` is a compact epic/issue index.
- Full historical/as-built context is split under `docs/backlog/`.
- `docs/backlog/github-issues.json` maps migrated backlog keys to issue numbers/URLs.

Confirmed shipped and folded into local history before migration:

- RedGifs resolver (`resolve-redgifs`) with dry-run default and explicit network/apply gates.
- HN/Firefox tag precision expansion with `metadata.tags_auto` provenance.
- Triage swipe consolidation onto shared `core/swipe.js`.
- Archive.today recovery opt-in: generic Recover is metadata-only; archive.today requires explicit per-item confirmation.
- `archive-media --videos` explicit opt-in path for `v.redd.it` video bytes.
- Firefox local/manual tab ingest endpoint and `firefox-token` setup command.
- Bulk unsave-by-tag local queueing and web drain safety gates.
- Scroll-to-top/top-bar stabilization for mobile browse; physical-device feel still needs QA.

## Immediate T1 gates / good next issues

1. **Real-device mobile QA pass** on Pixel-6-class Chrome PWA.
   - Start from issues #35–#43 and #48.
   - Check: hold-to-preview, physical pinch, zoomed pan clamp, 1× swipe-to-close, reader no-feed-refresh, drawer/sheet scroll-lock, tag editor no-keyboard path, and scroll-to-top/fling feel.
   - Output: either “verified” in the relevant issue or one new issue/comment per finding with a repro.
2. **Any live media/archive smoke must use a DB copy.**
   - Issue #11: local media archiving follow-ups.
   - `archive.today`: use the script's no-network plan first; live/apply only with explicit gates.
   - `v.redd.it`: verify `yt-dlp`/`ffmpeg` on one representative copied-DB item before any larger pass.
3. **Any live Reddit unsave drain must use preview first.**
   - Queue-by-tag is local/reversible; drain is the real external action and requires the explicit live confirmation shape.

## Ready implementation tasks after approval/input

| Issue | Tier | Blocker / input | Suggested scope |
|---|---:|---|---|
| #14 Keyboard map rework | T2 | User approves or edits the Gmail-aligned proposal. | Browse/triage key handlers, cheatsheet, focused tests. |
| #15 Watch Later / WL3 import | T2 | Representative export sample and decision: one-shot import vs recurring workflow. | YouTube connector/parser fixture tests. |
| #19 App icon redesign | T3 after visual decision | Approved backwards-E/H mark asset direction. | `static/icon.svg`, PNG icons, manifest, cache bump. |
| #49 Mobile `/reddit` view | T1-led design first | Decide whether to improve `/reddit` or accelerate Epic 17 unification. | Design proposal before code. |
| #26 OCR image text search | T1-led spike | Pick engine path: Tesseract vs local vision model; sample accuracy. | Enrich pass + FTS/search wiring after decision. |

## Research-only / defer

- **Firefox Sync account-backed tabs:** no issue was created because the local manual ingest path already solves the near-term need; only revisit if account-backed cross-device sync becomes necessary.
- **Stable-height top chrome redesign:** only start if real-device QA still finds scroll/top-bar feel bad after the conservative stabilization (#48).
- **Durable unsave batch IDs/cancel-by-batch:** defer unless the pending queue UX proves insufficient.

## Parallelization rules

1. Do not run two agents against `browse/main.js`, `core/media.js`, `core/swipe.js`, or `browse.css` at the same time unless line scopes are split.
2. UI/asset changes must state any `sw.js` / `APP_VERSION` cache bump they made.
3. Backend tasks should add targeted tests first where possible, then run the narrowest relevant suite.
4. For sandboxed/offline delegated agents, include the issue body in the prompt and point to the relevant `docs/backlog/epic-*.md` file; do not assume GitHub access.
