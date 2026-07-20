# Audit: public vs private repo + doc fold/delete candidates

**Date: 2026-07-19 late-p.m. session.** Status: **PROPOSED, not yet acted on.** Apply the changes
in a separate session when the user has time to review.

## 1. Public/private audit

### Current state

| Remote | Tip | Behind/ahead of local? | Action needed |
|---|---|---|---|
| `origin/main` (public) | `55a775f` (PR #76 squash-merge) | in sync with local `ea45011` (1 commit ahead of `55a775f`) | `git push origin main` (after deciding the squash-merge caveat, see below) |
| `private/main` (private) | `3669b6e` (pre-PR #76) | 2 commits behind (`55a775f` + `ea45011`) | `git push private main` (user-gated; canonical-public model says yes) |

### Local branches vs remotes

| Branch | Local | origin | private | Notes |
|---|---|---|---|---|
| `main` | ea45011 | 55a775f | 3669b6e | local is 1 ahead of origin (NEXT.md update), 2 ahead of private |
| `fix/74-comment-reader-empty` | (gone after merge) | 65d18d3 (orphan) | (gone) | PR was merged; remote can be deleted: `git push origin :fix/74-comment-reader-empty` |
| `archive/bakeoff-arm-wip` | ✓ | — | ✓ | local-only + private mirror; never public |
| `feat/ios-splash-screens` (private) | — | — | ✓ (orphan) | merged into main long ago via `e48c47e`; can be deleted on private |
| `feat/p3.5-legacy-retirement` (private) | — | — | ✓ (orphan) | merged into main long ago via `efc4f5c`; can be deleted on private |
| `feat/ios-pwa` | — | ✓ (orphan) | ✓ (orphan) | merged; both remotes can delete |
| `feat/lightbox-caption-blurbs` | — | ✓ | ✓ | active feature branch (PR #77) |
| `feat/ocr-tesseract-experimental` | — | ✓ | ✓ | active feature branch (PR #75) |
| `feature/anki-connect-card-source` | — | ✓ | — | research spike; never made private |
| `feature/llm-triage-verdicts` | — | ✓ | — | research spike; never made private |
| `feat/fix-ui-preregression` | ✓ | — | — | local-only; unmerged work — name suggests abandoned |
| `docs/life-os-fixture-pointer` | ✓ | — | — | local-only branch; purpose unclear |
| `feature/anki-connect-card-source` | ✓ | ✓ | — | local + origin only |

### "Canonical-public" model — boundary check

The repo uses the **canonical-public model**: history is shared; private is a mirror with extra
branches. The sensitive material (live DB, exports, NSFW rules, etc.) is gitignored at the path
level, never scrubbed from history. Per `docs/PUBLISH-SAFETY.md`, the public repo is
already safe to push.

**No privacy boundary leaks found.** The private-only branches are either (a) archive markers
(`archive/bakeoff-arm-wip`), (b) orphan post-merge branches (deleted work, kept as branches on
private only), or (c) ephemeral research spikes that simply never made it to public.

### Recommended actions

1. **Delete orphan branches on both remotes** to reduce noise (after user OK):
   ```
   git push origin :fix/74-comment-reader-empty
   git push origin :feat/ios-pwa
   git push private :fix/74-comment-reader-empty
   git push private :feat/ios-pwa
   git push private :feat/ios-splash-screens
   git push private :feat/p3.5-legacy-retirement
   ```
2. **Push local main to both remotes** (user-gated per AGENTS.md):
   ```
   git push origin main
   git push private main
   ```
3. **Investigate the local-only branches** (`feat/fix-ui-preregression`, `docs/life-os-fixture-pointer`,
   the local copy of `feature/anki-connect-card-source`) — these are pre-existing pre-session, not
   in the late-p.m. audit scope; mention for the user's next session.

### Squash-merge caveat (PR #76)

The squash-merge of PR #76 on `55a775f` bundled my 3 late-p.m. commits (corruption test refactor,
video-archive launcher, Spec 10 cadence closeout) along with PR #76's 2 commits. Cause: the
`ch-pr76` worktree's `git rebase` was run against `main` (local, which had the 3 commits) instead
of `origin/main` (which was at `3669b6e` and didn't have them).

**Code is correct** — 1054 unit tests pass on `55a775f`, CI green, all 8 tests in
`tests/test_issue_74_comment_thread.py` pass. **History is just compressed**: those 3 commits
aren't visible in `git log` on origin/main — they're inlined into the "Fix #74" commit.

To restore clean history, the next session can:
```
git revert -m 1 55a775f           # revert the squash-merge
# 3 separate commits on top:
git cherry-pick <the-3-commit-ids-from-reflog>
# (PR #76 was the merge, so its content is the 2 commits that were squashed; cherry-pick each separately)
git push origin main --force-with-lease
```

This is a non-trivial history rewrite. Recommend doing it ONLY if the user values clean history
over the simplicity of leaving it.

## 2. Doc fold / delete audit

### Categories

| Category | Count | Action | Examples |
|---|---|---|---|
| **Active reference** (current, useful) | ~12 | KEEP | AGENTS.md, README.md, CHANGELOG.md, NEXT.md, PRODUCT.md, DESIGN.md, BACKLOG.md, IMPORTING.md, MOBILE_TAILSCALE.md, PUBLISH-SAFETY.md, QA-CHECKLIST.md, `docs/engagement/README.md` |
| **Post-implementation retrospective** (one-time records, can be folded into CHANGELOG) | ~7 | FOLD into CHANGELOG + delete | `docs/parallel-run-2026-06-12.md` (session notes), `docs/app-css-audit-2026-06-26.md` (for deleted `app.css`), `docs/thread-hydration-feasibility.md` (planning doc for shipped feature), `docs/specs/46-fastscroll-jitter-fix-spec.md` (shipped, `docs/bugs/46-*.md` covers it), `docs/specs/46-fastscroll-scrub-loads-plan.md` (shipped, `docs/bugs/46-fastscroll-scrub-loads.md` covers it), `docs/specs/mobile-scrollbar.md` (superseded by `docs/bugs/46-mobile-scrollbar.md`), `docs/specs/triage-swipe-consolidation.md` (shipped, retrospective only) |
| **Already-marked shipped but still in `docs/specs/`** | ~3 | ADD a "STATUS: SHIPPED" banner or move to `docs/specs/_shipped/` | `docs/specs/09-devstral-batch.md` (509 lines — bulk dev), `docs/specs/parity-ideas.md` (suggestions, not yet queued) |
| **Epic retrospectives (every checkbox done)** | ~5 | FOLD into CHANGELOG + delete (or move to `docs/backlog/_archive/`) | `docs/backlog/epic-19-backend-hardening.md`, `docs/backlog/epic-09-reddit-merge-follow-ups.md`, etc. — all the "epic-NN-..." files that say "Shipped 2026-..." with all `[x]` checkboxes |
| **Handoff files (transient, post-session)** | 2 | DELETE | `handoff-p3.4.md`, `handoff-p3.5.md` (session handoffs that are now historical) |
| **Personal/private-flavored research** | ~10 | **MOVE TO PRIVATE** (per `PUBLISH-SAFETY.md`, these reference the user's ADHD, identity, personal habits) | `docs/engagement/` (10 files: README + A1-A4, B5-B6, C7-C8, D9) — explicitly discusses "your future self's calm", ADHD, etc. The synthesis is gold but should be private. |
| **Design reference (study material)** | ~5 | KEEP, but add "study only, not a current roadmap" banner | `docs/design/reddit-thumbnail-cropping.md`, `docs/design/mobile-nav-redesign/*` (4 files + README), `docs/design/inline-reddit-reader/spec.md` (already self-marked "shipped + design rationale") |
| **Bug retrospectives** | 3 | KEEP | `docs/bugs/46-fastscroll-scrub-loads.md`, `docs/bugs/46-mobile-scrollbar.md`, `docs/bugs/74-reddit-comments-empty-reader.md` — useful for next time we touch the same area |
| **Bakeoff / research artifacts** | 4 | MOVE TO PRIVATE or archive | `bakeoff/Content-Hoarder-Bakeoff-Plan.md` (386 lines), `bakeoff/RESULTS.md`, `bakeoff/STATUS-REPORT.md`, `bakeoff/results.csv` — research, not product. The `.bat` test files in `tests/test_bakeoff_*.py` are also research artifacts (4 files). |

### Recommended doc moves (concrete)

**Move to private (`git mv` on a private-only branch or to `private/` remote, then delete on public):**

```
docs/engagement/                  # 10 files, all reference the user's ADHD + personal habits
bakeoff/                          # research artifacts
```

**Delete (post-implementation, content folded into CHANGELOG):**

```
docs/parallel-run-2026-06-12.md
docs/app-css-audit-2026-06-26.md
docs/thread-hydration-feasibility.md
docs/specs/46-fastscroll-jitter-fix-spec.md
docs/specs/46-fastscroll-scrub-loads-plan.md
docs/specs/mobile-scrollbar.md
docs/specs/triage-swipe-consolidation.md
docs/specs/parity-ideas.md         # suggestions, not yet queued; park in an issue instead
handoff-p3.4.md
handoff-p3.5.md
```

**Fold (mark as shipped-banner, add to CHANGELOG):**

```
docs/specs/09-devstral-batch.md     # 509 lines, the devstral bakeoff plan - keep, add banner
docs/specs/12-unify-one-surface.md  # 168 lines, mostly shipped, add banner
docs/specs/13-ios-pwa-installability.md  # 122 lines, shipped, add banner
```

**Keep as-is:**

```
docs/IMPORTING.md, docs/MOBILE_TAILSCALE.md, docs/PUBLISH-SAFETY.md, docs/QA-CHECKLIST.md
docs/specs/00-INDEX.md (add banner: "executed 2026-06-14, this is the historical TOC")
docs/specs/01-08.md (most are self-marked shipped already; just verify)
docs/specs/10-media-backup.md, docs/specs/11-video-archive-smoke.md (active)
docs/bugs/46-*.md, docs/bugs/74-*.md (retrospectives, useful for future)
docs/design/inline-reddit-reader/spec.md, docs/design/reddit-thumbnail-cropping.md (study material)
docs/design/main-page-impeccable-critique-2026-06-29.md (snapshot critique, useful design ref)
docs/engagement/README.md (master synthesis - depends on whether you want it public)
```

### Estimated impact

- ~22 files deleted, ~10 files moved to private, ~3 files banner-updated.
- Reduces public `docs/` from 83 files to ~58, with a much higher signal-to-noise ratio.

## 3. Open decisions (need user)

1. **Push to `origin` and `private`?** (User-gated per AGENTS.md.)
2. **Move `docs/engagement/` to private?** (The 10 files explicitly discuss the user's ADHD + personal habits.)
3. **Move `bakeoff/` to private?** (Research artifacts, ~386 lines of bakeoff plan.)
4. **Restore clean history for PR #76's squash-merge?** (3 inline commits vs separate commits; non-trivial history rewrite.)
5. **Apply the doc audit's recommended deletes/folds/moves?** (Proposed list above.)
6. **Delete orphan branches on both remotes?** (List above.)
7. **Investigate the local-only branches** (`feat/fix-ui-preregression`, `docs/life-os-fixture-pointer`)?
