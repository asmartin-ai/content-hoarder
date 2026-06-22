/* core/tags.js — pure manual-tag helpers shared by the tag editors.
   Consolidates the copies that lived in triage.js, browse/reader.js and
   browse/tagedit.js so tag normalization (the 40-char clamp + lowercase) and the
   "known tags, not yet applied, matching the query" suggestion filter are each
   defined exactly once. */

/* Normalize a tag for storage/compare: trim, lowercase, clamp to 40 chars
   (mirrors the server-side clamp so the UI never offers a tag the API would reject). */
export const normTag = (t) => String(t == null ? "" : t).trim().toLowerCase().slice(0, 40);

/* The tags array on an item (metadata.tags), or [] when absent. */
export const itemTags = (item) => (((item && item.metadata) || {}).tags) || [];

/* Suggestions for the "＋ tag" add-UI: known-vocabulary tags not already applied to
   the item, filtered by a substring query and capped. `applied` is the item's current
   tags. */
export function suggestTags(known, applied, query, limit = 8) {
  const have = {};
  (applied || []).forEach((t) => { have[normTag(t)] = 1; });
  const q = normTag(query);
  return (known || [])
    .filter((t) => !have[normTag(t)] && (!q || normTag(t).indexOf(q) !== -1))
    .slice(0, limit);
}
