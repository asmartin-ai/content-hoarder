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
import { importOffThread } from "./import_runner.ts";

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

const PlaylistSummary = z.object({
  id: z.string(),
  snippet: z.object({ title: z.string().default("Playlist") }),
  contentDetails: z.object({ itemCount: z.number().optional() }).optional(),
});

export interface YoutubePlaylistListing {
  id: string;
  title: string;
  count: number | null;
}

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

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

interface Budget {
  left: number;
  deadline?: number;
}

function missedDeadline(deadline: number | undefined): boolean {
  return deadline !== undefined && Date.now() >= deadline;
}

function deadlineSignal(deadline: number | undefined): AbortSignal | undefined {
  if (deadline === undefined) return undefined;

  const remaining = deadline - Date.now();

  return remaining > 0 ? AbortSignal.timeout(remaining) : AbortSignal.abort();
}

async function getJson<T extends z.ZodType>(
  url: string,
  headers: Record<string, string>,
  schema: T,
  signal?: AbortSignal,
): Promise<z.infer<T>> {
  const response = await hostedFetch()(url, { headers, signal });

  if (!response.ok)
    throw new ApiError(`${new URL(url).pathname} answered ${response.status}`, response.status);

  return schema.parse(await response.json());
}

async function youtubePages(
  token: string,
  path: string,
  params: Record<string, string>,
  budget: Budget,
): Promise<JsonRecord[]> {
  const out: JsonRecord[] = [];
  let pageToken = "";

  while (budget.left > 0 && !missedDeadline(budget.deadline)) {
    const query = new URLSearchParams({ ...params, maxResults: "50" });

    if (pageToken) query.set("pageToken", pageToken);

    let page: z.infer<typeof YoutubePage>;

    try {
      page = await getJson(
        `${YOUTUBE_API}/${path}?${query}`,
        { authorization: `Bearer ${token}` },
        YoutubePage,
        deadlineSignal(budget.deadline),
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

function deadlineError(): Error {
  return new Error("youtube deadline reached");
}

export async function listYoutubePlaylists(
  token: string,
  deadline?: number,
): Promise<YoutubePlaylistListing[]> {
  const raw = await youtubePages(
    token,
    "playlists",
    { part: "snippet,contentDetails", mine: "true" },
    { left: 500, deadline },
  );

  if (missedDeadline(deadline)) throw deadlineError();

  const playlists: YoutubePlaylistListing[] = [];

  for (const value of raw) {
    const playlist = PlaylistSummary.safeParse(value);

    if (!playlist.success) continue;

    playlists.push({
      id: playlist.data.id,
      title: playlist.data.snippet.title,
      count: playlist.data.contentDetails?.itemCount ?? null,
    });
  }

  playlists.push({ id: "LL", title: "Liked videos", count: null });

  return playlists;
}

export async function fetchYoutube(
  token: string,
  ids: string[],
  deadline?: number,
): Promise<PulledPlaylist[]> {
  const wanted = new Set(ids);
  const budget = { left: ITEM_CAP, deadline };
  const lists: PulledPlaylist[] = [];

  const playlists = await youtubePages(
    token,
    "playlists",
    { part: "snippet", mine: "true" },
    { left: 500, deadline },
  );

  if (missedDeadline(deadline)) throw deadlineError();

  for (const raw of playlists) {
    const playlist = PlaylistSnippet.safeParse(raw);

    if (!playlist.success || budget.left <= 0 || !wanted.has(playlist.data.id)) continue;

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

  if (missedDeadline(deadline)) throw deadlineError();

  if (budget.left > 0 && wanted.has("LL")) {
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

  if (missedDeadline(deadline)) throw deadlineError();

  return lists;
}

type TwitchFollow = z.infer<typeof TwitchFollows>["data"][number];

type PullFile =
  | { _type: "playlist"; id: string; title: string; entries: PlaylistEntry[] }
  | { schema: typeof TWITCH_FOLLOWS_SCHEMA; follows: TwitchFollow[] };

async function importJson(db: Database, source: string, payload: PullFile): Promise<number> {
  const path = join(tmpdir(), `content-hoarder-pull-${randomBytes(12).toString("hex")}.json`);

  await Bun.write(path, JSON.stringify(payload));

  try {
    return (await importOffThread(db, path, source, { queue: true })).imported;
  } finally {
    try {
      unlinkSync(path);
    } catch {}
  }
}

export async function pullYoutube(
  db: Database,
  token: string,
  ids: string[],
  deadline: number,
  onPlaylistImported: (id: string) => void = () => {},
): Promise<number> {
  const lists = await fetchYoutube(token, ids, deadline);
  let imported = 0;

  for (const list of lists) {
    if (list.entries.length)
      imported += await importJson(db, "youtube", {
        _type: "playlist",
        id: list.id,
        title: list.title,
        entries: list.entries,
      });

    onPlaylistImported(list.id);
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
