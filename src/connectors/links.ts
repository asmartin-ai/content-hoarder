import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { newItem, type Metadata, type RawItem } from "../models.ts";
import type { BaseConnector } from "./base.ts";
import { youtubeId } from "./firefox.ts";

const URL_PATTERN = /https?:\/\/[^\s<>"'|)\]]+/i;

const MARKDOWN_LINK = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/;

const MAX_BYTES = 20 * 1024 * 1024;

function normalizedUrl(url: string): string {
  try {
    const parsed = new URL(url);

    parsed.hash = "";

    return `${parsed.protocol}//${parsed.host.toLowerCase()}${parsed.pathname.replace(/\/$/, "")}${parsed.search}`;
  } catch {
    return url;
  }
}

function domain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function linkItem(
  url: string,
  title: string,
  extra: { folder?: string; addedAt?: number } = {},
): RawItem {
  const cleanTitle = title.trim() || url;
  const created = extra.addedAt ?? 0;
  const video = youtubeId(url);
  const metadata: Metadata = {};

  if (extra.folder) metadata.folder = extra.folder;

  if (video) {
    metadata.thumbnail = `https://i.ytimg.com/vi/${video}/hqdefault.jpg`;

    return newItem({
      source: "youtube",
      source_id: video,
      kind: "video",
      title: cleanTitle.replace(/\s*-\s*YouTube\s*$/i, ""),
      url: `https://youtu.be/${video}`,
      created_utc: created,
      metadata,
    });
  }

  metadata.domain = domain(url);

  return newItem({
    source: "bookmarks",
    source_id: createHash("sha1").update(normalizedUrl(url), "utf8").digest("hex").slice(0, 16),
    kind: "link",
    title: cleanTitle,
    url,
    created_utc: created,
    metadata,
  });
}

export function uniqueItems(items: RawItem[]): RawItem[] {
  const seen = new Set<string>();

  return items.filter((item) => {
    if (seen.has(item.fullname)) return false;
    seen.add(item.fullname);

    return true;
  });
}

function parseLine(line: string, previous: string): { url: string; title: string } | null {
  const markdown = line.match(MARKDOWN_LINK);

  if (markdown?.[1] && markdown[2]) return { url: markdown[2], title: markdown[1] };

  const url = line.match(URL_PATTERN)?.[0];

  if (!url) return null;

  const rest = line
    .replace(url, "")
    .replace(/^[\s|\t:–-]+|[\s|\t:–-]+$/g, "")
    .trim();

  const before = previous && !URL_PATTERN.test(previous) ? previous.trim() : "";

  return { url, title: rest || before };
}

export function parseLinks(text: string): RawItem[] {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const items: RawItem[] = [];
  let previous = "";

  for (const line of lines) {
    const parsed = parseLine(line, previous);

    if (parsed) items.push(linkItem(parsed.url, parsed.title));

    previous = parsed ? "" : line;
  }

  return uniqueItems(items);
}

function readText(path: string): string | null {
  if (!existsSync(path) || !/\.(txt|md|csv)$/i.test(path)) return null;

  const content = readFileSync(path, "utf8");

  return content.length > MAX_BYTES ? null : content;
}

export class LinksConnector implements BaseConnector {
  readonly id = "links";
  readonly label = "Links";
  readonly badgeColor = "#8fbf8f";

  canImport(path: string): boolean {
    const text = readText(path);

    if (text === null) return false;

    const first = text.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0] ?? "";

    return !first.includes("Export Tabs URLs") && URL_PATTERN.test(text);
  }

  importFile(path: string): RawItem[] {
    const text = readText(path);

    return text === null ? [] : parseLinks(text);
  }
}
