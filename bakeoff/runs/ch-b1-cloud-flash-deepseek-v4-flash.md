# Phase 0 smoke run — CH-B1 cloud arm

- **Executor:** DeepSeek V4 Flash (`deepseek/deepseek-v4-flash`) via ZenMux (PAYG key)
- **Branch:** `delegated/run-7466c395` (created off `998a234`, the RED-oracle commit)
- **Outcome:** first-shot green (6/6 oracle tests pass), 4-check verification cleared
- **Tokens:** 15k sent / 6.3k received → `exec_usd = (15000 × $0.14 + 6300 × $0.28) / 1M = $0.003864`
- **Diff stat:** `src/content_hoarder/categorize.py | 15 +++++++++++++++` (15 insertions, 0 deletions)

## Caveat

The aider-delegate CLI created the run branch but **did not commit** the edit — it was left
as an uncommitted working-tree modification. At the end of Phase 0 the orchestrator ran
`git checkout -- categorize.py && git checkout main` to restore the baseline, which
discarded the working-tree edit. The branch itself has no commits ahead of the oracle
base (`git log main..delegated/run-7466c395 --oneline` is empty). The diff below is
reconstructed from the `git diff` output captured in the Phase 0 report; the original
working-tree copy is gone.

## Diff (reconstructed from Phase 0 report — 2026-07-04)

```diff
diff --git a/src/content_hoarder/categorize.py b/src/content_hoarder/categorize.py
--- a/src/content_hoarder/categorize.py
+++ b/src/content_hoarder/categorize.py
@@ -470,6 +470,14 @@ _SUBREDDIT_TAGS.update(
     }
 )

+_SUBREDDIT_TAGS.update(
+    {
+        "machinelearning": ["ai_ml"],
+        "datascience": ["ai_ml"],
+        "learnmachinelearning": ["ai_ml"],
+    }
+)
+
 # Keyword fallback for items whose subreddit isn't mapped — applied to the subreddit name +
 # title ONLY (never body: incidental body mentions, e.g. an AskReddit answer that says "Japan",
 # caused false positives) and only when the subreddit map produced no topic tag. Word-bounded.
@@ -492,6 +500,13 @@ _KEYWORD_TAGS = [
             re.IGNORECASE,
         ),
     ),
+    (
+        "ai_ml",
+        re.compile(
+            r"\bllm\b|\bgpt[- ]?\d+\b|\bchatgpt\b|\bclaude\s+(?:\d|ai|model|sonnet|opus|haiku)\b|\btransformer\b|\bembedding\b|\bneural network\b|\bmachine learning\b|\bdeep learning\b|\bartificial intelligence\b",
+            re.IGNORECASE,
+        ),
+    ),
 ]
```

## Quality notes

- Approach: added a separate `_SUBREDDIT_TAGS.update({...})` block for the 3 ML subs, and
  added a new `ai_ml` entry to the reddit `_KEYWORD_TAGS` list (which previously lacked it —
  the existing `ai_ml` keyword entry at L786 is in `_BROWSER_KEYWORD_TAGS`, a different list).
- Did NOT touch the existing `learnmachinelearning: ["coding"]` entry — instead the new
  `_SUBREDDIT_TAGS.update` block shadows it with `["ai_ml"]`. (Python dict: last write wins.)
  Functionally correct; mild code smell (two definitions of `learnmachinelearning` in the same
  dict — the L470 entry wins because the `update` block at L470+ runs after the L464 block).
- All 4 oracle contract clauses satisfied: ML subs emit `ai_ml`, ML keyword on neutral sub
  emits `ai_ml`, off-topic stays empty, existing coding subs (`learnpython`) stay `coding`.
