import type { Database } from "bun:sqlite";
import * as z from "zod";
import { HttpError, request } from "./_http";
import { parseMetadata, type Metadata } from "./models";

export const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36";

const imagePattern = /\.(png|jpe?g|gif|webp|bmp)(\?|#|$)/i;

const deadCodes = new Set([403, 404, 410]);

type Target = { fullname: string; best: string; preview: string; tags: string[] };

type Classified = {
  fullname: string;
  status: "alive" | "salvageable" | "gone" | "unknown";
  liveUrl: string | null;
  tags: string[];
};

type ScanRow = { fullname: string; status: string; url: string; metadata: string };

export type ScanResult = {
  scanned: number;
  alive: number;
  salvageable: number;
  gone: number;
  unknown: number;
  applied: boolean;
  status_filter: string | null;
  salvageable_items: Array<{ fullname: string; live_url: string }>;
};

const MediaScanMetadataSchema = z
  .object({
    media_url: z.string().optional().catch(undefined),
    thumbnail: z.string().optional().catch(undefined),
    gallery: z.array(z.string()).optional().catch(undefined),
    tags: z.array(z.string()).optional().catch(undefined),
  })
  .catchall(z.json());

type MediaScanMetadata = z.infer<typeof MediaScanMetadataSchema>;

function directImage(url: string): boolean {
  return Boolean(url) && (imagePattern.test(url) || url.includes("i.redd.it"));
}

function isMedia(metadata: MediaScanMetadata, url: string): boolean {
  if (metadata.media_type === "image" || metadata.media_type === "gallery") return true;

  if (metadata.gallery?.length) return true;

  return url.includes("/gallery/") || directImage(url) || directImage(metadata.media_url ?? "");
}

function chooseImage(metadata: MediaScanMetadata, url: string): [string, string] {
  const gallery = metadata.gallery ?? [];
  const mediaUrl = metadata.media_url ?? "";

  let best =
    gallery[0] ??
    (directImage(url)
      ? url
      : directImage(mediaUrl)
        ? mediaUrl
        : metadata.media_type === "image"
          ? mediaUrl
          : "");

  let preview = metadata.thumbnail?.includes("redd.it") ? metadata.thumbnail : "";

  if (!best) {
    best = preview;
    preview = "";
  }

  return [best, preview];
}

export async function defaultProbe(url: string): Promise<number> {
  try {
    const [status] = await request(url, {
      method: "HEAD",
      headers: { "User-Agent": UA },
      timeout: 15_000,
    });

    return status;
  } catch (error) {
    return error instanceof HttpError && error.kind === "http" && error.status !== null
      ? error.status
      : -1;
  }
}

async function classify(
  target: Target,
  probe: (url: string) => number | Promise<number>,
): Promise<Classified> {
  const code = await probe(target.best);

  if (code === 200 || code === 206)
    return { fullname: target.fullname, status: "alive", liveUrl: null, tags: target.tags };

  if (deadCodes.has(code)) {
    if (target.preview && target.preview !== target.best && (await probe(target.preview)) === 200)
      return {
        fullname: target.fullname,
        status: "salvageable",
        liveUrl: target.preview,
        tags: target.tags,
      };

    return { fullname: target.fullname, status: "gone", liveUrl: null, tags: target.tags };
  }

  return { fullname: target.fullname, status: "unknown", liveUrl: null, tags: target.tags };
}

export async function scanMedia(
  database: Database,
  opts: {
    status?: string;
    limit?: number;
    recheck?: boolean;
    apply?: boolean;
    workers?: number;
    batch?: number;
    probe?: (url: string) => number | Promise<number>;
    progress?: (message: string) => void;
  } = {},
): Promise<ScanResult> {
  const statusFilter = opts.status ?? null;
  const conditions = ["source='reddit'"];
  const params: string[] = [];

  if (statusFilter) {
    conditions.push("status=?");
    params.push(statusFilter);
  }

  const rows = database
    .query<ScanRow, string[]>(
      `SELECT fullname,status,url,metadata FROM items WHERE ${conditions.join(" AND ")}`,
    )
    .all(...params);

  const targets: Target[] = [];

  for (const row of rows) {
    const metadata = parseMetadata(row.metadata);
    const media = MediaScanMetadataSchema.parse(metadata);

    if (!isMedia(media, row.url) || (!opts.recheck && metadata.media_status)) continue;
    const [best, preview] = chooseImage(media, row.url);

    if (!best) continue;
    targets.push({ fullname: row.fullname, best, preview, tags: media.tags ?? [] });
  }

  if (opts.limit) targets.length = Math.min(targets.length, Math.max(0, Math.trunc(opts.limit)));
  const counts = { alive: 0, salvageable: 0, gone: 0, unknown: 0 };
  const salvageableItems: Array<{ fullname: string; live_url: string }> = [];
  const batchSize = Math.max(1, Math.trunc(opts.batch ?? 200));
  const workers = Math.max(1, Math.trunc(opts.workers ?? 10));

  for (let start = 0; start < targets.length; start += batchSize) {
    const batch = targets.slice(start, start + batchSize);

    for (let workerStart = 0; workerStart < batch.length; workerStart += workers) {
      const results = await Promise.all(
        batch
          .slice(workerStart, workerStart + workers)
          .map((target) => classify(target, opts.probe ?? defaultProbe)),
      );

      for (const result of results) {
        counts[result.status]++;

        if (result.status === "salvageable" && result.liveUrl)
          salvageableItems.push({ fullname: result.fullname, live_url: result.liveUrl });

        if (opts.apply && (result.status === "gone" || result.status === "salvageable")) {
          const patch: Metadata = { media_status: result.status };

          if (result.status === "salvageable" && result.liveUrl)
            patch.media_salvage_url = result.liveUrl;

          if (result.status === "gone" && !result.tags.includes("deleted"))
            patch.tags = [...result.tags, "deleted"];
          database
            .query("UPDATE items SET metadata=json_patch(metadata, ?) WHERE fullname=?")
            .run(JSON.stringify(patch), result.fullname);
        }
      }
    }

    opts.progress?.(
      `  ...${Math.min(start + batch.length, targets.length)}/${targets.length}  alive=${counts.alive} salvage=${counts.salvageable} gone=${counts.gone} unknown=${counts.unknown}`,
    );
  }

  return {
    scanned: targets.length,
    ...counts,
    applied: opts.apply ?? false,
    status_filter: statusFilter,
    salvageable_items: salvageableItems,
  };
}
