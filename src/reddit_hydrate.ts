import { readdir, readFile } from "node:fs/promises";
import type { NormalizedCommentTree, NormalizedPost } from "./archival/providers.ts";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import * as config from "./config.ts";
import * as db from "./db.ts";
import { buildSearchText, parseMetadata, type JsonValue, type Metadata } from "./models.ts";
import * as oauth from "./reddit_oauth.ts";
import * as unsave from "./reddit_unsave.ts";
import { defaultProviders, type ArchiveProvider } from "./archival/providers.ts";
import { childToItem, previewThumb } from "./connectors/reddit.ts";
import { z } from "zod";
import { jitteredThrottle, MIN_THROTTLE } from "./_http.ts";

const ThreadDataSchema = z
  .object({ children: z.array(z.object({ data: z.record(z.string(), z.json()) }).passthrough()) })
  .passthrough();

const ThreadSchema = z.array(z.object({ data: ThreadDataSchema }).passthrough());

const EmptyObjectSchema = z.object({}).strict();

const FullnameRowSchema = z.object({ fullname: z.string() });

const SourceMetadataRowSchema = z.object({ source: z.string(), metadata: z.string() });

const ArchiveCommentSchema = z
  .object({
    id: z.string().optional(),
    submission: z.string().optional(),
    author: z.string().optional(),
    body: z.string().optional(),
    score: z.number().optional(),
    permalink: z.string().optional(),
    created_utc: z.number().optional(),
    replies: z.array(z.json()).optional(),
  })
  .passthrough();

const ArchivePostSchema = z
  .object({
    name: z.string().optional(),
    id: z.string().optional(),
    permalink: z.string().optional(),
    subreddit: z.string().optional(),
    title: z.string().optional(),
    author: z.string().optional(),
    selftext: z.string().optional(),
    score: z.number().optional(),
    url: z.string().optional(),
    created_utc: z.number().optional(),
    comments: z.array(z.json()).optional(),
  })
  .passthrough();

type ArchiveComment = z.infer<typeof ArchiveCommentSchema>;

const TitleBackfillRowSchema = z.object({
  fullname: z.string(),
  body: z.string(),
  author: z.string(),
  metadata: z.string(),
  raw_json: z.string(),
});

const TitleSourceRowSchema = z.object({
  fullname: z.string(),
  body: z.string(),
  author: z.string(),
  metadata: z.string(),
});

const RawSubmissionTitleSchema = z
  .object({ submission_title: z.string().optional() })
  .passthrough();

const HydrateFailureRowSchema = z.object({ value: z.number().nullable() });

const PriorityRowSchema = z.object({ fullname: z.string(), permalink: z.string() });

interface HydrateBatchResult {
  eligible: number;
  hydrated: number;
  failed: number;
  auth_error: boolean;
  network_errors: number;
  dry_run: boolean;
  statuses: Record<string, number>;
  sample?: string[];
}

interface HydrateResult {
  status: string;
  fullname: string;
  source?: string;
  cached?: boolean;
  cached_failure?: boolean;
  via?: string;
  comments?: number;
  detail?: string;
  gallery?: string[];
  gallery_preview?: string[];
  media_url?: string;
  thumbnail?: string;
}

interface TitleBackfillLocalResult {
  candidates: number;
  updated: number;
  dry_run: boolean;
  samples: Array<{ fullname: string; title: string }>;
}

interface TitleBackfillNetworkResult {
  candidates: number;
  resolvable: number;
  submissions: number;
  skipped_no_submission_id: number;
  updated: number;
  missed: number;
  dry_run: boolean;
  by_provider: Record<string, number>;
  sample_targets?: Array<{ fullname: string; submission_id: string }>;
  samples?: Array<{ fullname: string; submission_id: string; title: string }>;
  errors?: Record<string, string>;
}

interface BackfillThumbnailResult {
  scanned: number;
  eligible: number;
  patched: number;
}

interface HydrateFromDirResult {
  files: number;
  hydrated: number;
  skipped_no_item: number;
  skipped_hydrated: number;
  skipped_bad: number;
  errors: number;
}

const SID_FROM_PERMALINK = /\/comments\/([A-Za-z0-9]+)\//;

const SUB_FROM_PERMALINK = /^\/r\/([^/]+)\//;

const HYDRATE_FAIL_TTL = 7 * 24 * 3600;

export const DEFAULT_BATCH_LIMIT = 25;

export function submissionIdFromPermalink(permalink: string | null | undefined): string | null {
  return permalink ? (SID_FROM_PERMALINK.exec(permalink)?.[1] ?? null) : null;
}

export function submissionFullname(permalink: string | null | undefined): string | null {
  const id = submissionIdFromPermalink(permalink);

  return id ? `reddit:t3_${id}` : null;
}

function cacheThreadBlob(
  database: Database,
  fullname: string,
  metadata: Metadata,
  data: JsonValue,
): void {
  const blob = JSON.stringify(data);
  db.setRedditThread(database, fullname, blob);
  const postFullname = submissionFullname(metadata.permalink);

  if (postFullname && postFullname !== fullname) db.setRedditThread(database, postFullname, blob);
}

export function backfillTitlesLocal(
  database: Database,
  opts: { dryRun?: boolean } = {},
): TitleBackfillLocalResult {
  const rows = database
    .query(
      "SELECT fullname,body,author,metadata,raw_json FROM items WHERE source='reddit' AND trim(title)='' AND raw_json!=''",
    )
    .all()
    .map((row) => TitleBackfillRowSchema.parse(row));

  let updated = 0;
  const samples: Array<{ fullname: string; title: string }> = [];

  for (const row of rows) {
    let decoded: unknown;

    try {
      decoded = JSON.parse(row.raw_json);
    } catch {
      continue;
    }

    const raw = RawSubmissionTitleSchema.safeParse(decoded);
    const title = raw.success ? (raw.data.submission_title?.trim() ?? "") : "";

    if (!title) continue;

    if (!opts.dryRun) {
      const metadata = parseMetadata(row.metadata);
      const searchText = buildSearchText({ title, body: row.body, author: row.author }, metadata);
      database
        .query("UPDATE items SET title=?,search_text=? WHERE fullname=?")
        .run(title, searchText, row.fullname);
    }

    updated++;

    if (samples.length < 5) samples.push({ fullname: row.fullname, title: title.slice(0, 80) });
  }

  return { candidates: rows.length, updated, dry_run: Boolean(opts.dryRun), samples };
}

export async function backfillTitlesNetwork(
  database: Database,
  opts: {
    providers?: ArchiveProvider[];
    userAgent?: string;
    dryRun?: boolean;
    limit?: number;
    progress?: (message: string) => void;
  } = {},
): Promise<TitleBackfillNetworkResult> {
  const rows = database
    .query(
      "SELECT fullname,body,author,metadata FROM items WHERE source='reddit' AND trim(title)='' ORDER BY last_seen_utc DESC",
    )
    .all()
    .map((row) => TitleSourceRowSchema.parse(row));

  const targets: Array<{
    fullname: string;
    sid: string;
    body: string;
    author: string;
    metadata: Metadata;
  }> = [];

  let skippedNoSid = 0;

  for (const row of rows) {
    const metadata = parseMetadata(row.metadata);
    const sid = submissionIdFromPermalink(metadata.permalink);

    if (!sid) {
      skippedNoSid++;
      continue;
    }

    targets.push({ fullname: row.fullname, sid, body: row.body, author: row.author, metadata });
  }

  if (opts.limit !== undefined) targets.splice(Math.max(0, Math.trunc(opts.limit)));
  const ids = [...new Set(targets.map((target) => target.sid))].sort();

  const result: TitleBackfillNetworkResult = {
    candidates: rows.length,
    resolvable: targets.length,
    submissions: ids.length,
    skipped_no_submission_id: skippedNoSid,
    updated: 0,
    missed: 0,
    dry_run: Boolean(opts.dryRun),
    by_provider: {},
  };

  if (opts.dryRun) {
    result.sample_targets = targets
      .slice(0, 20)
      .map(({ fullname, sid }) => ({ fullname, submission_id: sid }));

    return result;
  }

  if (!targets.length) return result;
  const providers = opts.providers ?? defaultProviders(opts.userAgent ?? config.get("USER_AGENT"));
  const titles: Record<string, string> = {};
  const remaining = new Set(ids);
  const errors: Record<string, string> = {};
  const byProvider = result.by_provider;

  for (const provider of providers) {
    if (!remaining.size) break;
    let found: Record<string, { title: string }>;

    try {
      found = await provider.fetchPosts([...remaining].sort());
    } catch (error) {
      errors[provider.name] = error instanceof Error ? error.message : String(error);
      continue;
    }

    let received = 0;

    for (const [id, post] of Object.entries(found)) {
      const title = post.title.trim();

      if (title && title !== "[removed]" && title !== "[deleted]") {
        titles[id] = title;
        received++;
      }
    }

    for (const id of Object.keys(titles)) remaining.delete(id);

    if (received) byProvider[provider.name] = (byProvider[provider.name] ?? 0) + received;
    opts.progress?.(
      `  ${provider.name}: ${Object.keys(titles).length}/${ids.length} submissions resolved`,
    );
  }

  const samples: Array<{ fullname: string; submission_id: string; title: string }> = [];

  for (const target of targets) {
    const title = titles[target.sid];

    if (!title) {
      result.missed++;
      continue;
    }

    const searchText = buildSearchText(
      { title, body: target.body, author: target.author },
      target.metadata,
    );

    database
      .query("UPDATE items SET title=?,search_text=? WHERE fullname=?")
      .run(title, searchText, target.fullname);
    result.updated++;

    if (samples.length < 8)
      samples.push({
        fullname: target.fullname,
        submission_id: target.sid,
        title: title.slice(0, 80),
      });
  }

  result.samples = samples;

  if (Object.keys(errors).length) result.errors = errors;

  return result;
}

function postFromBlob(threadJson: string): Record<string, JsonValue> | null {
  try {
    const parsed = ThreadSchema.safeParse(JSON.parse(threadJson));

    return parsed.success ? (parsed.data[0]?.data.children[0]?.data ?? null) : null;
  } catch {
    return null;
  }
}

function galleryPayload(post: Record<string, JsonValue>): Metadata | null {
  const item = childToItem({ kind: "t3", data: post });

  if (!item) return null;
  const metadata = parseMetadata(item.metadata);

  if (!metadata.gallery?.length) return null;
  const thumbnail = metadata.thumbnail || metadata.gallery_preview?.[0] || metadata.gallery[0];

  const payload: Metadata = {
    media_type: "gallery",
    media_url: metadata.media_url ?? "",
    gallery: metadata.gallery,
    gallery_preview: metadata.gallery_preview ?? [],
  };

  if (thumbnail) payload.thumbnail = thumbnail;

  return payload;
}

export async function hydrateGallery(
  database: Database,
  fullname: string,
  opts: { getf?: unsave.Get; userAgent?: string; providers?: ArchiveProvider[] } = {},
): Promise<HydrateResult> {
  const parsedRow = SourceMetadataRowSchema.safeParse(
    database.query("SELECT source,metadata FROM items WHERE fullname=?").get(fullname),
  );

  if (!parsedRow.success) return { status: "not_found", fullname };

  if (parsedRow.data.source !== "reddit") return { status: "no_permalink", fullname };
  const metadata = parseMetadata(parsedRow.data.metadata);

  if (metadata.gallery?.length)
    return {
      status: "cached",
      source: "metadata",
      fullname,
      gallery: metadata.gallery,
      gallery_preview: metadata.gallery_preview ?? [],
    };

  let post = db.getRedditThread(database, fullname)?.thread_json
    ? postFromBlob(db.getRedditThread(database, fullname)!.thread_json)
    : null;

  let hydrateStatus = "cached";

  if (!post) {
    const hydration = await hydrateOne(database, fullname, opts);
    hydrateStatus = String(hydration.status ?? "error");
    const thread = db.getRedditThread(database, fullname);
    post = thread ? postFromBlob(thread.thread_json) : null;

    if (!post) return { status: hydrateStatus, fullname };
  }

  const payload = galleryPayload(post);

  if (!payload?.gallery) return { status: "no_gallery", fullname };
  const mediaUrl = z.string().optional().catch(undefined).parse(payload.media_url) ?? "";
  const thumbnail = z.string().optional().catch(undefined).parse(payload.thumbnail) ?? "";

  return {
    status: ["hydrated", "archived"].includes(hydrateStatus) ? "hydrated" : "cached",
    source: hydrateStatus === "cached" ? "thread" : hydrateStatus,
    fullname,
    gallery: payload.gallery,
    gallery_preview: payload.gallery_preview ?? [],
    media_url: mediaUrl,
    thumbnail,
  };
}

function permalinkPath(value: string): string {
  return (
    value.startsWith("http://") || value.startsWith("https://") ? new URL(value).pathname : value
  ).replace(/^\/+|\/+$/g, "");
}

export async function hydrateOne(
  database: Database,
  fullname: string,
  opts: { getf?: unsave.Get; userAgent?: string; providers?: ArchiveProvider[] } = {},
): Promise<HydrateResult> {
  const parsedRow = SourceMetadataRowSchema.safeParse(
    database.query("SELECT source,metadata FROM items WHERE fullname=?").get(fullname),
  );

  if (!parsedRow.success) return { status: "not_found", fullname };
  const metadata = parseMetadata(parsedRow.data.metadata);

  if (parsedRow.data.source !== "reddit" || !metadata.permalink)
    return { status: "no_permalink", fullname };
  const userAgent = opts.userAgent ?? unsave.cookieUserAgent();

  const token =
    !opts.getf && oauth.isConfigured(database) ? await oauth.accessToken(database) : null;

  const auth = token ? null : unsave.getAuth(database);

  if (!token && !auth) return { status: "auth_missing", fullname };
  const sessionCookie = auth?.session_cookie ?? "";
  const base = token ? "https://oauth.reddit.com" : "https://www.reddit.com";
  const userAgentForCall = token ? oauth.oauthUserAgent(database) : userAgent;
  const url = `${base}/${permalinkPath(metadata.permalink)}/.json?raw_json=1`;
  let data: unknown;

  try {
    data = token
      ? await oauth.oauthGet(url, { bearer: token, userAgent: userAgentForCall })
      : await (opts.getf ?? unsave.httpGet)(url, {
          session_cookie: sessionCookie,
          user_agent: userAgentForCall,
        });
  } catch (error) {
    if (error instanceof oauth.RedditNotFoundError)
      return hydrateOneFromArchive(database, fullname, opts);

    if (error instanceof oauth.RedditNetworkError)
      return { status: "network_error", fullname, detail: error.message };

    return {
      status: "network_error",
      fullname,
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  if (EmptyObjectSchema.safeParse(data).success) return { status: "auth_expired", fullname };
  const parsedThread = ThreadSchema.safeParse(data);

  if (!parsedThread.success || !parsedThread.data.length) return { status: "bad_shape", fullname };
  const thread = parsedThread.data;
  const comments = thread[1]?.data.children.length ?? 0;
  cacheThreadBlob(database, fullname, metadata, z.json().parse(thread));
  const post = thread[0]?.data.children[0]?.data;
  const thumbnail = post ? previewThumb(post) : "";

  if (thumbnail) db.patchItemMetadata(database, fullname, { thumbnail }, { onlyIfMissing: true });

  return { status: "hydrated", fullname, comments };
}

function archivedTree(
  comments: NormalizedCommentTree[],
  subreddit: string,
  bare: string,
): JsonValue[] {
  const childrenOf = new Map<string, NormalizedCommentTree[]>();
  const byId = new Map<string, NormalizedCommentTree>();

  for (const comment of comments) {
    if (comment.id) byId.set(comment.id, comment);
    const list = childrenOf.get(comment.parent_id) ?? [];
    list.push(comment);
    childrenOf.set(comment.parent_id, list);
  }

  const roots = comments.filter(
    (comment) =>
      comment.parent_id === `t3_${bare}` || !byId.has(comment.parent_id.replace(/^t[13]_/, "")),
  );

  const toChild = (comment: NormalizedCommentTree): JsonValue => {
    const id = comment.id;

    const permalink =
      comment.permalink || (subreddit && id ? `/r/${subreddit}/comments/${bare}/_/${id}/` : "");

    const nested = childrenOf.get(`t1_${id}`) ?? [];

    return z.json().parse({
      kind: "t1",
      data: {
        author: comment.author,
        body: comment.body,
        score: comment.score,
        permalink,
        created_utc: comment.created_utc,
        replies: nested.length ? { kind: "Listing", data: { children: nested.map(toChild) } } : "",
      },
    });
  };

  return roots.map(toChild);
}

export async function hydrateOneFromArchive(
  database: Database,
  fullname: string,
  opts: { providers?: ArchiveProvider[]; userAgent?: string } = {},
): Promise<HydrateResult> {
  if (db.getRedditThread(database, fullname)) return { status: "archived", fullname, cached: true };
  const item = db.getItem(database, fullname);

  if (!item) return { status: "archived", fullname, comments: 0 };
  const bare = item.source_id.replace(/^t[13]_/, "");

  if (!bare) return { status: "archived", fullname, comments: 0 };

  const providers =
    opts.providers ??
    defaultProviders(opts.userAgent ?? config.get("USER_AGENT"), {
      throttle: false,
      order: ["arctic", "pullpush"],
    });

  let post: NormalizedPost | undefined;
  let chosen: ArchiveProvider | undefined;

  for (const provider of providers) {
    try {
      const found = await provider.fetchPosts([bare]);

      if (found[bare]) {
        post = found[bare];
        chosen = provider;
        break;
      }
    } catch {
      /* next archive source */
    }
  }

  if (!post || !chosen) return { status: "archived", fullname, comments: 0 };
  let comments: NormalizedCommentTree[] = [];

  try {
    comments = await chosen.searchCommentsTree(item.source_id, 500);
  } catch {
    comments = [];
  }

  const subreddit = post.subreddit;

  const postData = {
    title: post.title,
    author: post.author,
    selftext: post.body,
    subreddit,
    permalink: post.permalink,
    score: post.score,
    url: post.url,
    created_utc: post.created_utc,
    _archive_sourced: true,
  } satisfies Record<string, JsonValue>;

  const roots = archivedTree(comments, subreddit, bare);

  const listing = [
    { kind: "Listing", data: { children: [{ kind: "t3", data: postData }] } },
    { kind: "Listing", data: { children: roots } },
  ];

  cacheThreadBlob(database, fullname, parseMetadata(item.metadata), z.json().parse(listing));

  return { status: "archived", fullname, comments: roots.length };
}

export async function hydrateIfMissing(
  database: Database,
  fullname: string,
  opts: {
    getf?: unsave.Get;
    userAgent?: string;
    providers?: ArchiveProvider[];
    now?: number;
    ttl?: number;
  } = {},
): Promise<HydrateResult> {
  if (db.getRedditThread(database, fullname)?.thread_json) return { status: "cached", fullname };
  const item = db.getItem(database, fullname);
  const metadata = parseMetadata(item?.metadata);
  const postFullname = submissionFullname(metadata.permalink);

  if (postFullname && postFullname !== fullname) {
    const postThread = db.getRedditThread(database, postFullname);

    if (postThread?.thread_json) {
      db.setRedditThread(database, fullname, postThread.thread_json);

      return { status: "cached", fullname, via: "submission" };
    }
  }

  const now = opts.now ?? Math.floor(Date.now() / 1000);

  const failedRow = database
    .query(
      "SELECT json_extract(metadata,'$.hydrate_failed_at') AS value FROM items WHERE fullname=?",
    )
    .get(fullname);

  const failed = failedRow === null ? null : HydrateFailureRowSchema.parse(failedRow);

  if (
    failed?.value !== null &&
    failed?.value !== undefined &&
    now - failed.value < (opts.ttl ?? HYDRATE_FAIL_TTL)
  )
    return { status: "unavailable", fullname, cached_failure: true };
  const result = await hydrateOne(database, fullname, opts);

  if (result.status === "archived" && !db.getRedditThread(database, fullname)?.thread_json) {
    const current = db.getItem(database, fullname);

    if (current) {
      const md = parseMetadata(current.metadata);
      md.hydrate_failed_at = now;
      database
        .query("UPDATE items SET metadata=? WHERE fullname=?")
        .run(JSON.stringify(md), fullname);
    }

    result.cached_failure = true;
  }

  return result;
}

export function backfillThumbnails(
  database: Database,
  opts: { apply?: boolean; limit?: number } = {},
): BackfillThumbnailResult {
  const rows = database
    .query(
      "SELECT i.fullname FROM items i JOIN reddit_threads t ON t.fullname=i.fullname WHERE i.source='reddit'",
    )
    .all()
    .map((row) => FullnameRowSchema.parse(row));

  let scanned = 0;
  let eligible = 0;
  let patched = 0;

  for (const row of rows) {
    if (opts.limit !== undefined && scanned >= opts.limit) break;
    scanned++;
    const item = db.getItem(database, row.fullname);

    if (!item || parseMetadata(item.metadata).thumbnail) continue;
    const cached = db.getRedditThread(database, row.fullname);

    if (!cached) continue;
    let decoded: unknown;

    try {
      decoded = JSON.parse(cached.thread_json);
    } catch {
      continue;
    }

    const parsedThread = ThreadSchema.safeParse(decoded);

    if (!parsedThread.success) continue;
    const post = parsedThread.data[0]?.data.children[0]?.data;
    const thumb = post ? previewThumb(post) : "";

    if (!thumb) continue;
    eligible++;

    if (
      opts.apply &&
      db.patchItemMetadata(database, row.fullname, { thumbnail: thumb }, { onlyIfMissing: true })
    )
      patched++;
  }

  return { scanned, eligible, patched };
}

export async function hydrateFromDir(
  database: Database,
  archiveDir: string,
  opts: {
    limit?: number;
    includeOrphans?: boolean;
    overwrite?: boolean;
    progress?: (message: string) => void;
  } = {},
): Promise<HydrateFromDirResult> {
  const files: string[] = [];

  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);

      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith(".json")) files.push(path);
    }
  }

  await walk(archiveDir);
  files.sort();

  const result = {
    files: files.length,
    hydrated: 0,
    skipped_no_item: 0,
    skipped_hydrated: 0,
    skipped_bad: 0,
    errors: 0,
  };

  const already = opts.overwrite
    ? new Set<string>()
    : new Set(
        database
          .query("SELECT fullname FROM reddit_threads")
          .all()
          .map((row) => FullnameRowSchema.parse(row).fullname),
      );

  const toChild = (value: ArchiveComment, subreddit: string, submissionId: string): JsonValue => {
    const comment = value;
    const replies = z.array(ArchiveCommentSchema).parse(comment.replies ?? []);
    const id = comment.id?.trim() ?? "";
    const sid = comment.submission?.trim() || submissionId;
    const permalink = subreddit && sid && id ? `/r/${subreddit}/comments/${sid}/_/${id}/` : "";

    return z.json().parse({
      kind: "t1",
      data: {
        author: comment.author ?? "",
        body: comment.body ?? "",
        score: comment.score ?? 0,
        permalink,
        created_utc: comment.created_utc ?? 0,
        replies: replies.length
          ? {
              kind: "Listing",
              data: { children: replies.map((reply) => toChild(reply, subreddit, submissionId)) },
            }
          : "",
      },
    });
  };

  for (const path of files) {
    if (opts.limit !== undefined && result.hydrated >= opts.limit) break;
    let decoded: unknown;

    try {
      decoded = JSON.parse(await readFile(path, "utf8"));
    } catch {
      result.errors++;
      continue;
    }

    const parsedPost = ArchivePostSchema.safeParse(decoded);

    if (!parsedPost.success) {
      result.skipped_bad++;
      continue;
    }

    const post = parsedPost.data;
    const name = post.name?.trim() ?? "";
    const id = name.startsWith("t3_") ? name.slice(3) : (post.id?.trim() ?? "");

    if (!id) {
      result.skipped_bad++;
      continue;
    }

    const fullname = `reddit:t3_${id}`;

    if (opts.includeOrphans !== true && !db.getItem(database, fullname)) {
      result.skipped_no_item++;
      continue;
    }

    if (already.has(fullname)) {
      result.skipped_hydrated++;
      continue;
    }

    const permalink = post.permalink ?? "";
    const subreddit = post.subreddit ?? SUB_FROM_PERMALINK.exec(permalink)?.[1] ?? "";
    const comments = z.array(ArchiveCommentSchema).parse(post.comments ?? []);

    const postData = {
      title: post.title ?? "",
      author: post.author ?? "",
      selftext: post.selftext ?? "",
      subreddit,
      permalink,
      score: post.score ?? 0,
      url: post.url ?? "",
      created_utc: post.created_utc ?? 0,
    };

    const children = comments.map((comment) => toChild(comment, subreddit, id));

    const thread = [
      { kind: "Listing", data: { children: [{ kind: "t3", data: postData }] } },
      { kind: "Listing", data: { children } },
    ];

    db.setRedditThread(database, fullname, JSON.stringify(thread));
    result.hydrated++;

    if (result.hydrated % 50 === 0) opts.progress?.(`hydrated ${result.hydrated}/${result.files}…`);
  }

  return result;
}

export function priorityUnhydrated(database: Database, limit: number): Array<[string, string]> {
  const rows = database
    .query(
      "SELECT i.fullname AS fullname,json_extract(i.metadata,'$.permalink') AS permalink FROM items i WHERE i.source='reddit' AND i.kind='post' AND i.status='inbox' AND i.body IS NOT NULL AND i.body!='' AND json_extract(i.metadata,'$.permalink') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM reddit_threads t WHERE t.fullname=i.fullname) ORDER BY i.saved_utc DESC LIMIT ?",
    )
    .all(Math.trunc(limit))
    .map((row) => PriorityRowSchema.parse(row));

  return rows.map((row) => [row.fullname, row.permalink]);
}

export async function hydrateBatch(
  database: Database,
  opts: {
    limit?: number;
    throttle?: number;
    dryRun?: boolean;
    getf?: unsave.Get;
    sleep?: (seconds: number) => Promise<void> | void;
    progress?: (message: string) => void;
  } = {},
): Promise<HydrateBatchResult> {
  const limit = opts.limit ?? DEFAULT_BATCH_LIMIT;
  const throttle = Math.max(opts.throttle ?? 2, MIN_THROTTLE);
  const targets = priorityUnhydrated(database, limit);

  const result: HydrateBatchResult = {
    eligible: targets.length,
    hydrated: 0,
    failed: 0,
    auth_error: false,
    network_errors: 0,
    dry_run: Boolean(opts.dryRun),
    statuses: {},
  };

  if (opts.dryRun) {
    result.sample = targets.slice(0, 20).map(([fullname]) => fullname);

    return result;
  }

  if (!unsave.getAuth(database)) {
    result.auth_error = true;

    return result;
  }

  const sleep = opts.sleep ?? (async (seconds) => Bun.sleep(seconds * 1000));
  const statuses = result.statuses;

  for (let i = 0; i < targets.length; i++) {
    const [fullname] = targets[i]!;
    const hydration = await hydrateOne(database, fullname, { getf: opts.getf });
    const status = String(hydration.status ?? "error");
    statuses[status] = (statuses[status] ?? 0) + 1;

    if (status === "hydrated") result.hydrated++;
    else if (status === "auth_expired" || status === "auth_missing") {
      result.auth_error = true;
      break;
    } else {
      result.failed++;

      if (status === "network_error") result.network_errors++;
    }

    if ((i + 1) % 10 === 0) opts.progress?.(`hydrated ${result.hydrated}/${result.eligible}…`);

    if (i + 1 < targets.length) await sleep(jitteredThrottle(throttle));
  }

  return result;
}
