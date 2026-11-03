import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import * as config from "./config.ts";
import { isPublicAddress, safeFetchUrl } from "./_http.ts";
import {
  DEFAULT_MAX_VIDEO_BYTES,
  DEFAULT_VIDEO_TIMEOUT,
  UA,
  redditVideoCandidate,
  redditVideoPlaylists,
  type VideoCandidate,
} from "./media_archive.ts";
import * as mediaStore from "./media_store.ts";
import { parseMetadata, type JsonValue, type Metadata } from "./models.ts";

export type VideoExportItem = {
  fullname: string;
  title: string;
  url?: string;
  metadata: Metadata | string;
};

export type FetchLike = (
  url: string,
  init: { headers: Record<string, string>; redirect: "manual"; signal: AbortSignal },
) => Promise<Response>;

export type HostResolver = (hostname: string) => Promise<string[]>;

export type MuxResult =
  | { ok: true }
  | { ok: false; reason: "ffmpeg_failed" | "timeout" | "too_large" | "invalid_media" };

export type MuxRunner = (opts: {
  inputs: string[];
  output: string;
  maxBytes: number;
  timeoutMs: number;
  ffmpeg: string;
}) => Promise<MuxResult>;

export type VideoExportDeps = {
  fetch?: FetchLike;
  resolveHost?: HostResolver;
  mux?: MuxRunner;
  ffmpeg?: string | null;
  libraryKey?: string;
  cacheRoot?: string;
  cacheDir?: string;
  cacheCapBytes?: number;
  maxBytes?: number;
  timeoutMs?: number;
};

export type LocalVideo = { path: string; bytes: number };

export type VideoExportResult =
  | { ok: true; path: string; bytes: number; cached: boolean }
  | { ok: false; status: number; error: string; message: string };

export const PREPARE_WAIT_MS = 25_000;

const DEFAULT_CACHE_BYTES = 2 * 1024 * 1024 * 1024;

const MANIFEST_MAX_BYTES = 4 * 1024 * 1024;

const MAX_REDIRECTS = 3;

const MAX_QUEUE = 20;

const MAX_CONCURRENT_MUXES = 2;

const STALE_TEMP_MS = 6 * 60 * 60 * 1000;

const MP4_PROBE_BYTES = 64 * 1024;

const REDDIT_MEDIA_HOST = /(^|\.)redd\.it$/i;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const dnsLookup: HostResolver = async (hostname) =>
  (await lookup(hostname, { all: true })).map((entry) => entry.address);

class VideoExportError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "VideoExportError";
    this.code = code;
  }
}

class SizeLimitError extends Error {}

const inflight = new Map<string, Promise<VideoExportResult>>();

const activeTemps = new Set<string>();

const pinned = new Map<string, number>();

const maintained = new Set<string>();

let active = 0;

const waiters: Array<() => void> = [];

async function withSlot<T>(run: () => Promise<T>): Promise<T> {
  if (active < MAX_CONCURRENT_MUXES) {
    active += 1;
  } else {
    const { promise, resolve: resume } = Promise.withResolvers<void>();

    waiters.push(() => {
      active += 1;
      resume();
    });
    await promise;
  }

  try {
    return await run();
  } finally {
    active -= 1;
    waiters.shift()?.();
  }
}

function fail(status: number, error: string, message: string): VideoExportResult {
  return { ok: false, status, error, message };
}

export function libraryCacheKey(database: Database): string {
  return createHash("sha256")
    .update(database.filename || "unknown")
    .digest("hex")
    .slice(0, 16);
}

export function videoCacheRoot(): string {
  return join(dirname(resolve(config.dbPath())), "cache", "video-export");
}

export function isRedditMediaUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();

    return REDDIT_MEDIA_HOST.test(host);
  } catch {
    return false;
  }
}

export function videoFilename(title: string): string {
  const plain = title
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/["\\/:*?<>|\r\n\t]+/g, " ")
    .replace(/[^A-Za-z0-9._ -]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.\- ]+|[.\- ]+$/g, "")
    .slice(0, 80)
    .trim();

  return `${plain || "reddit-video"}.mp4`;
}

const RedditVideoSchema = z
  .object({
    fallback_url: z.string().optional().catch(undefined),
  })
  .catchall(z.json());

const ArchivedMediaSchema = z.record(z.string(), z.json());

function text(value: JsonValue | undefined): string {
  const parsed = z.string().safeParse(value);

  return parsed.success ? parsed.data.trim() : "";
}

type RedditVideoSource = { candidate: VideoCandidate; fallbackUrl: string };

function resolveSource(
  item: VideoExportItem,
): RedditVideoSource | { error: string; message: string } {
  const metadata = parseMetadata(item.metadata);
  const candidate = redditVideoCandidate(item.fullname, item.url ?? "", metadata);

  if (!candidate) {
    const parsed = RedditVideoSchema.safeParse(metadata.reddit_video);
    const fields = parsed.success ? parsed.data : {};

    const evidence = [
      text(metadata.media_url),
      text(fields.fallback_url),
      text(metadata.media_hls_url),
      text(metadata.media_dash_url),
      text(item.url),
    ].filter(Boolean);

    return {
      error: evidence.length ? "unsupported_host" : "not_reddit_video",
      message: evidence.length
        ? "Only Reddit video hosts (v.redd.it) can be exported."
        : "This item is not a Reddit video.",
    };
  }

  const parsed = RedditVideoSchema.safeParse(metadata.reddit_video);
  const fallback = text(parsed.success ? parsed.data.fallback_url : undefined);

  return {
    candidate,
    fallbackUrl: isRedditMediaUrl(fallback) ? fallback : candidate.canonical_url,
  };
}

function cacheTarget(deps: VideoExportDeps, fullname: string) {
  const dir =
    deps.cacheDir ?? join(deps.cacheRoot ?? videoCacheRoot(), deps.libraryKey ?? "default");

  const hash = createHash("sha256").update(fullname).digest("hex").slice(0, 32);

  return { dir, path: join(dir, `${hash}.mp4`) };
}

function archivedPath(metadata: Metadata, keys: string[]): string | null {
  const stored = ArchivedMediaSchema.safeParse(metadata.archived_media);
  const archive = stored.success ? stored.data : {};

  for (const key of keys) {
    const blob = text(archive[key]);

    if (!blob) continue;
    const path = mediaStore.pathFor(blob);

    if (path && statSync(path, { throwIfNoEntry: false })?.isFile()) return path;
  }

  return null;
}

type DashTracks = { video: string[]; audio: string[] };

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function absoluteUrl(value: string, baseUrl: string): string {
  try {
    return new URL(decodeEntities(value.trim()), baseUrl).toString();
  } catch {
    return "";
  }
}

export function parseDashManifest(manifest: string, manifestUrl: string): DashTracks {
  const found: DashTracks = { video: [], audio: [] };

  for (const set of manifest.matchAll(/<AdaptationSet\b([^>]*)>([\s\S]*?)<\/AdaptationSet>/gi)) {
    const attrs = set[1] ?? "";
    const body = set[2] ?? "";
    const mime = (/mimeType="([^"]+)"/i.exec(attrs)?.[1] ?? "").toLowerCase();
    const contentType = (/contentType="([^"]+)"/i.exec(attrs)?.[1] ?? "").toLowerCase();

    const kind =
      mime.includes("audio") || contentType.includes("audio")
        ? "audio"
        : mime.includes("video") || contentType.includes("video")
          ? "video"
          : "";

    if (!kind) continue;

    const representations = [
      ...body.matchAll(/<Representation\b([^>]*)>([\s\S]*?)<\/Representation>/gi),
    ];

    const picks: Array<{ url: string; bandwidth: number }> = [];

    for (const representation of representations) {
      const base = /<BaseURL>([\s\S]*?)<\/BaseURL>/i.exec(representation[2] ?? "")?.[1];

      if (!base) continue;

      picks.push({
        url: absoluteUrl(base, manifestUrl),
        bandwidth: Number(/bandwidth="(\d+)"/i.exec(representation[1] ?? "")?.[1] ?? 0),
      });
    }

    if (!picks.length) {
      const base = /<BaseURL>([\s\S]*?)<\/BaseURL>/i.exec(body)?.[1];

      if (base) picks.push({ url: absoluteUrl(base, manifestUrl), bandwidth: 0 });
    }

    picks.sort((left, right) => right.bandwidth - left.bandwidth);

    for (const pick of picks) if (pick.url) found[kind].push(pick.url);
  }

  return found;
}

async function assertPublicResolution(url: string, resolveHost: HostResolver): Promise<void> {
  const hostname = new URL(url).hostname;

  if (isIP(hostname) !== 0) return;

  let addresses: string[];

  try {
    addresses = await resolveHost(hostname);
  } catch {
    throw new VideoExportError("blocked_host", `Could not resolve ${hostname}.`);
  }

  if (!addresses.length)
    throw new VideoExportError("blocked_host", `Could not resolve ${hostname}.`);

  for (const address of addresses)
    if (!isPublicAddress(address))
      throw new VideoExportError(
        "blocked_redirect",
        "Refusing a Reddit video host that resolves to a private address.",
      );
}

async function openRedditResponse(
  url: string,
  fetchImpl: FetchLike,
  resolveHost: HostResolver,
  timeoutMs: number,
): Promise<Response> {
  let current = url;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (!isRedditMediaUrl(current))
      throw new VideoExportError(
        "blocked_redirect",
        "Refusing a redirect away from Reddit video hosts.",
      );

    const [allowed, reason] = safeFetchUrl(current);

    if (!allowed)
      throw new VideoExportError(
        "blocked_redirect",
        `Refusing to fetch a Reddit redirect target (${reason}).`,
      );

    await assertPublicResolution(current, resolveHost);

    const response = await fetchImpl(current, {
      headers: { "User-Agent": UA },
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!REDIRECT_STATUSES.has(response.status)) return response;
    await response.body?.cancel().catch(() => {});

    if (hop === MAX_REDIRECTS)
      throw new VideoExportError("too_many_redirects", "Reddit returned too many redirects.");

    const location = response.headers.get("location");

    if (!location)
      throw new VideoExportError("bad_redirect", "Reddit returned a redirect without a location.");

    try {
      current = new URL(location, current).toString();
    } catch {
      throw new VideoExportError("bad_redirect", "Reddit returned an invalid redirect location.");
    }
  }

  throw new VideoExportError("too_many_redirects", "Reddit returned too many redirects.");
}

async function fetchManifest(
  url: string,
  fetchImpl: FetchLike,
  resolveHost: HostResolver,
  timeoutMs: number,
): Promise<string> {
  const response = await openRedditResponse(url, fetchImpl, resolveHost, timeoutMs);

  if (!response.ok) {
    await response.body?.cancel().catch(() => {});

    return "";
  }

  if (!response.body) return "";

  const declared = Number(response.headers.get("content-length"));

  if (Number.isFinite(declared) && declared > MANIFEST_MAX_BYTES) {
    await response.body.cancel().catch(() => {});

    return "";
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) break;

    if (!value) continue;

    size += value.byteLength;

    if (size > MANIFEST_MAX_BYTES) {
      await reader.cancel().catch(() => {});

      return "";
    }

    chunks.push(value);
  }

  const bytes = new Uint8Array(size);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(bytes);
}

async function resolveTracks(
  source: RedditVideoSource,
  fetchImpl: FetchLike,
  resolveHost: HostResolver,
  timeoutMs: number,
): Promise<DashTracks> {
  const { dash } = redditVideoPlaylists(source.candidate);
  const manifest = await fetchManifest(dash, fetchImpl, resolveHost, timeoutMs);

  const parsed: DashTracks = manifest
    ? parseDashManifest(manifest, dash)
    : { video: [], audio: [] };

  const video = [...parsed.video];

  if (!video.length) {
    const derived = `${source.candidate.canonical_url}/DASH_${source.candidate.height ?? 720}.mp4`;

    video.push(isRedditMediaUrl(source.fallbackUrl) ? source.fallbackUrl : derived);
  }

  const audio = [...parsed.audio];

  if (!audio.length && source.candidate.has_audio !== false && source.candidate.is_gif !== true)
    audio.push(
      `${source.candidate.canonical_url}/DASH_AUDIO_128.mp4`,
      `${source.candidate.canonical_url}/DASH_AUDIO_64.mp4`,
    );

  const clean = (urls: string[]) => [...new Set(urls)].filter(isRedditMediaUrl);

  return { video: clean(video), audio: clean(audio) };
}

function isMp4(path: string): boolean {
  let descriptor: number | null = null;

  try {
    descriptor = openSync(path, "r");
    const size = statSync(path).size;

    if (size < 12) return false;

    const headLength = Math.min(MP4_PROBE_BYTES, size);
    const head = Buffer.alloc(headLength);

    readSync(descriptor, head, 0, headLength, 0);

    if (head.toString("latin1", 4, 8) !== "ftyp") return false;

    if (head.includes("moov")) return true;

    if (size <= headLength) return false;

    const tail = Buffer.alloc(headLength);

    readSync(descriptor, tail, 0, headLength, size - headLength);

    return tail.includes("moov");
  } catch {
    return false;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

async function writeResponse(response: Response, path: string, maxBytes: number): Promise<void> {
  if (!response.body)
    throw new VideoExportError("empty_track", "Reddit returned an empty video track.");

  const writer = Bun.file(path).writer();
  let size = 0;

  try {
    const reader = response.body.getReader();

    for (;;) {
      const { done, value } = await reader.read();

      if (done) break;

      if (!value) continue;

      size += value.byteLength;

      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new SizeLimitError();
      }

      writer.write(value);
    }

    await writer.end();
  } catch (error) {
    try {
      await writer.end();
    } catch {}

    rmSync(path, { force: true });
    throw error;
  }

  if (size === 0) {
    rmSync(path, { force: true });
    throw new VideoExportError("empty_track", "Reddit returned an empty video track.");
  }
}

type TrackDownload = {
  ok: boolean;
  reason?: string;
  message?: string;
  tooLarge?: boolean;
};

async function downloadTrack(
  urls: string[],
  path: string,
  fetchImpl: FetchLike,
  resolveHost: HostResolver,
  timeoutMs: number,
  maxBytes: number,
): Promise<TrackDownload> {
  let lastReason = "track_unavailable";
  let lastMessage = "Could not download the Reddit video track.";

  for (const url of urls) {
    let response: Response;

    try {
      response = await openRedditResponse(url, fetchImpl, resolveHost, timeoutMs);
    } catch (error) {
      if (error instanceof VideoExportError) throw error;
      lastReason = "track_request_failed";
      lastMessage = "Could not reach Reddit for this video track.";
      continue;
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      lastReason = `http_${response.status}`;
      lastMessage = `Reddit returned HTTP ${response.status} for this video track.`;
      continue;
    }

    const declared = Number(response.headers.get("content-length"));

    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel().catch(() => {});

      return {
        ok: false,
        reason: "too_large",
        message: "The exported video exceeds the size limit.",
        tooLarge: true,
      };
    }

    try {
      await writeResponse(response, path, maxBytes);
    } catch (error) {
      if (error instanceof SizeLimitError)
        return {
          ok: false,
          reason: "too_large",
          message: "The exported video exceeds the size limit.",
          tooLarge: true,
        };

      if (error instanceof VideoExportError) throw error;
      lastReason = "write_failed";
      lastMessage = "Could not store the Reddit video track.";
      continue;
    }

    if (!isMp4(path)) {
      rmSync(path, { force: true });
      lastReason = "invalid_media";
      lastMessage = "Reddit returned a track that is not an MP4 file.";
      continue;
    }

    return { ok: true };
  }

  return { ok: false, reason: lastReason, message: lastMessage };
}

async function runProcess(
  proc: {
    stderr: ReadableStream<Uint8Array<ArrayBuffer>>;
    exited: Promise<number>;
    kill(signal: "SIGKILL"): void;
  },
  timeoutMs: number,
): Promise<{ exitCode: number; timedOut: boolean }> {
  let timedOut = false;

  const timeout = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, timeoutMs);

  const stderr = new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  clearTimeout(timeout);
  await stderr;

  return { exitCode, timedOut };
}

export async function ffmpegMux(opts: {
  inputs: string[];
  output: string;
  maxBytes: number;
  timeoutMs: number;
  ffmpeg: string;
}): Promise<MuxResult> {
  const args = [opts.ffmpeg, "-nostdin", "-y", "-v", "error"];

  for (const input of opts.inputs)
    args.push("-protocol_whitelist", "file", "-f", "mp4", "-i", input);

  args.push("-map", "0:v:0", "-map", opts.inputs.length > 1 ? "1:a:0?" : "0:a:0?");
  args.push("-c", "copy", "-movflags", "+faststart", "-fs", String(opts.maxBytes + 1), opts.output);

  const proc = Bun.spawn(args, { stdout: "ignore", stderr: "pipe" });
  const result = await runProcess(proc, opts.timeoutMs);

  if (result.timedOut) {
    rmSync(opts.output, { force: true });

    return { ok: false, reason: "timeout" };
  }

  if (result.exitCode !== 0) {
    rmSync(opts.output, { force: true });

    return { ok: false, reason: "ffmpeg_failed" };
  }

  if (statSync(opts.output, { throwIfNoEntry: false })?.size === undefined)
    return { ok: false, reason: "ffmpeg_failed" };

  if (statSync(opts.output).size > opts.maxBytes) {
    rmSync(opts.output, { force: true });

    return { ok: false, reason: "too_large" };
  }

  if (!isMp4(opts.output)) {
    rmSync(opts.output, { force: true });

    return { ok: false, reason: "invalid_media" };
  }

  return { ok: true };
}

export function pinVideo(path: string): () => void {
  pinned.set(path, (pinned.get(path) ?? 0) + 1);
  let released = false;

  return () => {
    if (released) return;
    released = true;

    const remaining = (pinned.get(path) ?? 1) - 1;

    if (remaining <= 0) pinned.delete(path);
    else pinned.set(path, remaining);
  };
}

export function sweepVideoCache(
  dir: string,
  capBytes: number,
  keepPath: string | null = null,
  now = Date.now(),
): void {
  let entries: Array<{ path: string; size: number; mtime: number; dir: boolean }>;

  try {
    entries = readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);

      try {
        const info = statSync(path);

        return [{ path, size: info.size, mtime: info.mtimeMs, dir: entry.isDirectory() }];
      } catch {
        return [];
      }
    });
  } catch {
    return;
  }

  for (const entry of entries)
    if (
      entry.dir &&
      entry.path.split("/").at(-1)?.startsWith("tmp-") &&
      !activeTemps.has(entry.path) &&
      now - entry.mtime > STALE_TEMP_MS
    )
      rmSync(entry.path, { recursive: true, force: true });

  const files = entries
    .filter((entry) => !entry.dir && entry.path.endsWith(".mp4"))
    .sort((left, right) => left.mtime - right.mtime);

  let total = files.reduce((sum, entry) => sum + entry.size, 0);

  for (const entry of files) {
    if (total <= capBytes) break;

    if (entry.path === keepPath || pinned.has(entry.path)) continue;
    rmSync(entry.path, { force: true });
    total -= entry.size;
  }
}

function maintainCache(dir: string, capBytes: number): void {
  if (maintained.has(dir)) return;
  maintained.add(dir);
  mkdirSync(dir, { recursive: true });
  sweepVideoCache(dir, capBytes);
}

function localVideoFor(
  source: RedditVideoSource,
  item: VideoExportItem,
  deps: VideoExportDeps,
): LocalVideo | null {
  const archived = archivedPath(parseMetadata(item.metadata), source.candidate.archive_keys);

  if (archived) return { path: archived, bytes: statSync(archived).size };

  const { path } = cacheTarget(deps, item.fullname);
  const size = statSync(path, { throwIfNoEntry: false })?.size ?? 0;

  if (size <= 0) return null;

  const now = new Date();

  utimesSync(path, now, now);

  return { path, bytes: size };
}

export function localVideo(item: VideoExportItem, deps: VideoExportDeps = {}): LocalVideo | null {
  const source = resolveSource(item);

  if ("error" in source) return null;

  return localVideoFor(source, item, deps);
}

type BuildDeps = {
  fetch: FetchLike;
  resolveHost: HostResolver;
  mux: MuxRunner;
  ffmpeg: string;
  maxBytes: number;
  timeoutMs: number;
  cacheCapBytes: number;
};

async function buildVideo(
  item: VideoExportItem,
  source: RedditVideoSource,
  target: string,
  deps: BuildDeps,
): Promise<VideoExportResult> {
  mkdirSync(dirname(target), { recursive: true });
  const tempDir = mkdtempSync(join(dirname(target), "tmp-"));

  activeTemps.add(tempDir);

  try {
    const tracks = await resolveTracks(source, deps.fetch, deps.resolveHost, deps.timeoutMs);
    const videoPath = join(tempDir, "video.mp4");

    const video = await downloadTrack(
      tracks.video,
      videoPath,
      deps.fetch,
      deps.resolveHost,
      deps.timeoutMs,
      deps.maxBytes,
    );

    if (!video.ok)
      return video.tooLarge
        ? fail(413, "too_large", "The exported video exceeds the size limit.")
        : fail(502, video.reason ?? "video_unavailable", video.message ?? "Video unavailable.");

    const inputs = [videoPath];

    if (tracks.audio.length) {
      const audioPath = join(tempDir, "audio.mp4");

      const audio = await downloadTrack(
        tracks.audio,
        audioPath,
        deps.fetch,
        deps.resolveHost,
        deps.timeoutMs,
        deps.maxBytes,
      );

      if (!audio.ok)
        return fail(
          502,
          "audio_unavailable",
          "The Reddit video's audio track could not be downloaded; refusing to export a silent video.",
        );

      inputs.push(audioPath);
    } else if (source.candidate.has_audio === true) {
      return fail(
        502,
        "audio_unavailable",
        "This Reddit video has audio, but its audio track could not be found.",
      );
    }

    const output = join(tempDir, "out.mp4");

    const muxed = await deps.mux({
      inputs,
      output,
      maxBytes: deps.maxBytes,
      timeoutMs: deps.timeoutMs,
      ffmpeg: deps.ffmpeg,
    });

    if (!muxed.ok)
      return fail(
        muxed.reason === "too_large" ? 413 : 502,
        muxed.reason === "too_large" ? "too_large" : "ffmpeg_failed",
        muxed.reason === "too_large"
          ? "The exported video exceeds the size limit."
          : "ffmpeg could not mux the Reddit video tracks.",
      );

    const size = statSync(output).size;

    if (size > deps.maxBytes) {
      rmSync(output, { force: true });

      return fail(413, "too_large", "The exported video exceeds the size limit.");
    }

    renameSync(output, target);
    sweepVideoCache(dirname(target), deps.cacheCapBytes, target);

    return { ok: true, path: target, bytes: size, cached: false };
  } catch (error) {
    if (error instanceof VideoExportError) return fail(502, error.code, error.message);

    throw error;
  } finally {
    activeTemps.delete(tempDir);
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export async function exportVideo(
  item: VideoExportItem,
  deps: VideoExportDeps = {},
): Promise<VideoExportResult> {
  try {
    return await runVideoExport(item, deps);
  } catch {
    return fail(500, "export_failed", "Could not prepare this Reddit video.");
  }
}

async function runVideoExport(
  item: VideoExportItem,
  deps: VideoExportDeps,
): Promise<VideoExportResult> {
  const source = resolveSource(item);

  if ("error" in source) return fail(400, source.error, source.message);

  const local = localVideoFor(source, item, deps);

  if (local) return { ok: true, ...local, cached: true };

  const { dir, path: target } = cacheTarget(deps, item.fullname);
  const cacheCapBytes = deps.cacheCapBytes ?? DEFAULT_CACHE_BYTES;

  maintainCache(dir, cacheCapBytes);

  if (config.offline())
    return fail(
      409,
      "offline",
      "Video export needs network access, but content-hoarder is offline (CONTENT_HOARDER_OFFLINE=1).",
    );

  const ffmpeg = deps.ffmpeg === undefined ? Bun.which("ffmpeg") : deps.ffmpeg;

  if (!ffmpeg)
    return fail(
      501,
      "ffmpeg_missing",
      "ffmpeg is not installed, so content-hoarder cannot build a shareable MP4.",
    );

  const key = `${dir}\0${item.fullname}`;
  const running = inflight.get(key);

  if (running) return running;

  if (active >= MAX_CONCURRENT_MUXES && waiters.length >= MAX_QUEUE)
    return fail(429, "busy", "Too many video exports are queued; try again in a moment.");

  const task = withSlot(() =>
    buildVideo(item, source, target, {
      fetch: deps.fetch ?? fetch,
      resolveHost: deps.resolveHost ?? dnsLookup,
      mux: deps.mux ?? ffmpegMux,
      ffmpeg,
      maxBytes: deps.maxBytes ?? DEFAULT_MAX_VIDEO_BYTES,
      timeoutMs: deps.timeoutMs ?? DEFAULT_VIDEO_TIMEOUT * 1000,
      cacheCapBytes,
    }),
  ).finally(() => {
    inflight.delete(key);
  });

  inflight.set(key, task);

  return task;
}

export async function prepareVideo(
  item: VideoExportItem,
  deps: VideoExportDeps = {},
  waitMs = PREPARE_WAIT_MS,
): Promise<
  | { ready: true; bytes: number; cached: boolean }
  | { ready: false; pending: true }
  | { ready: false; error: string; message: string; status: number }
> {
  const local = localVideo(item, deps);

  if (local) return { ready: true, bytes: local.bytes, cached: true };

  const task = exportVideo(item, deps);
  const { promise, resolve: settle } = Promise.withResolvers<null>();
  const timer = setTimeout(() => settle(null), waitMs);
  let result: VideoExportResult | null;

  try {
    result = await Promise.race([task, promise]);
  } finally {
    clearTimeout(timer);
  }

  if (result === null) return { ready: false, pending: true };

  if (!result.ok)
    return {
      ready: false,
      error: result.error,
      message: result.message,
      status: result.status,
    };

  return { ready: true, bytes: result.bytes, cached: result.cached };
}
