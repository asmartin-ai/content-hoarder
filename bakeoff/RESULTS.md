# content-hoarder Price-to-Performance Bakeoff — Results & Verdict

**Run:** 2026-07-05. 80 runs across 4 hard-oracle tasks × 10 models × 2 runs each.
Total executor spend: **$0.43** (PAYG ZenMux, promo pricing). Orchestrator: GLM-5.2 (Zed agent).

## TL;DR

- **T3 (Flash tier) winner: `minimax/minimax-m3`** — best quality-to-cost ratio
  (q2c=347) at 88% pass rate and ~$0.0025/pass. Honorable mention: `deepseek-v4-flash`,
  `qwen3.7-plus`, and `qwen3.6-flash` all hit 100% pass rate at ~$0.005/pass —
  perfect-reliability options when correctness matters more than cost.
- **Pro tier verdict: NOT worth ~3× cost for this workload.** Only `qwen/qwen3.7-max`
  (100% pass, q2c=71) beats the T3 winner on pass rate — and at 3× the cost for a
  12-point pass-rate gain over minimax-m3. `deepseek-v4-pro` and `kimi-k2.7-code`
  are *worse* than the T3 winner (62% and 50% pass). `glm-5.2` is unusable for
  headless delegation (25% pass — the M5 thinking-tokens bug, hits output cap with 0 edits).
- **Routing table:** use a T3 Flash-line model as the default delegation lane;
  reserve Pro for genuinely hard jobs where the T3 models struggle (none observed here).

## Full results (sorted by quality-to-cost, best first)

| Model | Tier | Pass | Fail | Pass rate | Median $/pass | Q2C | Median wall (s) |
|---|---|---|---|---|---|---|---|
| `minimax/minimax-m3` | T3 | 7 | 1 | 0.88 | $0.00252 | 347 | 28 |
| `kuaishou/kat-coder-pro-v2` | T3 | 6 | 2 | 0.75 | $0.00239 | 313 | 30 |
| `deepseek/deepseek-v4-flash` | T3 | 8 | 0 | 1.00 | $0.00455 | 220 | 66 |
| `qwen/qwen3.7-plus` | T3 | 8 | 0 | 1.00 | $0.00469 | 213 | 162 |
| `qwen/qwen3.6-flash` | T3 | 8 | 0 | 1.00 | $0.00498 | 201 | 69 |
| `stepfun/step-3.7-flash` | T3 | 2 | 6 | 0.25 | $0.00399 | 63 | 45 |
| `qwen/qwen3.7-max` | Pro | 8 | 0 | 1.00 | $0.01405 | 71 | 165 |
| `moonshotai/kimi-k2.7-code` | Pro | 4 | 4 | 0.50 | $0.00705 | 71 | 44 |
| `deepseek/deepseek-v4-pro` | Pro | 5 | 3 | 0.62 | $0.01227 | 51 | 136 |
| `z-ai/glm-5.2` | Pro | 2 | 6 | 0.25 | $0.01131 | 22 | 60 |

**Q2C** = pass_rate ÷ median_$ per passing run (higher = better value).

## Per-task pass rate

| Model | CH-B1 | CH-B3 | CH-B4 | CH-B7 | Total |
|---|---|---|---|---|---|
| `deepseek/deepseek-v4-flash` | 2/2 | 2/2 | 2/2 | 2/2 | 8/8 |
| `qwen/qwen3.7-plus` | 2/2 | 2/2 | 2/2 | 2/2 | 8/8 |
| `qwen/qwen3.6-flash` | 2/2 | 2/2 | 2/2 | 2/2 | 8/8 |
| `qwen/qwen3.7-max` | 2/2 | 2/2 | 2/2 | 2/2 | 8/8 |
| `minimax/minimax-m3` | 2/2 | 2/2 | 1/2 | 2/2 | 7/8 |
| `kuaishou/kat-coder-pro-v2` | 2/2 | 0/2 | 2/2 | 2/2 | 6/8 |
| `deepseek/deepseek-v4-pro` | 1/2 | 1/2 | 1/2 | 2/2 | 5/8 |
| `moonshotai/kimi-k2.7-code` | 1/2 | 0/2 | 1/2 | 2/2 | 4/8 |
| `stepfun/step-3.7-flash` | 0/2 | 1/2 | 0/2 | 1/2 | 2/8 |
| `z-ai/glm-5.2` | 0/2 | 1/2 | 0/2 | 1/2 | 2/8 |

Tasks (4 hard-oracle, RED → fix pairs):
- **CH-B1** — Reddit `ai_ml` tagging (`categorize.py`, single-file additive, easy)
- **CH-B3** — OCR text → FTS search wiring (`models.py` + `search_query.py` + `db.py`, 3-file, medium)
- **CH-B4** — User-tag rename-in-vocabulary (`db.py`, DB read-modify-write, medium)
- **CH-B7** — Triage high-skip-bucket detection (`triage_score.py`, pure-analysis, medium)

## Key findings

### 1. The T3 Flash tier is sufficient for scoped feature work
Four T3 models hit 100% pass rate (deepseek-v4-flash, qwen3.7-plus, qwen3.6-flash,
and the Pro-tier qwen3.7-max). The plan's §7 kill-fast gate fired: if every T3 model
passed every task first-shot the T3 question is answered. We're close — three T3
models are perfect, and a fourth (minimax-m3) is 88% with the best cost efficiency.

### 2. minimax-m3 is the best value; deepseek-v4-flash is the safe pick
`minimax/minimax-m3` has the highest quality-to-cost ratio (q2c=347) at $0.0025/pass —
but its 88% pass rate means occasional retries. `deepseek/deepseek-v4-flash` and
`qwen/qwen3.7-plus` / `qwen3.6-flash` are perfect at ~$0.005/pass — pick these when
reliability matters more than the $0.002 delta.

### 3. Pro tier does NOT earn its ~3× cost here
Only `qwen/qwen3.7-max` (100% pass, $0.014/pass) beats the T3 winner on pass rate —
and at 5.6× the cost per pass for a 12-point pass-rate gain over minimax-m3 (or a 0-point
gain over the perfect T3 models). `deepseek-v4-pro` (62%) and `kimi-k2.7-code` (50%) are
*worse* than minimax-m3 — Pro pricing doesn't buy reliability here. The §9 decision
rule: "If Pro models only match the T3 winner on tasks the T3 winner already aces →
Pro tier is not worth ~3× for this workload; reserve it for genuinely hard jobs."

### 4. GLM-5.2 and stepfun-3.7-flash are unusable for headless delegation
Both at 25% pass rate. GLM-5.2's failures are the M5 thinking-tokens bug (burns 50K+
output tokens on thinking prose, hits output cap with 0 edits applied — confirmed in
the aider-headless-delegate skill). stepfun-3.7-flash shows the same 0-edit pattern.
The fails are almost all `diff=''` (the executor applied nothing). Use these models
interactively (where a human can interrupt and redirect), not for headless delegation.

### 5. Variance is real — 2 runs is the floor, not the ceiling
Several models split 1/2 on a task (deepseek-v4-pro on B1/B3/B4, kimi on B1/B4,
minimax on B4). The plan calls for 2-3× runs; the 2-run data shows the variance but
isn't enough to fully separate "model flake" from "task hard". For production routing
decisions on these middle-tier models, 3+ runs would tighten the confidence interval.

### 6. CH-B3 is the discriminator task
It separates the coding-specialists from the generalists: kuaishou-kat-coder-pro-v2
(0/2 on B3), kimi (0/2 on B3), stepfun (1/2), glm-5.2 (1/2) all struggle with the
3-file wiring task. The T3 perfect-scorers and qwen3.7-max all pass B3. If you're
routing by task shape, B3-class (multi-file additive wiring) is where the T3
perfect-scorers earn their keep over the cheaper-but-fragile coding-specialists.

## Cross-substrate check (vs PKMS bakeoff)

The PKMS bakeoff (companion plan) had not landed as of this run. The
content-hoarder verdict stands alone: **T3 Flash-tier is the default delegation
lane; minimax-m3 for cost, deepseek-v4-flash or qwen3.7-plus for reliability.**
If PKMS later confirms the same winner, the routing table becomes
high-confidence. If different, the win is substrate-specific and the routing
table should be picked per task-shape.

## Caveats

- **Oracle fix mid-bakeoff:** the CH-B7 oracle had a variable-shadowing bug in
  its `_model` helper (committed in Phase 0); it was fixed before the batch ran
  (commit `066047d`). 5 CH-B7 runs from the first (dead) batch attempt were
  discarded; all 8 final CH-B7 runs used the fixed oracle.
- **GLM-5.2 self-delegation flag:** when GLM-5.2 is the executor, the
  orchestrator (also GLM-5.2 on Zed) and executor are the same model. The
  isolation is real (separate aider-delegate context, run branch, oracle gate);
  the orchestration cost is separated (not in the executor $/task column).
- **Promo pricing:** ZenMux promo ($0.14/$0.28 T3, $0.435/$0.87 Pro) expires
  ~2026-08-03. All arms ran on the same promo, so the comparison is valid;
  re-verify absolute-$ projections afterward.
- **2 runs per (task, model):** the plan's minimum. Variance is visible but
  not fully characterized. 3+ runs would tighten confidence on middle-tier models.
