export const normTag = (t) =>
  String(t == null ? "" : t)
    .trim()
    .toLowerCase()
    .slice(0, 40);

export const itemTags = (item) => ((item && item.metadata) || {}).tags || [];

export function suggestTags(known, applied, query, limit = 8) {
  const have = {};
  (applied || []).forEach((t) => {
    have[normTag(t)] = 1;
  });
  const q = normTag(query);

  return (known || [])
    .filter((t) => !have[normTag(t)] && (!q || normTag(t).indexOf(q) !== -1))
    .slice(0, limit);
}
