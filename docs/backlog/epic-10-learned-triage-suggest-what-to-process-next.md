## Epic 10 — Learned triage: suggest what to process next  (`enhancement`, `area:triage`)
*Motivation: triage decisions aren't random — the things I mark **done** share signals (source,
subreddit/channel, kind, age, media type, title keywords). The app should learn from my own history
and surface what I'm most likely to act on, instead of a flat random batch.*

- [x] ~~**P2 — Learn a "likely-done" score from triage history.**~~ SHIPPED on main:
  triage_score.py, learn-triage CLI, and smart-triage mode (get_random_batch(mode="smart")) are all live.
  The former triage-score feature branch is merged; the old parking notes about reverting a revert are stale.
  `triage_score.py` — transparent per-feature processed-rate model (composite
  source/kind, subreddit, channel, media type, category, age buckets; Laplace-smoothed,
  min-support 20; **decay-stamped rows excluded from training**; title tokens deferred).
  `learn-triage` CLI (dry-run default) writes `metadata.triage_score` + top-3 `triage_why`.
  Rehearsed on the live-corpus copy (82k scored in 23s; model card at
  `data\rehearsal-decay\TRIAGE-SCORE-REPORT.md`); the first rehearsal caught source/kind
  double-counting — fixed via the composite `sk:` feature.
- [x] ~~**P2 — "Smart triage" mode (recency + likely-done interleave).**~~ SHIPPED on main:
  get_random_batch(mode="smart") + /random?mode=smart.
  The triage-card UI toggle remains an Epic 20 Stage-C item.
- [x] ~~**P3 — Feedback loop.**~~ ✅ SHIPPED 2026-06-26: `triage_score.drift()` compares two fitted models
  (features added/dropped, rate drift with top movers, prior drift, `drift_score`); `triage-drift` CLI reports
  drift vs the persisted model; `--apply` refits, rescores inbox items, and persists. **Follow-up shipped
  2026-06-29:** local-LLM keep/skip suggestions stored by `assist/llm.py` now feed the transparent model as
  `llm:keep` / `llm:skip` features (category was already included as `cat:<category>`). The suggestion still
  never changes status on its own; it only becomes one explainable ranking signal when present.
- [ ] **P2 — Research analytics/content algorithms for better smart-sort + triage addiction loop.**
  *(Mobile test 2026-06-29.)* Study how recommendation feeds, spaced-review queues, email triage, and
  addictive-but-ethical content algorithms rank items; adapt the useful parts to `smart:desc` and triage
  without violating the ADHD guardrails (no guilt counters/streaks/dark patterns). Candidate signals:
  recent successful triage streaks, source/category diversity, novelty vs familiarity, media/text effort,
  skip/snooze friction, old-save resurfacing, and exploration/exploitation. Output should be a short research
  note + concrete scoring changes, then offline rehearsal against a DB copy before any default-sort change.
- [ ] **P3 — Per-source / per-subreddit "auto-archive likely-skip" assist.** Where the learned
  skip-rate for a bucket (e.g. a subreddit) is very high, offer a one-click reversible bulk-archive
  (built on `db.bankruptcy`-style ops) so low-value buckets clear fast.

- [x] ~~**P2 — Shuffle / mixed-content mode.**~~ ✅ Shipped 2026-06-13: a "SHUFFLE · MIX" sort that
  interleaves sources round-robin (`db._order_clause` window fn: nth-of-each-source then source —
  deterministic, so infinite-scroll pages don't dup/skip, unlike RANDOM()). +3 tests; preview-verified
  (sources interleave hackernews/reddit/youtube…). Orig: interleaves a *mix* of sources
  and categories (not grouped) for variety; complements smart-triage above.
- [x] **P2 — Default "All" view sorted by "easy to triage".** ✅ SHIPPED 2026-06-22 (origin/main): per-tab sort memory — the All tab defaults to `smart:desc` (the learned triage-score, degrades to recency until trained). Use the learned likely-done score (this
  epic) to order the default All view so quick wins surface first, instead of recency/random.
- Note: the user's "analytics/learning → triage suggestion" idea (collect activity offline, batch-
  process, suggest) is exactly this epic — folded here.
