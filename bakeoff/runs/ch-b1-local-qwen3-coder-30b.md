# Phase 0 smoke run — CH-B1 local arm

- **Executor:** Qwen3-Coder-30B-A3B-Instruct (local, LM Studio, `--ttl 300`)
- **Branch:** `delegated/run-6c81de9e` (created off `998a234`, the RED-oracle commit)
- **Outcome:** first-shot green (6/6 oracle tests pass), 4-check verification cleared
- **Tokens:** 16k sent / 295 received → `exec_usd = $0.0` (local model, free)
- **Diff stat:** `src/content_hoarder/categorize.py | 14 +++++++++++++-` (13 insertions, 1 deletion)

## Caveat

Same as the cloud arm: aider-delegate left the edit as an uncommitted working-tree modification
on the run branch. The orchestrator restored the baseline at the end of Phase 0, discarding the
working-tree edit. The branch has no commits ahead of the oracle base. The diff below is
reconstructed from the `git diff` output captured in the Phase 0 report.

## Diff (reconstructed from Phase 0 report — 2026-07-04)

```diff
diff --git a/src/content_hoarder/categorize.py b/src/content_hoarder/categorize.py
--- a/src/content_hoarder/categorize.py
+++ b/src/content_hoarder/categorize.py
@@ -336,6 +336,10 @@ _SUBREDDIT_TAGS.update(
         "196": ["memes"],
         "okbuddyvicodin": ["memes"],
         "bookscirclejerk": ["memes"],
+        # ML/AI communities
+        "machinelearning": ["ai_ml"],
+        "datascience": ["ai_ml"],
+        "learnmachinelearning": ["ai_ml"],
     }
 )

@@ -463,7 +467,7 @@ _SUBREDDIT_TAGS.update(
         "engineeringporn": ["science"],
         # coding / computing
         "learnpython": ["coding"],
-        "learnmachinelearning": ["coding"],
+        "learnmachinelearning": ["ai_ml"],
         "linux": ["coding"],
         "hacking": ["coding"],
         "howtohack": ["coding"],
@@ -479,6 +483,14 @@ _KEYWORD_TAGS = [
     ("vtubers", re.compile(r"\bvtuber\b|hololive|nijisanji", re.IGNORECASE)),
     ("defense", re.compile(r"\bnon[- ]?credible\b", re.IGNORECASE)),
     ("japan", re.compile(r"\bjapan(ese)?\b", re.IGNORECASE)),
+    # ML/AI keywords
+    (
+        "ai_ml",
+        re.compile(
+            r"\bllm\b|\bgpt[- ]?\d+\b|\bchatgpt\b|\bclaude\s+(?:\d|ai|model|sonnet|opus|haiku)\b|\btransformer\b|\bembedding\b|\bneural network\b|\bmachine learning\b|\bdeep learning\b|\bartificial intelligence\b",
+            re.IGNORECASE,
+        ),
+    ),
     # Ephemeral promo/sale/event vocabulary — deliberately specific phrases only (never bare
     # "free"/"sale"/"deal"/"event": false-positive magnets). The decay wave for this tag is
     # age-gated, so a rare false positive is recoverable and a true-but-recent promo survives.
```

## Quality notes

- Approach: in-place edit of the existing `learnmachinelearning: ["coding"]` → `["ai_ml"]` (1 deletion
  + 1 insertion), PLUS a new block adding 3 ML subs to `_SUBREDDIT_TAGS`, PLUS the new `ai_ml`
  entry in the reddit `_KEYWORD_TAGS` list.
- **Defect flagged in Phase 0 report:** `learnmachinelearning` is now defined TWICE in
  `_SUBREDDIT_TAGS` — once at the new block (L336, `["ai_ml"]`) and once at the in-place edit
  (L467, `["ai_ml"]`). Both definitions have the same value (`["ai_ml"]`), so functionally
  correct, but a code smell. This is exactly the kind of variance the bakeoff wants to surface
  — the local model was more concise in output tokens (295 vs 6300) but produced a small
  redundancy the cloud model avoided.
- All 4 oracle contract clauses satisfied.
