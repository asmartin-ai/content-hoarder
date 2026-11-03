import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  exportVideo,
  localVideo,
  pinVideo,
  prepareVideo,
  sweepVideoCache,
  videoFilename,
  type FetchLike,
  type MuxRunner,
  type VideoExportItem,
} from "../src/video_export.ts";
import type { Metadata } from "../src/models.ts";
import { goOffline, withOnline } from "./network.ts";

const MANIFEST = `<?xml version="1.0" encoding="utf-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011">
  <Period>
    <AdaptationSet mimeType="video/mp4">
      <Representation id="video" bandwidth="2500000">
        <BaseURL>DASH_720.mp4</BaseURL>
      </Representation>
    </AdaptationSet>
    <AdaptationSet mimeType="audio/mp4">
      <Representation id="audio" bandwidth="128000">
        <BaseURL>DASH_AUDIO_128.mp4</BaseURL>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

const VIDEO_ONLY_MANIFEST = MANIFEST.replace(
  /<AdaptationSet mimeType="audio[\s\S]*?<\/AdaptationSet>/,
  "",
);

function mp4Bytes(size = 256): Uint8Array {
  const bytes = new Uint8Array(Math.max(32, size));

  bytes.set(new TextEncoder().encode("ftyp"), 4);
  bytes.set(new TextEncoder().encode("moov"), 16);

  return bytes;
}

const MP4 = mp4Bytes();

const item: VideoExportItem = {
  fullname: "reddit:t3_videoexport",
  title: "Test clip",
  metadata: { media_type: "reddit_video", media_url: "https://v.redd.it/abc123" },
};

type HarnessOptions = {
  root?: string;
  libraryKey?: string;
  video?: Uint8Array;
  audio?: Uint8Array | null;
  av?: Uint8Array;
  manifest?: string;
  redirectVideoTo?: string;
};

function harness(options: HarnessOptions = {}) {
  const root = options.root ?? mkdtempSync(join(tmpdir(), "content-hoarder-video-export-"));
  const fetches: string[] = [];
  const muxes: string[][] = [];

  const fetchImpl: FetchLike = async (url, init) => {
    if (init.redirect !== "manual") throw new Error("expected manual redirects");
    fetches.push(url);

    if (url.endsWith("/DASHPlaylist.mpd"))
      return new Response(options.manifest ?? MANIFEST, {
        headers: { "content-type": "application/dash+xml" },
      });

    if (options.redirectVideoTo && url.includes("DASH_720"))
      return new Response(null, {
        status: 302,
        headers: { location: options.redirectVideoTo },
      });

    if (url.includes("DASH_AUDIO"))
      return options.audio === null
        ? new Response("missing", { status: 404 })
        : new Response(options.audio ?? MP4);

    if (url.includes("DASH_720")) return new Response(options.video ?? options.av ?? MP4);

    return new Response("missing", { status: 404 });
  };

  const mux: MuxRunner = async (opts) => {
    muxes.push(opts.inputs);
    writeFileSync(opts.output, mp4Bytes(4096));

    return { ok: true };
  };

  return {
    root,
    fetches,
    muxes,
    fetchImpl,
    mux,
    deps: {
      fetch: fetchImpl,
      resolveHost: async () => ["151.101.1.140"],
      mux,
      ffmpeg: "/usr/bin/ffmpeg",
      cacheRoot: root,
      libraryKey: options.libraryKey ?? "lib",
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function videoItem(fullname: string, mediaId: string, metadata: Metadata = {}): VideoExportItem {
  return {
    fullname,
    title: "Test clip",
    metadata: {
      media_type: "reddit_video",
      media_url: `https://v.redd.it/${mediaId}`,
      ...metadata,
    },
  };
}

test("concurrent exports mux the Reddit DASH tracks once", async () => {
  const harnessed = harness();

  await withOnline(async () => {
    const [first, second] = await Promise.all([
      exportVideo(item, harnessed.deps),
      exportVideo(item, harnessed.deps),
    ]);

    expect(first).toEqual({ ok: true, path: expect.any(String), bytes: 4096, cached: false });
    expect(second.ok).toBe(true);
    expect(harnessed.muxes).toHaveLength(1);
    expect(harnessed.muxes[0]).toHaveLength(2);
    expect(harnessed.fetches.filter((url) => url.includes("DASH_720"))).toHaveLength(1);
    expect(harnessed.fetches.filter((url) => url.includes("DASH_AUDIO"))).toHaveLength(1);
  });

  harnessed.cleanup();
});

test("a second request serves the cached export without muxing again", async () => {
  const harnessed = harness();

  await withOnline(async () => {
    const first = await exportVideo(item, harnessed.deps);

    const second = await exportVideo(
      { ...item, title: "Renamed clip" },
      {
        fetch: async () => {
          throw new Error("network must not run for a cache hit");
        },
        mux: async () => {
          throw new Error("mux must not run for a cache hit");
        },
        ffmpeg: "/usr/bin/ffmpeg",
        cacheRoot: harnessed.root,
        libraryKey: "lib",
      },
    );

    expect(first.ok).toBe(true);
    expect(second).toEqual({
      ok: true,
      path: first.ok ? first.path : "",
      bytes: 4096,
      cached: true,
    });
    expect(harnessed.muxes).toHaveLength(1);
  });

  harnessed.cleanup();
});

test("offline mode serves cached or archived videos before refusing network builds", async () => {
  const harnessed = harness();

  await withOnline(async () => {
    const built = await exportVideo(item, harnessed.deps);

    expect(built.ok).toBe(true);
  });

  goOffline();

  try {
    const cached = await exportVideo(item, harnessed.deps);

    expect(cached).toEqual({
      ok: true,
      path: expect.any(String),
      bytes: 4096,
      cached: true,
    });
    expect(localVideo(item, harnessed.deps)?.bytes).toBe(4096);

    const missing = await exportVideo(videoItem("reddit:t3_offline", "offline123"), harnessed.deps);

    expect(missing.ok).toBe(false);

    if (!missing.ok) {
      expect(missing.status).toBe(409);
      expect(missing.error).toBe("offline");
    }
  } finally {
    goOffline();
  }

  harnessed.cleanup();
});

test("non-Reddit media hosts are refused", async () => {
  const harnessed = harness();

  await withOnline(async () => {
    const result = await exportVideo(
      videoItem("reddit:t3_evil", "ignored", { media_url: "https://example.com/clip.mp4" }),
      harnessed.deps,
    );

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error).toBe("unsupported_host");
      expect(result.message).toContain("Reddit video hosts");
    }
  });

  expect(harnessed.fetches).toHaveLength(0);
  harnessed.cleanup();
});

test("redirects away from Reddit hosts are refused without fetching the target", async () => {
  const external = harness({ redirectVideoTo: "https://evil.example/video.mp4" });

  await withOnline(async () => {
    const result = await exportVideo(item, external.deps);

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.status).toBe(502);
      expect(result.error).toBe("blocked_redirect");
    }
  });

  expect(external.fetches.some((url) => url.includes("evil.example"))).toBe(false);
  external.cleanup();

  const loopback = harness({ redirectVideoTo: "http://127.0.0.1/secret.mp4" });

  await withOnline(async () => {
    const result = await exportVideo(item, loopback.deps);

    expect(result.ok).toBe(false);

    if (!result.ok) expect(result.error).toBe("blocked_redirect");
  });

  expect(loopback.fetches.some((url) => url.includes("127.0.0.1"))).toBe(false);
  loopback.cleanup();
});

test("Reddit hosts resolving to private addresses are refused", async () => {
  const harnessed = harness();
  const deps = { ...harnessed.deps, resolveHost: async () => ["127.0.0.1"] };

  await withOnline(async () => {
    const result = await exportVideo(item, deps);

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.status).toBe(502);
      expect(result.error).toBe("blocked_redirect");
      expect(result.message).toContain("private address");
    }
  });

  expect(harnessed.fetches).toHaveLength(0);
  harnessed.cleanup();
});

test("missing ffmpeg answers 501", async () => {
  const harnessed = harness();

  await withOnline(async () => {
    const result = await exportVideo(item, { ...harnessed.deps, ffmpeg: null });

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.status).toBe(501);
      expect(result.error).toBe("ffmpeg_missing");
      expect(result.message).toContain("ffmpeg");
    }
  });

  expect(harnessed.muxes).toHaveLength(0);
  harnessed.cleanup();
});

test("two libraries with the same fullname keep separate cache entries", async () => {
  const root = mkdtempSync(join(tmpdir(), "content-hoarder-video-libraries-"));
  const first = harness({ root, libraryKey: "lib-a" });
  const second = harness({ root, libraryKey: "lib-b" });

  await withOnline(async () => {
    const a = await exportVideo(videoItem(item.fullname, "aaa111"), first.deps);
    const b = await exportVideo(videoItem(item.fullname, "bbb222"), second.deps);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);

    if (a.ok && b.ok) {
      expect(a.path).not.toBe(b.path);
      expect(a.path).toContain(`${join(root, "lib-a")}/`);
      expect(b.path).toContain(`${join(root, "lib-b")}/`);
      expect(statSync(a.path).size).toBe(4096);
      expect(statSync(b.path).size).toBe(4096);
    }
  });

  expect(first.muxes).toHaveLength(1);
  expect(second.muxes).toHaveLength(1);
  rmSync(root, { recursive: true, force: true });
});

test("a failed audio track fails the build instead of exporting silence", async () => {
  const harnessed = harness({ audio: null });

  await withOnline(async () => {
    const result = await exportVideo(item, harnessed.deps);

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.status).toBe(502);
      expect(result.error).toBe("audio_unavailable");
      expect(result.message).toContain("silent");
    }
  });

  expect(harnessed.muxes).toHaveLength(0);
  expect(harnessed.fetches.filter((url) => url.includes("DASH_AUDIO"))).toHaveLength(1);
  harnessed.cleanup();
});

test("non-MP4 track payloads are rejected before muxing", async () => {
  const harnessed = harness({
    video: new TextEncoder().encode("#EXTM3U\n#EXT-X-VERSION:3\n"),
  });

  await withOnline(async () => {
    const result = await exportVideo(item, harnessed.deps);

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.status).toBe(502);
      expect(result.error).toBe("invalid_media");
    }
  });

  expect(harnessed.muxes).toHaveLength(0);
  harnessed.cleanup();
});

test("prepareVideo returns ready metadata for a cached export", async () => {
  const harnessed = harness();

  await withOnline(async () => {
    const built = await exportVideo(item, harnessed.deps);

    expect(built.ok).toBe(true);

    const prepared = await prepareVideo(item, harnessed.deps);

    expect(prepared).toEqual({ ready: true, bytes: 4096, cached: true });
  });

  harnessed.cleanup();
});

test("prepareVideo reports pending and later joins the same build", async () => {
  const harnessed = harness();
  let release = () => {};

  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const mux: MuxRunner = async (opts) => {
    await gate;
    writeFileSync(opts.output, mp4Bytes(4096));

    return { ok: true };
  };

  const deps = { ...harnessed.deps, mux };

  await withOnline(async () => {
    const pending = await prepareVideo(item, deps, 5);

    expect(pending).toEqual({ ready: false, pending: true });

    release();

    const ready = await prepareVideo(item, deps);

    expect(ready).toEqual({ ready: true, bytes: 4096, cached: false });
  });

  harnessed.cleanup();
});

test("pinned cache files survive eviction", () => {
  const dir = mkdtempSync(join(tmpdir(), "content-hoarder-video-pins-"));
  const pinnedPath = join(dir, "pinned.mp4");
  const evictablePath = join(dir, "evictable.mp4");
  const old = new Date(Date.now() - 60_000);

  writeFileSync(pinnedPath, mp4Bytes(2048));
  writeFileSync(evictablePath, mp4Bytes(2048));
  utimesSync(pinnedPath, old, old);
  utimesSync(evictablePath, old, old);

  const release = pinVideo(pinnedPath);

  sweepVideoCache(dir, 0);

  expect(statSync(pinnedPath, { throwIfNoEntry: false })?.size).toBe(2048);
  expect(statSync(evictablePath, { throwIfNoEntry: false })).toBeUndefined();

  release();
  sweepVideoCache(dir, 0);
  expect(statSync(pinnedPath, { throwIfNoEntry: false })).toBeUndefined();

  rmSync(dir, { recursive: true, force: true });
});

test("download filenames are slugged safe for Content-Disposition", () => {
  const hostile = '../../etc/passwd "quoted"\nname: <script>|?*';
  const name = videoFilename(hostile);

  expect(name.endsWith(".mp4")).toBe(true);
  expect(name).not.toMatch(/["\\/<>:\n\r\t?*|]/);
  expect(name).toMatch(/^[A-Za-z0-9._ -]+\.mp4$/);
  expect(videoFilename("")).toBe("reddit-video.mp4");
  expect(videoFilename("Nice clip")).toBe("Nice clip.mp4");
});

async function generateMedia(
  dir: string,
): Promise<{ video: Uint8Array; audio: Uint8Array; av: Uint8Array } | null> {
  const ffmpeg = Bun.which("ffmpeg");

  if (!ffmpeg) return null;

  const run = async (args: string[]) => {
    const proc = Bun.spawn([ffmpeg, "-v", "error", ...args], {
      stdout: "ignore",
      stderr: "ignore",
    });

    return (await proc.exited) === 0;
  };

  const fragmented = ["-movflags", "frag_keyframe+empty_moov", "-f", "mp4"];

  const videoOk = await run([
    "-f",
    "lavfi",
    "-i",
    "testsrc=duration=1:size=320x240:rate=10",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    ...fragmented,
    join(dir, "video.mp4"),
  ]);

  const audioOk = await run([
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=1",
    "-c:a",
    "aac",
    ...fragmented,
    join(dir, "audio.mp4"),
  ]);

  const avOk = await run([
    "-f",
    "lavfi",
    "-i",
    "testsrc=duration=1:size=320x240:rate=10",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=1",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    ...fragmented,
    join(dir, "av.mp4"),
  ]);

  if (!videoOk || !audioOk || !avOk) return null;

  return {
    video: new Uint8Array(readFileSync(join(dir, "video.mp4"))),
    audio: new Uint8Array(readFileSync(join(dir, "audio.mp4"))),
    av: new Uint8Array(readFileSync(join(dir, "av.mp4"))),
  };
}

async function streamKinds(path: string): Promise<string[]> {
  const ffprobe = Bun.which("ffprobe");

  if (!ffprobe) return [];

  const proc = Bun.spawn(
    [ffprobe, "-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", path],
    { stdout: "pipe", stderr: "ignore" },
  );

  const text = await new Response(proc.stdout).text();

  await proc.exited;

  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

test("real ffmpeg muxes separate video and audio tracks into a valid MP4", async () => {
  const sourceDir = mkdtempSync(join(tmpdir(), "content-hoarder-video-media-"));

  try {
    const media = await generateMedia(sourceDir);
    const ffmpeg = Bun.which("ffmpeg");

    if (!media || !ffmpeg) return;

    const harnessed = harness({ video: media.video, audio: media.audio });

    await withOnline(async () => {
      const result = await exportVideo(item, { ...harnessed.deps, mux: undefined, ffmpeg });

      expect(result.ok).toBe(true);

      if (!result.ok) return;
      expect(statSync(result.path).size).toBeGreaterThan(0);
      expect(readFileSync(result.path).toString("latin1", 4, 8)).toBe("ftyp");

      const kinds = await streamKinds(result.path);

      if (kinds.length) {
        expect(kinds).toContain("video");
        expect(kinds).toContain("audio");
      }
    });

    harnessed.cleanup();
  } finally {
    rmSync(sourceDir, { recursive: true, force: true });
  }
});

test("real ffmpeg keeps embedded audio on a single-input mux", async () => {
  const sourceDir = mkdtempSync(join(tmpdir(), "content-hoarder-video-embedded-"));

  try {
    const media = await generateMedia(sourceDir);
    const ffmpeg = Bun.which("ffmpeg");

    if (!media || !ffmpeg) return;

    const harnessed = harness({
      av: media.av,
      manifest: VIDEO_ONLY_MANIFEST,
    });

    await withOnline(async () => {
      const result = await exportVideo(
        videoItem(item.fullname, "abc123", { reddit_video: { has_audio: false } }),
        { ...harnessed.deps, mux: undefined, ffmpeg },
      );

      expect(result.ok).toBe(true);

      if (!result.ok) return;
      expect(statSync(result.path).size).toBeGreaterThan(0);

      const kinds = await streamKinds(result.path);

      if (kinds.length) expect(kinds).toContain("audio");
    });

    harnessed.cleanup();
  } finally {
    rmSync(sourceDir, { recursive: true, force: true });
  }
});
