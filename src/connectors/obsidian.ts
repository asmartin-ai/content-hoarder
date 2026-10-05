import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, basename, join } from "node:path";
import * as z from "zod";
import { newItem, type JsonValue, type RawItem } from "../models.ts";
import type { BaseConnector } from "./base.ts";

const filesUnder = (root: string): string[] => {
  const files: string[] = [];

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== ".obsidian" && entry.name !== ".trash")
        walk(join(dir, entry.name));
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
        files.push(join(dir, entry.name));
    }
  };

  walk(root);

  return files;
};

const scalar = (value: string): JsonValue => {
  const stripped = value.trim().replace(/^['"]|['"]$/g, "");

  if (stripped === "true") return true;

  if (stripped === "false") return false;

  if (/^-?\d+(?:\.\d+)?$/.test(stripped)) return Number(stripped);

  return stripped;
};

const frontmatterFieldsSchema = z.record(z.string(), z.json());

type ObsidianFields = z.infer<typeof frontmatterFieldsSchema>;

interface ParsedFrontmatter {
  fields: ObsidianFields;
  body: string;
}

const frontmatter = (text: string): ParsedFrontmatter => {
  const lines = text.split(/\r?\n/);

  if (lines[0]?.trim() !== "---") return { fields: {}, body: text };
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");

  if (end < 0) return { fields: {}, body: text };
  const fields: ObsidianFields = {};
  let current: string | null = null;

  for (const line of lines.slice(1, end)) {
    const trimmed = line.trim();

    if (!trimmed) continue;

    if (current && trimmed.startsWith("- ")) {
      const values = fields[current];

      if (Array.isArray(values)) values.push(scalar(trimmed.slice(2)));
      continue;
    }

    const match = line.match(/^(\w[\w-]*):\s*(.*)$/);

    if (!match) continue;
    const key = match[1];
    const value = match[2] ?? "";

    if (!key) continue;

    if (!value) {
      fields[key] = [];
      current = key;
    } else if (value.startsWith("[") && value.endsWith("]")) {
      fields[key] = value.slice(1, -1).split(",").map(scalar);
      current = null;
    } else {
      fields[key] = scalar(value);
      current = null;
    }
  }

  return { fields, body: lines.slice(end + 1).join("\n") };
};

const tagsSchema = z.union([
  z
    .string()
    .transform((value) => value.trim())
    .transform((value) => (value ? [value] : [])),
  z.array(z.json()).transform((values) => values.map(String).filter(Boolean)),
]);

const titleSchema = z.union([z.string(), z.number(), z.boolean()]).transform(String);

const epochSchema = z
  .union([z.number(), z.string().transform((value) => Date.parse(value) / 1000)])
  .pipe(z.number().finite())
  .transform(Math.floor);

export class ObsidianConnector implements BaseConnector {
  readonly id = "obsidian";
  readonly label = "Obsidian";
  readonly badgeColor = "#7c3aed";
  canImport(path: string): boolean {
    try {
      if (statSync(path).isDirectory())
        return existsSync(join(path, ".obsidian")) || filesUnder(path).length > 0;

      return path.toLowerCase().endsWith(".md");
    } catch {
      return false;
    }
  }
  importFile(path: string): RawItem[] {
    let files: string[];
    let root: string;

    try {
      const isDirectory = statSync(path).isDirectory();
      root = isDirectory ? path : dirname(path);
      files = isDirectory ? filesUnder(root) : [path];
    } catch {
      return [];
    }

    const out: RawItem[] = [];

    for (const file of files) {
      let text: string;
      let mtime: number;

      try {
        text = readFileSync(file, "utf8");
        mtime = Math.floor(statSync(file).mtimeMs / 1000);
      } catch {
        continue;
      }

      const parsed = frontmatter(text);

      const wikilinks = [...parsed.body.matchAll(/\[\[([^\]]+)\]\]/g)].flatMap((match) => {
        const target = (match[1] ?? "").split(/[|#]/, 1)[0]?.trim() ?? "";

        return target ? [target] : [];
      });

      const parsedTags = tagsSchema.safeParse(parsed.fields.tags);
      const tags = parsedTags.success ? parsedTags.data : [];

      const uniqueTags = [
        ...new Set([
          ...tags,
          ...[...parsed.body.matchAll(/(?<![:/\w])#([\w/-]+)/g)].flatMap((match) =>
            match[1] ? [match[1]] : [],
          ),
        ]),
      ];

      const parsedTitle = titleSchema.safeParse(parsed.fields.title);
      const title = parsedTitle.success ? parsedTitle.data : basename(file, ".md");
      const parsedUrl = z.string().safeParse(parsed.fields.url ?? parsed.fields.source);
      const url = parsedUrl.success ? parsedUrl.data : "";
      const parsedCreated = epochSchema.safeParse(parsed.fields.date ?? parsed.fields.created);
      out.push(
        newItem({
          source: this.id,
          source_id: relative(root, file).split("\\").join("/"),
          kind: "note",
          title,
          body: parsed.body,
          url,
          created_utc: parsedCreated.success ? parsedCreated.data : mtime,
          saved_utc: mtime,
          metadata: {
            tags: uniqueTags,
            vault: basename(root),
            wikilinks,
            frontmatter: parsed.fields,
          },
        }),
      );
    }

    return out;
  }
}
