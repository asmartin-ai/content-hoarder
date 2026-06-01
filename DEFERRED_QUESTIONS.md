# Deferred questions / notes (autonomous run 2026-06-01)

Questions and decisions raised while working autonomously — for asmartin-ai to review later.
Each feature was implemented, committed, and run through `/code-review` (real findings fixed inline).

## Open questions
- _(none yet)_

## Notes / decisions made autonomously
- Categorizer uses the agreed defaults (listenable ≥30min OR allowlisted channel; watch ≤5min;
  wotagei title keyword); see `categorize.py` for the channel allowlist — tell me who to add/remove.

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
