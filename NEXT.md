# NEXT.md — content-hoarder session focus

`main` is 137 commits ahead of `origin/main`. Not pushed (user-gated per §7).
Suite: **1008 passing** (baseline unchanged; the 4 CH-B* bakeoff oracles stay RED on main by design — they're turned green on per-run `delegated/run-*` branches).

## Just done (2026-07-05 session, content-hoarder bakeoff)
- **Phase 0 + Phase 1 + Phase 2 bakeoff COMPLETE.** 80 runs across 4 hard-oracle
  tasks × 10 models × 2 runs. Total executor spend $0.43 (ZenMux PAYG, promo
  pricing). Full verdict in `bakeoff/RESULTS.md`; raw data in `bakeoff/results.csv`.
- **T3 (Flash tier) WINNER: `minimax/minimax-m3`** — best quality-to-cost
  (q2c=347) at 88% pass / $0.0025 per pass. Reliability picks: `deepseek-v4-flash`,
  `qwen3.7-plus`, `qwen3.6-flash` (all 100% pass at ~$0.005/pass).
- **Pro tier verdict: NOT worth ~3× cost for this workload.** Only `qwen3.7-max`
  (100% pass, $0.014/pass) beats the T3 winner on pass rate — at 5.6× the cost
  for a 12-point gain. `deepseek-v4-pro` (62%) and `kimi-k2.7-code` (50%) are
  *worse* than minimax-m3. `glm-5.2` is unusable headless (25% pass — the M5
  thinking-tokens bug).
- **Oracle bug fixed mid-bakeoff:** CH-B7's `_model` helper had a variable-
  shadowing bug (`{k: [n, k, rate] for k, (n, k, rate) in ...}` — the dict key
  was overwritten by the tuple's processed-count). Fixed in commit `066047d`
  before the final batch; all 8 CH-B7 runs used the fixed oracle.
- **Driver tooling shipped:** `scripts/bakeoff_arm.py` (per-run driver with
  4-check verification + CSV row) + `scripts/bakeoff_batch.py` (batch runner,
  idempotent, commits results.csv after each row). Per-task delegation specs
  in `bakeoff/specs/`. Run branches preserved under `delegated/run-*` for review.

## Next 1-3 actions (in order)
1. **Review the bakeoff run branches** for the winning models — spot-check
   minimax-m3's CH-B4 fix (the highest-quality diff I saw; correctly uses
   the canonical FTS5 rebuild + preserves `tags_auto`) and deepseek-v4-flash's
   CH-B1 fix. Cherry-pick any that should land on `main`.
2. **P3.5 legacy retirement** — still pending from prior session. Execute
   spec 12 §2 checklist: delete `/triage` + `/reddit` page routes (keep JSON),
   strip SHELL entries, delete `static/{triage.js,reddit.js,reddit.css,app.css,
   tokens.css (verify)}`, add 302 redirects. KEEP `/static/haptics.js`.
3. **Push 137 local commits** to `origin/main`? (user-gated per §7)

## Open decisions (need user)
- Push the 137 local commits to `origin/main`? (user-gated per §7)
- Pick `<DEST>` drive for media mirror (spec 10).
- Pick representative item + auth posture for video smoke (spec 11).
- Real-device Pixel-6 QA pass for the mobile changes (issues #35-#48) +
  P3.1 deck gestures + P3.3 subreddit facet.
- Adopt the bakeoff winner (`minimax/minimax-m3` for cost, `deepseek-v4-flash`
  for reliability) as the default `aider-delegate` lane for future delegations?

## Icebox
- #72 Life-OS fixtures — real T1, needs Life-OS contract work; defer.
- P2.1/P2.2 engagement Phase 1 — depends on user flipping
  `learn-triage --apply` (their switch, deferred once already).
- Live media/archive/unsave runs — all user-gated (§7).
- PKMS cross-substrate bakeoff check — run the same model comparison on the
  PKMS substrate to confirm the routing table (per bakeoff plan §3).
