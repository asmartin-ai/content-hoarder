import { existsSync, readFileSync } from "node:fs";
import { YTNodes } from "youtubei.js";
import * as z from "zod";
import { newItem, parseMetadata, type JsonValue, type Metadata, type RawItem } from "../models.ts";
import { innertubeClient, innertubePlayer } from "../youtube.ts";
import { jsonRecord, looseRecord, looseText, type BaseConnector, type JsonRecord } from "./base.ts";

const videoId = /(?:v=|youtu\.be\/|\/shorts\/|\/embed\/)([\w-]{6,})/;

const idFrom = (entry: JsonRecord): string =>
  looseText(entry.id) || looseText(entry.videoId) || looseText(entry.url).match(videoId)?.[1] || "";

const metadataObject = (raw: RawItem): Metadata => parseMetadata(raw.metadata);

export class YouTubeConnector implements BaseConnector {
  readonly id = "youtube";
  readonly label = "YouTube";
  readonly badgeColor = "#ff0000";

  canImport(path: string): boolean {
    if (!existsSync(path) || !path.toLowerCase().endsWith(".json")) return false;

    try {
      const parsed = z.json().safeParse(JSON.parse(readFileSync(path, "utf8")));

      if (!parsed.success) return false;
      const root = parsed.data;
      const entries = z.array(jsonRecord).safeParse(root);

      if (entries.success) {
        const first = entries.data.at(0);

        return first ? Boolean(idFrom(first)) : false;
      }

      const playlist = looseRecord(root);
      const playlistEntries = z.array(jsonRecord).safeParse(playlist?.entries);

      return playlist?._type === "playlist" && playlistEntries.success;
    } catch {
      return false;
    }
  }

  importFile(path: string): RawItem[] {
    let root: JsonValue;

    try {
      const parsed = z.json().safeParse(JSON.parse(readFileSync(path, "utf8")));

      if (!parsed.success) return [];
      root = parsed.data;
    } catch {
      return [];
    }

    const playlist = looseRecord(root);
    const isPlaylist = playlist?._type === "playlist";
    const playlistEntries = z.array(jsonRecord).safeParse(playlist?.entries);
    const flatEntries = z.array(jsonRecord).safeParse(root);
    const entries = isPlaylist ? playlistEntries : flatEntries;

    if (!entries.success) return [];
    const title = looseText(playlist?.title) || "playlist";
    const listId = looseText(playlist?.id);
    const out: RawItem[] = [];
    entries.data.forEach((entry, position) => {
      const id = idFrom(entry);

      if (!id) return;

      const channel =
        looseText(entry.channel) ||
        looseText(entry.uploader) ||
        (!isPlaylist ? looseText(entry.author) : "");

      const timestamp = Number(entry.timestamp);

      const metadata: Metadata = {
        channel,
        channel_id: looseText(entry.channel_id) || looseText(entry.uploader_id),
        playlist: isPlaylist ? title : "WL",
        playlist_id: isPlaylist ? listId : "",
        position,
        availability: looseText(entry.availability),
        thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      };

      const duration = z.number().safeParse(entry.duration);

      if (duration.success) metadata.duration = duration.data;
      const viewCount = z.number().safeParse(entry.view_count);

      if (viewCount.success) metadata.view_count = viewCount.data;
      out.push(
        newItem({
          source: this.id,
          source_id: id,
          kind: "video",
          title: looseText(entry.title),
          author: channel,
          url: looseText(entry.url) || `https://youtu.be/${id}`,
          created_utc: Number.isFinite(timestamp) ? Math.trunc(timestamp) : 0,
          metadata,
        }),
      );
    });

    return out;
  }
  async enrich(items: RawItem[]): Promise<RawItem[]> {
    const hydratedAt = Math.floor(Date.now() / 1000);

    // One client for the whole batch: the innertube handshake is paid once, so
    // a video costs a single API call through the guarded transport.
    const client = await innertubeClient();

    return Promise.all(
      items.map(async (item) => {
        try {
          const player = await innertubePlayer(item.source_id, { client });
          const details = player.video_details;

          if (!details) return item;

          const microformat =
            player.microformat instanceof YTNodes.PlayerMicroformat ? player.microformat : null;

          const metadata = metadataObject(item);
          const duration = Number(details.duration);
          const viewCount = Number(details.view_count);
          const parsedTags = z.array(z.string()).safeParse(details.keywords);
          const tags = parsedTags.success ? parsedTags.data.slice(0, 25) : [];
          const description = looseText(details.short_description).slice(0, 2000);
          const channel = looseText(details.author);
          const channelId = looseText(details.channel_id);
          const category = looseText(microformat?.category);
          const uploadDate = looseText(microformat?.upload_date);

          if (Number.isFinite(duration)) metadata.duration = duration;

          if (Number.isFinite(viewCount)) metadata.view_count = viewCount;

          if (tags.length) metadata.tags = tags;

          if (description) metadata.description = description;

          if (channel) metadata.channel = channel;

          if (channelId) metadata.channel_id = channelId;

          if (category) metadata.yt_categories = [category];

          if (uploadDate) metadata.upload_date = uploadDate;
          metadata.availability =
            player.playability_status?.status === "OK" ? "public" : "unavailable";
          const parsedDate = uploadDate ? Date.parse(uploadDate) : Number.NaN;

          return newItem({
            source: item.source,
            source_id: item.source_id,
            kind: item.kind,
            title: looseText(details.title) || item.title,
            body: item.body,
            author: channel || item.author,
            url: item.url,
            created_utc: Number.isFinite(parsedDate)
              ? Math.floor(parsedDate / 1000)
              : item.created_utc,
            saved_utc: item.saved_utc,
            hydrated_at: hydratedAt,
            metadata,
          });
        } catch {
          return item;
        }
      }),
    );
  }
}
