import * as z from "zod";
import type { Database } from "bun:sqlite";
import * as db from "./db.ts";
import { VALID_STATUSES, parseMetadata, type ItemStatus, type Metadata } from "./models.ts";
import { youtubeId, ytItem } from "./connectors/firefox.ts";

interface PlannedRow {
  fullname: string;
  vid: string;
  title: string;
  status: ItemStatus;
  processed_utc: number | null;
  metadata: Metadata;
}

export interface MigrationPlan {
  dupes: PlannedRow[];
  orphans: PlannedRow[];
}

export interface MigrationPlan {
  dupes: PlannedRow[];
  orphans: PlannedRow[];
}

const youtubeIdsSchema = z.array(z.object({ source_id: z.string() }));

const firefoxRowsSchema = z.array(
  z.object({
    fullname: z.string(),
    url: z.string(),
    title: z.string(),
    status: z.string(),
    processed_utc: z.number().nullable(),
    metadata: z.string(),
  }),
);

export function plan(database: Database): MigrationPlan {
  const youtubeIds = new Set(
    youtubeIdsSchema
      .parse(database.query("SELECT source_id FROM items WHERE source='youtube'").all())
      .map((row) => row.source_id),
  );

  const dupes: PlannedRow[] = [];
  const orphans: PlannedRow[] = [];

  const rows = firefoxRowsSchema.parse(
    database
      .query(
        "SELECT fullname, url, title, status, processed_utc, metadata FROM items WHERE source='firefox' ORDER BY fullname",
      )
      .all(),
  );

  for (const row of rows) {
    const vid = youtubeId(row.url || "");

    if (!vid) continue;
    const status = VALID_STATUSES.find((candidate) => candidate === row.status) ?? "inbox";

    const entry: PlannedRow = {
      fullname: row.fullname,
      vid,
      title: row.title || "",
      status,
      processed_utc: row.processed_utc,
      metadata: parseMetadata(row.metadata),
    };

    (youtubeIds.has(vid) ? dupes : orphans).push(entry);
  }

  return { dupes, orphans };
}

export interface MigrationResult {
  dupes: number;
  orphans: number;
  firefox_rows_removed: number;
  applied: boolean;
  sample_orphans: string[];
}

export function migrate(database: Database, opts: { apply?: boolean } = {}): MigrationResult {
  const { dupes, orphans } = plan(database);

  const output: MigrationResult = {
    dupes: dupes.length,
    orphans: orphans.length,
    firefox_rows_removed: 0,
    applied: Boolean(opts.apply),
    sample_orphans: orphans.slice(0, 5).map((row) => row.fullname),
  };

  if (!opts.apply) return output;
  let removed = 0;

  for (const entry of dupes) {
    const metadata: Metadata = { open_in_firefox: true };

    if (entry.metadata.window) metadata.firefox_window = entry.metadata.window;

    if (entry.metadata.pinned) metadata.firefox_pinned = entry.metadata.pinned;
    db.patchItemMetadata(database, `youtube:${entry.vid}`, metadata);
    database.query("DELETE FROM items WHERE fullname=?").run(entry.fullname);
    removed++;
  }

  for (const entry of orphans) {
    const item = ytItem(
      entry.vid,
      entry.title,
      String(entry.metadata.window || ""),
      Boolean(entry.metadata.pinned),
    );

    item.status = entry.status;
    item.processed_utc = entry.processed_utc;
    db.mergeUpsert(database, item);
    database.query("DELETE FROM items WHERE fullname=?").run(entry.fullname);
    removed++;
  }

  output.firefox_rows_removed = removed;

  return output;
}
