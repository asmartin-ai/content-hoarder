import type { Database } from "bun:sqlite";
import { z } from "zod";
import * as db from "./db.ts";
import { parseMetadata, type JsonValue, type RawItem } from "./models.ts";

const ThreadEntrySchema = z
  .object({ kind: z.string().optional(), data: z.record(z.string(), z.json()).optional() })
  .passthrough();

const ListingSchema = z
  .object({ data: z.object({ children: z.array(ThreadEntrySchema) }).passthrough() })
  .passthrough();

const ThreadSchema = z.array(ListingSchema);

const MediaSourceSchema = z
  .object({
    gif: z.string().optional(),
    mp4: z.string().optional(),
    u: z.string().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
  })
  .passthrough();

const MediaMetadataSchema = z.record(
  z.string(),
  z
    .object({
      status: z.string().optional(),
      e: z.string().optional(),
      s: MediaSourceSchema.optional(),
    })
    .passthrough(),
);

const RepliesSchema = z
  .object({ data: z.object({ children: z.array(ThreadEntrySchema) }).passthrough() })
  .passthrough();

const ThreadMediaSchema = z.object({
  u: z.string(),
  kind: z.string(),
  w: z.number(),
  h: z.number(),
});

export type ThreadMedia = z.infer<typeof ThreadMediaSchema>;

const ThreadMediaMapSchema = z.record(z.string(), ThreadMediaSchema);

export type ThreadMediaMap = z.infer<typeof ThreadMediaMapSchema>;

export interface ThreadComment {
  author: string;
  body: string;
  score: JsonValue;
  depth: number;
  permalink: string;
  created_utc: number;
  media?: ThreadMediaMap;
}

export interface ThreadPost {
  title: JsonValue;
  author: JsonValue;
  selftext: JsonValue;
  subreddit: JsonValue;
  permalink: string;
  score: JsonValue;
  url: JsonValue;
  created_utc: JsonValue;
  media: ThreadMediaMap;
}

export interface ThreadResult {
  post: ThreadPost | Record<string, never>;
  comments: ThreadComment[];
  cached: boolean;
  archived?: boolean;
  item_fullname: string;
  item_kind: string;
  sort: string;
  cache_via?: "submission";
  error?: string;
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

function stringValue(value: JsonValue | undefined): string {
  return value === null || value === undefined ? "" : String(value);
}

function absPermalink(value: JsonValue | undefined): string {
  const path = stringValue(value);

  return path.startsWith("/") ? `https://www.reddit.com${path}` : path;
}

function resolveMedia(value: JsonValue | undefined): ThreadMediaMap {
  const parsed = MediaMetadataSchema.safeParse(value);

  if (!parsed.success) return {};
  const out: ThreadMediaMap = {};

  for (const [id, meta] of Object.entries(parsed.data)) {
    if (meta.status !== undefined && meta.status !== "valid") continue;
    const source = meta.s ?? {};
    const animated = meta.e === "AnimatedImage";

    const url = animated
      ? source.gif || source.mp4 || source.u
      : source.u || source.gif || source.mp4;

    if (!url || !/^https?:\/\//.test(url)) continue;
    out[id] = {
      u: decodeHtml(url),
      kind: animated ? (source.gif ? "gif" : source.mp4 ? "video" : "image") : "image",
      w: source.x ?? 0,
      h: source.y ?? 0,
    };
  }

  return out;
}

function numberValue(value: JsonValue | undefined): number {
  const number = Number(value ?? 0);

  return Number.isFinite(number) ? number : 0;
}

function extractComments(
  children: Array<z.infer<typeof ThreadEntrySchema>>,
  depth: number,
  sort: string,
): ThreadComment[] {
  const filtered = children.filter((entry) => entry.kind !== "more" && entry.data !== undefined);

  if (sort === "top")
    filtered.sort((a, b) => numberValue(b.data?.score) - numberValue(a.data?.score));

  if (sort === "new")
    filtered.sort((a, b) => numberValue(b.data?.created_utc) - numberValue(a.data?.created_utc));
  const out: ThreadComment[] = [];

  for (const child of filtered) {
    const data = child.data!;

    const entry: ThreadComment = {
      author: stringValue(data.author),
      body: stringValue(data.body),
      score: data.score ?? 0,
      depth,
      permalink: absPermalink(data.permalink),
      created_utc: numberValue(data.created_utc),
    };

    const media = resolveMedia(data.media_metadata);

    if (Object.keys(media).length) entry.media = media;
    out.push(entry);
    const replies = RepliesSchema.safeParse(data.replies);

    if (replies.success) out.push(...extractComments(replies.data.data.children, depth + 1, sort));
  }

  return out;
}

export function parseThread(
  rawJson: string,
  item: Pick<RawItem, "fullname" | "kind">,
  sort = "best",
): ThreadResult {
  const normalizedSort = sort;
  let decoded: unknown;

  try {
    decoded = JSON.parse(rawJson);
  } catch {
    return {
      post: {},
      comments: [],
      cached: true,
      item_fullname: item.fullname,
      item_kind: item.kind,
      sort: normalizedSort,
      error: "could not parse thread JSON",
    };
  }

  const parsed = ThreadSchema.safeParse(decoded);

  if (!parsed.success)
    return {
      post: {},
      comments: [],
      cached: true,
      item_fullname: item.fullname,
      item_kind: item.kind,
      sort: normalizedSort,
    };
  const thread = parsed.data;
  let post: ThreadPost | Record<string, never> = {};
  let postData: Record<string, JsonValue> | undefined;
  const postEntry = thread[0]?.data.children[0];

  if (postEntry?.data) {
    postData = postEntry.data;
    post = {
      title: postData.title ?? "",
      author: postData.author ?? "",
      selftext: postData.selftext ?? "",
      subreddit: postData.subreddit ?? "",
      permalink: absPermalink(postData.permalink),
      score: postData.score ?? 0,
      url: postData.url ?? "",
      created_utc: postData.created_utc ?? 0,
      media: resolveMedia(postData.media_metadata),
    };
  }

  const comments = extractComments(thread[1]?.data.children ?? [], 0, normalizedSort);

  return {
    post,
    comments,
    cached: true,
    archived: postData?._archive_sourced === true,
    item_fullname: item.fullname,
    item_kind: item.kind,
    sort: normalizedSort,
  };
}

export function getThread(
  database: Database,
  fullname: string,
  sort = "best",
): ThreadResult | null {
  const item = db.getItem(database, fullname);

  if (!item) return null;
  let cached = db.getRedditThread(database, fullname);
  let viaSubmission = false;

  if (!cached?.thread_json && fullname.startsWith("reddit:t1_")) {
    const permalink = parseMetadata(item.metadata).permalink ?? "";
    const match = permalink.match(/\/comments\/([a-z0-9]+)/i);

    if (match?.[1]) {
      const alternate = db.getRedditThread(database, `reddit:t3_${match[1]}`);

      if (alternate?.thread_json) {
        cached = alternate;
        viaSubmission = true;
        db.setRedditThread(database, fullname, alternate.thread_json);
      }
    }
  }

  if (cached?.thread_json) {
    const thread = parseThread(cached.thread_json, item, sort);

    if (viaSubmission) thread.cache_via = "submission";

    return thread;
  }

  return {
    post: {},
    comments: [],
    cached: false,
    item_fullname: fullname,
    item_kind: item.kind,
    sort,
  };
}
