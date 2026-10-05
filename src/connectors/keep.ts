import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import * as z from "zod";
import { newItem, type RawItem } from "../models.ts";
import type { BaseConnector } from "./base.ts";

const timestampInput = z.union([z.string(), z.number()]);

const keepNoteSchema = z
  .object({
    title: z.string().optional(),
    textContent: z.string().optional(),
    listContent: z
      .array(
        z
          .object({
            text: z.string().optional(),
            isChecked: z.boolean().optional(),
            checked: z.boolean().optional(),
          })
          .catchall(z.json()),
      )
      .optional(),
    labels: z.array(z.object({ name: z.string().optional() }).catchall(z.json())).optional(),
    timestamps: z
      .object({
        createTime: timestampInput.optional(),
        updateTime: timestampInput.optional(),
      })
      .catchall(z.json())
      .optional(),
    createdTimestampMs: timestampInput.optional(),
    userEditedTimestampMs: timestampInput.optional(),
    color: z.string().nullable().optional(),
    isArchived: z.boolean().optional(),
    isTrashed: z.boolean().optional(),
    isPinned: z.boolean().optional(),
  })
  .catchall(z.json());

type KeepNote = z.infer<typeof keepNoteSchema>;

const filesUnder = (path: string): string[] => {
  const files: string[] = [];

  for (const name of readdirSync(path)) {
    const child = join(path, name);

    if (statSync(child).isDirectory()) files.push(...filesUnder(child));
    else if (name.toLowerCase().endsWith(".json")) files.push(child);
  }

  return files;
};

const readNote = (path: string): KeepNote | null => {
  try {
    const parsed = keepNoteSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));

    return parsed.success &&
      ["title", "textContent", "listContent", "isTrashed"].some((key) => key in parsed.data)
      ? parsed.data
      : null;
  } catch {
    return null;
  }
};

const epochUtc = z.union([
  z.string().transform((value) => {
    const milliseconds = /^\d+$/.test(value) ? Number(value) : Date.parse(value);

    return Number.isFinite(milliseconds)
      ? Math.trunc(milliseconds >= 1e15 ? milliseconds / 1e6 : milliseconds / 1000)
      : 0;
  }),
  z
    .number()
    .transform((value) =>
      Number.isFinite(value) ? Math.trunc(value >= 1e15 ? value / 1e6 : value / 1000) : 0,
    ),
]);

export class KeepConnector implements BaseConnector {
  readonly id = "keep";
  readonly label = "Google Keep";
  readonly badgeColor = "#fbbc04";

  canImport(path: string): boolean {
    if (!existsSync(path)) return false;

    try {
      const files = statSync(path).isDirectory() ? filesUnder(path) : [path];

      return files.some((file) => readNote(file) !== null);
    } catch {
      return false;
    }
  }

  importFile(path: string): RawItem[] {
    const files = statSync(path).isDirectory() ? filesUnder(path) : [path];
    const account = basename(path);
    const out: RawItem[] = [];

    for (const file of files) {
      const note = readNote(file);

      if (!note || !["title", "textContent", "listContent"].some((key) => key in note)) continue;
      const timestamps = note.timestamps ?? {};
      const title = note.title ?? "";
      const bodyText = note.textContent ?? "";
      const list = note.listContent ?? [];

      const checklist = list
        .flatMap((entry) => {
          if (entry.text === undefined) return [];
          const checked = entry.isChecked ?? entry.checked ?? false;

          return [`${checked ? "[x]" : "[ ]"} ${entry.text}`];
        })
        .join("\n");

      const body = checklist ? (bodyText ? `${bodyText}\n\n${checklist}` : checklist) : bodyText;
      const createdMs = note.createdTimestampMs;
      const editedMs = note.userEditedTimestampMs;
      const createdAt = createdMs ?? timestamps.createTime;
      const editedAt = editedMs ?? timestamps.updateTime;

      const sourceId =
        createdMs !== undefined
          ? String(createdMs)
          : timestamps.createTime !== undefined
            ? String(timestamps.createTime)
            : basename(file).replace(/\.json$/i, "");

      const labels = (note.labels ?? []).flatMap((label) => (label.name ? [label.name] : []));
      const link = bodyText.match(/https?:\/\/\S+/)?.[0] ?? "";
      out.push(
        newItem({
          source: this.id,
          source_id: sourceId,
          kind: "note",
          title,
          body,
          url: link,
          created_utc: createdAt === undefined ? 0 : epochUtc.parse(createdAt),
          saved_utc: editedAt === undefined ? 0 : epochUtc.parse(editedAt),
          metadata: {
            labels,
            color: note.color ?? null,
            isArchived: note.isArchived ?? false,
            isTrashed: note.isTrashed ?? false,
            isPinned: note.isPinned ?? false,
            list_items: list,
            account,
          },
        }),
      );
    }

    return out;
  }
}
