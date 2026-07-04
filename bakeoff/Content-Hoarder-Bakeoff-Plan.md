# content-hoarder Price-to-Performance Bakeoff — Test Plan

*Created 2026-07-04. Companion to `PKMS-Price-Performance-Bakeoff-Plan-2026-07-03.md` (the
same model-selection question on the PKMS substrate) and `ZenMux-Token-Economics-Promo-2026-07-03.md`
(the model catalog this bakeoff draws from). This doc = **which model gives the best
price-to-performance on scoped content-hoarder feature implementation**, across two price
tiers, with GLM-5.2 orchestrating.*


> **Source:** this is a copy of the canonical plan at
> `K:/Users/Kenja/Documents/LLM-dev/bakeoffs/Content-Hoarder-Price-Performance-Bakeoff-Plan-2026-07-04.md`.
> Edits to the plan should go there; this copy is for reference during execution.

Status: **PLANNED 2026-07-04 — copy hosted in content-hoarder repo for executor proximity** — not yet running. Window: ZenMux token-economics promo
(expiring ~2026-08-03, re-check before relying on it).

---

## 0. The question (stated so it can be answered with numbers)

> Across the ZenMux promo's two DeepSeek price lines, **which model delivers a green
> content-hoarder feature oracle at the lowest $/task and best quality-to-cost ratio** — and
> does the Pro price line ($0.435/$0.87) buy enough quality/speed headroom over the Flash price
> line ($0.14/$0.28) to justify its ~3× per-token cost?

Two sub-questions:
1. **T3 (Flash price line, cheap):** Among DeepSeek V4 Flash, MiniMax M3, Qwen 3.7-Plus,
   Step 3.7 Flash, KAT-Coder-Pro-V2, etc. — which is the best execution lane for scoped
   content-hoarder features?
2. **T1/T2 (Pro price line, premium):** Among DeepSeek V4 Pro, GLM-5.2, Kimi K2.7 Code,
   Qwen 3.7-Max — is the premium tier worth ~3× on tasks where the Flash tier struggles?

This is **not** the Tier-B question (does delegation beat Claude-alone). That was answered
(L≈1.0, no leverage). This is a **model-selection** bakeoff: the orchestration layer is
settled (aider-delegate, run-branch protocol), the orchestrator is fixed (GLM-5.2 on ZenMux),
and the variable is **which executor model** runs the agentic loop.

### Why content-hoarder as a second substrate

- PKMS has a clean pytest discipline (130+ tests) but a small task surface (B6 + F-batch).
- content-hoarder has a **larger task surface** (1008 passing tests, 26 epics, many open
  backend/logic items with clean oracles) and a **proven bakeoff precedent** — the shipped
  `test_bakeoff_f{9,14,15}_*.py` oracles came from prior Fireworks bakeoffs that shipped real
  features to `main`.
- Running the same model comparison on **two independent substrates** is the cleanest way to
  separate a model win from a substrate artifact (the Tier-B pitfall: "one task is an
  anecdote").
- content-hoarder's baseline is currently clean (1008 passing on `feat/p3.5-legacy-retirement`,
  no collection errors) — no Phase 0 baseline repair needed (unlike PKMS).

---

## 1. The decisive metrics

**Per run, per model:**

| Metric | How |
|---|---|
| **Quality** | `pytest` green (objective) **+** orchestrator review for test-gaming/hacks (the `aider-headless-delegate` checklist) |
| **$ per task** | executor input+output tokens × provider rate; orchestrator tokens logged separately |
| **Tokens** | executor in/out (from aider-delegate's accurate per-token reporting); orchestrator in/out |
| **Wall-clock** | start→gate-green |
| **Retries/escalations** | did the executor fail and need a re-spec? how many? |
| **First-shot success** | did it pass without any retry? (the cleanest quality signal) |

**Per model, across the task set:**

- **Pass rate** = green tasks ÷ attempted tasks
- **Median $/task** (robust to one bad run)
- **Quality-to-cost ratio** = pass rate ÷ median $/task (higher = better value)
- **First-shot rate** = tasks green on first attempt ÷ attempted

**Decision outputs:**
- T3 winner = the Flash-line model with the best quality-to-cost ratio
- T1/T2 verdict = does any Pro-line model beat the T3 winner on pass rate by enough to justify
  ~3× cost? (the "is premium worth it" answer)
- A routing table: which tier for which task complexity
- **Cross-substrate check** vs the PKMS bakeoff: does the same model win on both substrates?
  If yes → high-confidence routing table. If no → the win is substrate-specific; document both.

---

## 2. The orchestrator (fixed across all arms)

**Orchestrator: GLM-5.2 on ZenMux** (`z-ai/glm-5.2`, 1M ctx, thinking mode, $0.435/$0.87
Pro-line pricing).

Why GLM-5.2 as orchestrator (per user direction + the `zcode-orchestration` skill):
- Cheap enough that orchestrator cost doesn't dominate — logged separately, never folded into
  the executor's $/task.
- 1M context holds the full task set + content-hoarder epic context + oracle specs without
  compression.
- Already the ZCode primary agent and the Zed default — no extra wiring.
- Tool-capable for the aider-delegate MCP / CLI handoff.

**Orchestrator responsibilities (identical to the PKMS bakeoff):**
1. Read the task spec (goal, files in scope, the exact acceptance command).
2. Write a self-contained delegation spec for the executor.
3. Hand off via `delegate_to_aider` (MCP) or `aider-delegate` CLI.
4. Review the returned diff per the `aider-headless-delegate` checklist (applied edits, scope,
   oracle integrity, full suite green). **Never auto-merge** — results stay on run branches
   for human review.
5. Log the run to the results file.

**The orchestrator is the same model for every executor** — it's a controlled constant, not a
variable. Any orchestrator-side variance (spec quality, review strictness) is shared across
all arms and doesn't bias the model comparison.

---

## 3. The two tiers (the variable)

Both tiers draw from the ZenMux token-economics promo. See
`ZenMux-Token-Economics-Promo-2026-07-03.md` for the full model list and IDs.

### T3 — DeepSeek V4 Flash price line ($0.14 in / $0.28 out per M)

The cheap execution tier. 12 models on the promo; pick the coding-relevant subset:

| Model | ZenMux ID | Context | Why included |
|---|---|---|---|
| DeepSeek V4 Flash | `deepseek/deepseek-v4-flash` | 1M | The price-setter; native thinking mode |
| MiniMax M3 | `minimax/minimax-m3` | 1M | 1M ctx, prior content-hoarder bakeoff winner (Epic 24 batch-2, `cde5b01`) |
| Qwen 3.7-Plus | `qwen/qwen3.7-plus` | 1M | 1M ctx, 66% off; prior Fireworks bakeoff challenger |
| Step 3.7 Flash | `stepfun/step-3.7-flash` | 256K | Multimodal MoE, 33% off |
| KAT-Coder-Pro-V2 | `kuaishou/kat-coder-pro-v2` | 256K | Coding-specialist, 54% off |
| Qwen3.6 Flash | `qwen/qwen3.6-flash` | 1M | 1M ctx, 54% off |

**Optional / stretch:** Longcat 2.0, Ling-2.6-flash, Doubao-Seed-2.1-turbo — add only if the
core six leave the question unanswered.

### T1/T2 — DeepSeek V4 Pro price line ($0.435 in / $0.87 out per M)

The premium tier. ~3× the Flash line; the question is whether the quality justifies it.

| Model | ZenMux ID | Context | Why included |
|---|---|---|---|
| DeepSeek V4 Pro | `deepseek/deepseek-v4-pro` | 1M | The price-setter; native thinking, 384K max output |
| GLM 5.2 | `z-ai/glm-5.2` | 1M | Same family as the orchestrator (note: orchestrator cost is logged separately) |
| Kimi K2.7 Code | `moonshotai/kimi-k2.7-code` | 262K | Coding-specialist, 55% off |
| Qwen 3.7-Max | `qwen/qwen3.7-max` | 1M | 1M ctx, 83% off (smallest normal discount in this tier) |

**Note on GLM-5.2 as both orchestrator and T1/T2 arm:** when GLM-5.2 is the executor, the
orchestrator and executor are the same model — the delegation is still real (isolated context
via aider-delegate, run branch, oracle gate), but log the run as `executor=glm-5.2` and flag the
self-delegation in notes. It's a valid data point, not a confound, because the orchestration
cost is separated.

---

## 4. Task matrix — content-hoarder scoped features

**Source:** `K:\Projects\content-hoarder` — open items from
`docs/backlog/epic-*.md` (26 epics; unchecked `- [ ]` items), cross-referenced with
`docs/backlog/github-issues.json` for issue numbers. content-hoarder has a clean pytest
discipline (1008 passing) and a proven bakeoff-oracle precedent
(`tests/test_bakeoff_f{9,14,15}_*.py`).

**Baseline concern:** content-hoarder's baseline is currently clean (1008 passing on
`feat/p3.5-legacy-retirement`). **Phase 0 must re-confirm the clean baseline** off `main`
(or the latest feature branch with a green suite) before any bakeoff run. No collection errors
expected (unlike the PKMS substrate).

### Candidate tasks (hard-oracle, RED → fix pairs)

Mined from open backlog items; each traces to a real epic + issue. Full provenance in the
sub-agent report; summarized here.

| # | ID | Item | Source | Oracle shape | Difficulty |
|---|---|---|---|---|---|
| 1 | **CH-B1** | Reddit `ai_ml` tagging | Epic 26, issue #71, `categorize.py` | `test_bakeoff_ch_b1_reddit_ai_ml.py` — `reddit_tags` emits `ai_ml` for ML subs + title keywords; off-topic stays empty; existing `coding` sub still tags `coding` not `ai_ml` | **Easy** (TOP PICK) |
| 2 | **CH-B3** | OCR text → FTS search wiring (`is:ocr`) | Epic 12, issue #26 (search-wiring half), `models.py`/`search_query.py`/`db.py` | `test_bakeoff_ch_b3_ocr_search.py` — `build_search_text` folds in `ocr_text`; `is:ocr` operator filters; no-`ocr_text` items byte-identical | **Medium** |
| 3 | **CH-B4** | User-tag rename-in-vocabulary | Epic 26, issue #70 (rename half), `db.py` | `test_bakeoff_ch_b4_rename_user_tag.py` — `rename_user_tag(old, new)` rewrites `tags_manual` only; `tags_auto` survives; FTS rebuilt; non-existent tag returns 0 | **Medium** |
| 4 | **CH-B7** | Triage high-skip-bucket detection | Epic 10, P3 (no GH issue), `triage_score.py` | `test_bakeoff_ch_b7_high_skip_buckets.py` — `high_skip_buckets(model, min_skip_rate=0.9, min_support=2)` returns r/highskip with skip_rate≈1.0; excludes low-support buckets | **Medium** (borderline — pin model dict shape) |
| 5 | **CH-B5** | PKMS thread→markdown export | Epic 21, issue #62 (**icebox**), `reddit_thread.py` | `test_bakeoff_ch_b5_thread_to_markdown.py` — `thread_to_markdown(thread_json, item)` renders H1 title + permalink + selftext + nested comments | **Medium** (flag: icebox — confirm before pulling forward) |

**Target: 3–4 hard-oracle tasks per model.** One task is an anecdote; three to four gives a
usable median. The CH-B1 (easy) + CH-B3 (medium, 3-file) + CH-B4 (medium, DB primitive) + CH-B7
(medium, analysis) set is the recommended core — it spans single-file additive, multi-file
wiring, DB read-modify-write, and pure-analysis shapes, which is the variance the bakeoff wants
to expose.

### Tasks to AVOID (not bakeoff-suitable)

| Item | Source | One-line reason |
|---|---|---|
| Comments-table normalization | Epic 24, issues #67/#68 | Whole-subsystem schema rewrite — exceeds 1-4 file scope |
| RepostSleuth reverse-image-hash spike | Epic 4, issue #12 | Undocumented live API; research spike, not offline/deterministic |
| Search operator rename (aliases) | Epic 12, issue #27 (icebox) | Gated on a user naming decision; no oracle until the rename map is fixed |
| Defense-bucket decay-wave review | Epic 21, issue #60 (P2) | Judgment review of live DB content, not a code task |

### Task selection rules (carry over from PKMS / Tier-B §3)

- **Mechanical + clean oracle** is the class — delegation *should* win, and the question is
  *which model wins*.
- Each task: 2–3× runs per model (variance is real — single runs mislead).
- **Test-first trick:** write the RED acceptance test before any arm runs; all arms turn it
  green without editing the oracle; reject any diff that edits the test or hard-codes the
  expected output.
- **Run-branch protocol:** each run on its own `bakeoff/<task>-<model>-run<N>` branch off the
  clean baseline; never auto-merge; human reviews after.
- **Naming:** follow the existing `test_bakeoff_<id>_<slug>.py` precedent
  (`test_bakeoff_ch_b1_reddit_ai_ml.py`, etc.) so the oracles are grep-findable and clearly
  distinguished from production tests.

---

## 5. Protocol (symmetric across all executors)

Per task, per executor model, per run:

1. **Orchestrator (GLM-5.2)** reads the task spec + oracle, writes a self-contained delegation
   spec (goal, files in scope, acceptance command). Log orchestrator tokens.
2. **Delegate** via `delegate_to_aider` MCP (preferred) or `aider-delegate` CLI. The executor
   runs the agentic loop (read→edit→test→observe→retry) against the oracle on its run branch.
   Log executor tokens + $.
3. **Verify** per the `aider-headless-delegate` checklist:
   - applied-edit count > 0,
   - `git status` scope = only files the spec names,
   - oracle test-file hash unchanged,
   - full suite green (not just the oracle) — content-hoarder's 1008-test suite is the
     regression floor.
4. **Review** the diff for test-gaming/hacks. Flag if quality is suspect despite green gate.
5. **Log** the run to the results CSV. Leave the result on its run branch.

**Symmetry rules (or the comparison lies):**
- Identical task statement + identical oracle for every executor.
- Identical orchestrator (GLM-5.2) for every run — it's a constant.
- Identical aider-delegate config (same `--auto-test --test-cmd`, same model metadata for $
  reporting) — only the `--model` flag changes.
- Don't over-review one model and under-review another. Review every diff exactly as you'd
  review a junior PR.
- 2–3× per task per model; report the spread, not just the median.

---

## 6. Instrumentation

| Side | Capture |
|---|---|
| Orchestrator (GLM-5.2, all arms) | aider-delegate's orchestrator token log; cross-check ZenMux dashboard $ |
| Executor (variable) | aider-delegate's per-token cost report (accurate for OpenAI-compatible); cross-check ZenMux dashboard $ |
| Gate | `pytest -q` exit code in content-hoarder `.venv` (one venv per project) |
| Run branch | `git status` scope check; oracle test-file hash before/after |

**Results CSV header (same as the PKMS bakeoff):**

```
run_id, task_id, tier, executor_model, executor_id, run_n,
orch_tok_in, orch_tok_out, orch_usd,
exec_tok_in, exec_tok_out, exec_usd,
wallclock_s, gate_pass, quality_verdict, first_shot, retries, notes
```

- `tier ∈ {T3_flash, T12_pro}` — the price line.
- `quality_verdict` — orchestrator's test-gaming review (`pass` / `flag`), separate from
  `gate_pass`.
- `first_shot` — bool, green on first attempt with no re-spec.
- Token-of-record: aider-delegate's in-harness counter, cross-checked against the ZenMux
  dashboard $ (the Tier-B bakeoff found broken token counting on some custom
  OpenAI-compatible providers — cross-check is non-negotiable).

---

## 7. Phasing — cheapest signal first

- **Phase 0 (≈half day): baseline + oracle authoring.**
  - Re-confirm content-hoarder clean test baseline (off `main` or the latest green feature
    branch). Record the number (expected ~1008).
  - GLM-5.2 orchestrates authoring the RED oracles for CH-B1, CH-B3, CH-B4, CH-B7. Human
    verifies each is red for the right reason with baselines held.
  - Confirm aider-delegate token reporting is accurate against ZenMux dashboard $ on one
    smoke run (CH-B1 is the easiest seed — single-file additive).
- **Phase 1 (T3 — the cheap tier, the main event):** run the 3–4 tasks × 6 T3 models × 2–3
  runs. This is the bulk of the data and the cheapest signal. Compute pass rate, median
  $/task, quality-to-cost ratio per model. Pick the T3 winner.
- **Phase 2 (T1/T2 — the premium tier, the experiment):** run the same 3–4 tasks × 4 Pro-line
  models × 2–3 runs. Higher cost per run — only run after Phase 1 lands, so the comparison is
  well-shaped. Compute the same metrics.
- **Phase 3 (decision + cross-substrate check):** does any Pro-line model beat the T3 winner
  on pass rate / first-shot rate by enough to justify ~3× cost? Build the routing table. Then
  **cross-check against the PKMS bakeoff** — if the same model wins on both substrates, the
  routing table is high-confidence; if not, document both and note which task shapes drove the
  difference.

**Kill-fast gates:**
- After Phase 0: if the baseline can't be confirmed clean or the oracles can't be authored
  red-for-the-right-reason, **stop** — the bakeoff can't produce trustworthy data.
- After Phase 1: if every T3 model passes every task first-shot (no variance), the T3 question
  is answered (they're all fine — pick the cheapest or the 1M-ctx one) and Phase 2 shrinks to
  a single Pro-line spot-check.

---

## 8. Pitfalls to design against (carry over from PKMS / Tier-B §7)

- **Test-gaming** — the `aider-headless-delegate` oracle-hash gate is the guard; the
  orchestrator review is the second guard. Reject any diff that edits the oracle.
- **Variance** — 2–3× minimum; report spread. A single run where MiniMax M3 flails is a data
  point, not a verdict.
- **Asymmetric effort** — the #1 way to fake a win. Identical specs, identical review
  strictness, identical run-branch protocol for every model.
- **Token-counting bugs** — the Tier-B bakeoff found broken token counting on some custom
  OpenAI-compatible providers. Cross-check every model's reported tokens against the ZenMux
  dashboard $ before trusting its $/task.
- **Promo expiration** — the ZenMux promo expires ~2026-08-03 (re-check). If it ends
  mid-bakeoff, the pricing data is still valid for the comparison (all models were on the same
  promo), but re-verify any absolute $ projection afterward.
- **Orchestrator cost leakage** — keep orchestrator tokens in their own columns; never fold
  them into the executor's $/task or the comparison is confounded.
- **GLM-5.2 self-delegation** — when GLM-5.2 is both orchestrator and executor, the run is
  valid but flag it in notes; the isolation (separate aider-delegate context, run branch) keeps
  it honest.
- **Substrate specificity** — a model that wins on content-hoarder but loses on PKMS (or vice
  versa) is a substrate-specific win, not a universal routing rule. The cross-check in Phase 3
  is what makes the routing table trustworthy.

---

## 9. Decision rule

After Phase 3, for each model compute pass rate, median $/task, first-shot rate,
quality-to-cost ratio. Then:

- **T3 winner** = highest quality-to-cost ratio among Flash-line models, provided pass rate
  ≥ the baseline expectation (e.g. ≥2/3 tasks green first-shot) and no test-gaming flags.
- **Pro tier verdict:**
  - If the best Pro-line model's pass rate / first-shot rate beats the T3 winner by a clear
    margin on the tasks the T3 winner struggled with → Pro tier earns its keep as the
    escalation lane for hard tasks.
  - If Pro models only match the T3 winner on tasks the T3 winner already aces → Pro tier is
    not worth ~3× for this workload; reserve it for genuinely hard jobs (the
    `orchestrator-mode` sizing rule).
- **Routing table output:** a one-line-per-model recommendation — "T3 default", "T3 1M-ctx
  option", "Pro escalation for hard tasks", "skip — quality or cost not competitive".
- **Cross-substrate verdict:** if the PKMS bakeoff has also landed, compare winners. Same
  winner → high-confidence routing table. Different winners → document both, note which task
  shapes drove the split, and pick the routing table per task-shape rather than per model.

If no model clears a usable bar → the honest answer is the current default (GLM-5.2 on ZenMux
as both orchestrator and executor) is already the right pick for this workload; don't over-fit
to the promo.

---

## 10. Setup checklist

- [ ] **Phase 0:** confirm content-hoarder clean test baseline (off `main` or latest green
      branch). Record the number (expected ~1008).
- [ ] Author CH-B1 RED oracle (`tests/test_bakeoff_ch_b1_reddit_ai_ml.py`); verify
      red-for-the-right-reason.
- [ ] Author CH-B3, CH-B4, CH-B7 RED oracles; verify each.
- [ ] (Optional) Author CH-B5 RED oracle — only if the user confirms pulling the icebox item
      forward.
- [ ] Confirm aider-delegate token reporting matches ZenMux dashboard $ on one smoke run
      (CH-B1 is the seed).
- [ ] Wire the T3 + T1/T2 executor models into aider-delegate's provider config (ZenMux
      Anthropic-format endpoint, model IDs from `ZenMux-Token-Economics-Promo-2026-07-03.md`).
- [ ] Seed the results CSV with the header from §6.
- [ ] Run Phase 1 (T3 × 3–4 tasks × 6 models × 2–3 runs).
- [ ] Run Phase 2 (T1/T2 × 3–4 tasks × 4 models × 2–3 runs).
- [ ] Compute metrics, build the routing table, write the verdict.
- [ ] Cross-check against the PKMS bakeoff verdict (if landed).

---

## 11. Icebox — deferred extensions

- **CH-B2 (human-mimic log-normal jitter, Epic 25 issue #69).** A clean single-file oracle
  exists, but the epic note says "explicitly a learning project — Kenja wants to build it
  himself." **Excluded unless the user explicitly waives the reservation.**
- **CH-B5 (PKMS thread→markdown export, Epic 21 issue #62).** Currently icebox; the read path
  is shipped so it's bakeoff-able, but confirm with the user before pulling forward.
- **Local models via `local-llm-bridge`.** Qwen3.6 35B, Devstral 24B, the new Qwen3-Coder-30B,
  etc. are free but slower and weaker; a separate "free but local" tier that doesn't compete on
  the promo's terms. Run only if the promo tier leaves a "cheap-but-good-enough" gap. Note:
  the 2026-07-04 LM Studio model upgrades (see
  `K:/Users/Kenja/Documents/LLM-dev/investigations/LM-Studio-Model-Upgrades-2026-07-04.md`) make this a live question —
  Qwen3-Coder-30B-A3B is a coding-specialist local model worth probing.
- **Caveman / Headroom compression levers.** Parked per Tier-B §11/§12 — one variable at a
  time. The compression verdict (if ever run) stacks on top of the model-selection verdict from
  this bakeoff, never confounded with it.
- **Long-horizon tasks.** This bakeoff is scoped features (mechanical, clean oracle). A
  long-horizon multi-step bakeoff is a different question (Tier-B §12 icebox (b)) — don't fold
  it in. The pro-model orchestration bakeoff (`Pro-Model-Orchestration-Bakeoff-Plan-2026-07-04.md`)
  is the companion for the orchestration question.
