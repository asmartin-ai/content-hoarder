import { request, HttpError } from "../_http";
import * as z from "zod";

export const PULLPUSH_BASE = "https://api.pullpush.io";

export const ARCTIC_BASE = "https://arctic-shift.photon-reddit.com";

const validId = /^[A-Za-z0-9]+$/;

const JsonSchema = z.json();

type Json = z.infer<typeof JsonSchema>;

type JsonObject = { [key: string]: Json };

const JsonObjectSchema = z.record(z.string(), JsonSchema);

const ArchiveTodayMetadataSchema = z.union([
  z.string().transform((value) => JsonObjectSchema.parse(JSON.parse(value))),
  JsonObjectSchema,
]);

type ArchiveProviderName = "pullpush" | "arctic";

const ArchiveResponseSchema = z.union([
  z.array(JsonSchema),
  z.object({ data: JsonSchema }).catchall(JsonSchema),
]);

/** Seconds-based sleep, matching the shape of the injectable `sleep` options. */
const sleepSeconds = (seconds: number): Promise<void> => Bun.sleep(seconds * 1000);

export type NormalizedPost = {
  title: string;
  body: string;
  author: string;
  subreddit: string;
  permalink: string;
  url: string;
  created_utc: Json;
  score: number;
  over_18: number;
  media_type: string;
  media_url: string;
  thumbnail: string;
  gallery: string[];
  gallery_preview: string[];
};

export type NormalizedComment = {
  body: string;
  author: string;
  subreddit: string;
  permalink: string;
  score: number;
  depth: number;
  created_utc: Json;
};

export type NormalizedCommentTree = {
  id: string;
  parent_id: string;
  author: string;
  body: string;
  score: number;
  created_utc: Json;
  permalink: string;
};

export class ArchiveError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
    readonly retryAfter: number | null = null,
  ) {
    super(message);
    this.name = "ArchiveError";
  }
}

function object(value: Json | undefined): JsonObject {
  const parsed = JsonObjectSchema.safeParse(value);

  return parsed.success ? parsed.data : {};
}

const textValueSchema = z.string().catch("");

const numberValueSchema = z.number().catch(0);

const arrayValueSchema = z.array(JsonSchema).catch([]);

function text(value: Json | undefined): string {
  return textValueSchema.parse(value);
}

function number(value: Json | undefined): number {
  return numberValueSchema.parse(value);
}

function array(value: Json | undefined): Json[] {
  return arrayValueSchema.parse(value);
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&#x([\da-f]+);/gi, (_m, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function bareId(fullname: string): string {
  return fullname.startsWith("t1_") || fullname.startsWith("t3_") ? fullname.slice(3) : fullname;
}

function permalink(value: string): string {
  return value.startsWith("/") ? `https://www.reddit.com${value}` : value;
}

function nested(objectValue: JsonObject, key: string): JsonObject {
  return object(objectValue[key]);
}

function mediaUrl(rec: JsonObject): string {
  for (const holder of [
    nested(nested(rec, "media"), "reddit_video"),
    nested(nested(rec, "secure_media"), "reddit_video"),
  ]) {
    const fallback = text(holder.fallback_url);

    if (fallback) return fallback;
  }

  return text(rec.url_overridden_by_dest) || text(rec.url);
}

function thumbnail(rec: JsonObject): string {
  const images = array(nested(rec, "preview").images);
  const source = images.length ? text(nested(object(images[0]), "source").url) : "";

  if (source) return decodeHtml(source);
  const candidate = text(rec.thumbnail);

  return candidate.startsWith("http") ? candidate : "";
}

function gallery(rec: JsonObject, preview = false, target = 1080): string[] {
  if (!rec.is_gallery) return [];
  const metadata = nested(rec, "media_metadata");

  const requested = array(nested(rec, "gallery_data").items).flatMap((item) => {
    const id = text(object(item).media_id);

    return id ? [id] : [];
  });

  const order = requested.length ? requested : Object.keys(metadata);
  const out: string[] = [];

  for (const id of order) {
    const frame = nested(metadata, id);
    const source = nested(frame, "s");
    const full = text(source.u) || text(source.gif) || text(source.mp4);

    if (!full) continue;
    let chosen = full;

    const previews = array(frame.p).flatMap((value) => {
      const item = object(value);

      return text(item.u) ? [item] : [];
    });

    if (preview && previews.length) {
      const fitting = previews
        .filter((item) => number(item.x) <= target)
        .sort((a, b) => number(b.x) - number(a.x));

      const pick = fitting[0] ?? previews.toSorted((a, b) => number(a.x) - number(b.x))[0];
      chosen = text(pick?.u) || full;
    }

    out.push(decodeHtml(chosen));
  }

  return out;
}

function mediaType(rec: JsonObject): string {
  if (
    rec.is_video ||
    (nested(nested(rec, "media"), "reddit_video") &&
      Object.keys(nested(nested(rec, "media"), "reddit_video")).length)
  )
    return "reddit_video";

  if (rec.is_gallery) return "gallery";

  if (rec.post_hint === "image") return "image";

  if (rec.post_hint === "hosted:video") return "reddit_video";

  return rec.post_hint === "link" ? "link" : "";
}

function normalizePost(rec: JsonObject): NormalizedPost {
  return {
    title: text(rec.title),
    body: text(rec.selftext),
    author: text(rec.author),
    subreddit: text(rec.subreddit),
    permalink: permalink(text(rec.permalink)),
    url: text(rec.url),
    created_utc: rec.created_utc ?? null,
    score: number(rec.score),
    over_18: rec.over_18 ? 1 : 0,
    media_type: mediaType(rec),
    media_url: mediaUrl(rec),
    thumbnail: thumbnail(rec),
    gallery: gallery(rec),
    gallery_preview: gallery(rec, true),
  };
}

function normalizeComment(rec: JsonObject): NormalizedComment {
  return {
    body: text(rec.body),
    author: text(rec.author),
    subreddit: text(rec.subreddit),
    permalink: permalink(text(rec.permalink)),
    score: number(rec.score),
    depth: 0,
    created_utc: rec.created_utc ?? null,
  };
}

function normalizeCommentTree(rec: JsonObject): NormalizedCommentTree {
  return {
    id: text(rec.id),
    parent_id: text(rec.parent_id),
    author: text(rec.author),
    body: text(rec.body),
    score: number(rec.score),
    created_utc: rec.created_utc ?? null,
    permalink: text(rec.permalink),
  };
}

export async function getJson(
  url: string,
  userAgent: string,
): Promise<[number, Record<string, string>, Json]> {
  try {
    const [status, headers, raw] = await request(url, {
      method: "GET",
      headers: { "User-Agent": userAgent, Accept: "application/json" },
      timeout: 20_000,
    });

    try {
      const data: unknown = JSON.parse(new TextDecoder().decode(raw));

      return [status, headers, JsonSchema.parse(data)];
    } catch (error) {
      throw new ArchiveError(
        `invalid JSON from ${url}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } catch (error) {
    if (error instanceof ArchiveError) throw error;

    if (error instanceof HttpError)
      throw new ArchiveError(
        error.kind === "http"
          ? `HTTP ${error.status} for ${url}`
          : `connection error for ${url}: ${error.reason}`,
        error.status,
        error.retryAfter,
      );
    throw new ArchiveError(
      `connection error for ${url}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export abstract class ArchiveProvider {
  readonly name: string;
  readonly maxBatch: number;
  private madeRequest = false;
  constructor(
    name: string,
    maxBatch: number,
    readonly userAgent: string,
    readonly options: {
      minInterval?: number;
      maxRetries?: number;
      sleep?: (seconds: number) => Promise<void> | void;
      fetchJson?: typeof getJson;
    } = {},
  ) {
    this.name = name;
    this.maxBatch = maxBatch;
  }
  protected abstract idsUrl(kind: "posts" | "comments", ids: string[]): string;
  protected abstract searchCommentsUrl(linkFullname: string, limit: number): string;
  private async requestJson(url: string): Promise<JsonObject> {
    if (this.madeRequest && (this.options.minInterval ?? 0) > 0)
      await (this.options.sleep ?? sleepSeconds)(this.options.minInterval ?? 0);
    let delay = 2;

    for (let attempt = 0; ; attempt++) {
      this.madeRequest = true;

      try {
        const [, , data] = await (this.options.fetchJson ?? getJson)(url, this.userAgent);
        const response = ArchiveResponseSchema.parse(data);

        return Array.isArray(response) ? { data: response } : object(response);
      } catch (error) {
        if (error instanceof z.ZodError)
          throw new ArchiveError(`invalid response from ${url}: ${error.message}`);

        if (
          !(error instanceof ArchiveError) ||
          error.status !== 429 ||
          attempt >= (this.options.maxRetries ?? 3)
        )
          throw error;
        await (this.options.sleep ?? sleepSeconds)(error.retryAfter ?? delay);
        delay *= 2;
      }
    }
  }
  private async fetch<T>(
    kind: "posts" | "comments",
    ids: string[],
    normalize: (record: JsonObject) => T,
  ): Promise<Record<string, T>> {
    const valid = ids.filter((id) => validId.test(id));
    const out: Record<string, T> = {};

    for (let start = 0; start < valid.length; start += this.maxBatch) {
      const response = await this.requestJson(
        this.idsUrl(kind, valid.slice(start, start + this.maxBatch)),
      );

      for (const value of array(response.data)) {
        const rec = object(value);
        const id = text(rec.id);

        if (id) out[id] = normalize(rec);
      }
    }

    return out;
  }
  fetchPosts(ids: string[]): Promise<Record<string, NormalizedPost>> {
    return this.fetch("posts", ids, normalizePost);
  }
  fetchComments(ids: string[]): Promise<Record<string, NormalizedComment>> {
    return this.fetch("comments", ids, normalizeComment);
  }
  async searchComments(linkFullname: string, limit = 200): Promise<NormalizedComment[]> {
    const response = await this.requestJson(this.searchCommentsUrl(linkFullname, limit));

    return array(response.data).map((value) => normalizeComment(object(value)));
  }
  async searchCommentsTree(linkFullname: string, limit = 200): Promise<NormalizedCommentTree[]> {
    const response = await this.requestJson(this.searchCommentsUrl(linkFullname, limit));

    return array(response.data).map((value) => normalizeCommentTree(object(value)));
  }
}

export class PullPushProvider extends ArchiveProvider {
  constructor(userAgent: string, options: ConstructorParameters<typeof ArchiveProvider>[3] = {}) {
    super("pullpush", 100, userAgent, options);
  }
  protected idsUrl(kind: "posts" | "comments", ids: string[]): string {
    return `${PULLPUSH_BASE}/reddit/search/${kind === "posts" ? "submission" : "comment"}/?ids=${ids.join(",")}`;
  }
  protected searchCommentsUrl(linkFullname: string, limit: number): string {
    return `${PULLPUSH_BASE}/reddit/search/comment/?link_id=${bareId(linkFullname)}&size=${Math.min(limit, 100)}`;
  }
}

export class ArcticShiftProvider extends ArchiveProvider {
  constructor(userAgent: string, options: ConstructorParameters<typeof ArchiveProvider>[3] = {}) {
    super("arctic", 500, userAgent, options);
  }
  protected idsUrl(kind: "posts" | "comments", ids: string[]): string {
    return `${ARCTIC_BASE}/api/${kind === "posts" ? "posts" : "comments"}/ids?ids=${ids.join(",")}`;
  }
  protected searchCommentsUrl(linkFullname: string, limit: number): string {
    return `${ARCTIC_BASE}/api/comments/search?link_id=${bareId(linkFullname)}&limit=${limit}`;
  }
}

export class ArchiveTodayProvider {
  readonly name = "archive_today";
  private madeRequest = false;
  constructor(
    readonly userAgent: string,
    readonly options: {
      minInterval?: number;
      maxRetries?: number;
      sleep?: (seconds: number) => Promise<void> | void;
      fetchHtml?: (url: string) => Promise<string>;
    } = {},
  ) {}
  private async fetchHtml(url: string): Promise<string> {
    if (this.options.fetchHtml) return this.options.fetchHtml(url);

    try {
      const [, , bytes] = await request(url, {
        method: "GET",
        headers: { "User-Agent": this.userAgent, Accept: "text/html" },
        timeout: 20_000,
        retries: this.options.maxRetries ?? 2,
        sleep: (seconds) => (this.options.sleep ?? sleepSeconds)(seconds),
      });

      return new TextDecoder().decode(bytes);
    } catch (error) {
      if (error instanceof HttpError)
        throw new ArchiveError(
          `HTTP error for ${url}: ${error.message}`,
          error.status,
          error.retryAfter,
        );
      throw new ArchiveError(
        `network error for ${url}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  async recoverMedia(
    item: { metadata: JsonObject | string },
    opts: { wantGallery?: boolean } = {},
  ): Promise<Array<{ url: string; title: string }>> {
    const md = ArchiveTodayMetadataSchema.parse(item.metadata);
    const mediaUrl = text(md.media_url);
    const gallery = opts.wantGallery === false ? [] : array(md.gallery).map(text);
    const urls = [mediaUrl, ...gallery].filter((url) => url.startsWith("http"));
    const unique = [...new Set(urls)];
    const output: Array<{ url: string; title: string }> = [];

    for (const original of unique) {
      if (this.madeRequest && (this.options.minInterval ?? 2) > 0)
        await (this.options.sleep ?? sleepSeconds)(this.options.minInterval ?? 2);
      this.madeRequest = true;
      let html: string;

      try {
        html = await this.fetchHtml(`https://archive.ph/newest/${encodeURIComponent(original)}`);
      } catch (error) {
        if (error instanceof ArchiveError) continue;
        throw error;
      }

      output.push(...this.extractImages(html));
    }

    return output;
  }
  private extractImages(html: string): Array<{ url: string; title: string }> {
    const titleTag = /<meta\b[^>]*property=["']og:title["'][^>]*>/i.exec(html)?.[0] ?? "";
    const title = decodeHtml(/content=["']([^"']+)["']/i.exec(titleTag)?.[1] ?? "").trim();

    const tags = [...html.matchAll(/<meta\b[^>]*property=["']og:image["'][^>]*>/gi)].map(
      (match) => match[0],
    );

    const urls = tags.map((tag) => /content=["']([^"']+)["']/i.exec(tag)?.[1] ?? "");
    urls.push(
      ...[...html.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["']/gi)].map((match) => match[1] ?? ""),
    );

    return [
      ...new Set(
        urls.flatMap((value) => {
          const url = decodeHtml(value).trim();

          return url.startsWith("http") ? [url] : [];
        }),
      ),
    ].map((url) => ({ url, title }));
  }
}

export function defaultProviders(
  userAgent: string,
  opts: { throttle?: boolean; order?: readonly ArchiveProviderName[] } = {},
): ArchiveProvider[] {
  const throttle = opts.throttle !== false;

  const providers = {
    pullpush: new PullPushProvider(userAgent, { minInterval: throttle ? 4 : 0 }),
    arctic: new ArcticShiftProvider(userAgent, { minInterval: throttle ? 0.4 : 0 }),
  } satisfies Record<ArchiveProviderName, ArchiveProvider>;

  const result: ArchiveProvider[] = [];

  for (const name of opts.order ?? ["pullpush", "arctic"]) result.push(providers[name]);

  return result;
}

export function defaultMediaProviders(userAgent: string, throttle = true): ArchiveTodayProvider[] {
  return [new ArchiveTodayProvider(userAgent, { minInterval: throttle ? 2 : 0 })];
}
