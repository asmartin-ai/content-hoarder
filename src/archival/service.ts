import type { Database } from "bun:sqlite";
import * as z from "zod";
import * as db from "../db";
import { parseMetadata, type Metadata, type RawItem } from "../models";
import {
  ArchiveError,
  defaultProviders,
  defaultMediaProviders,
  type ArchiveTodayProvider,
  type NormalizedPost,
  type NormalizedComment,
} from "./providers";
import { defaultFetch } from "../media_archive";
import * as mediaStore from "../media_store";

export const DEFAULT_USER_AGENT = "content-hoarder/0.1 (reddit archival recovery)";

const placeholders = new Set(["[removed]", "[deleted]"]);

const targetWhere =
  "source='reddit' AND (body IN ('[removed]','[deleted]') OR title IN ('[removed]','[deleted]') OR body LIKE '[ removed by%' OR title LIKE '[ removed by%' OR title LIKE 'deleted by user%' OR (kind='comment' AND (body IS NULL OR body='')))";

export type RecoveryScope = "removed" | "all" | "gallery_preview";

export type RecoveryResult = {
  selected: number;
  recovered: number;
  missed: number;
  by_provider: Record<string, number>;
  errors?: Record<string, string>;
};

export type ArchiveTodayResult = {
  eligible: boolean;
  attempted: boolean;
  mode: "apply" | "preview";
  bytes_archived: number;
  snapshot_candidates: number;
  result: "skipped" | "hit" | "miss";
  errors: string[];
};

export type RecoverOneResult = {
  recovered: boolean;
  metadata_recovered: boolean;
  metadata_result: "hit" | "miss";
  metadata_reason: null;
  title: string | null;
  body: string | null;
  url: string | null;
  bytes_archived: number;
  archive_today?: ArchiveTodayResult;
};

export type RecoveryProvider = {
  name: string;
  fetchPosts(ids: string[]): Promise<Record<string, NormalizedPost>>;
  fetchComments(ids: string[]): Promise<Record<string, NormalizedComment>>;
};

export type RecoveryOptions = {
  limit?: number;
  retry?: boolean;
  scope?: RecoveryScope;
  providers?: RecoveryProvider[];
  userAgent?: string;
  progress?: (message: string) => void;
};

export type RecoverOneOptions = {
  providers?: RecoveryProvider[];
  userAgent?: string;
  mediaProviders?: ArchiveTodayProvider[];
  fetchBytes?: typeof defaultFetch;
  applyBytes?: boolean;
};

export type ArchiveTodayMediaEligibility = {
  eligible: boolean;
  reason: string;
  metadata: Metadata;
  urls: string[];
};

type RecoveryRow = RawItem;

type RecoveryFields = NormalizedPost | NormalizedComment;

type RecoveryPatch = Partial<
  Pick<RawItem, "title" | "body" | "author" | "url" | "created_utc" | "hydrated_at">
> & { metadata?: Metadata };

type RecoveryOverlay = { item: RecoveryPatch; meaningful: boolean };

const JsonObjectSchema = z.record(z.string(), z.json());

type JsonObject = z.infer<typeof JsonObjectSchema>;

const ArchiveMediaFieldsSchema = z
  .object({
    media_url: z.string().optional().catch(undefined),
    media_salvage_url: z.string().optional().catch(undefined),
    media_status: z.string().optional().catch(undefined),
    media_type: z.string().optional().catch(undefined),
    gallery: z.array(z.string()).optional().catch(undefined),
    gallery_preview: z.array(z.string()).optional().catch(undefined),
    archived_media: JsonObjectSchema.optional().catch(undefined),
  })
  .catchall(z.json());

type ArchiveMediaFields = z.infer<typeof ArchiveMediaFieldsSchema>;

function archiveMediaFields(metadata: Metadata): ArchiveMediaFields {
  return ArchiveMediaFieldsSchema.parse(metadata);
}

function archivedMedia(metadata: Metadata): JsonObject {
  const parsed = JsonObjectSchema.safeParse(metadata.archived_media);

  return parsed.success ? parsed.data : {};
}

function whereFor(scope: RecoveryScope): string {
  if (scope === "all") return "source='reddit'";

  if (scope === "gallery_preview")
    return "source='reddit' AND json_extract(metadata, '$.gallery') IS NOT NULL AND json_extract(metadata, '$.gallery_preview') IS NULL";

  return targetWhere;
}

export function countTargets(
  database: Database,
  opts: { retry?: boolean; scope?: RecoveryScope } = {},
): number {
  const sql = `SELECT COUNT(*) AS count FROM items WHERE ${whereFor(opts.scope ?? "removed")}${opts.retry ? "" : " AND hydrated_at IS NULL"}`;

  return Number(database.query<{ count: number }, []>(sql).get()?.count ?? 0);
}

function selectTargets(
  database: Database,
  opts: { retry: boolean; limit?: number; scope: RecoveryScope },
): RecoveryRow[] {
  const sql = `SELECT * FROM items WHERE ${whereFor(opts.scope)}${opts.retry ? "" : " AND hydrated_at IS NULL"} ORDER BY last_seen_utc DESC${opts.limit ? " LIMIT ?" : ""}`;

  return opts.limit
    ? database.query<RecoveryRow, [number]>(sql).all(Math.trunc(opts.limit))
    : database.query<RecoveryRow, []>(sql).all();
}

function overlay(fields: RecoveryFields): RecoveryOverlay {
  const patch: RecoveryPatch = {};
  const metadata: Metadata = {};
  let meaningful = false;

  if ("title" in fields && fields.title && !placeholders.has(fields.title)) {
    patch.title = fields.title;
    meaningful = true;
  }

  if (fields.body && !placeholders.has(fields.body)) {
    patch.body = fields.body;
    meaningful = true;
  }

  if (fields.author && !placeholders.has(fields.author)) patch.author = fields.author;

  if ("url" in fields && fields.url && fields.media_type !== "reddit_video") patch.url = fields.url;

  if (
    fields.created_utc !== null &&
    fields.created_utc !== undefined &&
    fields.created_utc !== ""
  ) {
    const created = Number(fields.created_utc);

    if (Number.isFinite(created)) patch.created_utc = Math.trunc(created);
  }

  if (fields.subreddit) metadata.subreddit = fields.subreddit;

  if (fields.permalink) metadata.permalink = fields.permalink;

  if ("media_type" in fields && fields.media_type) metadata.media_type = fields.media_type;

  if ("media_url" in fields && fields.media_url) metadata.media_url = fields.media_url;

  if ("thumbnail" in fields && fields.thumbnail) metadata.thumbnail = fields.thumbnail;

  if ("gallery" in fields && fields.gallery.length) metadata.gallery = fields.gallery;

  if ("gallery_preview" in fields && fields.gallery_preview.length)
    metadata.gallery_preview = fields.gallery_preview;

  if (fields.score) metadata.score = fields.score;

  if ("over_18" in fields && fields.over_18) metadata.over_18 = 1;

  if (Object.keys(metadata).length) patch.metadata = metadata;

  return { item: patch, meaningful };
}

function collect(
  found: Record<string, RecoveryFields>,
  prefix: "t1_" | "t3_",
  byId: ReadonlyMap<string, RawItem>,
  recovered: Map<string, RecoveryPatch>,
): Set<string> {
  const done = new Set<string>();

  for (const [bareId, fields] of Object.entries(found)) {
    const sourceId = `${prefix}${bareId}`;
    const item = byId.get(sourceId);

    if (!item) continue;
    const result = overlay(fields);
    const previous = recovered.get(item.fullname);
    const patch: RecoveryPatch = { ...previous, ...result.item };
    const metadata: Metadata = { ...previous?.metadata };

    if (result.item.metadata) Object.assign(metadata, result.item.metadata);

    if (Object.keys(metadata).length) patch.metadata = metadata;
    recovered.set(item.fullname, patch);
    done.add(bareId);
  }

  return done;
}

export async function recover(
  database: Database,
  opts: RecoveryOptions = {},
): Promise<RecoveryResult> {
  const retry = opts.retry ?? false;
  const scope = opts.scope ?? "removed";
  const targets = selectTargets(database, { retry, scope, limit: opts.limit });

  if (!targets.length) return { selected: 0, recovered: 0, missed: 0, by_provider: {} };
  const providers = opts.providers ?? defaultProviders(opts.userAgent ?? DEFAULT_USER_AGENT);
  const byId = new Map<string, RawItem>();
  const postIds = new Set<string>();
  const commentIds = new Set<string>();

  for (const item of targets) {
    byId.set(item.source_id, item);

    if (item.source_id.startsWith("t3_")) postIds.add(item.source_id.slice(3));

    if (item.source_id.startsWith("t1_")) commentIds.add(item.source_id.slice(3));
  }

  const recovered = new Map<string, RecoveryPatch>();
  const byProvider: Record<string, number> = {};
  const errors: Record<string, string> = {};

  for (const provider of providers) {
    let recoveredCount = 0;

    if (postIds.size) {
      try {
        const done = collect(
          await provider.fetchPosts([...postIds].sort()),
          "t3_",
          byId,
          recovered,
        );

        for (const id of done) postIds.delete(id);
        recoveredCount += done.size;
      } catch (error) {
        if (!(error instanceof ArchiveError)) throw error;
        errors[provider.name] = error.message;
      }
    }

    if (commentIds.size) {
      try {
        const done = collect(
          await provider.fetchComments([...commentIds].sort()),
          "t1_",
          byId,
          recovered,
        );

        for (const id of done) commentIds.delete(id);
        recoveredCount += done.size;
      } catch (error) {
        if (!(error instanceof ArchiveError)) throw error;
        errors[provider.name] = error.message;
      }
    }

    if (recoveredCount)
      byProvider[provider.name] = (byProvider[provider.name] ?? 0) + recoveredCount;
    opts.progress?.(`  ${provider.name}: ${recovered.size}/${targets.length} recovered`);

    if (!postIds.size && !commentIds.size) break;
  }

  const now = Math.floor(Date.now() / 1000);
  db.withTransaction(database, () => {
    for (const item of targets) {
      const patch: RecoveryPatch = { hydrated_at: now };
      const fields = recovered.get(item.fullname);

      if (fields) Object.assign(patch, fields);
      db.patchItem(database, item.fullname, patch);
    }
  });

  const result: RecoveryResult = {
    selected: targets.length,
    recovered: recovered.size,
    missed: postIds.size + commentIds.size,
    by_provider: byProvider,
  };

  if (Object.keys(errors).length) result.errors = errors;

  return result;
}

function imageUrls(metadata: Metadata): string[] {
  const media = archiveMediaFields(metadata);
  const direct = media.media_url?.startsWith("http") ? [media.media_url] : [];
  const gallery = media.gallery?.filter((url) => url.startsWith("http")) ?? [];

  return [...new Set([...direct, ...gallery])];
}

export function archiveTodayMediaEligibility(item: RawItem | null): ArchiveTodayMediaEligibility {
  if (!item) return { eligible: false, reason: "not_found", metadata: {}, urls: [] };

  if (item.source !== "reddit")
    return { eligible: false, reason: "non_reddit", metadata: {}, urls: [] };
  const metadata = parseMetadata(item.metadata);

  if (metadata.media_status !== "gone")
    return { eligible: false, reason: "media_not_gone", metadata, urls: [] };

  if (metadata.archived_media)
    return { eligible: false, reason: "already_archived", metadata, urls: [] };
  const urls = imageUrls(metadata);

  if (!urls.length) return { eligible: false, reason: "missing_media_url", metadata, urls };

  return { eligible: true, reason: "eligible", metadata, urls };
}

async function recoverArchiveMedia(
  database: Database,
  item: RawItem,
  providers: ArchiveTodayProvider[],
  opts: { applyBytes: boolean; fetchBytes: typeof defaultFetch },
): Promise<number> {
  const metadata = parseMetadata(item.metadata);

  if (metadata.media_status !== "gone") return 0;
  const archived = archivedMedia(metadata);

  let added = 0;

  for (const provider of providers) {
    let candidates;

    try {
      candidates = await provider.recoverMedia({ metadata: JSON.stringify(metadata) });
    } catch {
      continue;
    }

    for (const candidate of candidates) {
      if (candidate.url in archived) continue;

      if (!opts.applyBytes) {
        added++;
        continue;
      }

      const [bytes, mime] = await opts.fetchBytes(candidate.url);

      if (!bytes) continue;
      archived[candidate.url] = mediaStore.store(bytes, { mime, url: candidate.url });
      added++;
    }

    if (added) break;
  }

  if (added && opts.applyBytes) {
    const fresh = db.getItem(database, item.fullname);

    if (!fresh) return 0;
    const current = parseMetadata(fresh.metadata);
    current.archived_media = { ...archivedMedia(current), ...archived };
    current.media_status = "recovered_archive_today";
    db.patchItem(database, item.fullname, { metadata: current });
  }

  return added;
}

export async function archiveTodayRecoverMedia(
  database: Database,
  fullname: string,
  opts: {
    providers: ArchiveTodayProvider[];
    fetchBytes?: typeof defaultFetch;
    applyBytes?: boolean;
  },
): Promise<ArchiveTodayResult> {
  const item = db.getItem(database, fullname);
  const eligibility = archiveTodayMediaEligibility(item);
  const applyBytes = opts.applyBytes ?? false;

  const result: ArchiveTodayResult = {
    eligible: eligibility.eligible,
    attempted: false,
    mode: applyBytes ? "apply" : "preview",
    bytes_archived: 0,
    snapshot_candidates: 0,
    result: eligibility.eligible ? "miss" : "skipped",
    errors: eligibility.eligible ? [] : [eligibility.reason],
  };

  if (!eligibility.eligible || !item) return result;
  const before = Object.keys(archivedMedia(eligibility.metadata)).length;

  const count = await recoverArchiveMedia(database, item, opts.providers, {
    applyBytes,
    fetchBytes: opts.fetchBytes ?? defaultFetch,
  });

  result.attempted = true;

  if (applyBytes) {
    const fresh = db.getItem(database, fullname);
    const freshMetadata = parseMetadata(fresh?.metadata);
    const after = Object.keys(archivedMedia(freshMetadata)).length;
    result.bytes_archived = Math.max(after - before, count);
    result.result = result.bytes_archived ? "hit" : "miss";
  } else {
    result.snapshot_candidates = count;
    result.result = count ? "hit" : "miss";
  }

  return result;
}

export async function recoverOne(
  database: Database,
  fullname: string,
  opts: RecoverOneOptions = {},
): Promise<RecoverOneResult | null> {
  const item = db.getItem(database, fullname);

  if (!item || item.source !== "reddit" || !/^(t1_|t3_)/.test(item.source_id)) return null;
  const sourceId = item.source_id;
  const prefix = sourceId.startsWith("t3_") ? "t3_" : "t1_";

  const providers =
    opts.providers ?? defaultProviders(opts.userAgent ?? DEFAULT_USER_AGENT, { throttle: false });

  const recovered = new Map<string, RecoveryPatch>();
  const byId = new Map([[sourceId, item]]);

  for (const provider of providers) {
    try {
      const done =
        prefix === "t3_"
          ? collect(await provider.fetchPosts([sourceId.slice(3)]), prefix, byId, recovered)
          : collect(await provider.fetchComments([sourceId.slice(3)]), prefix, byId, recovered);

      if (done.size) break;
    } catch (error) {
      if (!(error instanceof ArchiveError)) throw error;
    }
  }

  const recoveryPatch: RecoveryPatch = { hydrated_at: Math.floor(Date.now() / 1000) };
  const recoveredFields = recovered.get(fullname);

  if (recoveredFields) Object.assign(recoveryPatch, recoveredFields);
  db.patchItem(database, fullname, recoveryPatch);
  let archiveToday: ArchiveTodayResult | undefined;

  if (opts.mediaProviders)
    archiveToday = await archiveTodayRecoverMedia(database, fullname, {
      providers: opts.mediaProviders,
      fetchBytes: opts.fetchBytes,
      applyBytes: opts.applyBytes ?? true,
    });
  const fresh = db.getItem(database, fullname);
  const metadataRecovered = recovered.size > 0;

  const bytesArchived = archiveToday
    ? opts.applyBytes === false
      ? archiveToday.snapshot_candidates
      : archiveToday.bytes_archived
    : 0;

  const result: RecoverOneResult = {
    recovered: metadataRecovered || Boolean(bytesArchived),
    metadata_recovered: metadataRecovered,
    metadata_result: metadataRecovered ? "hit" : "miss",
    metadata_reason: null,
    title: fresh?.title ?? null,
    body: fresh?.body ?? null,
    url: fresh?.url ?? null,
    bytes_archived: bytesArchived,
  };

  if (archiveToday) result.archive_today = archiveToday;

  return result;
}

export { defaultMediaProviders };
