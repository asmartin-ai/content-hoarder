import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import * as db from "./db.ts";
import type { Item, Metadata } from "./models.ts";

export const EXPORT_FIELDS = [
  "fullname",
  "source",
  "kind",
  "status",
  "title",
  "url",
  "permalink",
  "subreddit",
  "tags",
  "score",
  "created_utc",
] as const;

export type ExportRecord = Record<(typeof EXPORT_FIELDS)[number], string | number | null>;

export function exportRecords(rows: readonly Item[]): ExportRecord[] {
  return rows.map((item) => {
    const md = item.metadata;

    return {
      fullname: item.fullname,
      source: item.source,
      kind: item.kind,
      status: item.status,
      title: item.title,
      url: item.url,
      permalink: md.permalink ?? "",
      subreddit: md.subreddit ?? "",
      tags: (md.tags ?? []).join("|"),
      score: md.score ?? null,
      created_utc: item.created_utc,
    };
  });
}

export function toCsv(records: readonly ExportRecord[]): string {
  const cell = (value: string | number | null): string => {
    const text = value === null ? "" : String(value);

    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };

  return (
    [
      EXPORT_FIELDS.join(","),
      ...records.map((r) => EXPORT_FIELDS.map((key) => cell(r[key])).join(",")),
    ].join("\n") + "\n"
  );
}

function slug(text: string): string {
  return (
    text
      .replace(/[^\w\s-]/g, "")
      .trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, "-")
      .slice(0, 80) || "note"
  );
}

function frontmatter(item: Item, md: Metadata): string {
  const lines = [
    "---",
    `title: "${String(item.title || item.fullname || "").replaceAll('"', "'")}"`,
    `source: ${String(item.source ?? "")}`,
  ];

  if (item.url) lines.push(`url: ${String(item.url)}`);
  const created = Number(item.created_utc || 0);

  if (created) lines.push(`date: ${new Date(created * 1000).toISOString().slice(0, 10)}`);

  const tags = [
    ...(md.tags ?? []),
    ...(md.subreddit ? [`r/${md.subreddit}`] : []),
    ...(md.labels ?? []).map(String),
  ];

  const unique = [...new Set(tags)];

  if (unique.length) lines.push("tags:", ...unique.map((tag) => `  - ${tag}`));
  lines.push(`ch_fullname: ${String(item.fullname ?? "")}`, "---");

  return lines.join("\n");
}

export async function exportItem(item: Item, vaultDir: string): Promise<string> {
  await mkdir(vaultDir, { recursive: true });
  const md = item.metadata;
  const title = item.title || item.fullname;
  const content = `${frontmatter(item, md)}\n\n# ${title}\n\n${item.body || ""}\n`;
  const base = slug(title);
  let file = join(vaultDir, `${base}.md`);

  for (let n = 2; await Bun.file(file).exists(); n++) file = join(vaultDir, `${base}-${n}.md`);
  await writeFile(file, content, "utf8");

  return file;
}

export async function exportItems(
  database: Database,
  opts: {
    out: string;
    format?: "csv" | "json";
    tags?: string[];
    status?: string;
    source?: string;
    subreddit?: string;
  },
): Promise<{ exported: number; path: string }> {
  const rows = db.searchItems(database, "", {
    tags: opts.tags,
    status: opts.status,
    source: opts.source,
    subreddit: opts.subreddit,
    limit: 1_000_000,
  });

  const records = exportRecords(rows);
  const content = opts.format === "json" ? JSON.stringify(records, null, 2) : toCsv(records);
  await writeFile(opts.out, content, "utf8");

  return { exported: records.length, path: opts.out };
}

export async function exportObsidian(
  database: Database,
  opts: { vault: string; status?: string },
): Promise<{ exported: number; vault: string }> {
  const rows = db.searchItems(database, "", { status: opts.status ?? "keep", limit: 1_000_000 });

  for (const row of rows) await exportItem(row, opts.vault);

  return { exported: rows.length, vault: opts.vault };
}
