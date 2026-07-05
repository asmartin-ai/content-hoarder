# CH-B1 delegation spec — Reddit `ai_ml` tagging

## Role & tier
You are the EXECUTOR for one bounded task handed down by a T1-frontier orchestrator.
Do exactly the task; do not re-scope, refactor beyond it, or touch unrelated files.

## Environment (cheap models hallucinate this — state it every time)
- User: Kenja. OS: Windows.
- CWD / repo root: K:\Projects\content-hoarder
- Absolute paths only. Python exe: backslashes (K:\Projects\content-hoarder\.venv\Scripts\python.exe).
  pytest path args: forward slashes (K:/Projects/content-hoarder/tests/test_bakeoff_ch_b1_reddit_ai_ml.py).

## Edit format (NON-NEGOTIABLE)
- Use --edit-format diff. Whole-file edits silently corrupt multi-file work on GLM/OpenModel.

## Goal
Make `tests/test_bakeoff_ch_b1_reddit_ai_ml.py` pass without modifying the test file.

The oracle (DO NOT EDIT — read-only context) is at
`tests/test_bakeoff_ch_b1_reddit_ai_ml.py`. It pins the contract:
- `categorize.reddit_tags(item)` MUST emit the `ai_ml` tag for items whose
  subreddit is an ML/AI community (`MachineLearning`, `datascience`) AND for
  items whose title carries an ML/AI keyword (`transformer`, `LLM`, `GPT-*`,
  `chatgpt`, `claude <digit|ai|model|sonnet|opus|haiku>`, `embedding`,
  `neural network`, `machine learning`, `deep learning`, `artificial intelligence`)
  when the subreddit itself does not map to a competing topic tag.
- Off-topic subreddit + off-topic title MUST NOT emit `ai_ml`.
- Existing `coding` subreddits (`learnpython`) MUST continue to emit `coding`
  (NOT `ai_ml`) — reclassification of an existing `coding` subreddit is a regression.
- `learnmachinelearning` is currently tagged `coding` and MUST be reclassified
  to `ai_ml` (NOT `coding`).

## Files in scope (the ONLY files you may edit)
- `src/content_hoarder/categorize.py`

## Approach (suggested; you may choose a different correct approach)
- `categorize.py` has a `_SUBREDDIT_TAGS` dict (subreddit -> tag list) and a
  reddit-specific `_KEYWORD_TAGS` list (regex, tag) used as a fallback when the
  subreddit map produced no topic tag. The existing `learnmachinelearning` entry
  in `_SUBREDDIT_TAGS` currently maps to `["coding"]` — change it to `["ai_ml"]`.
- Add `machinelearning` and `datascience` to `_SUBREDDIT_TAGS` mapping to `["ai_ml"]`
  (case is normalized to lowercase in the dict — verify the lookup lowercases
  the input subreddit before reading the dict).
- Add a new entry to the reddit `_KEYWORD_TAGS` list (NOT `_BROWSER_KEYWORD_TAGS` —
  there is a separate `ai_ml` keyword entry there already that you should NOT
  duplicate; the reddit list is the one used by `reddit_tags`) with the
  regex pattern from the Goal section, tagged `ai_ml`.

## Invariants (must hold)
- The existing `coding` subreddit classification (e.g. `learnpython -> coding`)
  is preserved byte-for-byte.
- No reordering or removal of unrelated entries in `_SUBREDDIT_TAGS` or
  `_KEYWORD_TAGS`.
- Don't edit the test file.

## Done-when
- `K:\Projects\content-hoarder\.venv\Scripts\python.exe -m pytest
   K:/Projects/content-hoarder/tests/test_bakeoff_ch_b1_reddit_ai_ml.py -q` exits 0
  (all 6 oracle tests pass).
- The full pre-existing suite still passes (no regressions in the 1008-test baseline).
- The oracle test file's hash is unchanged (you didn't edit the test).
- `git status -s` shows ONLY `src/content_hoarder/categorize.py` modified.
