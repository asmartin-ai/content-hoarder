import * as z from "zod";
import type { RedditReconcileResult } from "../db.ts";
import type { JsonValue, RawItem } from "../models.ts";

export interface BaseConnector {
  readonly id: string;
  readonly label: string;
  readonly badgeColor: string;
  canImport(path: string): boolean;
  importFile(path: string): RawItem[];
  enrich?(items: RawItem[]): Promise<RawItem[]>;
  sync?(): Promise<RawItem[]>;
}

export interface ImportResult {
  imported: number;
  skipped: number;
  errors: string[];
  reconcile: RedditReconcileResult | null;
}

/** Schema every loosely-typed connector payload (export JSON, archive blobs) is read through. */
export const jsonRecord = z.record(z.string(), z.json());

export type JsonRecord = z.infer<typeof jsonRecord>;

const scalar = z.union([z.string(), z.number()]);

/** A payload that is a JSON object, or null when it is anything else. */
export function looseRecord(value: JsonValue | undefined): JsonRecord | null {
  const parsed = jsonRecord.safeParse(value);

  return parsed.success ? parsed.data : null;
}

/** A payload that is a JSON string/number, as text; "" for everything else. */
export function looseText(value: JsonValue | undefined): string {
  const parsed = scalar.safeParse(value);

  return parsed.success ? String(parsed.data) : "";
}

/** Table or column names from a `sqlite_master` / `PRAGMA table_info` row set. */
export function sqliteNames(rows: readonly unknown[]): string[] {
  return z
    .array(z.object({ name: z.string() }))
    .parse(rows)
    .map((row) => row.name);
}

const csvCells = (line: string): string[] => {
  const cells: string[] = [];

  let cell = "",
    quoted = false;

  for (let index = 0; index < line.length; index++) {
    const char = line[index] ?? "";

    if (char === '"' && quoted && line[index + 1] === '"') {
      cell += '"';
      index++;
    } else if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) {
      cells.push(cell);
      cell = "";
    } else cell += char;
  }

  cells.push(cell);

  return cells;
};

/**
 * RFC 4180 rows with a leading BOM tolerated. Cells keep their whitespace;
 * callers normalize keys and values themselves.
 */
export function parseCsv(input: string): JsonRecord[] {
  const lines = input
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter(Boolean);

  if (!lines.length) return [];

  const headers = csvCells(lines[0] ?? "").map((header) => header.trim());

  return lines
    .slice(1)
    .map((line) =>
      Object.fromEntries(
        csvCells(line).map((value, index) => [headers[index] ?? "", value] as const),
      ),
    );
}
