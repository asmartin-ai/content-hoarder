## Epic 6 — Duplicates v2  (`enhancement`, `area:ui`)
*The first cut was removed: the "duplicate group" naming confused, and placeholder titles created
false positives.*

- [x] ~~**Redesign de-duplication (v2).**~~ Shipped: `dedup.py` non-destructive flag + reversible
  resolve via CLI `dedup [--by url|title] [--resolve] [--clear]`. **Excludes placeholder titles**
  (`[removed]`/`[deleted]`/`[Private video]`/`[Deleted video]`); URL grouping **keeps the query string**
  (a real-data scan caught the old code collapsing every `youtube.com/watch?v=…` into one group).
- [x] ~~**P3 — Duplicates review UI.**~~ ✅ SHIPPED 2026-06-26: a `#dupesheet` panel under Settings → Duplicates,
  `/duplicates` + `/duplicates/resolve` + `/duplicates/undo` routes, deduped item cards with "Archive others"
  per group, undo snackbar. Built on `dedup.find_groups` with By URL / By Title toggle.
