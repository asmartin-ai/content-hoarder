## Epic 21 — ADHD-research adoption: guilt-free decay  (`enhancement`, `area:triage`)
*From the PKMS research handoff (2026-06-10; evidence in
`K:\Projects\PKMS\vault\resources\research\`, esp. `17-hoarder-mining.md`): 97.55% of 84,250
items never left `inbox` in the app's lifetime; ~80% of the hoard is entertainment; saving is
the only proven-durable behavior. Direction: promote-on-demand (search/All/Archived already
reach every status — nothing is ever lost) + guilt-free bulk decay; per-item review of the
backlog will never happen and the design stops pretending it will. **Decisions locked
2026-06-10:** decay = auto-archive + `metadata.decayed_at` stamp (no schema change); one-shot
supervised backfill, rolling automation iceboxed; gaming buckets added, subdivided.
**Guardrails:** zero new capture friction; no guilt mechanics anywhere (no streaks / overdue
counters / red badges / "you haven't…" copy); everything reversible behind dry-run + backup;
the word "bankruptcy" stays CLI-only, never UI copy.*

- [x] ~~**P1 — Tag/subreddit-aware decay (extend `bankruptcy`).**~~ Shipped (2026-06-10,
  `feat/inbox-decay`): `db.decay`/`db.undecay` + the `decay` CLI (dry-run default, `--apply`,
  `--undo` with `--decayed-after/--decayed-before` wave windows). Stamps
  `metadata.decayed_at` (one stamp per call = one reversible wave); direct UPDATE like
  bankruptcy — never `bulk_set_status`, so a mass decay can never enqueue live Reddit
  unsaves (pinned by test). 14 new tests incl. merge_upsert stamp survival.
  **Round 2 (user review):** `--label swept` writes `metadata.decay_label` so the initial
  pass stays distinguishable from deliberate archives AND future rolling decay; new search
  operators `is:decayed` (any wave) + `is:swept` (the labeled pass) on browse + `/reddit`;
  any manual status transition (per-item ↩, set_status, bulk) strips the decay marks, so a
  rescued item never reappears in `is:swept`. A label is a metadata key, NOT a tag —
  tags get wholesale-replaced by categorize retags.
- [x] ~~**P1 — Gaming buckets in `categorize.py`, subdivided.**~~ Shipped (2026-06-10):
  `esports` (LoL/OW/CS/R6/Valorant subs, 2,116 items on the live corpus) + casual `gaming`
  (2,239) + modded-MC subs joined `minecraft` per user decision; `gamedev` → `coding`.
  Plus an untagged-tail coverage expansion (~45 conservative mappings: anime fandoms,
  screenshot-humor subs, military, spacex/engineeringporn, learnpython/linux/hacking).
  All corpus-confirmed via read-only inventory; rail/chips pick the tags up automatically.
- [x] ~~**P1 — `ephemeral` bucket: time-limited promos/sales/events.**~~ Shipped
  (2026-06-10): deal subreddits (gamedeals, buildapcsales, freegamefindings,
  frugalmalefashion, freebies — ephemeral-ONLY, no gaming co-tag, so only the age-gated
  wave touches them) + conservative title keywords (`giveaway` with a dead-giveaway idiom
  guard, `N% off`, `humble bundle`, …; never bare `free`/`sale`/`event`). 203 items on the
  live corpus (197 subreddit-path, 6 keyword-path); precision samples in the rehearsal report.
- [x] ~~**P1 — One-shot supervised "swept" backfill.**~~ ✅ APPLIED LIVE 2026-06-11 (user signed off): **21,610 items** carry `decay_label='swept'` in `data/app.db` (re-verified 2026-06-13); reddit inbox 82,190→60,580. Backup `data/app.backup-20260611-1340.db`. Rehearsal detail below kept for the record:
  Policy per user review 2026-06-10: wave 1 = `memes/gaming/esports` older than ~90 days;
  wave 2 = `ephemeral` older than ~60 days; both labeled `swept`. Rehearsal passed on a
  live-DB copy: **21,615 items would decay (33.3% of reddit inbox)** — wave 1 21,414 +
  wave 2 201; every item carries `decay_label='swept'`; NSFW preserved; apply==dry; full
  undecay round trip clean. `tinder`/`comics` removed from memes per user decision.
  ⏱ ~15 min supervised. ▶ read `data\rehearsal-decay\DECAY-REHEARSAL-REPORT.md` (tables,
  ephemeral precision samples, exact live command block incl. `--backup-live`). ✓ live block
  executed; `is:swept` pulls the pass; the freebies round-trip recipe is clean. Note: "age"
  = `created_utc` (content age) — Reddit exposes no save timestamps.
- [ ] **P2 — Defense bucket: review time-sensitive vs evergreen before sweeping.** *(Deferred from
  WP1 P13, 2026-06-26.)* Breakdown: 5,825 defense-tagged items — 75% defense memes (keep),
  16% evergreen defense tech (keep), 9% Ukraine-war subs (sweep candidates). Review the 4
  Ukraine-war subs before running: `ukraine` (171), `CombatFootage` (162),
  `UkraineWarVideoReport` (111), `UkrainianConflict` (88). Dry-run: `content_hoarder decay
  --tag defense --subreddit ukraine,CombatFootage,UkraineWarVideoReport,UkrainianConflict
  --before 90d --dry-run`.
- [ ] **P2 — Future decay waves for the remaining entertainment buckets.** `anime` (5.9k),
  `vtubers` (2.8k), `minecraft` (2.2k), `defense` (5.8k — includes aviation + Ukraine-war
  subs; review before sweeping) stay tagged in the inbox. Each is one command when ready:
  `decay --tag <bucket> --before <date> --label swept [--apply]`. **`japan` is excluded** —
  user decision 2026-06-11: it's a resurfacing cluster (see
  [`docs/resurfacing-card-design.md`](docs/resurfacing-card-design.md)), not decay material.
- [x] ~~**P3 — Hard-delete pathway for triaged ephemeral items.**~~ Shipped (overnight
  2026-06-10, user-approved with unsave coupling): `delete` CLI — dry-run is the
  confirmation surface; execution needs BOTH `--apply` and `--yes`; automatic timestamped
  pre-delete backup + `data/delete-audit.jsonl`; `--max` blast-radius cap (default 5000);
  `--also-unsave` enqueues into the unsave queue BEFORE rows vanish, and without it stale
  pending queue rows are purged so a later drain can't unsave a local-only delete. Deletes
  the `reddit_threads` cache rows too. 8 tests.
- [x] ~~**P2 — Done items auto-delete after a retention window (Gmail-trash style).**~~ ✅ VERIFIED
  SHIPPED: `purge-done` wraps `db.purge_done` in the money-action safety shape (dry-run default, `--apply`
  + `--yes` gate, auto pre-purge backup, `delete-audit.jsonl`, `--max`, `--retention-days`), and the settings
  sheet exposes the retention window plus purge preview/action. Optional scheduled sweep remains icebox scope. *(User-requested
  2026-06-17.)* **DB primitive SHIPPED 2026-06-18 (F15 bakeoff, glm-5p2 arm + review fixes):**
  `db.purge_done(conn, *, now, apply, max_rows)` permanently purges `status='done'` items older than
  setting `done_retention_days` (default 30), aging from `processed_utc` (NULL excluded). Direct-delete —
  never routes through `bulk_set_status`/`enqueue_unsave`, so a purge **cannot enqueue a Reddit unsave**
  (mirrors the decay invariant, oracle-pinned); cleans pending `reddit_unsave` + `reddit_threads` rows;
  `max_rows` blast cap. `processed_utc` confirmed as the Done-transition timestamp (no schema
  change needed). Builds on the P3 hard-delete pathway above + the decay machinery.
- [ ] **P3 — Rolling decay automation (Icebox).** Reactivate after the backfill proves out and
  ~a month of new saves accumulates.
- [ ] **P3 — PKMS promote-pipeline export wrapper (Icebox).** The read path already exists
  (`db.get_reddit_thread`, db.py:834; 672 threads cached); build the thread-JSON→markdown
  export only when PKMS Phase 3 starts. Don't build capture/promote here before then.
  Related open question (PKMS side, Kenja decides later): whether the PKMS mobile `/capture`
  endpoint lives inside this Flask app (same tailnet host) or as a sibling service.
  **UI surface (user idea 2026-06-17):** the eventual trigger is a per-item **"Move to PKMS" button** in
  content-hoarder — deferred with this item (don't build the button before the promote pipeline exists).
  **Ambitious icebox add-on (mobile test 2026-06-29):** while reading a thread, let the user rapidly tap
  comments of interest; then an LLM summarizes just those selected comments into PKMS takeaways with
  autotagging/autosorting. Requires a comment-selection UI, cached thread hydration, local-LLM summary path,
  and a real PKMS ingest/export contract; do not build before the promote pipeline exists.
- [ ] **P3 — LLM identity-vs-actionable classifier (Icebox).** v1 approximates it with tag
  buckets (memes/vtubers = identity; tips/coding/science = actionable); reactivate when the
  resurfacing card (Epic 20) needs better candidates. Reuses the Epic 1/10 local-LLM lane.
- [ ] **P3 — Content-based ephemeral detection (Icebox).** Event posts whose time-limited
  nature isn't visible from subreddit/title (announcement bodies, "ends Sunday" buried in
  text) need body analysis — local-LLM lane once the GPU is back in service. The subreddit +
  title-keyword v1 above covers the high-precision bulk first.
