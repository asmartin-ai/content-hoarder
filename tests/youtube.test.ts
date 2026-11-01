import { expect, test } from "bun:test";
import { withOnline } from "./network.ts";
import {
  guardedPreconnect,
  mapYouTubePlaylist,
  parseYouTubeUrl,
  youtubeFetch,
} from "../src/youtube";

test("YouTube URL parsing accepts only supported video and playlist targets", () => {
  expect(parseYouTubeUrl("https://www.youtube.com/watch?v=abc12345678")).toEqual({
    kind: "video",
    videoId: "abc12345678",
  });
  expect(parseYouTubeUrl("https://youtu.be/abc12345678")).toEqual({
    kind: "video",
    videoId: "abc12345678",
  });
  expect(parseYouTubeUrl("https://youtube.com/playlist?list=PL123456")).toEqual({
    kind: "playlist",
    playlistId: "PL123456",
  });
  expect(() => parseYouTubeUrl("https://example.com/watch?v=abc12345678")).toThrow(
    "Only YouTube playlist or video URLs are supported here.",
  );
});

test("YouTube playlist mapping preserves connector-compatible entry fields", () => {
  expect(
    mapYouTubePlaylist("Watch Later", "WL", [
      {
        id: "video_123",
        title: "Saved video",
        author: "Creator",
        authorId: "UC123",
        duration: 42,
        viewCount: 1200,
      },
      { id: "bad/id" },
    ]),
  ).toEqual({
    _type: "playlist",
    title: "Watch Later",
    id: "WL",
    entries: [
      {
        id: "video_123",
        title: "Saved video",
        uploader: "Creator",
        channel: "Creator",
        channel_id: "UC123",
        duration: 42,
        view_count: 1200,
        availability: "",
        url: "https://www.youtube.com/watch?v=video_123",
        thumbnail: "https://i.ytimg.com/vi/video_123/hqdefault.jpg",
      },
    ],
  });
});

test("the YouTube transport refuses loopback and reserved targets", async () => {
  let hits = 0;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      hits++;

      return new Response("ytInitialPlayerResponse = {};");
    },
  });

  try {
    for (const url of [
      `http://127.0.0.1:${server.port}/youtubei/v1/player`,
      "http://169.254.169.254/latest/meta-data/",
      "http://localhost:8788/",
      "http://10.0.0.1/",
    ])
      await expect(youtubeFetch(url)).rejects.toMatchObject({ kind: "url" });

    expect(hits).toBe(0);
  } finally {
    server.stop(true);
  }
});

test("the YouTube preconnect guard refuses reserved targets and forwards safe ones", () => {
  const calls: Array<[string, Parameters<typeof fetch.preconnect>[1]]> = [];

  const spy = (url: string | URL, options?: Parameters<typeof fetch.preconnect>[1]) => {
    calls.push([String(url), options]);
  };

  for (const url of [
    "http://127.0.0.1:8788/",
    "http://[::1]:8788/",
    "http://169.254.169.254/",
    "http://localhost:8788/",
  ])
    expect(() => guardedPreconnect(url, undefined, spy)).toThrow(/blocked YouTube preconnect URL/);

  expect(calls).toEqual([]);

  return withOnline(() => {
    guardedPreconnect("https://www.youtube.com/", { dns: true, tcp: true }, spy);
    expect(calls).toEqual([["https://www.youtube.com/", { dns: true, tcp: true }]]);
  });
});
