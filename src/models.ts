import * as z from "zod";

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

export type ItemStatus = (typeof VALID_STATUSES)[number];

export const NSFW_TAGS = ["nsfw_erotic", "nsfw_other", "nsfw_talk"] as const;

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

export type Promotion = z.infer<typeof _PromotionSchema>;

const _optionalString = z.string().optional().catch(undefined);

const _optionalNumberOrBoolean = z.union([z.number(), z.boolean()]).optional().catch(undefined);

const _optionalNumber = z.number().optional().catch(undefined);

const _optionalStrings = z.array(z.string()).optional().catch(undefined);

const _optionalPromotedBy = z.enum(["consolidate", "note_youtube"]).optional().catch(undefined);

export const LlmSuggestionSchema = z.object({
  verdict: z.enum(["keep", "skip"]),
  reason: z.string().max(200),
  tags: z.array(z.string()).optional().default([]),
  model: z.string().optional(),
  at: z.number().optional(),
});

export type LlmSuggestion = z.infer<typeof LlmSuggestionSchema>;

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
    reddit_export_thin: _optionalNumber,
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

export type Metadata = z.infer<typeof MetadataSchema>;

export const ItemSchema = _ItemCoreSchema.extend({
  metadata: MetadataSchema,
  raw_json: z.string(),
});

export type Item = z.infer<typeof ItemSchema>;

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

export function copyMetadata(value: Metadata | null | undefined): Metadata {
  return value === null || value === undefined ? {} : { ...value };
}

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

const SCRIPT_URL = /^\s*(javascript|data|vbscript):/i;

export function newItem(input: NewItemInput): RawItem {
  const ts = input.now ?? Math.floor(Date.now() / 1000);

  const md: Metadata =
    input.metadata === null || input.metadata === undefined ? {} : { ...input.metadata };

  const isSaved = input.is_saved === undefined ? 1 : input.is_saved;
  const status = VALID_STATUSES.find((candidate) => candidate === input.status) ?? "inbox";

  const item: RawItem = {
    fullname: `${input.source}:${input.source_id}`,
    source: input.source,
    source_id: String(input.source_id),
    kind: input.kind || "item",
    title: (input.title || "").trim(),
    body: input.body || "",
    url: SCRIPT_URL.test(input.url || "") ? "" : (input.url || "").trim(),
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
