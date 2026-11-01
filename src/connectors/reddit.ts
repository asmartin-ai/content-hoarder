import { Database } from "bun:sqlite";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import * as z from "zod";
import { newItem, type JsonValue, type Metadata, type RawItem } from "../models.ts";
import {
  looseRecord,
  looseText,
  parseCsv,
  sqliteNames,
  type BaseConnector,
  type JsonRecord,
} from "./base.ts";

const sqliteText = z.union([z.string(), z.number(), z.null()]);

const sqliteRedditRows = z.array(
  z
    .object({
      fullname: sqliteText.optional(),
      reddit_id: sqliteText.optional(),
      permalink: sqliteText.optional(),
      kind: sqliteText.optional(),
      subreddit: sqliteText.optional(),
      score: sqliteText.optional(),
      over_18: sqliteText.optional(),
      num_comments: sqliteText.optional(),
      title: sqliteText.optional(),
      body: sqliteText.optional(),
      selftext: sqliteText.optional(),
      url: sqliteText.optional(),
      author: sqliteText.optional(),
      created_utc: sqliteText.optional(),
      saved_utc: sqliteText.optional(),
    })
    .passthrough(),
);

const redditFieldsSchema = z.object({
  subreddit: z.string().optional(),
  score: z.union([z.number(), z.string()]).transform(Number).pipe(z.number().finite()).optional(),
});

export function previewThumb(value: JsonValue): string {
  const record = looseRecord(value);

  if (!record) return "";
  const preview = looseRecord(record.preview);
  const images = z.array(z.json()).safeParse(preview?.images);
  const first = looseRecord(images.success ? images.data.at(0) : undefined);
  const source = looseRecord(first?.source);
  const imageUrl = z.string().safeParse(source?.url);

  if (imageUrl.success) return imageUrl.data.replaceAll("&amp;", "&");
  const thumbnail = looseText(record.thumbnail);

  return thumbnail.startsWith("http") ? thumbnail : "";
}

const finiteNumber = (value: string | number | null | undefined): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : null;
};

const commentPermalink = /\/comments\/([a-z0-9]+)\/[^/]*\/([a-z0-9]+)/i;

const postPermalink = /\/comments\/([a-z0-9]+)/i;

const subredditPermalink = /\/r\/([^/]+)\//i;

export const sidFromPermalink = (permalink: string): string => {
  const comment = commentPermalink.exec(permalink);

  if (comment?.[2]) return `t1_${comment[2]}`;
  const post = postPermalink.exec(permalink);

  return post?.[1] ? `t3_${post[1]}` : "";
};

const titleFrom = (permalink: string): string => {
  const slug =
    permalink
      .match(/\/comments\/[a-z0-9]+\/([^/]+)/i)?.[1]
      ?.replace(/[_-]/g, " ")
      .trim() ?? "";

  return slug ? slug.charAt(0).toUpperCase() + slug.slice(1) : "";
};

const cleanUrl = (url: string, permalink: string): string => {
  if (url) return url;

  if (!permalink) return "";

  if (/^https?:\/\//.test(permalink)) return permalink;

  if (permalink.startsWith("https//")) return `https://${permalink.slice(7)}`;

  if (permalink.startsWith("http//")) return `http://${permalink.slice(6)}`;

  if (permalink.startsWith("/")) return `https://www.reddit.com${permalink}`;

  if (permalink.startsWith("www.")) return `https://${permalink}`;

  return `https://www.reddit.com/${permalink}`;
};

const classifyMedia = (
  metadata: Metadata,
  sourceUrl: string,
  permalink: string,
  body: string,
  kind: string,
): string => {
  const url = cleanUrl(sourceUrl, permalink);
  const lower = url.toLowerCase();

  const mediaType = !url
    ? ""
    : lower.includes("v.redd.it")
      ? "reddit_video"
      : lower.includes("i.redd.it") || /\.(png|jpe?g|gif|gifv|webp|bmp)(?:\?|$)/i.test(url)
        ? "image"
        : /youtube\.com|youtu\.be/.test(lower)
          ? "youtube"
          : "link";

  if (mediaType === "reddit_video") {
    metadata.media_type = mediaType;

    if (url) metadata.media_url = url;

    return cleanUrl("", permalink) || url;
  }

  if (mediaType === "image" || mediaType === "youtube") {
    metadata.media_type = mediaType;

    return url;
  }

  if (mediaType === "link") {
    metadata.media_type =
      lower.includes("reddit.com") && kind === "post" && !body.trim() ? "reddit_media" : "link";

    return url;
  }

  if (kind === "post" && !body.trim()) metadata.media_type = "reddit_media";

  return cleanUrl("", permalink);
};

export const childToItem = (
  value: JsonValue,
  options: { savedSeenUtc?: number } = {},
): RawItem | null => {
  const child = looseRecord(value);

  if (!child) return null;
  const data = looseRecord(child.data) ?? child;
  const permalink = looseText(data.permalink);

  const id =
    looseText(data.name) ||
    sidFromPermalink(permalink) ||
    (looseText(data.id) ? `${child.kind === "t1" ? "t1_" : "t3_"}${looseText(data.id)}` : "");

  if (!id) return null;
  const kind = id.startsWith("t1_") ? "comment" : "post";
  const body = looseText(data.selftext) || looseText(data.body);
  const metadata: Metadata = {};

  const redditFields = redditFieldsSchema.safeParse(data);

  if (redditFields.success && redditFields.data.subreddit)
    metadata.subreddit = redditFields.data.subreddit;

  if (redditFields.success && redditFields.data.score !== undefined)
    metadata.score = redditFields.data.score;

  if (permalink) metadata.permalink = permalink;

  if (data.over_18 !== undefined && data.over_18 !== null) metadata.over_18 = data.over_18 ? 1 : 0;
  const thumbnail = previewThumb(data);

  if (thumbnail) metadata.thumbnail = thumbnail;

  if (options.savedSeenUtc !== undefined) metadata.saved_seen_utc = options.savedSeenUtc;
  const url = classifyMedia(metadata, looseText(data.url), permalink, body, kind);

  return newItem({
    source: "reddit",
    source_id: id,
    kind,
    title: looseText(data.title) || titleFrom(permalink),
    body,
    url,
    author: looseText(data.author),
    created_utc: Number(data.created_utc) || 0,
    metadata,
    raw: data,
  });
};

const tableItems = (rows: JsonRecord[], seenAt = Math.floor(Date.now() / 1000)): RawItem[] => {
  return rows.flatMap((raw) => {
    const normalized = Object.fromEntries(
      Object.entries(raw).map(([key, value]) => [
        key.trim().toLowerCase(),
        looseText(value).trim(),
      ]),
    );

    const permalink = String(normalized.permalink ?? "");
    let id = String(normalized.fullname ?? "");
    const rawId = String(normalized.id ?? "");

    if (!id && rawId)
      id = /^t[13]_/.test(rawId)
        ? rawId
        : `${commentPermalink.test(permalink) ? "t1_" : "t3_"}${rawId}`;

    if (!id) id = sidFromPermalink(permalink);

    if (!id) return [];
    const kind = id.startsWith("t1_") ? "comment" : "post";
    const metadata: Metadata = {};
    const subreddit = String(normalized.subreddit ?? subredditPermalink.exec(permalink)?.[1] ?? "");

    if (subreddit) metadata.subreddit = subreddit;

    if (permalink) metadata.permalink = permalink;

    const score = Number(normalized.score);

    if (normalized.score && Number.isFinite(score)) metadata.score = score;
    const commentCount = Number(normalized.numcomments ?? normalized.num_comments);

    if (Number.isFinite(commentCount) && (normalized.numcomments || normalized.num_comments))
      metadata.num_comments = commentCount;
    const over18 = String(normalized.over18 ?? normalized.over_18 ?? "").toLowerCase();

    if (over18) metadata.over_18 = ["true", "1", "yes"].includes(over18) ? 1 : 0;

    if (normalized.domain) metadata.domain = normalized.domain;
    metadata.saved_seen_utc = seenAt;
    const body = String(normalized.body ?? normalized.selftext ?? "");
    const url = classifyMedia(metadata, String(normalized.url ?? ""), permalink, body, kind);

    return [
      newItem({
        source: "reddit",
        source_id: id,
        kind,
        title: String(normalized.title ?? (kind === "post" ? titleFrom(permalink) : "")),
        body,
        url,
        author: String(normalized.author ?? ""),
        created_utc: Number(normalized.createdutc ?? normalized.created_utc) || 0,
        saved_utc: Number(normalized.saved_utc ?? normalized.savedutc) || 0,
        metadata,
      }),
    ];
  });
};

const readJsonItems = (path: string): RawItem[] => {
  const parsed = z.json().safeParse(JSON.parse(readFileSync(path, "utf8")));

  if (!parsed.success) return [];
  const data = parsed.data;
  const object = looseRecord(data);

  if (
    object &&
    !looseRecord(object.data) &&
    ["permalink", "name", "subreddit"].some((key) => key in object)
  ) {
    const item = childToItem(object);

    return item ? [item] : [];
  }

  const nested = looseRecord(object?.data);
  const nestedChildren = z.array(z.json()).safeParse(nested?.children);
  const rootChildren = z.array(z.json()).safeParse(data);

  const children = nestedChildren.success
    ? nestedChildren.data
    : rootChildren.success
      ? rootChildren.data
      : [];

  return children.flatMap((child) => {
    const item = childToItem(child);

    return item ? [item] : [];
  });
};

const zipFiles = (path: string): Map<string, string> => {
  const bytes = readFileSync(path);
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const files = new Map<string, string>();

  if (end < 0 || end + 22 > bytes.length) return files;
  const entries = bytes.readUInt16LE(end + 10);
  let offset = bytes.readUInt32LE(end + 16);

  for (let index = 0; index < entries; index++) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== 0x02014b50) break;
    const method = bytes.readUInt16LE(offset + 10);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    offset += 46 + nameLength + extraLength + commentLength;
    const filename = name.split(/[\\/]/).at(-1);

    if (!filename || !["saved_posts.csv", "saved_comments.csv"].includes(filename)) continue;

    if (localOffset + 30 > bytes.length) continue;
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;

    if (dataStart + compressedSize > bytes.length) continue;
    const compressed = bytes.subarray(dataStart, dataStart + compressedSize);
    const decoded = method === 0 ? compressed : method === 8 ? inflateRawSync(compressed) : null;

    if (decoded) files.set(name, decoded.toString("utf8"));
  }

  return files;
};

export class RedditConnector implements BaseConnector {
  readonly id = "reddit";
  readonly label = "Reddit";
  readonly badgeColor = "#ff4500";
  canImport(path: string): boolean {
    try {
      if (statSync(path).isDirectory())
        return this.walk(path)
          .slice(0, 50)
          .some((file) => this.looksReddit(file));

      if (/\.(db|sqlite|sqlite3)$/i.test(path)) return this.hasItemsTable(path);

      if (path.toLowerCase().endsWith(".csv")) return true;

      if (path.toLowerCase().endsWith(".json")) return this.looksReddit(path);

      if (path.toLowerCase().endsWith(".zip")) return zipFiles(path).size > 0;

      if (/\.(html?|xlsx?)$/i.test(path)) {
        const source = readFileSync(path, "utf8").slice(0, 16384).toLowerCase();

        return (
          source.includes("reddit") &&
          (source.includes("/comments/") ||
            (source.includes("<table") &&
              (source.includes("permalink") || source.includes("createdutc"))))
        );
      }

      return false;
    } catch {
      return false;
    }
  }
  importFile(path: string): RawItem[] {
    try {
      if (statSync(path).isDirectory())
        return this.walk(path).flatMap((file) => this.safeJson(file));

      if (/\.(db|sqlite|sqlite3)$/i.test(path)) return this.fromDatabase(path);

      if (path.toLowerCase().endsWith(".csv"))
        return tableItems(parseCsv(readFileSync(path, "utf8")));

      if (path.toLowerCase().endsWith(".json")) return this.safeJson(path);

      if (path.toLowerCase().endsWith(".zip")) {
        const importedAt = Math.floor(Date.now() / 1000);

        return [...zipFiles(path).values()].flatMap((csv) => tableItems(parseCsv(csv), importedAt));
      }

      if (/\.(html?|xlsx?)$/i.test(path)) return this.fromHtml(readFileSync(path, "utf8"));
    } catch {
      return [];
    }

    return [];
  }
  private walk(path: string): string[] {
    const files: string[] = [];

    const visit = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const target = `${dir}/${entry.name}`;

        if (entry.isDirectory()) visit(target);
        else if (entry.isFile() && entry.name.toLowerCase().endsWith(".json")) files.push(target);
      }
    };

    visit(path);

    return files.sort();
  }
  private looksReddit(path: string): boolean {
    try {
      const source = readFileSync(path, "utf8").slice(0, 8192);

      return ['"permalink"', '"subreddit"', '"kind": "t3', '"kind":"t3'].some((marker) =>
        source.includes(marker),
      );
    } catch {
      return false;
    }
  }
  private safeJson(path: string): RawItem[] {
    try {
      return readJsonItems(path);
    } catch {
      return [];
    }
  }
  private hasItemsTable(path: string): boolean {
    const db = new Database(path, { readonly: true, create: false });

    try {
      const tables = sqliteNames(
        db.query("SELECT name FROM sqlite_master WHERE type='table'").all(),
      );

      if (!tables.some((name) => name.toLowerCase() === "items")) return false;

      const columns = sqliteNames(db.query("PRAGMA table_info(items)").all());

      return (
        (columns.includes("permalink") || columns.includes("subreddit")) &&
        !columns.includes("source_id")
      );
    } finally {
      db.close();
    }
  }
  private fromDatabase(path: string): RawItem[] {
    const db = new Database(path, { readonly: true, create: false });

    try {
      return sqliteRedditRows.parse(db.query("SELECT * FROM items").all()).flatMap((data) => {
        const permalink = looseText(data.permalink);

        const id =
          looseText(data.fullname) || looseText(data.reddit_id) || sidFromPermalink(permalink);

        if (!id) return [];
        const kind = looseText(data.kind) || (id.startsWith("t1_") ? "comment" : "post");
        const metadata: Metadata = {};

        const subredditValue = looseText(data.subreddit);

        if (subredditValue) metadata.subreddit = subredditValue;

        if (permalink) metadata.permalink = permalink;
        const score = finiteNumber(data.score);

        if (score !== null) metadata.score = score;
        const over18 = looseText(data.over_18).toLowerCase();

        if (over18) metadata.over_18 = ["true", "1", "yes"].includes(over18) ? 1 : 0;
        const commentCount = finiteNumber(data.num_comments);

        if (commentCount !== null) metadata.num_comments = commentCount;
        const redditId = looseText(data.reddit_id);

        if (redditId) metadata.reddit_id = redditId;
        const subreddit = subredditPermalink.exec(permalink)?.[1];

        if (!metadata.subreddit && subreddit) metadata.subreddit = subreddit;

        if (permalink && !metadata.permalink) metadata.permalink = permalink;
        const body = looseText(data.body) || looseText(data.selftext);
        const url = classifyMedia(metadata, looseText(data.url), permalink, body, kind);

        return [
          newItem({
            source: "reddit",
            source_id: id,
            kind,
            title: looseText(data.title) || titleFrom(permalink),
            body,
            url,
            author: looseText(data.author),
            created_utc: Number(data.created_utc) || 0,
            saved_utc: Number(data.saved_utc) || 0,
            metadata,
          }),
        ];
      });
    } finally {
      db.close();
    }
  }
  private fromHtml(source: string): RawItem[] {
    if (/<table\b/i.test(source)) {
      const table = source.match(/<table\b[\s\S]*?<\/table>/i)?.[0] ?? "";

      const rows = [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((match) =>
        [...(match[1] ?? "").matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((cell) =>
          (cell[1] ?? "")
            .replace(/<[^>]+>/g, "")
            .replace(/&amp;/g, "&")
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .trim(),
        ),
      );

      const headers = rows[0]?.map((header) => header.toLowerCase()) ?? [];

      const data = rows
        .slice(1)
        .map((cells) =>
          Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""])),
        );

      if (headers.length && data.length) return tableItems(data);
    }

    const result: RawItem[] = [];
    const seen = new Set<string>();

    for (const block of source.split(/<\/li>/i)) {
      const links = [...block.matchAll(/<a\s+[^>]*href=['"]([^'"]+)['"][^>]*>(.*?)<\/a>/gis)];

      const permalink =
        links
          .flatMap((link) => (link[1] ? [link[1]] : []))
          .find((url) => url.toLowerCase().includes("reddit.com") && url.includes("/comments/")) ??
        "";

      const id = sidFromPermalink(permalink);

      if (!id || seen.has(id)) continue;
      seen.add(id);
      const rawUrl = links[0]?.[1] === permalink ? "" : (links[0]?.[1] ?? "");

      const title = (links[0]?.[2] ?? "")
        .replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/\s+/g, " ")
        .trim();

      const metadata: Metadata = { permalink };
      const subreddit = subredditPermalink.exec(permalink)?.[1];

      if (subreddit) metadata.subreddit = subreddit;
      const kind = id.startsWith("t1_") ? "comment" : "post";
      result.push(
        newItem({
          source: "reddit",
          source_id: id,
          kind,
          title: title || titleFrom(permalink),
          url: classifyMedia(metadata, rawUrl, permalink, "", kind),
          metadata,
        }),
      );
    }

    return result;
  }
}
