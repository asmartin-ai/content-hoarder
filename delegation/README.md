# Delegation pack — local-LLM fix prompts

Self-contained prompts for delegating well-scoped fixes to the local LM Studio models,
authored from the 2026-06-09 comprehensive review (BACKLOG Epic 19). Each file contains
**everything the model needs** — code excerpts, exact requirements, constraints, and the
acceptance test — so it works even with no repo access (paste into LM Studio chat). If you
run them through Continue.dev with repo context, the model may additionally read files.

## Model routing

| Tag in prompt | Model | Why |
|---|---|---|
| `devstral` | `devstral-small-2-24b-instruct-2512` | Single-file focused diffs; 8k context — these prompts are kept small |
| `qwen-3.6` | `qwen/qwen3.6-35b-a3b` (enable thinking) | Multi-file changes or test authoring needing more context (32k) |

## Workflow

1. Work on the **`fix/unsave-hardening`** branch.
2. Run a prompt file with its recommended model. Ask for **a unified diff only**.
3. Apply the diff (`git apply` or by hand if line drift). One prompt = one commit:
   `fix(<area>): <summary> (delegation/NN)`.
4. Run that prompt's **Acceptance** command. Red = iterate locally or flag for Claude review.
5. When a batch is done, hand back to Claude Code for review (`git diff main...`), full
   `pytest`, and repair.

Order is mostly free; exceptions: **05 and 06 touch different regions of `web.py`** (safe in
either order, apply one at a time). **08 is test-only and may legitimately fail** — if red,
stop and report; the fix is Claude-owned.

## Conventions the diffs must follow

- Python 3.11+, stdlib only (Flask is the only web dep). Match the surrounding comment
  density and style — this codebase explains *why*, not *what*.
- Never change the injectable test seams (`post=`, `getf=`, `sleep=` parameters).
- Tests are offline: no real network, in-memory/tmp SQLite (`conn` / `tmp_db` fixtures in
  `tests/conftest.py`).
- Run tests as: `python -m pytest tests/<file> --basetemp .pytest-tmp -q`
  (the `--basetemp` inside the repo avoids a Windows temp-dir permission quirk).
