import { randomBytes } from "node:crypto";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import * as config from "./config.ts";
import { TWITCH_FOLLOWS_SCHEMA } from "./connectors/twitch.ts";
import type { JsonRecord } from "./connectors/base.ts";
import { hostedFetch } from "./hosted.ts";
import { importPath } from "./pipeline.ts";

const YOUTUBE_API = "https://www.googleapis.com/youtube/v3";

const TWITCH_API = "https://api.twitch.tv/helix";

const ITEM_CAP = 5000;

const YoutubePage = z.object({
  nextPageToken: z.string().optional(),
  items: z.array(z.record(z.string(), z.json())).default([]),
});

const PlaylistSnippet = z.object({
  id: z.string(),
  snippet: z.object({ title: z.string().default("Playlist") }),
});

const PlaylistItem = z.object({
  snippet: z.object({
    title: z.string().default(""),
    videoOwnerChannelTitle: z.string().optional(),
    videoOwnerChannelId: z.string().optional(),
    publishedAt: z.string().optional(),
    resourceId: z.object({ videoId: z.string().optional() }).optional(),
  }),
});

const LikedVideo = z.object({
  id: z.string(),
  snippet: z.object({
    title: z.string().default(""),
    channelTitle: z.string().optional(),
    channelId: z.string().optional(),
  }),
});

export interface PlaylistEntry {
  id: string;
  title: string;
  channel: string;
  channel_id: string;
  timestamp?: number;
}

export interface PulledPlaylist {
  id: string;
  title: string;
  entries: PlaylistEntry[];
}

const HIDDEN_TITLES = new Set(["Private video", "Deleted video"]);

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function getJson<T extends z.ZodType>(
  url: string,
  headers: Record<string, string>,
  schema: T,
): Promise<z.infer<T>> {
  const response = await hostedFetch()(url, { headers });

  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 300);

    throw new ApiError(
      `${new URL(url).pathname} answered ${response.status}: ${detail}`,
      response.status,
    );
  }

  return schema.parse(await response.json());
}

async function youtubePages(
  token: string,
  path: string,
  params: Record<string, string>,
  budget: { left: number },
): Promise<JsonRecord[]> {
  const out: JsonRecord[] = [];
  let pageToken = "";

  while (budget.left > 0) {
    const query = new URLSearchParams({ ...params, maxResults: "50" });

    if (pageToken) query.set("pageToken", pageToken);

    let page: z.infer<typeof YoutubePage>;

    try {
      page = await getJson(
        `${YOUTUBE_API}/${path}?${query}`,
        { authorization: `Bearer ${token}` },
        YoutubePage,
      );
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) break;
      throw error;
    }

    for (const item of page.items.slice(0, budget.left)) out.push(item);
    budget.left -= page.items.length;

    if (!page.nextPageToken) break;
    pageToken = page.nextPageToken;
  }

  return out;
}

export async function fetchYoutube(token: string): Promise<PulledPlaylist[]> {
  const budget = { left: ITEM_CAP };
  const lists: PulledPlaylist[] = [];

  const playlists = await youtubePages(
    token,
    "playlists",
    { part: "snippet", mine: "true" },
    { left: 500 },
  );

  for (const raw of playlists) {
    const playlist = PlaylistSnippet.safeParse(raw);

    if (!playlist.success || budget.left <= 0) continue;

    const items = await youtubePages(
      token,
      "playlistItems",
      { part: "snippet", playlistId: playlist.data.id },
      budget,
    );

    const entries: PlaylistEntry[] = [];

    for (const value of items) {
      const item = PlaylistItem.safeParse(value);
      const id = item.success ? item.data.snippet.resourceId?.videoId : undefined;

      if (!item.success || !id || HIDDEN_TITLES.has(item.data.snippet.title)) continue;
      const added = Date.parse(item.data.snippet.publishedAt ?? "");

      const entry: PlaylistEntry = {
        id,
        title: item.data.snippet.title,
        channel: item.data.snippet.videoOwnerChannelTitle ?? "",
        channel_id: item.data.snippet.videoOwnerChannelId ?? "",
      };

      if (Number.isFinite(added)) entry.timestamp = Math.floor(added / 1000);
      entries.push(entry);
    }

    lists.push({ id: playlist.data.id, title: playlist.data.snippet.title, entries });
  }

  if (budget.left > 0) {
    const liked = await youtubePages(
      token,
      "videos",
      { part: "snippet", myRating: "like" },
      budget,
    );

    const entries: PlaylistEntry[] = [];

    for (const value of liked) {
      const video = LikedVideo.safeParse(value);

      if (!video.success) continue;

      entries.push({
        id: video.data.id,
        title: video.data.snippet.title,
        channel: video.data.snippet.channelTitle ?? "",
        channel_id: video.data.snippet.channelId ?? "",
      });
    }

    lists.push({ id: "LL", title: "Liked videos", entries });
  }

  return lists.filter((list) => list.entries.length);
}

type TwitchFollow = z.infer<typeof TwitchFollows>["data"][number];

type PullFile =
  | { _type: "playlist"; id: string; title: string; entries: PlaylistEntry[] }
  | { schema: typeof TWITCH_FOLLOWS_SCHEMA; follows: TwitchFollow[] };

async function importJson(db: Database, source: string, payload: PullFile): Promise<number> {
  const path = join(tmpdir(), `content-hoarder-pull-${randomBytes(12).toString("hex")}.json`);

  await Bun.write(path, JSON.stringify(payload));

  try {
    return (await importPath(db, path, { source })).imported;
  } finally {
    try {
      unlinkSync(path);
    } catch {}
  }
}

export async function pullYoutube(db: Database, token: string): Promise<number> {
  let imported = 0;

  for (const list of await fetchYoutube(token)) {
    imported += await importJson(db, "youtube", {
      _type: "playlist",
      id: list.id,
      title: list.title,
      entries: list.entries,
    });
  }

  return imported;
}

const TwitchUsers = z.object({ data: z.array(z.object({ id: z.string() })).min(1) });

const TwitchFollows = z.object({
  data: z
    .array(
      z.object({
        broadcaster_id: z.string(),
        broadcaster_login: z.string(),
        broadcaster_name: z.string(),
        followed_at: z.string().optional(),
      }),
    )
    .default([]),
  pagination: z.object({ cursor: z.string().optional() }).default({}),
});

export async function fetchTwitchFollows(token: string): Promise<TwitchFollow[]> {
  const headers = {
    authorization: `Bearer ${token}`,
    "client-id": config.get("TWITCH_OAUTH_CLIENT_ID").trim(),
  };

  const user = (await getJson(`${TWITCH_API}/users`, headers, TwitchUsers)).data[0];

  if (!user) return [];

  const follows: TwitchFollow[] = [];
  let cursor = "";

  while (follows.length < ITEM_CAP) {
    const query = new URLSearchParams({ user_id: user.id, first: "100" });

    if (cursor) query.set("after", cursor);

    const page = await getJson(`${TWITCH_API}/channels/followed?${query}`, headers, TwitchFollows);

    follows.push(...page.data);

    if (!page.pagination.cursor || !page.data.length) break;
    cursor = page.pagination.cursor;
  }

  return follows;
}

export async function pullTwitch(db: Database, token: string): Promise<number> {
  const follows = await fetchTwitchFollows(token);

  if (!follows.length) return 0;

  return importJson(db, "twitch", { schema: TWITCH_FOLLOWS_SCHEMA, follows });
}
