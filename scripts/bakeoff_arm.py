"""Bakeoff arm driver — runs one (task, model, run_n) and appends a CSV row.

Usage:
    python scripts/bakeoff_arm.py <task_id> <model_id> <run_n> [--provider P]
                                 [--tier T3_flash|T12_pro] [--timeout S]

Tasks map to specs in bakeoff/specs/<id>.md and oracle tests in
tests/test_bakeoff_ch_<id_slug>.py. Models are ZenMux IDs (e.g.
deepseek/deepseek-v4-flash). The driver:

  1. Records the oracle test file hash before the run.
  2. Calls aider-delegate with the per-task spec + editable files + test cmd,
     using the zenmux provider preset but overriding --api-key-env to
     ZENMUX_PAYG_API_KEY (per M19: PAYG keeps the per-token rate at the promo
     price and makes per-run $ verification programmatic).
  3. Verifies the 4 checks: applied-edit count > 0 (via git diff --stat, NOT
     the wrapper's reported count per M13), git status scope, oracle hash
     unchanged, full suite green.
  4. Computes exec_usd from the wrapper's reported tokens × the known
     Pro/Flash rate.
  5. Commits the diff to the run branch (so the diff is preserved for review).
  6. Checks out back to main so the next run starts clean.
  7. Appends a row to bakeoff/results.csv.

Run branches are left in place for human review (never auto-merged).
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

REPO = Path(r"K:\Projects\content-hoarder").resolve()
BAKEOFF = REPO / "bakeoff"
SPECS = BAKEOFF / "specs"
RESULTS_CSV = BAKEOFF / "results.csv"
VENV_PY = REPO / ".venv" / "Scripts" / "python.exe"
AIDER_DELEGATE = r"K:/Projects/aider-delegate/.venv/Scripts/aider-delegate.exe"

# task_id -> spec + editable files + oracle tests
TASKS: dict[str, dict] = {
    "CH-B1": {
        "spec": "ch-b1.md",
        "editable": ["src/content_hoarder/categorize.py"],
        "oracle": ["tests/test_bakeoff_ch_b1_reddit_ai_ml.py"],
    },
    "CH-B3": {
        "spec": "ch-b3.md",
        "editable": [
            "src/content_hoarder/models.py",
            "src/content_hoarder/search_query.py",
            "src/content_hoarder/db.py",
        ],
        "oracle": ["tests/test_bakeoff_ch_b3_ocr_search.py"],
    },
    "CH-B4": {
        "spec": "ch-b4.md",
        "editable": ["src/content_hoarder/db.py"],
        "oracle": ["tests/test_bakeoff_ch_b4_rename_user_tag.py"],
    },
    "CH-B7": {
        "spec": "ch-b7.md",
        "editable": ["src/content_hoarder/triage_score.py"],
        "oracle": ["tests/test_bakeoff_ch_b7_high_skip_buckets.py"],
    },
}

# Per-M pricing (USD per 1M tokens) by tier. Source: bakeoff plan §3.
TIER_RATES: dict[str, tuple[float, float]] = {
    "T3_flash": (0.14, 0.28),  # in, out per 1M
    "T12_pro": (0.435, 0.87),
}

PROTECTED = {"main", "master"}


def git(*args: str, cwd: Path = REPO, check: bool = True) -> str:
    r = subprocess.run(
        ["git", "--no-pager", *args], cwd=cwd, capture_output=True, text=True
    )
    if check and r.returncode != 0:
        raise RuntimeError(f"git {args[:2]} failed: {r.stderr}")
    return r.stdout


def current_branch() -> str:
    return git("rev-parse", "--abbrev-ref", "HEAD").strip()


def file_hash(p: Path) -> str:
    h = hashlib.sha256()
    h.update(p.read_bytes())
    return h.hexdigest()


def parse_tokens_from_stdout(stdout: str) -> tuple[int, int] | None:
    """Extract (tokens_in, tokens_out) from aider's stdout.

    Aider prints cost lines like 'Tokens: 5.2k sent, 384 cache hit, 2.6k received.'
    or '5.2k sent / 2.6k received'. Accept either form and normalize to int tokens.
    """
    m = re.search(
        r"([\d.]+)\s*(k?)\s*sent[, ].*?([\d.]+)\s*(k?)\s*received",
        stdout,
    )
    if not m:
        return None
    tin = float(m.group(1)) * (1000 if m.group(2) == "k" else 1)
    tout = float(m.group(3)) * (1000 if m.group(4) == "k" else 1)
    return int(tin), int(tout)


def run_arm(
    task_id: str, model_id: str, run_n: int, *, provider: str, tier: str, timeout: int
) -> dict:
    task = TASKS[task_id]
    spec_path = SPECS / task["spec"]
    spec_text = spec_path.read_text(encoding="utf-8")
    oracle_paths = [REPO / o for o in task["oracle"]]
    oracle_hashes_before = {str(p): file_hash(p) for p in oracle_paths}
    test_cmd = f"{VENV_PY} -m pytest {' '.join(task['oracle'])} -q"

    starting_branch = current_branch()
    if starting_branch in PROTECTED:
        # The wrapper will create the safety branch for us.
        pass
    else:
        # We expect to be on main; if not, that's a bug. Reset to main.
        raise RuntimeError(f"unexpected starting branch {starting_branch!r}; aborting")

    # Sanity: clean tree before run
    status = git("status", "--porcelain").strip()
    if status:
        raise RuntimeError(f"working tree not clean before run:\n{status}")

    # Build the aider-delegate command. The wrapper auto-creates a
    # delegated/run-<id> branch off HEAD and leaves us on it.
    cmd = [
        AIDER_DELEGATE,
        "--repo-path",
        str(REPO),
        "--message",
        spec_text,
        "--editable-files",
        *task["editable"],
        "--read-files",
        *task["oracle"],
        "--provider",
        provider,
        "--api-key-env",
        "ZENMUX_PAYG_API_KEY",
        "--api-format",
        "anthropic",
        "--model",
        model_id,
        "--edit-format",
        "diff",
        "--test-cmd",
        test_cmd,
        "--timeout-seconds",
        str(timeout),
        "--pretty",
    ]
    t0 = time.time()
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout + 90)
    wallclock_s = int(time.time() - t0)
    raw_stdout = proc.stdout

    # Parse JSON result.
    result: dict = {}
    try:
        result = json.loads(raw_stdout)
    except json.JSONDecodeError:
        for line in reversed(raw_stdout.strip().splitlines()):
            try:
                result = json.loads(line)
                break
            except json.JSONDecodeError:
                continue
        if not result:
            result = {"error": "non-JSON stdout", "stdout_tail": raw_stdout[-1500:]}

    run_branch = result.get("branch_created") or "(no branch)"
    branch_now = current_branch()

    # Tokens (from the wrapper stdout — M18: cost_reported may be null on ZenMux)
    tokens_in, tokens_out = None, None
    tok_match = parse_tokens_from_stdout(raw_stdout)
    if tok_match:
        tokens_in, tokens_out = tok_match
    rate_in, rate_out = TIER_RATES[tier]
    exec_usd = (
        round((tokens_in * rate_in + tokens_out * rate_out) / 1_000_000, 6)
        if tokens_in is not None and tokens_out is not None
        else None
    )

    # 4-check verification. We're now on `run_branch` with uncommitted edits.
    # 1. Applied-edit count > 0 (git diff --stat per M13).
    diff_stat = git("diff", "--stat", "HEAD", check=False).strip()
    print(
        f"[debug-pre-status] branch={current_branch()} HEAD={git('rev-parse', 'HEAD')[:8]} status={git('status', '--porcelain')!r} log={git('log', '--oneline', '-3')!r}",
        file=sys.stderr,
    )
    diff_files = [
        line.split("|", 1)[0].strip() for line in diff_stat.splitlines() if "|" in line
    ]
    applied = bool(diff_files)

    # 2. git status scope — only in-scope files dirty.
    git_status = git("status", "--porcelain", check=False).strip()
    print(f"[debug-status] git_status={git_status!r}", file=sys.stderr)
    # Format: "XY <path>" where XY is 2 status chars + 1 space. But the exact
    # spacing varies (staged: 'M  path', unstaged: ' M path', both: 'MM path'),
    # and Windows CRLF can add chars. Robust parse: drop the first 3 chars (the
    # 'XY ' prefix), then strip any remaining leading whitespace.
    dirty_files: set[str] = set()
    for line in git_status.splitlines():
        if not line:
            continue
        print(
            f"[debug-raw] line={line!r} len={len(line)} chars={[c for c in line[:5]]}",
            file=sys.stderr,
        )
        # Drop the 2-char status prefix + the single separating space.
        path = line[3:].strip()
        # Handle renames: "R  old -> new" -> take new
        if " -> " in path:
            path = path.split(" -> ", 1)[1].strip()
        dirty_files.add(path)
    scope_clean = dirty_files.issubset(set(task["editable"]))
    print(
        f"[debug] dirty_files={sorted(dirty_files)} editable={task['editable']}",
        file=sys.stderr,
    )
    print(
        f"[debug] dirty_files={sorted(dirty_files)} editable={task['editable']}",
        file=sys.stderr,
    )
    print(
        f"[debug] dirty_files={sorted(dirty_files)} editable={task['editable']}",
        file=sys.stderr,
    )
    print(
        f"[debug] dirty_files={sorted(dirty_files)} editable={task['editable']}",
        file=sys.stderr,
    )
    print(
        f"[debug] dirty_files={sorted(dirty_files)} editable={task['editable']}",
        file=sys.stderr,
    )

    # 3. Oracle hash unchanged.
    oracle_hashes_after = {str(p): file_hash(p) for p in oracle_paths}
    oracle_changed = any(
        oracle_hashes_before[k] != oracle_hashes_after[k] for k in oracle_hashes_before
    )

    # 4. Full suite green — but other bakeoff oracles (CH-B*) remain RED on
    # the baseline (they're separate tasks). The regression floor is:
    #   - this task's oracle: green
    #   - the other CH-B* oracles: still RED (expected, they're not in scope)
    #   - the 1008 pre-existing tests: still green
    # So we run the full suite and assert: the ONLY failures are in other
    # tasks' oracle files (test_bakeoff_ch_<id>_*.py where id != this task).
    other_oracle_files = {
        Path(o).name for tid, t in TASKS.items() if tid != task_id for o in t["oracle"]
    }
    print(f"[verify] branch={branch_now} running full pytest suite...", file=sys.stderr)
    try:
        pytest_proc = subprocess.run(
            [str(VENV_PY), "-m", "pytest", "tests/", "-q"],
            cwd=REPO,
            capture_output=True,
            text=True,
            timeout=900,
        )
        suite_lines = pytest_proc.stdout.strip().splitlines()
        suite_summary = suite_lines[-1] if suite_lines else "(no output)"
        # Collect the failed test file paths from the summary.
        failed_files: set[str] = set()
        for line in suite_lines:
            m = re.match(r"FAILED\s+(tests/[^:]+):", line)
            if m:
                failed_files.add(Path(m.group(1)).name)
        # Suite is "green for this task" = no failures outside the other oracles.
        unexpected_failures = failed_files - other_oracle_files
        suite_green = pytest_proc.returncode == 0 or (
            not unexpected_failures
            and all(
                # This task's own oracle must be green (not in failed_files).
                Path(o).name not in failed_files
                for o in task["oracle"]
            )
        )
    except subprocess.TimeoutExpired:
        suite_summary = "TIMEOUT"
        suite_green = False
        unexpected_failures = {"(timeout)"}

    gate_pass = (
        "pass"
        if (applied and not oracle_changed and suite_green and scope_clean)
        else "fail"
    )
    first_shot = gate_pass == "pass"

    # Commit the diff to the run branch (preserve for review) then return to main.
    committed = False
    if applied and scope_clean and not oracle_changed:
        try:
            git("add", *task["editable"])
            git(
                "commit",
                "-m",
                f"bakeoff {task_id} {model_id} run{run_n} ({tier})",
                check=False,
            )
            committed = True
        except Exception as e:
            print(f"[warn] commit failed: {e}", file=sys.stderr)
    # Always return to main so the next run starts clean.
    if branch_now != "main":
        # Discard any uncommitted leftovers before checkout.
        git("checkout", "--", ".", check=False)
        # Remove any untracked .aider litter (defensive; wrapper should have done it)
        git("clean", "-fd", "--", ".aider*", check=False)
        git("checkout", "main", check=False)

    # Verify we're back on main and clean.
    end_branch = current_branch()
    end_status = git("status", "--porcelain", check=False).strip()

    row = {
        "run_id": f"{task_id.lower().replace('-', '')}-{model_id.replace('/', '-').replace('.', '-')}-run{run_n}",
        "task_id": task_id,
        "tier": tier,
        "executor_model": model_id.split("/")[-1],
        "executor_id": model_id,
        "run_n": run_n,
        "orch_tok_in": "",
        "orch_tok_out": "",
        "orch_usd": "",
        "exec_tok_in": tokens_in if tokens_in is not None else "",
        "exec_tok_out": tokens_out if tokens_out is not None else "",
        "exec_usd": exec_usd if exec_usd is not None else "",
        "wallclock_s": wallclock_s,
        "gate_pass": gate_pass,
        "quality_verdict": "pass"
        if (gate_pass == "pass" and not oracle_changed)
        else "flag",
        "first_shot": first_shot,
        "retries": 0,
        "notes": (
            f"branch={run_branch}; diff={diff_stat!r}; suite={suite_summary!r}; "
            f"unexpected_failures={sorted(unexpected_failures)!r}; "
            f"oracle_changed={oracle_changed}; scope_clean={scope_clean}; "
            f"applied={applied}; committed={committed}; "
            f"end_branch={end_branch}; end_clean={not end_status}"
        ),
    }
    return row


def append_row(row: dict) -> None:
    fieldnames = [
        "run_id",
        "task_id",
        "tier",
        "executor_model",
        "executor_id",
        "run_n",
        "orch_tok_in",
        "orch_tok_out",
        "orch_usd",
        "exec_tok_in",
        "exec_tok_out",
        "exec_usd",
        "wallclock_s",
        "gate_pass",
        "quality_verdict",
        "first_shot",
        "retries",
        "notes",
    ]
    exists = RESULTS_CSV.exists() and RESULTS_CSV.read_text(encoding="utf-8").strip()
    with RESULTS_CSV.open("a", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        if not exists:
            w.writeheader()
        w.writerow(row)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("task_id", choices=list(TASKS))
    ap.add_argument("model_id")
    ap.add_argument("run_n", type=int)
    ap.add_argument("--provider", default="zenmux")
    ap.add_argument("--tier", choices=list(TIER_RATES), default="T3_flash")
    ap.add_argument("--timeout", type=int, default=900)
    args = ap.parse_args()

    row = run_arm(
        args.task_id,
        args.model_id,
        args.run_n,
        provider=args.provider,
        tier=args.tier,
        timeout=args.timeout,
    )
    append_row(row)
    print(json.dumps(row, indent=2))
    return 0 if row["gate_pass"] == "pass" else 1


if __name__ == "__main__":
    sys.exit(main())
