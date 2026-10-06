import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import * as z from "zod";
import { newItem, type JsonValue, type Metadata, type RawItem } from "../models.ts";
import type { BaseConnector } from "./base.ts";

export const FIREFOX_TABS_SCHEMA = "content-hoarder.firefox-tabs.v1";

const optionalFlag = z.union([z.boolean(), z.literal(0), z.literal(1)]).optional();

const httpUrl = /^https?:\/\//i;

export const FirefoxTabSchema = z
  .object({
    url: z.string().optional(),
    title: z.string().optional(),
    window: z.union([z.string(), z.number()]).optional(),
    windowId: z.union([z.string(), z.number()]).optional(),
    incognito: optionalFlag,
    pinned: optionalFlag,
    active: optionalFlag,
    discarded: optionalFlag,
    favicon: z.string().optional(),
    favIconUrl: z.string().optional(),
    capture_source: z.string().optional(),
    captured_at: z.union([z.string(), z.number()]).optional(),
    snapshot_id: z.union([z.string(), z.number()]).optional(),
    index: z.number().optional(),
    last_accessed_ms: z.number().nullable().optional(),
    lastAccessed: z.number().nullable().optional(),
    group_id: z.union([z.string(), z.number()]).optional(),
    groupId: z.union([z.string(), z.number()]).optional(),
    cookie_store_id: z.string().optional(),
    cookieStoreId: z.string().optional(),
  })
  .catchall(z.json());

export type FirefoxTab = z.infer<typeof FirefoxTabSchema>;

const firefoxPayloadSchema = z
  .object({
    schema: z.string(),
    tabs: z.array(FirefoxTabSchema),
    source: z.string().optional(),
    captured_at: z.union([z.string(), z.number()]).optional(),
    snapshot_id: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough();

const domain = (url: string): string => url.match(/^https?:\/\/([^/]+)/i)?.[1]?.toLowerCase() ?? "";

const normalizedUrl = (url: string): string => {
  try {
    const parsed = new URL(url);
    parsed.hash = "";

    return `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}${parsed.pathname.replace(/\/$/, "")}${parsed.search}`;
  } catch {
    return url;
  }
};

const stringValue = (value: JsonValue | undefined): string =>
  value === undefined || value === null ? "" : String(value);

export function youtubeId(url: string): string {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return "";
  }

  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");

  if (
    !["youtube.com", "youtu.be"].includes(host) &&
    !host.endsWith(".youtube.com") &&
    !host.endsWith(".youtu.be")
  )
    return "";

  const video =
    host === "youtu.be"
      ? (parsed.pathname.slice(1).split("/").at(0) ?? "")
      : (parsed.searchParams.get("v") ??
        parsed.pathname.match(/^\/(?:shorts|embed)\/([^/]+)/)?.[1] ??
        "");

  return video.length === 11 && !["videoseries", "live_stream"].includes(video) ? video : "";
}

const cleanTitle = (title: string): string =>
  title
    .replace(/^\(\d+\)\s*/, "")
    .replace(/\s*-\s*YouTube\s*$/i, "")
    .trim();

const extraMetadata = (record: FirefoxTab, includeUrl: boolean): Metadata => {
  const metadata: Metadata = {};

  if (includeUrl && record.url) metadata.firefox_original_url = record.url;

  if (record.capture_source) metadata.firefox_capture_source = record.capture_source;

  if (record.captured_at !== undefined) metadata.firefox_captured_at = record.captured_at;

  if (record.snapshot_id !== undefined) metadata.firefox_snapshot_id = String(record.snapshot_id);

  for (const [field, key] of [
    ["index", "firefox_index"],
    ["last_accessed_ms", "firefox_last_accessed_ms"],
    ["group_id", "firefox_group_id"],
  ] as const) {
    const value = record[field];

    if (value !== undefined && value !== null) metadata[key] = value;
  }

  if (record.active !== undefined)
    metadata.firefox_active = record.active === true || record.active === 1 ? 1 : 0;

  if (record.discarded !== undefined)
    metadata.firefox_discarded = record.discarded === true || record.discarded === 1 ? 1 : 0;
  const cookieStoreId = record.cookie_store_id ?? record.cookieStoreId;

  if (cookieStoreId) metadata.firefox_cookie_store_id = String(cookieStoreId);

  return metadata;
};

export function ytItem(
  vid: string,
  title = "",
  window = "",
  pinned = false,
  additional: Metadata = {},
): RawItem {
  const metadata: Metadata = {
    thumbnail: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
    open_in_firefox: true,
  };

  if (window) metadata.firefox_window = window;

  if (pinned) metadata.firefox_pinned = 1;
  Object.assign(metadata, additional);

  return newItem({
    source: "youtube",
    source_id: vid,
    kind: "video",
    title: cleanTitle(title),
    url: `https://youtu.be/${vid}`,
    metadata,
  });
}

export function itemFromTabRecord(record: FirefoxTab): RawItem | null {
  if (record.incognito === true || record.incognito === 1) return null;
  const url = stringValue(record.url).trim();

  if (!httpUrl.test(url)) return null;
  const title = stringValue(record.title);
  const window = stringValue(record.window ?? record.windowId);
  const pinned = record.pinned === true || record.pinned === 1;
  const id = youtubeId(url);

  if (id) return ytItem(id, title, window, pinned, extraMetadata(record, true));
  const metadata: Metadata = { domain: domain(url), open_in_firefox: true };

  if (record.favicon || record.favIconUrl)
    metadata.favicon = record.favicon ?? record.favIconUrl ?? "";

  if (window) metadata.window = window;

  if (pinned) metadata.pinned = 1;
  Object.assign(metadata, extraMetadata(record, false));
  const sourceId = createHash("sha1").update(normalizedUrl(url), "utf8").digest("hex").slice(0, 16);

  return newItem({ source: "firefox", source_id: sourceId, kind: "tab", title, url, metadata });
}

export class FirefoxConnector implements BaseConnector {
  readonly id = "firefox";
  readonly label = "Firefox Tabs";
  readonly badgeColor = "#0060df";
  canImport(path: string): boolean {
    try {
      if (!statSync(path).isFile()) return false;

      if (path.toLowerCase().endsWith(".txt"))
        return readFileSync(path, "utf8").slice(0, 256).includes("Export Tabs URLs");

      if (path.toLowerCase().endsWith(".json")) {
        const payload = firefoxPayloadSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));

        return payload.success && payload.data.schema === FIREFOX_TABS_SCHEMA;
      }
    } catch {
      return false;
    }

    return false;
  }
  importFile(path: string): RawItem[] {
    try {
      if (path.toLowerCase().endsWith(".json")) return this.importJson(path);

      return this.importText(path);
    } catch {
      return [];
    }
  }
  private importJson(path: string): RawItem[] {
    const payload = firefoxPayloadSchema.parse(JSON.parse(readFileSync(path, "utf8")));

    if (payload.schema !== FIREFOX_TABS_SCHEMA) return [];
    const source = payload.source ?? "json_export";

    return payload.tabs.flatMap((record) => {
      const normalized: FirefoxTab = { ...record };
      normalized.capture_source = normalized.capture_source || source;
      const capturedAt = normalized.captured_at ?? payload.captured_at;

      if (capturedAt !== undefined) normalized.captured_at = capturedAt;
      const snapshotId = normalized.snapshot_id ?? payload.snapshot_id;

      if (snapshotId !== undefined) normalized.snapshot_id = snapshotId;

      if (!normalized.favicon && normalized.favIconUrl) normalized.favicon = normalized.favIconUrl;

      if (!normalized.window && normalized.windowId !== undefined)
        normalized.window = normalized.windowId;
      const lastAccessed = normalized.last_accessed_ms ?? normalized.lastAccessed;

      if (lastAccessed !== undefined) normalized.last_accessed_ms = lastAccessed;

      if (!normalized.cookie_store_id && normalized.cookieStoreId)
        normalized.cookie_store_id = normalized.cookieStoreId;

      if (!normalized.group_id && normalized.groupId !== undefined)
        normalized.group_id = normalized.groupId;
      const item = itemFromTabRecord(normalized);

      return item ? [item] : [];
    });
  }
  private importText(path: string): RawItem[] {
    const text = readFileSync(path, "utf8");
    const items: RawItem[] = [];
    let window = "";

    for (const block of text.split(/\n\s*\n/)) {
      const lines = block
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

      const [first, second, third, fourth] = lines;

      if (!first) continue;

      if (first.startsWith("Window:::")) {
        window = first.match(/id:\s*(\S+)/)?.[1] ?? "";
        continue;
      }

      if (first.startsWith("#") || first.startsWith("Export Tabs URLs")) continue;

      let record: FirefoxTab | null = null;

      if (second && httpUrl.test(second)) {
        record = {
          url: second,
          title: first,
          favicon: lines.length >= 4 ? (third ?? "") : "",
          pinned: (lines.length >= 4 ? fourth : third)?.toLowerCase() === "true",
          window,
          capture_source: "export-tabs-urls",
        };
      } else if (httpUrl.test(first)) {
        record = { url: first, window, capture_source: "export-tabs-urls" };
      }

      const item = record ? itemFromTabRecord(record) : null;

      if (item) items.push(item);
    }

    return items;
  }
}
