import { existsSync, readFileSync } from "node:fs";
import * as z from "zod";
import { newItem, type JsonValue, type Metadata, type RawItem } from "../models.ts";
import { looseRecord, looseText, parseCsv, type BaseConnector, type JsonRecord } from "./base.ts";

const firstText = (...values: (JsonValue | undefined)[]): string => {
  for (const value of values) {
    const text = looseText(value);

    if (text) return text;
  }

  return "";
};

const statusUrl = /https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([^/?#]+)\/status\/(\d+)/i;

const tweetIdFromUrl = (url: string): string => statusUrl.exec(url)?.[2] ?? "";

const permalink = (id: string, handle: string, url: string): string => {
  if (tweetIdFromUrl(url)) return url;

  if (!handle || handle.toLowerCase() === "i") return `https://x.com/i/web/status/${id}`;

  return `https://x.com/${handle}/status/${id}`;
};

const timestamp = (value: string): number => {
  if (!value) return 0;

  if (/^-?\d+(?:\.\d+)?$/.test(value)) {
    const number = Number(value);

    return Math.trunc(number > 1e12 ? number / 1000 : number);
  }

  const parsed = Date.parse(value);

  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
};

const valueArray = z.array(z.json());

const sourceString = z.string();

const values = (value: JsonValue | undefined): JsonValue[] => {
  if (value === undefined || value === null || value === "") return [];
  const array = valueArray.safeParse(value);

  if (array.success) return array.data;
  const string = sourceString.safeParse(value);

  if (!string.success) return [value];
  const source = string.data.trim();

  if (source.startsWith("[")) {
    try {
      const parsed = z.json().safeParse(JSON.parse(source));

      if (parsed.success) {
        const entries = valueArray.safeParse(parsed.data);

        return entries.success ? entries.data : [parsed.data];
      }
    } catch {
      return source ? [source] : [];
    }
  }

  return source ? source.split(/[\n,;]\s*/).filter(Boolean) : [];
};

const extractMediaUrls = (...entries: JsonValue[]): string[] => {
  const result: string[] = [];

  for (const entry of entries) {
    const directUrl = sourceString.safeParse(entry);

    if (directUrl.success) {
      result.push(directUrl.data.trim());
      continue;
    }

    const row = looseRecord(entry);

    if (!row) continue;
    let url = firstText(row.media_url_https, row.media_url, row.url, row.expanded_url);
    const video = looseRecord(row.video_info);
    const parsedVariants = valueArray.safeParse(video?.variants);
    const variants = parsedVariants.success ? parsedVariants.data : [];

    const mp4Variants = variants
      .flatMap((value) => {
        const variant = looseRecord(value);
        const variantUrl = firstText(variant?.url);

        if (
          !variant ||
          !variantUrl.startsWith("http") ||
          !firstText(variant.content_type, variant.url).includes("mp4")
        )
          return [];

        return [{ url: variantUrl, bitrate: Number(variant.bitrate) || 0 }];
      })
      .toSorted((left, right) => right.bitrate - left.bitrate);

    const bestVariant = mp4Variants.at(0);

    if (bestVariant) url = bestVariant.url;

    if (url) result.push(url);
  }

  return [...new Set(result)];
};

const linkUrls = (entries: JsonValue[], text: string): string[] => {
  const links = entries.flatMap((entry) => {
    const directUrl = sourceString.safeParse(entry);

    if (directUrl.success) return [directUrl.data.trim()];
    const row = looseRecord(entry);

    return row ? [firstText(row.expanded_url, row.unwound_url, row.url)].filter(Boolean) : [];
  });

  const inline = (text.match(/https?:\/\/[^\s<>)"']+/g) ?? []).map((url) =>
    url.replace(/[.,;:!?)}\]]+$/, ""),
  );

  return [...new Set([...links, ...inline])];
};

const flatItem = (row: JsonRecord, index?: number): RawItem | null => {
  const url = firstText(row.url, row.permalink, row.tweet_url, row.expanded_url);
  const id = firstText(row.tweet_id, row.id_str, row.rest_id, row.id, tweetIdFromUrl(url));

  if (!/^\d{5,}$/.test(id)) return null;
  const text = firstText(row.full_text, row.text, row.tweet_text, row.body);

  const handle = firstText(
    row.screen_name,
    row.username,
    row.author_handle,
    row.handle,
    statusUrl.exec(url)?.[1],
  ).replace(/^@/, "");

  const authorName = firstText(row.name, row.author_name, row.display_name);

  const media = extractMediaUrls(
    ...[row.media_urls, row.media_url, row.media, row.photos, row.videos].flatMap(values),
  );

  const mediaUrls = media.map((mediaUrl) => {
    if (!mediaUrl.includes("pbs.twimg.com/media/")) return mediaUrl;

    return `${mediaUrl.split("?").at(0) ?? mediaUrl}?name=orig`;
  });

  const outlinks = linkUrls(
    [row.outlinks, row.links, row.urls, row.expanded_urls].flatMap(values),
    text,
  );

  const metadata: Metadata = {
    permalink: permalink(id, handle, url),
    author_handle: handle,
    author_name: authorName,
  };

  const thumbnail = mediaUrls[0];

  if (thumbnail) {
    metadata.media_urls = mediaUrls;
    metadata.media_type = mediaUrls.some((entry) => entry.includes("video.twimg.com/"))
      ? "video"
      : "image";
    metadata.thumbnail = thumbnail;
  }

  if (outlinks.length) metadata.outlinks = outlinks;

  for (const key of [
    "conversation_id",
    "conversation_id_str",
    "in_reply_to_status_id",
    "in_reply_to_status_id_str",
    "in_reply_to_screen_name",
  ] as const) {
    const value = row[key];

    if (value !== undefined && value !== null && value !== "")
      metadata[key.replace(/_str$/, "")] = value;
  }

  if (index !== undefined) metadata.bookmark_index = index;

  return newItem({
    source: "twitter",
    source_id: id,
    kind: "tweet",
    title: text,
    url: String(metadata.permalink),
    author: handle || authorName,
    created_utc: timestamp(firstText(row.created_at, row.createdAt, row.time)),
    metadata,
    raw: row,
  });
};

const parseJsonValue = (source: string): JsonValue | null => {
  const parsed = z.json().safeParse(JSON.parse(source));

  return parsed.success ? parsed.data : null;
};

const collectTweets = (root: JsonValue): RawItem[] => {
  const stack: JsonValue[] = [root];
  const ids = new Set<string>();
  const result: RawItem[] = [];

  while (stack.length) {
    const current = stack.pop();

    if (Array.isArray(current)) {
      for (let index = current.length - 1; index >= 0; index--) {
        const child = current[index];

        if (child !== undefined) stack.push(child);
      }

      continue;
    }

    const row = looseRecord(current);

    if (!row) continue;
    const legacy = looseRecord(row.legacy);
    const core = looseRecord(row.core);
    const userResults = looseRecord(core?.user_results);
    const user = looseRecord(userResults?.result);
    const userLegacy = looseRecord(user?.legacy);
    let candidate: RawItem | null = null;

    const legacyText = legacy ? sourceString.safeParse(legacy.full_text) : null;

    if (legacy && legacyText?.success) {
      const tweetId = firstText(row.rest_id, legacy.id_str, legacy.id);
      const author = firstText(userLegacy?.screen_name, legacy.screen_name);
      const entities = looseRecord(legacy.entities);
      const extended = looseRecord(legacy.extended_entities);

      const flat: JsonRecord = {
        tweet_id: tweetId,
        full_text: legacyText.data,
        url: permalink(tweetId, author, ""),
        screen_name: author,
      };

      if (legacy.created_at !== undefined) flat.created_at = legacy.created_at;

      if (userLegacy?.name !== undefined) flat.author_name = userLegacy.name;
      const media = extended?.media ?? entities?.media;

      if (media !== undefined) flat.media = media;

      if (entities?.urls !== undefined) flat.urls = entities.urls;
      const conversationId = legacy.conversation_id_str ?? legacy.conversation_id;

      if (conversationId !== undefined) flat.conversation_id = conversationId;
      const replyId = legacy.in_reply_to_status_id_str ?? legacy.in_reply_to_status_id;

      if (replyId !== undefined) flat.in_reply_to_status_id = replyId;

      if (legacy.in_reply_to_screen_name !== undefined)
        flat.in_reply_to_screen_name = legacy.in_reply_to_screen_name;
      candidate = flatItem(flat);
    } else candidate = flatItem(row);

    if (candidate) {
      if (!ids.has(candidate.source_id)) {
        ids.add(candidate.source_id);
        result.push(candidate);
      }

      continue;
    }

    for (const [key, child] of Object.entries(row))
      if (key !== "quoted_status_result" && key !== "retweeted_status_result") stack.push(child);
  }

  return result;
};

export class TwitterConnector implements BaseConnector {
  readonly id = "twitter";
  readonly label = "Twitter / X Bookmarks";
  readonly badgeColor = "#1d9bf0";
  canImport(path: string): boolean {
    if (!existsSync(path)) return false;

    try {
      if (path.toLowerCase().endsWith(".json")) {
        const root = parseJsonValue(readFileSync(path, "utf8"));

        return root !== null && collectTweets(root).length > 0;
      }

      if (path.toLowerCase().endsWith(".csv"))
        return parseCsv(readFileSync(path, "utf8"))
          .slice(0, 10)
          .some((row) => flatItem(row));
    } catch {
      return false;
    }

    return false;
  }
  importFile(path: string): RawItem[] {
    try {
      if (path.toLowerCase().endsWith(".json")) {
        const root = parseJsonValue(readFileSync(path, "utf8"));

        return root === null ? [] : collectTweets(root);
      }

      if (!path.toLowerCase().endsWith(".csv")) return [];
      const ids = new Set<string>();

      return parseCsv(readFileSync(path, "utf8")).flatMap((row, index) => {
        const item = flatItem(row, index);

        if (!item || ids.has(item.source_id)) return [];
        ids.add(item.source_id);

        return [item];
      });
    } catch {
      return [];
    }
  }
}
