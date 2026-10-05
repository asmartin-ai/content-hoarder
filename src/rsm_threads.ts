import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import type { Database as ContentDatabase } from "bun:sqlite";
import { z } from "zod";
import * as db from "./db.ts";

const ThreadRecordSchema = z.object({
  fullname: z.string().nullable(),
  thread_json: z.string(),
  hydrated_at: z.number().nullable(),
});

export interface MigrationResult {
  migrated: number;
  skipped: number;
}

export function migrate(
  database: ContentDatabase,
  sourcePath: string,
  opts: { allThreads?: boolean } = {},
): MigrationResult {
  if (!existsSync(sourcePath)) throw new Error(`RSM database not found: ${sourcePath}`);
  const source = new Database(sourcePath, { readonly: true });
  let migrated = 0;
  let skipped = 0;

  try {
    const records = source
      .query(
        "SELECT fullname, thread_json, hydrated_at FROM items WHERE thread_json IS NOT NULL AND thread_json <> ''",
      )
      .all()
      .map((record) => ThreadRecordSchema.parse(record));

    for (const record of records) {
      const id = (record.fullname ?? "").trim();

      if (!id) {
        skipped++;
        continue;
      }

      const fullname = id.startsWith("reddit:") ? id : `reddit:${id}`;

      if (!opts.allThreads && !db.getItem(database, fullname)) {
        skipped++;
        continue;
      }

      db.setRedditThread(database, fullname, record.thread_json, record.hydrated_at);
      migrated++;
    }
  } finally {
    source.close();
  }

  return { migrated, skipped };
}
