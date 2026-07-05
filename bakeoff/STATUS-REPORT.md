# content-hoarder bakeoff — status report for monitor agent

**Generated:** 2026-07-05 (post-cleanup session).
**Repo:** `K:\Projects\content-hoarder`, branch `main` @ `d94dc69`.
**Suite:** 1029 passed, 0 failed (1012 baseline + 17 newly-green oracle tests from 4 cherry-picks).
**Local model:** unloaded (`lms ps` confirms none loaded).
**Temp refs:** `bakeoff/cherry-pick-snapshot` deleted.

---

## 1. Bakeoff verdict (Phase 0 + 1 + 2 COMPLETE)

**80 runs** across 4 hard-oracle tasks × 10 models × 2 runs. Total executor spend **$0.43** (ZenMux PAYG, promo pricing). Orchestrator: GLM-5.2 (Zed agent). Full data in `bakeoff/results.csv`; full writeup in `bakeoff/RESULTS.md`.

| Tier | Winner | Pass rate | Median $/pass | Q2C |
|---|---|---|---|---|
| **T3 (Flash, $0.14/$0.28/M)** | `minimax/minimax-m3` | 0.88 | $0.0025 | 347 |
| T3 reliability picks | `deepseek-v4-flash`, `qwen3.7-plus`, `qwen3.6-flash` | 1.00 | ~$0.005 | ~210 |
| **Pro ($0.435/$0.87/M)** | NOT worth ~3× cost | — | — | — |
| Pro best | `qwen/qwen3.7-max` | 1.00 | $0.014 | 71 |

**Key findings:**
- T3 Flash tier is sufficient for scoped feature work — 3 models hit 100% pass.
- Pro tier does NOT earn its ~3× cost here. Only `qwen3.7-max` (100%) beats the T3 winner on pass rate, at 5.6× the cost per pass. `deepseek-v4-pro` (62%) and `kimi-k2.7-code` (50%) are *worse* than minimax-m3.
- `z-ai/glm-5.2` (25% pass) and `stepfun/step-3.7-flash` (25% pass) are unusable for headless delegation — the M5 thinking-tokens bug (burns 50K+ output tokens on thinking prose, hits output cap with 0 edits applied).
- Variance is real (several models split 1/2 on a task); 2 runs is the floor, not the ceiling.
- **CH-B3 (3-file wiring) is the discriminator task** — separates coding-specialists from generalists. kuaishou, kimi, stepfun, glm-5.2 all struggle (0/2 or 1/2); the T3 perfect-scorers and qwen3.7-max all pass.

**Cross-substrate check:** PKMS bakeoff not yet run (companion plan exists). Routing table stands alone for now; high-confidence once PKMS confirms.

---

## 2. Productionization status

### 2a. Cherry-picks to main — DONE ✓
All 4 winning diffs (minimax-m3 run1 for each task) cherry-picked to main and verified:
- `dcccc2c` CH-B1 (categorize.py — ai_ml tagging)
- `248be11` CH-B3 (db.py + search_query.py — OCR→FTS wiring)
- `628bf4c` CH-B4 (db.py — rename_user_tag, uses canonical FTS5 rebuild)
- `ae2a34f` CH-B7 (triage_score.py — high_skip_buckets)

All 4 oracles now GREEN on main. Full suite 1029 passed, 0 failed. Diffs spot-reviewed — genuine fixes, no test-gaming. No anti-drift regressions.

**Mid-bakeoff oracle fix:** CH-B7's `_model` helper had a variable-shadowing bug (`{k: [n, k, rate] for k, (n, k, rate) in ...}` — dict key overwritten by tuple's processed-count). Fixed in commit `066047d` before the final batch; all 8 CH-B7 runs used the fixed oracle. The fix is on main and must not be regressed.

### 2b. Local control backfill (GAP) — BLOCKED ⏳
CH ran only 1 Phase 0 smoke for `qwen3-coder-30b-a3b-instruct`; never ran it in Phase 1. PKMS found it clears easy single-file 2/2 but flails on multi-file 0/2 (edit-parse failures). Attempted to run on CH (CH-B1 + CH-B3 × 2 runs = 4 runs) but **blocked**:

- **qwen3-coder-30b-a3b-instruct times out** (even at 1800s wallclock) when given the full 2KB delegation spec + 38KB `categorize.py` + oracle test as `--read` context.
- With a SHORT inline message (no spec file), the model completes in <90s and applies the edit correctly.
- 4 attempts logged, all failed with `diff=''`, `applied=False`. No rows appended to results.csv (removed the failed rows).
- **Finding (provisional):** the local lane cannot handle the full delegation-spec shape that cloud models handle. This is itself a valid data point — confirms PKMS's "easy-single-file-only" characterization, possibly extends to "needs-leaner-spec" too. Not yet a definitive 0/2 on multi-file because the timeout may be a context-size issue rather than an edit-parse issue.

**To unblock:** either (a) author a leaner per-task spec for the local lane (1-2 sentences, not the full 2KB markdown), or (b) accept the timeout as the finding and document it, or (c) retry with `--map-tokens 0` already set (it is) and a smaller `--read` set (drop the oracle test from `--read` — the spec already describes the contract).

### 2c. Driver tooling — DONE ✓
- `scripts/bakeoff_arm.py` — per-run driver with 4-check verification (applied-edit count via `git diff --stat HEAD`, scope check, oracle hash, full suite green) + CSV row append. Now supports `--local` mode (raw `--api-base http://127.0.0.1:1234/v1`, openai format, $0 cost).
- `scripts/bakeoff_batch.py` — batch runner, idempotent (skips existing run_ids), commits results.csv after each row.
- `bakeoff/specs/{ch-b1,ch-b3,ch-b4,ch-b7}.md` — per-task delegation specs.

**Driver bug fixed mid-run:** `git status --porcelain` output must NOT be `.strip()`d — the leading space of the first line (the `XY ` prefix) gets stripped, corrupting the per-line path parse. Fixed by only rstrip'ing `\r\n`.

---

## 3. Open items (not done)

| # | Item | Status | Notes |
|---|---|---|---|
| 1 | Run-branch cleanup | NOT STARTED | 82 `delegated/run-*` branches preserved as audit trail. Delete with `git branch -D $(git branch --list 'delegated/run-*')` after main is confirmed green (it is). |
| 2 | Push decision | NOT STARTED | 124 commits ahead of `origin/main` (user-gated per §7). `git diff --stat origin/main..main` to review. |
| 3 | PAYG→subscription rewiring | NOT STARTED | Default completions key for ongoing delegation is `ZENMUX_API_KEY` (subscription, `sk-ss-v1-`). PAYG (`ZENMUX_PAYG_API_KEY`) was bakeoff-only. Verify the agent-hub `aider-headless-delegate` SKILL.md M19 note reflects this. |
| 4 | NEXT.md update | NOT STARTED | Needs cherry-pick + backfill status + the local-backfill-blocked finding. |
| 5 | Local control backfill | BLOCKED | See §2b above. |

---

## 4. Orchestrator-mode wiring (agent-hub)

Per the handoff: orchestrator-mode + orchestrator-law routing table already updated in agent-hub (MiniMax M3 default). This bakeoff's verdict is consistent with that wiring — `minimax/minimax-m3` is the T3 cost winner. The reliability picks (`deepseek-v4-flash`, `qwen3.7-plus`) are the fallback when correctness > cost.

---

## 5. Repo state for the next agent

- **Branch:** `main` @ `d94dc69`
- **Suite:** 1029 passed, 0 failed (73 deselected — the UI/Playwright tests, excluded by default)
- **Working tree:** clean
- **Local model:** unloaded
- **Temp refs:** none (`bakeoff/cherry-pick-snapshot` deleted)
- **Key files:**
  - `bakeoff/RESULTS.md` — full verdict
  - `bakeoff/results.csv` — 82 rows (80 cloud + 2 Phase 0 smoke)
  - `bakeoff/specs/` — 4 per-task delegation specs
  - `scripts/bakeoff_arm.py` + `scripts/bakeoff_batch.py` — driver + batch runner
  - 82 `delegated/run-*` branches — audit trail (delete after review)

**Hard constraints (carry forward):**
- Never edit an oracle test file to make it pass.
- Full suite must stay green (1029 — watch for anti-drift regressions on future edits to `db.py` / `search_query.py` / `categorize.py` / `triage_score.py`).
- CH-B7 oracle's `_model` helper was fixed mid-bakeoff (`066047d`) — don't regress it.
- One local model loaded at a time — `lms load` → run → `lms unload`, `lms ps` confirms.
