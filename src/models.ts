/**
 * Item normalization — the single place an item is shaped.
 *
 * Every connector yields objects produced by `newItem`. The DB
 * layer and the pipeline rely on this exact shape (`ITEM_FIELDS`).
 */

import * as z from "zod";

/** Full, ordered list of columns in the `items` table. Keep in sync with db.ts. */
export const ITEM_FIELDS = [
  "fullname",
  "source",
  "source_id",
  "kind",
  "title",
  "body",
  "url",
  "author",
  "created_utc",
  "saved_utc",
  "is_saved",
  "first_seen_utc",
  "last_seen_utc",
  "hydrated_at",
  "status",
  "processed_utc",
  "status_prev",
  "search_text",
  "metadata",
  "raw_json",
] as const;

export const VALID_STATUSES = ["inbox", "keep", "archived", "done"] as const;

/** Status domain — the only values `status` may take. */
export type ItemStatus = (typeof VALID_STATUSES)[number];

// The NSFW tag buckets (subreddit-driven; see categorize.ts). Canonical here so the
// query layer (db.searchItems) and the search-bar parser share one source of truth.
export const NSFW_TAGS = ["nsfw_erotic", "nsfw_other", "nsfw_talk"] as const;

// Metadata keys that are worth folding into the full-text search blob.
const _META_SEARCH_KEYS = [
  "subreddit",
  "channel",
  "tags",
  "labels",
  "playlist",
  "domain",
  "ocr_text",
] as const;

const _ItemCoreSchema = z.object({
  fullname: z.string(),
  source: z.string(),
  source_id: z.string(),
  kind: z.string(),
  title: z.string(),
  body: z.string(),
  url: z.string(),
  author: z.string(),
  created_utc: z.number(),
  saved_utc: z.number(),
  is_saved: z.union([z.literal(0), z.literal(1)]),
  first_seen_utc: z.number(),
  last_seen_utc: z.number(),
  hydrated_at: z.number().nullable(),
  status: z.enum(VALID_STATUSES),
  processed_utc: z.number().nullable(),
  status_prev: z.enum(VALID_STATUSES).nullable(),
  search_text: z.string(),
});

export type ItemCore = z.infer<typeof _ItemCoreSchema>;

/** SQLite item row: metadata and raw_json are stored as text. */
export const RawItemSchema = _ItemCoreSchema.extend({
  metadata: z.string(),
  raw_json: z.string(),
});

export type RawItem = z.infer<typeof RawItemSchema>;

const _JsonValueSchema = z.json();

export type JsonValue = z.infer<typeof _JsonValueSchema>;

const _PromotionReceiptSchema = z
  .object({
    id: z.string(),
    result: z.string(),
    occurred_at: z.string(),
    human_summary: z.string(),
  })
  .catchall(_JsonValueSchema);

/** PKMS promote receipt (private #2): the four consumed fields. */
export type PromotionReceipt = z.infer<typeof _PromotionReceiptSchema>;

const _PromotionSchema = z
  .object({
    status: z.string(),
    transport: z.string(),
    receipt: _PromotionReceiptSchema.optional().catch(undefined),
    response: z.string().optional().catch(undefined),
    delivery_ref: z.string().optional().catch(undefined),
    error: z.string().optional().catch(undefined),
  })
  .catchall(_JsonValueSchema);

/** PKMS promotion record stamped into `metadata.promotion`. */
export type Promotion = z.infer<typeof _PromotionSchema>;

const _optionalString = z.string().optional().catch(undefined);

const _optionalNumberOrBoolean = z.union([z.number(), z.boolean()]).optional().catch(undefined);

const _optionalNumber = z.number().optional().catch(undefined);

const _optionalStrings = z.array(z.string()).optional().catch(undefined);

const _optionalPromotedBy = z.enum(["consolidate", "note_youtube"]).optional().catch(undefined);

const _CompanionSchema = z
  .object({
    source: z.string(),
    kind: z.string(),
    fullname: z.string(),
    permalink: _optionalString,
    url: _optionalString,
  })
  .catchall(_JsonValueSchema);

export const MetadataSchema = z
  .object({
    subreddit: _optionalString,
    channel: _optionalString,
    tags: _optionalStrings,
    tags_manual: _optionalStrings,
    tags_auto: _optionalStrings,
    labels: _optionalStrings,
    playlist: _optionalString,
    domain: _optionalString,
    ocr_text: _optionalString,
    score: _optionalNumber,
    over_18: _optionalNumberOrBoolean,
    duration: _optionalNumber,
    position: _optionalNumber,
    permalink: _optionalString,
    num_comments: _optionalNumber,
    media_type: _optionalString,
    media_status: _optionalString,
    category: _optionalString,
    folder: _optionalString,
    snoozed_until: _optionalNumber,
    snoozed_wave: _optionalNumber,
    snooze_count: _optionalNumber,
    decayed_at: _optionalNumber,
    decay_label: _optionalString,
    karakeep_id: _optionalString,
    saved_seen_utc: _optionalNumber,
    body_edited_at: _optionalNumber,
    triage_score: _optionalNumber,
    triage_why: _optionalStrings,
    dup_group: _optionalString,
    dup_count: _optionalNumber,
    dedup_of: _optionalString,
    open_in_firefox: _optionalNumberOrBoolean,
    consolidated_into: _optionalString,
    thumbnail: _optionalString,
    gallery: _optionalStrings,
    gallery_preview: _optionalStrings,
    description: _optionalString,
    selftext: _optionalString,
    text: _optionalString,
    keywords: _optionalStrings,
    view_count: _optionalNumber,
    promotion: _PromotionSchema.optional().catch(undefined),
    promoted_by: _optionalPromotedBy,
    title_source: _optionalString,
    companions: z.array(_CompanionSchema).optional().catch(undefined),
    promoted_to: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .catch(undefined),
    promoted_to_by: _optionalString,
    urls: _optionalStrings,
    outlinks: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .catch(undefined),
  })
  .catchall(_JsonValueSchema);

/**
 * Known source/user metadata plus validated JSON-valued extension keys.
 * Catchall preserves connector facts without laundering them as `unknown`.
 */
export type Metadata = z.infer<typeof MetadataSchema>;

/** Item as served to API consumers: metadata is parsed and schema-checked. */
export const ItemSchema = _ItemCoreSchema.extend({
  metadata: MetadataSchema,
  raw_json: z.string(),
});

export type Item = z.infer<typeof ItemSchema>;

/** Parse stored JSON or an already-parsed metadata object with its schema. */
export function parseMetadata(value: Metadata | string | null | undefined): Metadata {
  if (value === null || value === undefined) return {};
  const objectResult = MetadataSchema.safeParse(value);

  if (objectResult.success) return objectResult.data;
  const stringResult = z.string().safeParse(value);

  if (!stringResult.success || !stringResult.data.trim()) return {};

  try {
    const decoded = MetadataSchema.safeParse(JSON.parse(stringResult.data));

    return decoded.success ? decoded.data : {};
  } catch {
    return {};
  }
}

/** Copy a parsed metadata object (the dict-input half of the old parse_metadata). */
export function copyMetadata(value: Metadata | null | undefined): Metadata {
  return value === null || value === undefined ? {} : { ...value };
}

/** Compose the denormalized search blob from item fields + key metadata. */
export function buildSearchText(
  item: Pick<ItemCore, "title" | "body" | "author">,
  metadata?: Metadata | null,
): string {
  const md = metadata ?? {};
  const parts: string[] = [item.title || "", item.body || "", item.author || ""];

  for (const key of _META_SEARCH_KEYS) {
    const val = md[key];

    if (!val) {
      continue;
    }

    if (Array.isArray(val)) {
      parts.push(val.map((x) => String(x)).join(" "));
    } else {
      parts.push(String(val));
    }
  }

  return parts
    .filter((p) => p)
    .join(" ")
    .trim();
}

/** Input for `newItem` — mirrors the Python `new_item` kwargs. */
export interface NewItemInput {
  source: string;
  source_id: string | number;
  kind?: string;
  title?: string;
  body?: string;
  url?: string;
  author?: string;
  created_utc?: number;
  saved_utc?: number;
  is_saved?: number | boolean;
  hydrated_at?: number | null;
  status?: string;
  metadata?: Metadata | null;
  raw?: JsonValue;
  now?: number | null;
}

/**
 * Build a fully-formed, DB-ready item. `fullname` is the global
 * dedup key `"<source>:<source_id>"`. `metadata` is JSON-encoded;
 * `search_text` is computed. `now` allows deterministic tests.
 */
export function newItem(input: NewItemInput): RawItem {
  const ts = input.now ?? Math.floor(Date.now() / 1000);

  const md: Metadata =
    input.metadata === null || input.metadata === undefined ? {} : { ...input.metadata };

  // Python default is `is_saved=1` (truthy): an omitted flag keeps the
  // item saved; only an explicit false/0 un-saves.
  const isSaved = input.is_saved === undefined ? 1 : input.is_saved;
  const status = VALID_STATUSES.find((candidate) => candidate === input.status) ?? "inbox";

  const item: RawItem = {
    fullname: `${input.source}:${input.source_id}`,
    source: input.source,
    source_id: String(input.source_id),
    kind: input.kind || "item",
    title: (input.title || "").trim(),
    body: input.body || "",
    url: (input.url || "").trim(),
    author: (input.author || "").trim(),
    created_utc: Math.trunc(input.created_utc || 0),
    saved_utc: Math.trunc(input.saved_utc || 0),
    is_saved: isSaved ? 1 : 0,
    first_seen_utc: ts,
    last_seen_utc: ts,
    hydrated_at: input.hydrated_at ?? null,
    status,
    processed_utc: null,
    status_prev: null,
    metadata: JSON.stringify(md),
    raw_json: input.raw === undefined || input.raw === null ? "" : JSON.stringify(input.raw),
    search_text: "",
  };

  item.search_text = buildSearchText(item, md);

  return item;
}
