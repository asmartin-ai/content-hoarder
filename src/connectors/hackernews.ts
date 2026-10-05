import { Database } from "bun:sqlite";
import { readFileSync, statSync } from "node:fs";
import * as z from "zod";
import { newItem, parseMetadata, type Metadata, type RawItem } from "../models.ts";
import type { BaseConnector } from "./base.ts";

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

const sqliteNames = z.array(z.object({ name: z.string() }));

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
          return sqliteNames
            .parse(db.query("SELECT name FROM sqlite_master WHERE type='table'").all())
            .some((entry) => ["favorite", "favorites", "saved"].includes(entry.name.toLowerCase()));
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

      if (/\.html?$/i.test(path)) ids = idsFromHtml(readFileSync(path, "utf8"));
      else if (path.toLowerCase().endsWith(".json")) {
        const value: unknown = JSON.parse(readFileSync(path, "utf8"));

        if (Array.isArray(value)) {
          const parsed = hnIds.safeParse(value);

          if (parsed.success) ids = parsed.data.map(String);
        }
      } else if (path.toLowerCase().endsWith(".txt"))
        ids = [...readFileSync(path, "utf8").matchAll(/\b(\d{4,})\b/g)].flatMap((match) =>
          match[1] ? [match[1]] : [],
        );

      return [...new Set(ids.map((id) => id.trim()).filter(Boolean))].map((id) => storyItem(id));
    } catch {
      return [];
    }
  }
  private fromDatabase(path: string): RawItem[] {
    const db = new Database(path, { readonly: true, create: false });

    try {
      const tables = sqliteNames
        .parse(db.query("SELECT name FROM sqlite_master WHERE type='table'").all())
        .map((row) => row.name);

      const favorite = tables.find((name) =>
        ["favorite", "favorites", "saved"].includes(name.toLowerCase()),
      );

      const items: RawItem[] = [];
      const seen = new Set<string>();

      if (favorite) {
        const columns = sqliteNames
          .parse(db.query(`PRAGMA table_info(${JSON.stringify(favorite)})`).all())
          .map((row) => row.name);

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
        sqliteNames
          .parse(db.query("PRAGMA table_info('read')").all())
          .some((row) => row.name.toLowerCase() === "itemid")
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
          const response = await fetch(
            `https://hacker-news.firebaseio.com/v0/item/${item.source_id}.json`,
          );

          if (!response.ok) return item;
          const parsed = hnItemSchema.safeParse(await response.json());

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
            try {
              const article = await fetch(articleUrl, {
                signal: AbortSignal.timeout(10_000),
                headers: { Accept: "text/html,application/xhtml+xml" },
              });

              if (
                article.ok &&
                (article.headers.get("content-type") ?? "").toLowerCase().includes("html")
              ) {
                const image = ogImage((await article.text()).slice(0, 262144), articleUrl);

                if (image) metadata.og_image = image;
              }
            } catch {
              /* a story's metadata does not depend on its linked article */
            }
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
