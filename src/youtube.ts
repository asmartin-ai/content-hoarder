import { rmSync } from "node:fs";
import Innertube, { YTNodes } from "youtubei.js";
import { request, safeFetchUrl } from "./_http";

export type YouTubeImportEntry = {
  id: string;
  title: string;
  uploader: string;
  channel: string;
  channel_id: string;
  duration: number | null;
  view_count: number | null;
  availability: string;
  url: string;
  thumbnail: string;
};

export type YouTubePlaylistExport = {
  _type: "playlist";
  title: string;
  id: string;
  entries: YouTubeImportEntry[];
};

export type YouTubeImportData = YouTubePlaylistExport | YouTubeImportEntry[];

export type YouTubeUrl =
  | { kind: "video"; videoId: string }
  | { kind: "playlist"; playlistId: string };

export type YouTubeClient = Pick<Innertube, "getPlaylist" | "getBasicInfo">;

type EntryInput = {
  id: string;
  title?: string;
  author?: string;
  authorId?: string;
  duration?: number;
  viewCount?: number;
  availability?: string;
  thumbnail?: string;
};

const VIDEO_ID = /^[A-Za-z0-9_-]{6,}$/;

const USER_AGENT = "content-hoarder/0.1 (youtube import)";

export function parseYouTubeUrl(value: string): YouTubeUrl {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error("Only YouTube playlist or video URLs are supported here.");
  }

  const host = url.hostname.toLowerCase();
  const validHost = host === "youtube.com" || host.endsWith(".youtube.com") || host === "youtu.be";

  if (!validHost || (url.protocol !== "https:" && url.protocol !== "http:"))
    throw new Error("Only YouTube playlist or video URLs are supported here.");
  const playlistId = url.searchParams.get("list") ?? "";

  if (playlistId && (url.pathname === "/playlist" || url.searchParams.has("v")))
    return { kind: "playlist", playlistId };

  const videoId =
    host === "youtu.be"
      ? (url.pathname.split("/").filter(Boolean)[0] ?? "")
      : (url.searchParams.get("v") ??
        url.pathname.match(/^\/(?:shorts|embed)\/([^/?]+)/)?.[1] ??
        "");

  if (!VIDEO_ID.test(videoId))
    throw new Error("Only YouTube playlist or video URLs are supported here.");

  return { kind: "video", videoId };
}

export function mapYouTubePlaylist(
  title: string,
  playlistId: string,
  entries: readonly EntryInput[],
): YouTubePlaylistExport {
  return {
    _type: "playlist",
    title: title || "playlist",
    id: playlistId,
    entries: entries.flatMap((entry) =>
      VIDEO_ID.test(entry.id)
        ? [
            {
              id: entry.id,
              title: entry.title ?? "",
              uploader: entry.author ?? "",
              channel: entry.author ?? "",
              channel_id: entry.authorId ?? "",
              duration: entry.duration ?? null,
              view_count: entry.viewCount ?? null,
              availability: entry.availability ?? "",
              url: `https://www.youtube.com/watch?v=${entry.id}`,
              thumbnail: entry.thumbnail ?? `https://i.ytimg.com/vi/${entry.id}/hqdefault.jpg`,
            },
          ]
        : [],
    ),
  };
}

const AUDIO_TIMEOUT_SECONDS = 900;

const TRANSPORT_TIMEOUT_SECONDS = 30;

export function guardedPreconnect(
  url: string | URL,
  options?: Parameters<typeof fetch.preconnect>[1],
  preconnect: typeof fetch.preconnect = fetch.preconnect,
): void {
  const target = url.toString();
  const [safe, reason] = safeFetchUrl(target);

  if (!safe) throw new Error(`blocked YouTube preconnect URL (${reason}): ${target}`);
  preconnect(url, options);
}

export const youtubeFetch: typeof fetch = Object.assign(
  async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const outgoing =
      input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);

    const headers: Record<string, string> = {};
    outgoing.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const body = outgoing.body ? new Uint8Array(await outgoing.arrayBuffer()) : undefined;

    const [status, responseHeaders, bytes] = await request(outgoing.url, {
      method: outgoing.method,
      headers,
      data: body,
      timeout: TRANSPORT_TIMEOUT_SECONDS,
      retries: 2,
      jitter: true,
      userAgent: USER_AGENT,
    });

    return new Response(bytes, { status, headers: responseHeaders });
  },
  { preconnect: guardedPreconnect },
);

export async function innertubeClient(
  opts: { client?: YouTubeClient; fetch?: typeof fetch } = {},
): Promise<YouTubeClient> {
  return opts.client ?? Innertube.create({ fetch: opts.fetch ?? youtubeFetch });
}

function videoEntry(video: InstanceType<typeof YTNodes.PlaylistVideo>): EntryInput {
  return {
    id: video.id,
    title: video.title.toString(),
    author: video.author.name,
    authorId: video.author.id,
    duration: video.duration.seconds,
    thumbnail: video.thumbnails[0]?.url,
  };
}

export async function resolveYouTubeUrl(
  value: string,
  opts: { client?: YouTubeClient; fetch?: typeof fetch } = {},
): Promise<YouTubeImportData> {
  const target = parseYouTubeUrl(value);
  const client = await innertubeClient(opts);

  if (target.kind === "playlist") {
    let playlist = await client.getPlaylist(target.playlistId);
    const entries: EntryInput[] = [];

    while (true) {
      for (const item of playlist.items)
        if (item instanceof YTNodes.PlaylistVideo) entries.push(videoEntry(item));

      if (!playlist.has_continuation) break;
      playlist = await playlist.getContinuation();
    }

    return mapYouTubePlaylist(playlist.info.title ?? "playlist", target.playlistId, entries);
  }

  const info = await client.getBasicInfo(target.videoId);
  const video = info.basic_info;

  const mapped = mapYouTubePlaylist(video.title ?? "", "", [
    {
      id: target.videoId,
      title: video.title,
      author: video.author ?? video.channel?.name,
      authorId: video.channel_id ?? video.channel?.id,
      duration: video.duration,
      viewCount: video.view_count,
      availability: info.playability_status?.status,
      thumbnail: video.thumbnail?.[0]?.url,
    },
  ]);

  return mapped.entries;
}

export async function innertubePlayer(
  videoId: string,
  opts: { client?: YouTubeClient; fetch?: typeof fetch } = {},
): Promise<Awaited<ReturnType<YouTubeClient["getBasicInfo"]>>["page"][0]> {
  if (!VIDEO_ID.test(videoId)) throw new Error("Invalid YouTube video id");
  const client = await innertubeClient(opts);
  const info = await client.getBasicInfo(videoId);

  return info.page[0];
}

export type YouTubeAudioResult = {
  path: string | null;
  reason?:
    | "missing_ffmpeg"
    | "missing_audio_stream"
    | "blocked_url"
    | "ffmpeg_failed"
    | "timeout"
    | "too_large";
  mime?: string;
  bytes?: number;
};

export async function downloadYouTubeAudio(
  videoId: string,
  outputPath: string,
  opts: { client?: YouTubeClient; fetch?: typeof fetch; timeout?: number; maxBytes?: number } = {},
): Promise<YouTubeAudioResult> {
  if (!VIDEO_ID.test(videoId)) throw new Error("Invalid YouTube video id");
  const ffmpeg = Bun.which("ffmpeg");

  if (!ffmpeg) return { path: null, reason: "missing_ffmpeg" };
  const client = await innertubeClient(opts);
  const info = await client.getBasicInfo(videoId);
  const streaming = await info.getStreamingInfo();

  const audio = streaming.audio_sets
    .flatMap((set) =>
      set.representations.map((representation) => ({
        bitrate: representation.bitrate,
        mime: set.mime_type,
        url: "base_url" in representation.segment_info ? representation.segment_info.base_url : "",
      })),
    )
    .filter((format) => format.url)
    .sort((left, right) => right.bitrate - left.bitrate)[0];

  if (!audio) return { path: null, reason: "missing_audio_stream" };

  if (!safeFetchUrl(audio.url)[0]) return { path: null, reason: "blocked_url" };
  const maxBytes = opts.maxBytes ?? 512 * 1024 * 1024;
  const timeoutMs = (opts.timeout ?? AUDIO_TIMEOUT_SECONDS) * 1000;

  const process = Bun.spawn(
    [
      ffmpeg,
      "-nostdin",
      "-y",
      "-v",
      "error",
      "-i",
      audio.url,
      "-vn",
      "-c:a",
      "copy",
      "-fs",
      String(maxBytes + 1),
      outputPath,
    ],
    { stdout: "ignore", stderr: "pipe" },
  );

  let timedOut = false;

  const timeout = setTimeout(() => {
    timedOut = true;
    process.kill("SIGKILL");
  }, timeoutMs);

  const stderrPromise = new Response(process.stderr).text();
  const exitCode = await process.exited;
  clearTimeout(timeout);
  const stderr = await stderrPromise;

  if (exitCode !== 0) {
    rmSync(outputPath, { force: true });

    return {
      path: null,
      reason: timedOut ? "timeout" : /killed|timeout/i.test(stderr) ? "timeout" : "ffmpeg_failed",
    };
  }

  const size = Bun.file(outputPath).size;

  if (size > maxBytes) {
    rmSync(outputPath, { force: true });

    return { path: null, reason: "too_large" };
  }

  return { path: outputPath, mime: audio.mime, bytes: size };
}
