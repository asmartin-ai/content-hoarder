import { z } from "zod";
import * as db from "../db.ts";
import { parse } from "../search_query.ts";
import type { Item, JsonValue } from "../models.ts";

export function json<T>(body: T, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers });
}

export function numberParam(value: string | null, fallback: number): number {
  if (value === null || value === "") return fallback;
  const result = Number(value);

  return Number.isInteger(result) ? result : fallback;
}

export function numberValue(value: JsonValue | undefined, fallback: number): number {
  const parsed = z.union([z.number().finite(), z.string()]).safeParse(value);

  return parsed.success ? numberParam(String(parsed.data), fallback) : fallback;
}

export function bool(value: JsonValue | undefined): boolean {
  return value === true;
}

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

export async function objectBody<T extends z.ZodType>(
  request: Request,
  schema: T,
): Promise<z.infer<T>> {
  const value = request.headers.get("content-type")?.includes("application/x-www-form-urlencoded")
    ? Object.fromEntries(new URLSearchParams(await request.text()).entries())
    : await request.json().catch(() => ({}));

  return schema.parse(value);
}

export function options(
  params: URLSearchParams,
  overrides: Partial<db.SearchOpts> = {},
): db.SearchOpts {
  const parsed = parse(params.get("q") ?? "");
  const status = parsed.status ?? params.get("status");

  return {
    source: parsed.source ?? params.get("source"),
    kind: parsed.kind ?? params.get("kind"),
    status,
    category: params.get("category"),
    tags: parsed.tags.length ? parsed.tags : params.getAll("tag"),
    tagsAll: parsed.tagsAll,
    subreddit: parsed.subreddit ?? params.get("subreddit"),
    author: parsed.author ?? params.get("author"),
    isSaved:
      parsed.isSaved ?? (params.has("is_saved") ? numberParam(params.get("is_saved"), 0) : null),
    nsfw: parsed.nsfw,
    hideNsfw: ["1", "true"].includes(params.get("safe") ?? ""),
    decayed: parsed.decayed,
    swept: parsed.swept,
    snoozed: parsed.snoozed,
    hideSnoozed: !parsed.snoozed && status === "inbox",
    deleted: parsed.deleted,
    hasMedia: parsed.has,
    ocr: parsed.ocr,
    openInFirefox:
      parsed.openInFirefox || ["1", "true"].includes(params.get("open_in_firefox") ?? ""),
    before: parsed.before,
    after: parsed.after,
    scoreMin: parsed.scoreMin,
    scoreMax: parsed.scoreMax,
    exact: parsed.exact.length ? parsed.exact : null,
    exclude: parsed.exclude.length ? parsed.exclude : null,
    includeConsolidated: params.get("consolidated") !== "false",
    fuzzy: params.get("exact") !== "1",
    sort: params.get("sort") ?? "last_seen_utc",
    order: params.get("order") === "asc" ? "asc" : "desc",
    limit: clamp(numberParam(params.get("limit"), 50), 1, 500) + 1,
    offset: Math.max(numberParam(params.get("offset"), 0), 0),
    ...overrides,
  };
}

export function redditView(item: Item) {
  const metadata = item.metadata;

  return {
    fullname: item.fullname,
    reddit_id: item.source_id,
    kind: item.kind,
    title: item.title,
    body: item.body,
    url: item.url,
    permalink: metadata.permalink ?? "",
    subreddit: metadata.subreddit ?? "",
    author: item.author,
    score: metadata.score ?? 0,
    over_18: metadata.over_18 ? 1 : 0,
    num_comments: metadata.num_comments ?? 0,
    created_utc: item.created_utc,
    saved_utc: item.saved_utc,
    first_seen_utc: item.first_seen_utc,
    is_saved: item.is_saved,
    status: item.status,
    media_type: metadata.media_type ?? "",
    media_url: metadata.media_url ?? "",
    tags: metadata.tags ?? [],
  };
}

export function requestItem(path: string): { fullname: string; action: string | null } | null {
  const match =
    /^\/(?:api\/)?(?:reddit\/)?items\/(.+?)(?:\/(status|snooze|promote|undo|suggest|body|recover|category|tags|folder|hydrate|hydrate-gallery|thread))?$/.exec(
      path,
    );

  if (!match) return null;

  try {
    return { fullname: decodeURIComponent(match[1] ?? ""), action: match[2] ?? null };
  } catch {
    return null;
  }
}
