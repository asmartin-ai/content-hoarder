# Changelog

This project follows [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Drag-and-drop to status buckets on desktop (issue #13): rows and deck cards drag onto the
  Inbox/Keep/Archived/Done folders, reusing the existing status path (haptics, undo snackbar);
  deck drops advance the deck queue. Vanilla HTML5 DnD — no new runtime dependency.
- `assist-auto-archive` CLI (issue #25): lists high-skip subreddit buckets from the learned
  triage model with live inbox counts, and (with `--apply`) archives each via the reversible,
  wave-stamped decay path (`label='auto-archive'`, queryable via `is:decayed`).
- PKMS promote action (Spec 15, ADR 0027): the row menu's Promote affordance POSTs the item to
  PKMS via the opt-in bridge (`PKMS_CAPTURE_URL`/`PKMS_CAPTURE_TOKEN`); the deterministic
  capture answer (``saved ✓``/``already saved ✓``, deduped on `ch_item_id`) is stamped onto
  `metadata.promotion` with a lifecycle receipt, snackbared verbatim; errors toast
  `data.error` (unconfigured 400 / transport 502). Never reads or prints the token.
- `user_tags` registry + `tag create|list|rename|delete` CLI (Epic 26 P3, issue #70):
  pre-create empty tags (stable id + display name), rename across the whole vocabulary in one
  transaction (bulk rewrite of `tags_manual`/`tags`, FTS rebuild), delete-from-vocabulary;
  the derived vocabulary still surfaces unregistered stamps, so nothing drops out.

### Fixed

- Promote row-menu action was dead UI: `promoteItem` was dispatched but never defined
  (Spec 15 §7) — handler wired, `promoteItem` wrapper added to `core/api.js`, and the
  `[hidden]` attribute now honored by the relay buttons (`browse.css`).
- `bridge.pkms._note_name` no longer records a non-✓ 2xx body as the vault-path
  `delivery_ref`.
- PKMS promote: a 2xx body without the ``saved ✓``/``already saved ✓`` confirmation is now
  recorded ``failed`` (error set, no delivery_ref) instead of being stamped ``promoted`` —
  a partial receipt was previously presented as success and permanently blocked re-promote
  (Spec 15 §5/§1.6).
- `db.create_user_tag` masks only duplicate-name (UNIQUE) failures as "already exists";
  other DB errors propagate instead of being mislabeled.
- `db.rename_user_tag_in_vocab` rolls back the vocabulary row + item stamps on failure
  (matches `delete_user_tag`); docstring now matches the actual commit contract.
- SW cache + APP_VERSION bumped v128 → v129 (new static assets must not serve stale).

### Changed

- Repository relocated under `K:\Projects\khaos\` (2026-08-15 unification); all internal path
  references updated to the new parent; venv editable hook repointed to `src`.

### Fixed

- AGENTS.md layout map and both frontend-design skills no longer describe the retired v2 teal
  system or legacy `/triage` + `/reddit` pages — they are 302 redirects into the v3 surface.
- Triage state roles (`ready-for-agent` / `ready-for-human` / `needs-info`) applied across the
  open backlog; already-implemented issues #18 (Karakeep bridge) and #55 (unified surface)
  closed as wontfix.

## 1.1.0 - 2026-07-01

### Added

- Added inbox-only triage filtering by source, category, tags, and Smart/Newest/Random mode, with persisted filter state and stale-session clearing when filters change.
- Added cached Hacker News thread rendering in the browse reader, including synthetic UI coverage for nested HN comments.

### Changed

- Reworked the triage deck controls around the pinboard-style card shell, clearer edge hints, reader handoff affordances, and settings-menu theme controls.
- Hardened archive.today media recovery so media-only retries can skip metadata archive providers, and broadened the PWA shell cache for `/reddit`, triage tokens, reddit assets, and HLS playback.

### Fixed

- Stabilized the mobile browse header around both finger-fling momentum and floating up-button scroll-to-top: near-top swipes now smoothly scrub the header between compact and expanded states without clipping the Today indicator, the up button finishes at the true top, and reduced-motion preferences remain respected.

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
