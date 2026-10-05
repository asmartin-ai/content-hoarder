import type { Database } from "bun:sqlite";
import { z } from "zod";
import * as config from "../config.ts";
import * as db from "../db.ts";
import { request } from "../_http.ts";
import { ItemSchema, MetadataSchema, RawItemSchema, parseMetadata, type Item } from "../models.ts";

const BookmarkPayloadSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("link"),
    url: z.string(),
    title: z.string(),
    tags: z.array(z.string()),
    note: z.string(),
  }),
  z.object({
    type: z.literal("text"),
    text: z.string(),
    tags: z.array(z.string()),
    note: z.string(),
  }),
]);

const BookmarkResponseSchema = z
  .object({ id: z.string().optional(), bookmark: z.object({ id: z.string() }).optional() })
  .passthrough();

const CountRowSchema = z.object({ count: z.number() });

export type BookmarkPayload = z.infer<typeof BookmarkPayloadSchema>;

export interface PromoteResult {
  configured: boolean;
  candidates: number;
  pushed: number;
  skipped: number;
  dry_run?: boolean;
}

export function isConfigured(): boolean {
  return Boolean(config.get("KARAKEEP_BASE_URL") && config.get("KARAKEEP_API_KEY"));
}

export function payloadFor(item: Item): BookmarkPayload {
  const metadata = parseMetadata(item.metadata);
  const tags = [`src:${item.source}`];

  if (metadata.subreddit) tags.push(`r/${metadata.subreddit}`);

  if (metadata.channel) tags.push(`yt:${metadata.channel}`);
  tags.push(...(metadata.labels ?? []).map(String));
  const note = `via content-hoarder (${item.fullname})`;

  if (item.url) return { type: "link", url: item.url, title: item.title || "", tags, note };
  const text = [item.title || "", item.body || ""].filter(Boolean).join("\n\n").trim();

  return { type: "text", text: text || item.fullname, tags, note };
}

async function postBookmark(
  payload: BookmarkPayload,
): Promise<z.infer<typeof BookmarkResponseSchema> | null> {
  const base = config.get("KARAKEEP_BASE_URL").replace(/\/+$/, "");

  try {
    const [, , raw] = await request(`${base}/api/v1/bookmarks`, {
      method: "POST",
      data: JSON.stringify(payload),
      timeout: 15,
      headers: {
        Authorization: `Bearer ${config.get("KARAKEEP_API_KEY")}`,
        "Content-Type": "application/json",
        "User-Agent": config.get("USER_AGENT"),
      },
    });

    const response: unknown = JSON.parse(new TextDecoder().decode(raw));
    const parsed = BookmarkResponseSchema.safeParse(response);

    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function bookmarkId(response: z.infer<typeof BookmarkResponseSchema> | null): string | null {
  if (response?.id) return response.id;

  return response?.bookmark?.id ?? null;
}

export interface PromoteOptions {
  status?: string;
  limit?: number;
  dryRun?: boolean;
}

export async function promote(
  database: Database,
  options: PromoteOptions = {},
): Promise<PromoteResult> {
  const status = options.status ?? "keep";

  const candidates = CountRowSchema.parse(
    database.query("SELECT COUNT(*) AS count FROM items WHERE status=?").get(status),
  ).count;

  if (!isConfigured()) return { configured: false, candidates, pushed: 0, skipped: 0 };
  const sql = `SELECT * FROM items WHERE status=?${options.limit ? " LIMIT ?" : ""}`;

  const rawRows = options.limit
    ? database.query(sql).all(status, Math.trunc(options.limit))
    : database.query(sql).all(status);

  const rows = rawRows.map((value) => {
    const raw = RawItemSchema.parse(value);

    return ItemSchema.parse({
      ...raw,
      metadata: MetadataSchema.parse(parseMetadata(raw.metadata)),
    });
  });

  let pushed = 0;
  let skipped = 0;

  for (const row of rows) {
    const metadata = parseMetadata(row.metadata);

    if (metadata.karakeep_id) {
      skipped++;
      continue;
    }

    if (options.dryRun) {
      pushed++;
      continue;
    }

    const id = bookmarkId(await postBookmark(payloadFor(row)));

    if (id) {
      db.patchItemMetadata(database, row.fullname, { karakeep_id: id });
      pushed++;
    } else skipped++;
  }

  return { configured: true, candidates, pushed, skipped, dry_run: Boolean(options.dryRun) };
}
