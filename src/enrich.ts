import type { Database } from "bun:sqlite";
import * as db from "./db.ts";
import * as connectors from "./connectors/registry.ts";
import { RawItemSchema } from "./models.ts";

export interface EnrichResult {
  selected: number;
  updated: number;
}

export async function enrichSource(
  database: Database,
  source: string,
  opts: { allRows?: boolean; limit?: number } = {},
): Promise<EnrichResult> {
  const connector = connectors.get(source);
  const sql = `SELECT * FROM items WHERE source=?${opts.allRows ? "" : " AND hydrated_at IS NULL"} ORDER BY last_seen_utc DESC${opts.limit ? " LIMIT ?" : ""}`;

  const rows = (
    opts.limit
      ? database.query(sql).all(source, Math.trunc(opts.limit))
      : database.query(sql).all(source)
  ).map((row) => RawItemSchema.parse(row));

  if (!rows.length) return { selected: 0, updated: 0 };
  const enriched = connector.enrich ? await connector.enrich(rows) : [];

  for (const item of enriched) db.mergeUpsert(database, item);

  return { selected: rows.length, updated: enriched.length };
}

export async function enrichAll(
  database: Database,
  opts: { allRows?: boolean } = {},
): Promise<{ selected: number; updated: number; bySource: Record<string, EnrichResult> }> {
  const bySource: Record<string, EnrichResult> = {};
  const totals = { selected: 0, updated: 0, bySource };

  for (const connector of connectors.allConnectors()) {
    if (!connector.enrich) continue;
    const result = await enrichSource(database, connector.id, opts);
    totals.selected += result.selected;
    totals.updated += result.updated;
    totals.bySource[connector.id] = result;
  }

  return totals;
}
