import type { Database } from "bun:sqlite";
import { z } from "zod";
import { type BaseConnector, dispatch, get } from "./connectors/registry.ts";
import { importPath } from "./pipeline.ts";

export const UNSUPPORTED =
  "Khaos can't read that file yet. Try a bookmarks export, a list of links, or a Reddit file.";

export const NOTHING_FOUND = "No importable items found in that input.";

export interface PreparedFile {
  source: string;
  label: string;
  count: number;
  fresh: number;
  sample: { title: string; source: string }[];
}

export interface ImportedFile {
  imported: number;
  skipped: number;
  errors: string[];
}

export type ImportJob =
  | { kind: "prepare"; dbPath: string; filePath: string; source?: string }
  | { kind: "import"; dbPath: string; filePath: string; source?: string };

export class ImportRefused extends Error {}

const CountRow = z.object({ count: z.number() });

function pickConnector(path: string, source: string | undefined): BaseConnector {
  try {
    return source ? get(source) : dispatch(path);
  } catch {
    throw new ImportRefused(UNSUPPORTED);
  }
}

export function prepareFile(
  database: Database,
  filePath: string,
  source: string | undefined,
): PreparedFile {
  const connector = pickConnector(filePath, source);
  const items = connector.importFile(filePath);

  if (!items.length) throw new ImportRefused(NOTHING_FOUND);

  const names = [...new Set(items.map((item) => item.fullname))];
  let existing = 0;

  for (let offset = 0; offset < names.length; offset += 500) {
    const chunk = names.slice(offset, offset + 500);
    const placeholders = chunk.map(() => "?").join(",");

    const row = CountRow.safeParse(
      database
        .query(`SELECT COUNT(*) AS count FROM items WHERE fullname IN (${placeholders})`)
        .get(...chunk),
    );

    existing += row.success ? row.data.count : 0;
  }

  return {
    source: connector.id,
    label: connector.label,
    count: names.length,
    fresh: Math.max(names.length - existing, 0),
    sample: items.slice(0, 5).map((item) => ({
      title: (item.title || item.url || item.fullname).slice(0, 120),
      source: item.source,
    })),
  };
}

export async function importFile(
  database: Database,
  filePath: string,
  source: string | undefined,
): Promise<ImportedFile> {
  const connector = pickConnector(filePath, source);
  const result = await importPath(database, filePath, { source: connector.id });

  return { imported: result.imported, skipped: result.skipped, errors: result.errors.slice(0, 20) };
}
