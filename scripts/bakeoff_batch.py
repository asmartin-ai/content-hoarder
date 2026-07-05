"""Bakeoff batch runner — runs Phase 1 (T3) and Phase 2 (T1/T2) delegations.

Usage:
    python scripts/bakeoff_batch.py [--phase 1|2|all] [--runs N] [--timeout S]

Iterates over all (task, model) combinations for the requested phase(s),
running N runs per combination. Writes progress to bakeoff/batch.log and
appends rows to bakeoff/results.csv. Designed to be run as a long background
job; safe to interrupt and resume (idempotent — skips runs whose run_id
already exists in the CSV).

Phase 1 (T3_flash, $0.14/$0.28 per M): 4 tasks × 6 models × N runs = 24×N runs.
Phase 2 (T12_pro, $0.435/$0.87 per M): 4 tasks × 4 models × N runs = 16×N runs.
"""

from __future__ import annotations

import argparse
import csv
import sys
import time
from pathlib import Path

REPO = Path(r"K:\Projects\content-hoarder").resolve()
BAKEOFF = REPO / "bakeoff"
RESULTS_CSV = BAKEOFF / "results.csv"
LOG = BAKEOFF / "batch.log"

# (task_id, model_id, tier)
T3_MODELS = [
    "deepseek/deepseek-v4-flash",
    "minimax/minimax-m3",
    "qwen/qwen3.7-plus",
    "stepfun/step-3.7-flash",
    "kuaishou/kat-coder-pro-v2",
    "qwen/qwen3.6-flash",
]
T12_MODELS = [
    "deepseek/deepseek-v4-pro",
    "z-ai/glm-5.2",
    "moonshotai/kimi-k2.7-code",
    "qwen/qwen3.7-max",
]
TASKS = ["CH-B1", "CH-B3", "CH-B4", "CH-B7"]


def log(msg: str) -> None:
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] {msg}"
    print(line, flush=True)
    with LOG.open("a", encoding="utf-8") as f:
        f.write(line + "\n")


def existing_run_ids() -> set[str]:
    if not RESULTS_CSV.exists():
        return set()
    ids: set[str] = set()
    with RESULTS_CSV.open("r", encoding="utf-8", newline="") as f:
        for row in csv.DictReader(f):
            if row.get("run_id"):
                ids.add(row["run_id"])
    return ids


def make_run_id(task_id: str, model_id: str, run_n: int) -> str:
    return (
        f"{task_id.lower().replace('-', '')}-"
        f"{model_id.replace('/', '-').replace('.', '-')}-run{run_n}"
    )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--phase", choices=["1", "2", "all"], default="all")
    ap.add_argument("--runs", type=int, default=2)
    ap.add_argument("--timeout", type=int, default=900)
    ap.add_argument(
        "--tasks",
        default=",".join(TASKS),
        help="comma-separated task IDs (default: all 4)",
    )
    args = ap.parse_args()

    tasks = args.tasks.split(",")
    phases: list[tuple[str, list[str]]] = []
    if args.phase in ("1", "all"):
        phases.append(("T3_flash", T3_MODELS))
    if args.phase in ("2", "all"):
        phases.append(("T12_pro", T12_MODELS))

    # Import the arm driver.
    sys.path.insert(0, str(REPO / "scripts"))
    from bakeoff_arm import append_row, run_arm  # type: ignore

    existing = existing_run_ids()
    total = sum(len(tasks) * len(models) * args.runs for _, models in phases)
    done = 0
    passed = 0
    failed = 0
    skipped = 0
    log(
        f"=== bakeoff batch start: phase={args.phase} tasks={tasks} runs={args.runs} "
        f"total_planned={total} existing={len(existing)} ==="
    )

    for tier, models in phases:
        for task_id in tasks:
            for model_id in models:
                for run_n in range(1, args.runs + 1):
                    rid = make_run_id(task_id, model_id, run_n)
                    if rid in existing:
                        log(f"[skip {done + 1}/{total}] {rid} (already in CSV)")
                        skipped += 1
                        done += 1
                        continue
                    log(
                        f"[run  {done + 1}/{total}] {task_id} {model_id} run{run_n} ({tier})"
                    )
                    t0 = time.time()
                    try:
                        row = run_arm(
                            task_id,
                            model_id,
                            run_n,
                            provider="zenmux",
                            tier=tier,
                            timeout=args.timeout,
                        )
                        append_row(row)
                        elapsed = int(time.time() - t0)
                        gp = row["gate_pass"]
                        if gp == "pass":
                            passed += 1
                            log(
                                f"  -> PASS in {elapsed}s  exec_usd={row.get('exec_usd')}  "
                                f"tok_in={row.get('exec_tok_in')} tok_out={row.get('exec_tok_out')}"
                            )
                        else:
                            failed += 1
                            log(
                                f"  -> FAIL in {elapsed}s  notes={row.get('notes', '')[:200]}"
                            )
                    except Exception as e:
                        elapsed = int(time.time() - t0)
                        failed += 1
                        log(f"  -> ERROR in {elapsed}s: {type(e).__name__}: {e}")
                    done += 1

    log(
        f"=== bakeoff batch done: total={done} passed={passed} failed={failed} skipped={skipped} ==="
    )
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
