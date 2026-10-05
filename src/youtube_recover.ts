import type { Database } from "bun:sqlite";
import * as z from "zod";
import { request, HttpError } from "./_http";
import { patchItem } from "./db";
import type { Metadata } from "./models";

export const DEFAULT_USER_AGENT = "content-hoarder/0.1 (youtube title recovery)";

const placeholderTitles = new Set([
  "",
  "[private video]",
  "[deleted video]",
  "[unavailable video]",
]);

type RecoveryResult = { selected: number; recovered: number };

type RecoveryRow = { fullname: string; source_id: string; last_seen_utc: number };

const WaybackAvailabilitySchema = z.object({
  archived_snapshots: z
    .object({
      closest: z
        .object({ available: z.boolean().optional(), url: z.string().url().optional() })
        .optional(),
    })
    .optional(),
});

type WaybackAvailability = z.infer<typeof WaybackAvailabilitySchema>;

const needsTitleSql =
  "(title IS NULL OR title='' OR lower(title) IN ('[private video]','[deleted video]','[unavailable video]'))";

export async function httpGet(
  url: string,
  userAgent = DEFAULT_USER_AGENT,
  timeout = 20_000,
): Promise<string> {
  try {
    const [, , bytes] = await request(url, {
      method: "GET",
      headers: { "User-Agent": userAgent },
      timeout,
    });

    return new TextDecoder().decode(bytes);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new Error(error instanceof Error ? error.message : String(error));
  }
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&#x([\da-f]+);/gi, (_match, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_match, number: string) => String.fromCodePoint(Number(number)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

export function extractTitle(html: string): string {
  const metaTag = /<meta\b[^>]*og:title[^>]*>/i.exec(html)?.[0] ?? "";
  const metaContent = /content\s*=\s*(["'])(.*?)\1/is.exec(metaTag)?.[2] ?? "";
  const pageTitle = /<title[^>]*>(.*?)<\/title>/is.exec(html)?.[1] ?? "";
  const raw = decodeHtml(metaContent || pageTitle).trim();

  return raw.replace(/\s*-\s*YouTube\s*$/i, "").trim();
}

export async function recoverTitle(
  videoId: string,
  opts: { get?: (url: string) => Promise<string> } = {},
): Promise<string> {
  if (!videoId) return "";
  const get = opts.get ?? httpGet;
  const watch = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  let availability: WaybackAvailability;

  try {
    availability = WaybackAvailabilitySchema.parse(
      JSON.parse(
        await get(`https://archive.org/wayback/available?url=${encodeURIComponent(watch)}`),
      ),
    );
  } catch {
    return "";
  }

  const snapshot = availability.archived_snapshots?.closest;

  if (!snapshot?.available || !snapshot.url) return "";
  let html: string;

  try {
    html = await get(snapshot.url);
  } catch {
    return "";
  }

  const title = extractTitle(html);

  return placeholderTitles.has(title.toLowerCase()) ? "" : title;
}

export async function recoverTitles(
  database: Database,
  opts: {
    limit?: number;
    retry?: boolean;
    get?: (url: string) => Promise<string>;
    sleep?: (seconds: number) => Promise<void> | void;
    throttle?: number;
    progress?: (message: string) => void;
  } = {},
): Promise<RecoveryResult> {
  const where = ["source='youtube'", needsTitleSql];

  if (!opts.retry) where.push("json_extract(metadata, '$.wayback_tried') IS NULL");
  const sql = `SELECT fullname,source_id,last_seen_utc FROM items WHERE ${where.join(" AND ")} ORDER BY last_seen_utc DESC${opts.limit ? " LIMIT ?" : ""}`;

  const rows = opts.limit
    ? database.query<RecoveryRow, [number]>(sql).all(Math.trunc(opts.limit))
    : database.query<RecoveryRow, []>(sql).all();

  let recovered = 0;

  for (const [index, item] of rows.entries()) {
    if (index > 0 && (opts.throttle ?? 1) > 0) await opts.sleep?.(opts.throttle ?? 1);
    const title = await recoverTitle(item.source_id, { get: opts.get });
    const metadata: Metadata = { wayback_tried: 1 };

    if (title) {
      metadata.title_source = "wayback";
      recovered++;
    }

    const patch = title ? { metadata, title } : { metadata };
    patchItem(database, item.fullname, patch);

    if (opts.progress && (index + 1) % 10 === 0)
      opts.progress(`  ${recovered}/${index + 1} titles recovered`);
  }

  return { selected: rows.length, recovered };
}
