# Deferred questions / notes (autonomous run 2026-06-01)

Questions and decisions raised while working autonomously — for asmartin-ai to review later.
Each feature was implemented, committed, and run through `/code-review` (real findings fixed inline).

## ✅ Shipped this run (10 features — each committed + `/code-review`'d, fixes applied)
1. **Heuristic categorizer** (listenable/watch/wotagei) — `categorize` CLI + `#category` "processing
   areas" dropdown with counts + a category tag on cards + manual re-tag chips on the triage card.
2. **YouTube per-video enrich** — `enrich --source youtube` (exact duration/views/categories/tags).
3. **YouTube title recovery** — `enrich --source youtube --titles` (Wayback for [Private/Deleted video]).
4. **On-demand Reddit "Recover"** button on [removed]/[deleted] cards (+ `POST /items/<fn>/recover`).
5. **Firefox tabs connector** (Export Tabs URLs) — imported 326 as a sample.
6. **Duplicates v2** — `dedup` CLI (placeholder-excluded, query-safe, non-destructive + reversible).
7. **.gitattributes** — LF normalization (stops the CRLF warnings).

## Open questions for you
- **Wotagei detection is conservative** — only 3 of 4998 WL2 videos matched (titles with ヲタ芸/wotagei/
  wota). If your wotagei videos use other terms (idol-event names, performers, サイリウム/cyalume, specific
  channels), tell me which and I'll widen the rules in `categorize.py` (kept tight to avoid false positives).
- **Categorizer tunables** — listenable ≥30 min OR allowlisted channel (Isaac Arthur, Perun, LEMMiNO,
  music/podcast/" - Topic"); watch ≤5 min. Re-tune thresholds/allowlist in `categorize.py` anytime.
- **Deliberately deferred (need your call, not built to avoid undo-work):** drag-and-drop to buckets
  (conflicts with the swipe pointer handlers + redundant with swipe), consolidating the triage swipe onto
  swipe.js (risky refactor, no visible gain), and a **Duplicates review UI** (you removed the last one as
  confusing — wants your design input; the CLI does the work now). LLM auto-classify stays deferred per
  your "validate heuristics first".

## Duplicates v2 (CLI; UI deferred)
- `python -m content_hoarder dedup --by url` flags possible dups (non-destructive); review, then
  `dedup --resolve` archives all-but-richest (reversible), or `dedup --clear`. A read-only scan of
  your inbox found only a handful of genuine URL-dup pairs. A clear review UI is a follow-up.

## Partial imports (sampled, finish when you want)
- Firefox tabs: connector built + imported **1 of ~17** TabExports (326 tabs). Import the rest with
  `python -m content_hoarder import "K:\Users\asmartin-ai\Downloads\TabExports\<file>.txt" --source firefox`
  (the daily exports overlap heavily, so they de-dup by URL).

## Data jobs NOT run (per "build + small sample")
- Full Reddit archival recovery (~9.5k items) — run `enrich --source reddit --archives` when ready.
- Full YouTube per-video enrich (~5k) — run `enrich --source youtube` when ready.

## Needs your input / data (couldn't do while away)
- WL3 + Watch Later import — need the `list=PL…` playlist URL(s).
- Google Keep import — need the Takeout export.
