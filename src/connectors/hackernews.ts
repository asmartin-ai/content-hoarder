import { Database } from "bun:sqlite";
import { readFileSync, statSync } from "node:fs";
import * as z from "zod";
import { newItem, parseMetadata, type Metadata, type RawItem } from "../models.ts";
import { sqliteNames, type BaseConnector } from "./base.ts";
import { request } from "../_http.ts";
import * as config from "../config.ts";

const hnItemSchema = z
  .object({
    id: z.number().optional(),
    by: z.string().optional(),
    descendants: z.number().optional(),
    score: z.number().optional(),
    text: z.string().optional(),
    time: z.number().optional(),
    title: z.string().optional(),
    type: z.string().optional(),
    url: z.string().optional(),
  })
  .catchall(z.json());

const hnIds = z.array(z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()]));

const sqliteRow = z.record(z.string(), z.union([z.string(), z.number(), z.null()]));

const readRows = z.array(z.object({ itemid: z.union([z.string(), z.number(), z.null()]) }));

const itemUrl = (id: string): string => `https://news.ycombinator.com/item?id=${id}`;

const itemId = /item\?id=(\d+)/;

const ogImage = (source: string, base: string): string => {
  const head = source.split(/<\/head\s*>/i, 1).at(0) ?? source;

  const keys = [
    "og:image",
    "og:image:url",
    "og:image:secure_url",
    "twitter:image",
    "twitter:image:src",
  ];

  const found = new Map<string, string>();

  for (const tag of head.match(/<meta\b[^>]*>/gi) ?? []) {
    const attrs = new Map<string, string>();

    for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
      const name = match[1]?.toLowerCase();

      if (name) attrs.set(name, match[2] ?? match[3] ?? match[4] ?? "");
    }

    const key = (attrs.get("property") ?? attrs.get("name") ?? "").toLowerCase();
    const content = (attrs.get("content") ?? "").trim();

    if (keys.includes(key) && content && !found.has(key)) found.set(key, content);
  }

  const value = keys.map((key) => found.get(key)).find(Boolean);

  if (!value) return "";

  try {
    return new URL(value.replaceAll("&amp;", "&"), base).toString();
  } catch {
    return "";
  }
};

export async function fetchOgImage(url: string): Promise<string> {
  try {
    const [, headers, raw] = await request(url, {
      headers: { Accept: "text/html,application/xhtml+xml" },
      userAgent: config.get("USER_AGENT"),
      timeout: 10,
      retries: 1,
      jitter: true,
    });

    if (!(headers["content-type"] ?? "").toLowerCase().includes("html")) return "";

    return ogImage(new TextDecoder().decode(raw).slice(0, 262144), url);
  } catch {
    return "";
  }
}

const storyItem = (
  id: string,
  fields: { title?: string; url?: string; time?: number; status?: string; list?: string } = {},
): RawItem => {
  const metadata: Metadata = { hn_url: itemUrl(id) };

  if (fields.list) metadata.hn_list = fields.list;

  return newItem({
    source: "hackernews",
    source_id: id,
    kind: "story",
    title: fields.title ?? "",
    url: fields.url || itemUrl(id),
    created_utc: fields.time ?? 0,
    saved_utc: fields.list === "saved" ? (fields.time ?? 0) : 0,
    status: fields.status,
    metadata,
  });
};

const idsFromHtml = (text: string): string[] =>
  [...text.matchAll(/item\?id=(\d+)/g)].flatMap((match) => (match[1] ? [match[1]] : []));

const decodeEntity = (entity: string): string => {
  switch (entity.toLowerCase()) {
    case "amp":
      return "&";
    case "lt":
      return "<";
    case "gt":
      return ">";
    case "quot":
      return '"';
    case "apos":
      return "'";
    default:
      return "";
  }
};

const decodeHtml = (text: string): string =>
  text
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
      const named = decodeEntity(entity);

      if (named) return named;

      if (!entity.startsWith("#")) return whole;

      const code =
        entity[1]?.toLowerCase() === "x"
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);

      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    })
    .trim();

const rowTag = /<tr\b([^>]*)>/gi;

const titleLink =
  /<span\b[^>]*\bclass=["'][^"']*\btitleline\b[^"']*["'][^>]*>[\s\S]*?<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i;

const attributeOf = (attributes: string, name: string): string => {
  const match = attributes.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i"));

  return decodeHtml(match?.[2] ?? match?.[3] ?? "");
};

const storiesFromHtml = (text: string): Map<string, { title: string; url: string }> => {
  const found = new Map<string, { title: string; url: string }>();

  for (const row of text.matchAll(rowTag)) {
    const attributes = row[1] ?? "";
    const id = attributeOf(attributes, "id");

    if (!attributeOf(attributes, "class").split(/\s+/).includes("athing")) continue;

    if (!/^\d+$/.test(id)) continue;
    const start = (row.index ?? 0) + row[0].length;
    const end = text.indexOf("</tr>", start);

    if (end < 0) continue;
    const link = titleLink.exec(text.slice(start, end));

    if (!link) continue;
    const href = decodeHtml(link[1] ?? "");
    const title = decodeHtml(link[2] ?? "");

    if (title) found.set(id, { title, url: /^https?:\/\//i.test(href) ? href : "" });
  }

  return found;
};

export class HackerNewsConnector implements BaseConnector {
  readonly id = "hackernews";
  readonly label = "Hacker News";
  readonly badgeColor = "#ff6600";
  canImport(path: string): boolean {
    try {
      if (!statSync(path).isFile()) return false;

      if (/\.(db|sqlite|sqlite3)$/i.test(path)) {
        const db = new Database(path, { readonly: true, create: false });

        try {
          return sqliteNames(
            db.query("SELECT name FROM sqlite_master WHERE type='table'").all(),
          ).some((name) => ["favorite", "favorites", "saved"].includes(name.toLowerCase()));
        } finally {
          db.close();
        }
      }

      if (/\.html?$/i.test(path))
        return readFileSync(path, "utf8").slice(0, 16384).includes("news.ycombinator.com");

      if (path.toLowerCase().endsWith(".json")) {
        const value: unknown = JSON.parse(readFileSync(path, "utf8"));
        const parsed = hnIds.safeParse(value);

        return parsed.success && parsed.data.length > 0;
      }
    } catch {
      return false;
    }

    return false;
  }
  importFile(path: string): RawItem[] {
    try {
      if (/\.(db|sqlite|sqlite3)$/i.test(path)) return this.fromDatabase(path);
      let ids: string[] = [];
      let stories = new Map<string, { title: string; url: string }>();

      if (/\.html?$/i.test(path)) {
        const source = readFileSync(path, "utf8");

        stories = storiesFromHtml(source);
        ids = idsFromHtml(source);
      } else if (path.toLowerCase().endsWith(".json")) {
        const value: unknown = JSON.parse(readFileSync(path, "utf8"));

        if (Array.isArray(value)) {
          const parsed = hnIds.safeParse(value);

          if (parsed.success) ids = parsed.data.map(String);
        }
      } else if (path.toLowerCase().endsWith(".txt"))
        ids = [...readFileSync(path, "utf8").matchAll(/\b(\d{4,})\b/g)].flatMap((match) =>
          match[1] ? [match[1]] : [],
        );

      return [...new Set(ids.map((id) => id.trim()).filter(Boolean))].map((id) => {
        const story = stories.get(id);

        return story ? storyItem(id, story) : storyItem(id);
      });
    } catch {
      return [];
    }
  }
  private fromDatabase(path: string): RawItem[] {
    const db = new Database(path, { readonly: true, create: false });

    try {
      const tables = sqliteNames(
        db.query("SELECT name FROM sqlite_master WHERE type='table'").all(),
      );

      const favorite = tables.find((name) =>
        ["favorite", "favorites", "saved"].includes(name.toLowerCase()),
      );

      const items: RawItem[] = [];
      const seen = new Set<string>();

      if (favorite) {
        const columns = sqliteNames(
          db.query(`PRAGMA table_info(${JSON.stringify(favorite)})`).all(),
        );

        const lookup = new Map(columns.map((column) => [column.toLowerCase(), column]));

        const idColumn = ["itemid", "item_id", "story_id", "id", "_id"]
          .map((key) => lookup.get(key))
          .find(Boolean);

        const titleColumn = lookup.get("title"),
          urlColumn = lookup.get("url");

        const timeColumn = lookup.get("time") ?? lookup.get("timestamp") ?? lookup.get("created");

        if (idColumn)
          for (const raw of db.query(`SELECT * FROM ${JSON.stringify(favorite)}`).all()) {
            const value = sqliteRow.safeParse(raw);

            if (!value.success) continue;
            const row = value.data;
            let id = String(row[idColumn] ?? "");
            const url = urlColumn ? String(row[urlColumn] ?? "") : "";

            if (!/^\d+$/.test(id)) id = itemId.exec(url)?.[1] ?? "";

            if (!id || seen.has(id)) continue;
            seen.add(id);
            let time = Number(timeColumn ? row[timeColumn] : 0) || 0;

            if (time > 1e12) time = Math.floor(time / 1000);
            items.push(
              storyItem(id, {
                title: titleColumn ? String(row[titleColumn] ?? "") : "",
                url,
                time,
                list: "saved",
              }),
            );
          }
      }

      if (
        tables.includes("read") &&
        sqliteNames(db.query("PRAGMA table_info('read')").all()).some(
          (name) => name.toLowerCase() === "itemid",
        )
      ) {
        for (const row of readRows.parse(db.query("SELECT itemid FROM read").all())) {
          const id = String(row.itemid);

          if (!/^\d+$/.test(id) || seen.has(id)) continue;
          seen.add(id);
          items.push(storyItem(id, { status: "archived", list: "read" }));
        }
      }

      return items;
    } finally {
      db.close();
    }
  }
  async enrich(items: RawItem[]): Promise<RawItem[]> {
    return Promise.all(
      items.map(async (item) => {
        if (!item.source_id) return item;

        try {
          const [, , raw] = await request(
            `https://hacker-news.firebaseio.com/v0/item/${item.source_id}.json`,
            { userAgent: config.get("USER_AGENT"), timeout: 10 },
          );

          const value: unknown = JSON.parse(new TextDecoder().decode(raw));
          const parsed = hnItemSchema.safeParse(value);

          if (!parsed.success) return item;
          const data = parsed.data;

          const metadata: Metadata = {
            ...parseMetadata(item.metadata),
            hn_url: itemUrl(item.source_id),
          };

          if (data.score !== undefined) metadata.score = data.score;

          if (data.descendants !== undefined) metadata.descendants = data.descendants;
          const articleUrl = data.url ?? item.url;

          if (
            articleUrl.startsWith("http") &&
            !articleUrl.toLowerCase().includes("news.ycombinator.com/item?id=") &&
            !metadata.og_image
          ) {
            metadata.og_image ||= await fetchOgImage(articleUrl);
          }

          return newItem({
            source: "hackernews",
            source_id: item.source_id,
            kind: data.type ?? "story",
            title: data.title ?? item.title,
            body: data.text ?? "",
            url: data.url ?? (item.url || itemUrl(item.source_id)),
            author: data.by ?? "",
            created_utc: data.time ?? 0,
            hydrated_at: Math.floor(Date.now() / 1000),
            metadata,
            raw: data,
          });
        } catch {
          return item;
        }
      }),
    );
  }
}
