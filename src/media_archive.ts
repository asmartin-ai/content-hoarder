import type { Database } from "bun:sqlite";
import * as z from "zod";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { HttpError, request, safeFetchUrl } from "./_http";
import { withTransaction } from "./db";
import * as mediaStore from "./media_store";
import { parseMetadata, type JsonValue, type Metadata } from "./models";

export const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36";

export const DEFAULT_MAX_BYTES = 15 * 1024 * 1024;

export const DEFAULT_MAX_VIDEO_BYTES = 512 * 1024 * 1024;

export const DEFAULT_VIDEO_TIMEOUT = 15 * 60;

export const DEFAULT_THROTTLE_SECONDS = 0.3;

export const SCOPES = ["salvageable", "galleries", "images", "twitter", "videos"] as const;

export type MediaScope = (typeof SCOPES)[number];

type ArchiveRow = { fullname: string; url: string; metadata: string };

export type VideoCandidate = {
  fullname: string;
  kind: "reddit_video";
  video_id: string;
  canonical_url: string;
  source_url: string;
  media_url: string;
  archive_keys: string[];
  has_audio: boolean | null;
  is_gif: boolean | null;
  duration: number | null;
  width: number | null;
  height: number | null;
};

export type VideoDownloadInfo = {
  mime: string;
  downloader: string;
  container: string;
  has_audio: boolean;
};

export type ArchiveResult = {
  items: number;
  urls: number;
  archived: number;
  skipped: number;
  failed: number;
  bytes: number;
  applied: boolean;
  by_scope: Partial<
    Record<MediaScope, { items: number; archived: number; failed: number; skipped: number }>
  >;
  fail_reasons: Record<string, number>;
};

const JsonObjectSchema = z.record(z.string(), z.json());

const MediaArchiveMetadataSchema = z
  .object({
    media_salvage_url: z.string().optional().catch(undefined),
    media_url: z.string().optional().catch(undefined),
    media_status: z.string().optional().catch(undefined),
    gallery_preview: z.array(z.string()).optional().catch(undefined),
    media_urls: z.array(z.string()).optional().catch(undefined),
    reddit_video: z
      .object({
        fallback_url: z.string().optional().catch(undefined),
        hls_url: z.string().optional().catch(undefined),
        dash_url: z.string().optional().catch(undefined),
        has_audio: z.boolean().nullable().optional().catch(undefined),
        is_gif: z.boolean().nullable().optional().catch(undefined),
        duration: z.number().nullable().optional().catch(undefined),
        width: z.number().nullable().optional().catch(undefined),
        height: z.number().nullable().optional().catch(undefined),
      })
      .catchall(z.json())
      .optional()
      .catch(undefined),
  })
  .catchall(z.json());

const VideoDownloadInfoSchema = z.object({
  mime: z.string(),
  downloader: z.string(),
  container: z.string(),
  has_audio: z.boolean(),
});

const imagePattern = /\.(png|jpe?g|gif|webp|bmp)(\?|#|$)/i;

const videoPattern = /\.(mp4|webm|mov)(\?|#|$)/i;

const redditIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function isImage(url: string): boolean {
  return Boolean(url) && (imagePattern.test(url) || url.includes("i.redd.it"));
}

function isTwitterImage(url: string): boolean {
  return url.includes("pbs.twimg.com/media/") && isImage(url);
}

function isTwitterMedia(url: string): boolean {
  return isTwitterImage(url) || (url.includes("video.twimg.com/") && videoPattern.test(url));
}

export function redditVideoId(url: string): string | null {
  try {
    const parsed = new URL(url);

    if (parsed.hostname !== "v.redd.it") return null;
    const id = parsed.pathname.split("/").filter(Boolean)[0] ?? "";

    return redditIdPattern.test(id) ? id : null;
  } catch {
    return null;
  }
}

export function isVredditUrl(url: string): boolean {
  return redditVideoId(url) !== null;
}

export function canonicalVredditUrl(url: string): string | null {
  const id = redditVideoId(url);

  return id ? `https://v.redd.it/${id}` : null;
}

export async function defaultFetch(
  url: string,
  maxBytes = DEFAULT_MAX_BYTES,
): Promise<[Uint8Array | null, string]> {
  const [allowed, reason] = safeFetchUrl(url);

  if (!allowed) return [null, `blocked_${reason}`];

  try {
    const [, headers, bytes] = await request(url, {
      method: "GET",
      headers: { "User-Agent": UA },
      timeout: 30_000,
      maxResponseBytes: maxBytes,
    });

    return [bytes, headers["content-type"] ?? ""];
  } catch (error) {
    if (error instanceof HttpError && error.kind === "size") return [null, "too_large"];

    return [
      null,
      error instanceof HttpError && error.status !== null ? `http_${error.status}` : "error",
    ];
  }
}

function urlsFor(metadata: Metadata, scope: MediaScope): string[] {
  const fields = MediaArchiveMetadataSchema.parse(metadata);
  let urls: string[] = [];

  if (scope === "salvageable" && fields.media_salvage_url) urls = [fields.media_salvage_url];

  if (scope === "galleries") urls = (fields.gallery_preview ?? []).filter((url) => url.length > 0);

  if (
    scope === "images" &&
    fields.media_url &&
    isImage(fields.media_url) &&
    fields.media_status !== "gone"
  )
    urls = [fields.media_url];

  if (scope === "twitter") urls = (fields.media_urls ?? []).filter(isTwitterMedia);

  return [...new Set(urls)];
}

function videoCandidate(
  fullname: string,
  itemUrl: string,
  metadata: Metadata,
): VideoCandidate | null {
  const fields = MediaArchiveMetadataSchema.parse(metadata);
  const redditVideo = fields.reddit_video ?? {};
  const mediaUrl = fields.media_url ?? "";
  const evidence: string[] = [];

  for (const url of [
    mediaUrl,
    redditVideo.fallback_url,
    redditVideo.hls_url,
    redditVideo.dash_url,
    itemUrl,
  ]) {
    if (url) evidence.push(url);
  }

  const source = evidence.find((url) => redditVideoId(url));

  if (!source) return null;
  const canonical = canonicalVredditUrl(source);
  const videoId = redditVideoId(source);

  if (!canonical || !videoId) return null;
  const primary = redditVideoId(mediaUrl) ? mediaUrl : canonical;
  const sourceUrl = itemUrl.toLowerCase().includes("reddit.com") ? itemUrl : mediaUrl || canonical;
  const archiveKeys = [...new Set([primary, canonical])];

  return {
    fullname,
    kind: "reddit_video",
    video_id: videoId,
    canonical_url: canonical,
    source_url: sourceUrl,
    media_url: mediaUrl,
    archive_keys: archiveKeys,
    has_audio: redditVideo.has_audio ?? null,
    is_gif: redditVideo.is_gif ?? null,
    duration: redditVideo.duration ?? null,
    width: redditVideo.width ?? null,
    height: redditVideo.height ?? null,
  };
}

function presentBlob(archive: Record<string, JsonValue>, keys: string[]): string | null {
  for (const key of keys) {
    const blob = z.string().safeParse(archive[key]);

    if (blob.success && mediaStore.pathFor(blob.data)) return blob.data;
  }

  return null;
}

function candidatesSql(scope: MediaScope): string {
  const base = "source='reddit'";

  if (scope === "salvageable")
    return `${base} AND json_extract(metadata, '$.media_salvage_url') IS NOT NULL`;

  if (scope === "galleries")
    return `${base} AND json_extract(metadata, '$.gallery_preview') IS NOT NULL`;

  if (scope === "twitter")
    return "source='twitter' AND json_extract(metadata, '$.media_urls') IS NOT NULL";

  if (scope === "videos")
    return `${base} AND (json_extract(metadata, '$.media_type')='reddit_video' OR json_extract(metadata, '$.media_url') LIKE '%v.redd.it%' OR url LIKE '%v.redd.it%')`;

  return `${base} AND COALESCE(json_extract(metadata, '$.media_status'),'') <> 'gone' AND (json_extract(metadata, '$.media_url') LIKE '%i.redd.it%' OR json_extract(metadata, '$.media_url') LIKE '%.jpg%' OR json_extract(metadata, '$.media_url') LIKE '%.png%' OR json_extract(metadata, '$.media_url') LIKE '%.webp%' OR json_extract(metadata, '$.media_url') LIKE '%.gif%')`;
}

async function processOutput(
  proc: {
    stderr: ReadableStream<Uint8Array<ArrayBuffer>>;
    exited: Promise<number>;
    kill(signal: "SIGKILL"): void;
  },
  timeoutMs: number,
): Promise<{ exitCode: number; stderr: string; timedOut: boolean }> {
  let timedOut = false;

  const timeout = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, timeoutMs);

  const stderrPromise = new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  clearTimeout(timeout);

  return { exitCode, stderr: await stderrPromise, timedOut };
}

async function probeAudio(path: string, timeoutMs: number): Promise<boolean> {
  const ffprobe = Bun.which("ffprobe");

  if (!ffprobe) return false;

  const proc = Bun.spawn(
    [
      ffprobe,
      "-v",
      "error",
      "-select_streams",
      "a:0",
      "-show_entries",
      "stream=codec_type",
      "-of",
      "csv=p=0",
      path,
    ],
    { stdout: "pipe", stderr: "ignore" },
  );

  const timeout = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
  const output = await new Response(proc.stdout).text();
  const code = await proc.exited;
  clearTimeout(timeout);

  return code === 0 && output.trim().length > 0;
}

export async function defaultVideoDownloader(
  candidate: VideoCandidate,
  tempDir: string,
  opts: { maxBytes?: number; timeout?: number } = {},
): Promise<[string | null, VideoDownloadInfo | string]> {
  const ffmpeg = Bun.which("ffmpeg");

  if (!ffmpeg) return [null, "missing_ffmpeg"];
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_VIDEO_BYTES;
  const timeout = (opts.timeout ?? DEFAULT_VIDEO_TIMEOUT) * 1000;
  const playlist = `${candidate.canonical_url}/HLSPlaylist.m3u8`;
  const dash = `${candidate.canonical_url}/DASHPlaylist.mpd`;

  const inputUrls = [
    ...new Set(
      [playlist, dash, candidate.media_url, candidate.source_url].filter(
        (url) => Boolean(url) && !url.includes("reddit.com/r/"),
      ),
    ),
  ];

  let muxFailure = false;

  for (const [index, url] of inputUrls.entries()) {
    const [allowed] = safeFetchUrl(url);

    if (!allowed) {
      muxFailure = true;
      continue;
    }

    const path = join(tempDir, `reddit-video-${index}.mp4`);

    const proc = Bun.spawn(
      [
        ffmpeg,
        "-nostdin",
        "-y",
        "-v",
        "error",
        "-i",
        url,
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        "-fs",
        String(maxBytes + 1),
        path,
      ],
      { stdout: "ignore", stderr: "pipe" },
    );

    const result = await processOutput(proc, timeout);

    if (result.timedOut) {
      rmSync(path, { force: true });

      return [null, "timeout"];
    }

    if (result.exitCode !== 0) {
      muxFailure ||= /mux|merge|stream|codec/i.test(result.stderr);
      rmSync(path, { force: true });
      continue;
    }

    try {
      const size = statSync(path).size;

      if (size > maxBytes) {
        rmSync(path, { force: true });

        return [null, "too_large"];
      }

      return [
        path,
        {
          mime: "video/mp4",
          downloader: "ffmpeg",
          container: "mp4",
          has_audio: await probeAudio(path, Math.min(timeout, 30_000)),
        },
      ];
    } catch {
      rmSync(path, { force: true });
    }
  }

  return [null, muxFailure ? "ffmpeg_failed" : "extractor_error"];
}

export async function archiveMedia(
  database: Database,
  opts: {
    scopes?: MediaScope[];
    limit?: number;
    apply?: boolean;
    fetch?: (url: string, maxBytes: number) => Promise<[Uint8Array | null, string]>;
    videoDownloader?: typeof defaultVideoDownloader;
    throttle?: number;
    maxBytes?: number;
    maxVideoBytes?: number;
    videoTimeout?: number;
    sleep?: (seconds: number) => Promise<void> | void;
    progress?: (message: string) => void;
  } = {},
): Promise<ArchiveResult> {
  const apply = opts.apply ?? false;
  const throttle = opts.throttle ?? DEFAULT_THROTTLE_SECONDS;
  const sleep = opts.sleep ?? ((seconds: number) => Bun.sleep(seconds * 1000));

  const result: ArchiveResult = {
    items: 0,
    urls: 0,
    archived: 0,
    skipped: 0,
    failed: 0,
    bytes: 0,
    applied: apply,
    by_scope: {},
    fail_reasons: {},
  };

  let budget = opts.limit;

  for (const scope of opts.scopes ?? ["salvageable", "galleries"]) {
    if (!SCOPES.includes(scope)) continue;
    const scopeResult = { items: 0, archived: 0, failed: 0, skipped: 0 };

    const rows = database
      .query<ArchiveRow, []>(
        `SELECT fullname,url,metadata FROM items WHERE ${candidatesSql(scope)}`,
      )
      .all();

    for (const row of rows) {
      if (budget !== undefined && budget <= 0) break;
      const metadata = parseMetadata(row.metadata);
      const parsedArchive = JsonObjectSchema.safeParse(metadata.archived_media);
      const archive: Record<string, JsonValue> = parsedArchive.success ? parsedArchive.data : {};

      if (scope === "videos") {
        const candidate = videoCandidate(row.fullname, row.url, metadata);

        if (!candidate) continue;

        if (presentBlob(archive, candidate.archive_keys)) {
          result.skipped++;
          scopeResult.skipped++;
          continue;
        }

        result.items++;
        scopeResult.items++;
        result.urls++;

        if (budget !== undefined) budget--;

        if (apply) {
          const parent = join(mediaStore.mediaDir(), "..", "tmp");
          mkdirSync(parent, { recursive: true });
          const tempDir = mkdtempSync(join(parent, "content-hoarder-vreddit-"));

          try {
            const [path, rawInfo] = await (opts.videoDownloader ?? defaultVideoDownloader)(
              candidate,
              tempDir,
              { maxBytes: opts.maxVideoBytes, timeout: opts.videoTimeout },
            );

            const parsedInfo = VideoDownloadInfoSchema.safeParse(rawInfo);

            if (!path || !parsedInfo.success) {
              const reasonValue = z.string().safeParse(rawInfo);
              const reason = reasonValue.success ? reasonValue.data : "error";
              result.failed++;
              scopeResult.failed++;
              result.fail_reasons[reason] = (result.fail_reasons[reason] ?? 0) + 1;
            } else {
              const info = parsedInfo.data;
              const size = statSync(path).size;

              if (size > (opts.maxVideoBytes ?? DEFAULT_MAX_VIDEO_BYTES))
                throw new Error("too_large");

              const blob = await mediaStore.storePath(path, {
                mime: info.mime,
                url: candidate.canonical_url,
              });

              for (const key of candidate.archive_keys) archive[key] = blob;
              const parsedDetails = JsonObjectSchema.safeParse(metadata.archived_media_details);

              const detailsValue: Record<string, JsonValue> = parsedDetails.success
                ? parsedDetails.data
                : {};

              detailsValue[candidate.canonical_url] = {
                kind: "reddit_video",
                blob,
                canonical_url: candidate.canonical_url,
                source_url: candidate.source_url,
                downloader: info.downloader,
                container: info.container,
                has_audio: info.has_audio,
                bytes: size,
                fetched_utc: Math.floor(Date.now() / 1000),
              };
              withTransaction(database, () =>
                database
                  .query(
                    "UPDATE items SET metadata=json_set(json_set(metadata, '$.archived_media', json(?)), '$.archived_media_details', json(?)) WHERE fullname=?",
                  )
                  .run(JSON.stringify(archive), JSON.stringify(detailsValue), row.fullname),
              );
              result.archived++;
              scopeResult.archived++;
              result.bytes += size;
            }
          } catch (error) {
            const reason =
              error instanceof Error && error.message === "too_large" ? "too_large" : "disk_error";

            result.failed++;
            scopeResult.failed++;
            result.fail_reasons[reason] = (result.fail_reasons[reason] ?? 0) + 1;
          } finally {
            rmSync(tempDir, { recursive: true, force: true });
          }
        }

        if (opts.progress && result.items % 10 === 0)
          opts.progress(
            `  [videos] ${result.items} items, ${result.archived} archived, ${result.failed} failed, ${Math.floor(result.bytes / 1024 / 1024)} MB`,
          );
      }

      const todo = urlsFor(metadata, scope).filter(
        (url) => !z.string().safeParse(archive[url]).success,
      );

      if (!todo.length) continue;
      result.items++;
      scopeResult.items++;

      if (budget !== undefined) budget--;

      for (const url of todo) {
        result.urls++;

        if (!apply) continue;

        const [bytes, mime] = await (opts.fetch ?? defaultFetch)(
          url,
          opts.maxBytes ?? DEFAULT_MAX_BYTES,
        );

        if (!bytes) {
          result.failed++;
          scopeResult.failed++;
          result.fail_reasons[mime] = (result.fail_reasons[mime] ?? 0) + 1;
        } else {
          archive[url] = mediaStore.store(bytes, { mime, url });
          result.archived++;
          scopeResult.archived++;
          result.bytes += bytes.byteLength;
        }

        if (throttle > 0) await sleep(throttle);
      }

      if (apply && Object.keys(archive).length)
        withTransaction(database, () =>
          database
            .query(
              "UPDATE items SET metadata=json_set(metadata, '$.archived_media', json(?)) WHERE fullname=?",
            )
            .run(JSON.stringify(archive), row.fullname),
        );

      if (opts.progress && result.items % 25 === 0)
        opts.progress(
          `  [${scope}] ${result.items} items, ${result.archived} blobs, ${Math.floor(result.bytes / 1024 / 1024)} MB`,
        );
    }

    result.by_scope[scope] = scopeResult;

    if (budget !== undefined && budget <= 0) break;
  }

  return result;
}
