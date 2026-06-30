# content-hoarder — backlog index

Active work is tracked in GitHub Issues. Historical/as-built backlog detail is split under
`docs/backlog/` so sandboxed and delegated agents can still work offline without reading one
monolithic file.

- GitHub repo: https://github.com/asmartin-ai/content-hoarder
- Issue mapping: `docs/backlog/github-issues.json`
- History index: `docs/backlog/README.md`
- Current delegation queue: `delegation/NEXT-DELEGATION.md`

## How to use this file

1. Start here for the epic/issue index.
2. Open the GitHub issue for active status and discussion.
3. If an agent is sandboxed/offline, use the linked `docs/backlog/epic-*.md` file plus the issue
   body copied into the task prompt.
4. Keep private data, live DB details, credentials, and personal exports out of GitHub Issues.

## Epic 1 — Content categorization: listenable / watch / wotagei

- History: `docs/backlog/epic-01-content-categorization-listenable-watch-wotagei.md`
- Milestone: https://github.com/asmartin-ai/content-hoarder/milestone/1
- Active issues: none currently migrated.

## Epic 2 — YouTube metadata enrich

- History: `docs/backlog/epic-02-youtube-metadata-enrich.md`
- Milestone: https://github.com/asmartin-ai/content-hoarder/milestone/2
- Active issues: none currently migrated.

## Epic 3 — Recover deleted / private YouTube titles

- History: `docs/backlog/epic-03-recover-deleted-private-youtube-titles.md`
- Milestone: https://github.com/asmartin-ai/content-hoarder/milestone/3
- Active issues: none currently migrated.

## Epic 4 — Recover deleted Reddit content

- History: `docs/backlog/epic-04-recover-deleted-reddit-content.md`
- Milestone: https://github.com/asmartin-ai/content-hoarder/milestone/4
- Active issues:
  - #11 — Hoard the BYTES, not just the link: local media archiving
  - #12 — RepostSleuth reverse-image-hash recovery (spike)

## Epic 5 — Inbox redesign follow-ups

- History: `docs/backlog/epic-05-inbox-redesign-follow-ups.md`
- Milestone: https://github.com/asmartin-ai/content-hoarder/milestone/5
- Active issues:
  - #13 — Smooth drag-and-drop to buckets
  - #14 — Rework the keyboard controls

## Epic 6 — Duplicates v2

- History: `docs/backlog/epic-06-duplicates-v2.md`
- Milestone: https://github.com/asmartin-ai/content-hoarder/milestone/6
- Active issues: none currently migrated.

## Epic 7 — More sources & live sync

- History: `docs/backlog/epic-07-more-sources-live-sync.md`
- Milestone: https://github.com/asmartin-ai/content-hoarder/milestone/7
- Active issues:
  - #15 — Import WL3 + Watch Later
  - #16 — Live Reddit / YouTube API sync
  - #17 — Per-item "added to playlist / Watch Later" date (needs API)

## Epic 8 — Polish & infra

- History: `docs/backlog/epic-08-polish-infra.md`
- Milestone: https://github.com/asmartin-ai/content-hoarder/milestone/8
- Active issues:
  - #18 — Optional Karakeep bridge
  - #19 — Redesign the app icon
  - #20 — 60fps UI
  - #21 — Data-saving mode + mobile performance pass
  - #22 — Trial GLM-5.2 as a design bakeoff arm (gated by the frontend-design skill + visual review)

## Epic 9 — Reddit merge follow-ups

- History: `docs/backlog/epic-09-reddit-merge-follow-ups.md`
- Milestone: https://github.com/asmartin-ai/content-hoarder/milestone/9
- Active issues:
  - #23 — Reddit auto-categorization

## Epic 10 — Learned triage: suggest what to process next

- History: `docs/backlog/epic-10-learned-triage-suggest-what-to-process-next.md`
- Milestone: https://github.com/asmartin-ai/content-hoarder/milestone/10
- Active issues:
  - #24 — Research analytics/content algorithms for better smart-sort + triage addiction loop
  - #25 — Per-source / per-subreddit "auto-archive likely-skip" assist

## Epic 11 — Cross-source consolidation: condense duplicates into YouTube items

- History: `docs/backlog/epic-11-cross-source-consolidation-condense-duplicates-into-youtube-items.md`
- Milestone: https://github.com/asmartin-ai/content-hoarder/milestone/11
- Active issues: none currently migrated.

## Epic 12 — Search operators in the search bar

- History: `docs/backlog/epic-12-search-operators-in-the-search-bar.md`
- Milestone: https://github.com/asmartin-ai/content-hoarder/milestone/12
- Active issues:
  - #26 — Image text search via OCR
  - #27 — Revisit operator names for intuitiveness (Icebox)

## Epic 13 — UI bugs & quick fixes

- History: `docs/backlog/epic-13-ui-bugs-quick-fixes.md`
- Milestone: https://github.com/asmartin-ai/content-hoarder/milestone/13
- Active issues:
  - #28 — Research + mimic reddit-app thumbnail cropping
  - #29 — Ask GLM what looks better for Log-view title wrapping/cutoff
  - #30 — Video not fetching properly

## Epic 14 — Settings menu

- History: `docs/backlog/epic-14-settings-menu.md`
- Milestone: https://github.com/asmartin-ai/content-hoarder/milestone/14
- Active issues: none currently migrated.

## Epic 15 — Reddit / HN as-app navigation

- History: `docs/backlog/epic-15-reddit-hn-as-app-navigation.md`
- Milestone: https://github.com/asmartin-ai/content-hoarder/milestone/15
- Active issues:
  - #31 — Reader/text-post preview blurbs
  - #32 — Show post text under image lightbox when a Reddit post has media + selftext
  - #33 — Video lightbox swipe gestures parity with images
  - #34 — Icebox — Obsidian-grade WYSIWYG (type-and-see-formatting) note editing

## Epic 16 — Mobile UX

- History: `docs/backlog/epic-16-mobile-ux.md`
- Milestone: https://github.com/asmartin-ai/content-hoarder/milestone/16
- Active issues:
  - #38 — Revisit inbox swipe controls / inertia
  - #39 — Text Reddit post rendered with a misleading preview play button
  - #40 — Reader should swipe up from bottom when opened via triage swipe-up
  - #41 — Surprise-me view should include a preview/blurb
  - #42 — Bring back subtle triage-card tilt on side swipes
  - #43 — Research / design-ref — Capture Relay-style interaction video for analysis
  - #44 — DEFERRED: long-press on a thumbnail enters group-select
  - #45 — ICEBOX: Swipe physics feel
  - #46 — Mobile-friendly scrollbar
  - #47 — Visual rework of the collapsing top bar
  - #48 — Scroll-deceleration physics feel (rapid scroll to top)
  - #49 — Make the Reddit view mobile-friendly
  - #50 — ICEBOX: ship content-hoarder as a Gecko-rendered standalone Android app
  - #51 — Explore Cromite (or similar adblock Chromium fork) as the PWA host browser
  - #52 — Explore Chrome Custom Tabs (+ Trusted Web Activity)
  - #53 — ICEBOX: watch the Web Haptics API (amplitude/intensity haptics for the PWA)
  - #54 — ICEBOX: remotely "turn on" the server from the phone

## Epic 17 — Unify the Reddit and Inbox/Triage surfaces

- History: `docs/backlog/epic-17-unify-the-reddit-and-inbox-triage-surfaces.md`
- Milestone: https://github.com/asmartin-ai/content-hoarder/milestone/17
- Active issues:
  - #55 — One unified surface

## Epic 18 — Custom YouTube view

- History: `docs/backlog/epic-18-custom-youtube-view.md`
- Milestone: https://github.com/asmartin-ai/content-hoarder/milestone/18
- Active issues:
  - #56 — A YouTube-specific surface

## Epic 19 — Backend hardening

- History: `docs/backlog/epic-19-backend-hardening.md`
- Milestone: https://github.com/asmartin-ai/content-hoarder/milestone/19
- Active issues: none currently migrated.

## Epic 20 — Frontend v3 overhaul

- History: `docs/backlog/epic-20-frontend-v3-overhaul.md`
- Milestone: https://github.com/asmartin-ai/content-hoarder/milestone/20
- Active issues:
  - #57 — Triage visual rework + inbox-like filtering
  - #58 — Unused `app.css` selectors (I3) — defer

## Epic 21 — ADHD-research adoption: guilt-free decay

- History: `docs/backlog/epic-21-adhd-research-adoption-guilt-free-decay.md`
- Milestone: https://github.com/asmartin-ai/content-hoarder/milestone/21
- Active issues:
  - #59 — Defense bucket: review time-sensitive vs evergreen before sweeping
  - #60 — Future decay waves for the remaining entertainment buckets
  - #61 — Rolling decay automation (Icebox)
  - #62 — PKMS promote-pipeline export wrapper (Icebox)
  - #63 — LLM identity-vs-actionable classifier (Icebox)
  - #64 — Content-based ephemeral detection (Icebox)

## Epic 22 — Triage as a separate app: the engagement deck

- History: `docs/backlog/epic-22-triage-as-a-separate-app-the-engagement-deck.md`
- Milestone: https://github.com/asmartin-ai/content-hoarder/milestone/22
- Active issues:
  - #65 — Architecture research FIRST (decision gate)
  - #66 — Anki interleave prototype (after the architecture gate)

## Epic 24 — Reddit thread hydration backfill

- History: `docs/backlog/epic-24-reddit-thread-hydration-backfill.md`
- Milestone: https://github.com/asmartin-ai/content-hoarder/milestone/24
- Active issues:
  - #67 — Lean middle option: normalize to a `comments` table
  - #68 — Advanced: comment search + pagination

## Epic 23 — ADHD design-language bridge

- History: `docs/backlog/epic-23-adhd-design-language-bridge.md`
- Milestone: https://github.com/asmartin-ai/content-hoarder/milestone/23
- Active issues: none currently migrated.

## Epic 25 — Reddit access de-risking

- History: `docs/backlog/epic-25-reddit-access-de-risking.md`
- Milestone: https://github.com/asmartin-ai/content-hoarder/milestone/25
- Active issues:
  - #69 — "Human-mimic" jitter for hydration pacing (learning experiment)

## Epic 26 — Tag & category taxonomy reorganization

- History: `docs/backlog/epic-26-tag-category-taxonomy-reorganization.md`
- Milestone: https://github.com/asmartin-ai/content-hoarder/milestone/26
- Active issues:
  - #70 — User-tag table: pre-create empty tags + rename-in-vocabulary
  - #71 — Audit Reddit coverage for `ai_ml` tagging
