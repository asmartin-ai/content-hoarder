# Changelog

This project follows [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html).

## 1.0.0 - 2026-06-29

### Release posture

- First SemVer-stable local release of content-hoarder as a local-first saved-content triage tool.
- The app remains intentionally local-only: SQLite database, local media store, and optional external integrations gated by explicit commands/settings.

### Highlights

- Unified saved-content import/search/triage across Reddit, YouTube, Hacker News, Obsidian, Google Keep, Firefox tabs, Twitter/X bookmark exports, and related local sources.
- v3 browse surface with source/status filtering, search operators, bulk actions, reader/lightbox overlays, mobile PWA support, and service-worker shell caching.
- Reddit media recovery and preservation path: scan deleted media, archive local bytes, prefer same-origin archived media, and per-item archive.today recovery for already-gone media.
- Reddit OAuth support, saved-list sync, cached discussion/thread hydration, and guarded Reddit unsave-on-Done workflow.
- Deterministic offline tests plus Pixel-6/PWA Playwright coverage for the mobile interaction paths.

### Fixed for 1.0.0

- Fixed lightbox blank-space drags scrolling the inbox behind the overlay.
- Fixed long-press relay menu activation shifting the pressed row under the finger.
- Fixed hold-to-preview image peeks panning/zooming into empty space, including full-viewport zoom bounds and transform reset between opens.
- Removed the mobile per-row `Decide` button; row triage remains available via gestures, keyboard, row menus, and existing action paths.
- Hardened async gallery hydration so a late response cannot reopen the lightbox after the user closes it.

### Notes

- `data/media/` is gitignored and is not contained in metadata-only DB backups; back it up separately if local media archival matters.
- Browser/PWA asset cache is versioned separately by the service-worker cache name and visible app build badge.
