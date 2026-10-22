import { z } from "zod";

export const RetentionBody = z.object({
  retention_days: z
    .union([z.number(), z.string()])
    .transform((value) => Number(value))
    .pipe(z.number().int().min(1).max(3650)),
});

export const SearchCountSchema = z.object({ total: z.number() });

export const QueueStateSchema = z.object({ state: z.string() });

export const PriorStatusSchema = z.object({ status: z.string(), state: z.string().nullable() });

export const PurgeVictimSchema = z.object({
  fullname: z.string(),
  source: z.string(),
  title: z.string(),
});

export const ExistingCountSchema = z.object({ count: z.number() });

export const HydrateResponseSchema = z.object({
  status: z.enum([
    "hydrated",
    "archived",
    "cached",
    "no_gallery",
    "not_found",
    "bad_shape",
    "auth_missing",
    "auth_expired",
    "network_error",
    "no_permalink",
    "unavailable",
  ]),
});

export const ItemStatusBody = z.object({ status: z.string() });

export const SnoozeBody = z.object({
  window_days: z.union([z.number(), z.string()]).optional(),
  until_utc: z.union([z.number(), z.string()]).optional(),
  escalate_after: z.union([z.number(), z.string()]).optional(),
});

export const BodyTextRequest = z.object({ body: z.string() });

export const CategoryBody = z.object({ category: z.string() });

export const TagBody = z.object({
  add: z.array(z.string()).optional(),
  remove: z.array(z.string()).optional(),
  tag: z.string().optional(),
});

export const RecoveryBody = z.object({
  fullnames: z.array(z.string()).optional(),
  bulk: z.boolean().optional(),
  archive_today: z.enum(["off", "preview", "apply"]).optional(),
  metadata: z.boolean().optional(),
  confirm_external_archive_today: z.boolean().optional(),
});

export const FolderBody = z.object({ folder: z.string().nullable().optional() });

export const SnoozeUndoBody = z.object({
  snoozed_wave: z.number().optional(),
  decayed_at: z.number().optional(),
});

export const ClusterBody = z.object({ cluster: z.string() });

export const ClusterUndoBody = ClusterBody.extend({ decayed_at: z.number() });

export const DuplicateResolveBody = z.object({ keep: z.string(), archive: z.array(z.string()) });

export const DuplicateUndoBody = z.object({ fullnames: z.array(z.string()).min(1) });

export const TagFilterBody = z.object({ tag: z.string().optional() });

export const CreateFolderBody = z.object({
  name: z.string(),
  description: z.string().optional(),
  query_def: z
    .object({
      source: z.string().optional(),
      status: z.string().optional(),
      subreddit: z.string().optional(),
      kind: z.string().optional(),
      has: z.string().optional(),
      q: z.string().optional(),
      tag: z.union([z.string(), z.array(z.string())]).optional(),
      tags_all: z.boolean().optional(),
    })
    .nullable()
    .optional(),
});

export const RenameFolderBody = z.object({ name: z.string() });

export const EvaluateFoldersBody = z.object({
  folder_id: z.union([z.number(), z.string()]).optional(),
});

export const EnabledBody = z.object({ enabled: z.boolean() });

export const CookieBody = z.object({ cookie: z.string() });

export const RedditSyncBody = z.object({
  full: z.boolean().optional(),
  max_pages: z.union([z.number(), z.string()]).optional(),
});

export const PurgeBody = z.object({
  expected_total: z.union([z.number(), z.string()]),
  expected_cutoff: z.union([z.number(), z.string()]),
});

export const DrainBody = z.object({
  max: z.union([z.number(), z.string()]).optional(),
  limit: z.union([z.number(), z.string()]).optional(),
  live: z.boolean().optional(),
  confirm: z.boolean().optional(),
  yes: z.boolean().optional(),
});

export const EnqueueTagBody = z.object({
  tag: z.string(),
  apply: z.boolean().optional(),
  confirm: z.boolean().optional(),
  yes: z.boolean().optional(),
});

export const PrepareImportBody = z.object({
  url: z.string().optional(),
  source: z.string().optional(),
});

export const CommitImportBody = z.object({ token: z.string().optional() });
