import { existsSync, readFileSync } from "node:fs";
import type { RawItem } from "../models.ts";
import type { BaseConnector } from "./base.ts";
import { linkItem, uniqueItems } from "./links.ts";

const TOKEN = /<H3\b[^>]*>([\s\S]*?)<\/H3>|<A\b([^>]*)>([\s\S]*?)<\/A>|<DL\b[^>]*>|<\/DL>/gi;

const ENTITIES = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
  ["nbsp", " "],
]);

function decode(text: string): string {
  return text
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
      if (entity.startsWith("#x") || entity.startsWith("#X"))
        return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));

      if (entity.startsWith("#")) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));

      return ENTITIES.get(entity.toLowerCase()) ?? whole;
    })
    .trim();
}

function attribute(attributes: string, name: string): string {
  const match = attributes.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i"));

  return decode(match?.[2] ?? match?.[3] ?? "");
}

export function parseBookmarks(content: string): RawItem[] {
  const items: RawItem[] = [];
  const stack: string[] = [];
  let pending = "";

  for (const match of content.matchAll(TOKEN)) {
    const token = match[0];

    if (match[1] !== undefined) {
      pending = decode(match[1]);
      continue;
    }

    if (/^<DL/i.test(token)) {
      stack.push(pending);
      pending = "";
      continue;
    }

    if (/^<\/DL/i.test(token)) {
      stack.pop();
      continue;
    }

    const href = attribute(match[2] ?? "", "HREF");

    if (!/^https?:\/\//i.test(href)) continue;

    const added = Number.parseInt(attribute(match[2] ?? "", "ADD_DATE"), 10);
    const folder = stack.filter(Boolean).at(-1) ?? "";

    items.push(
      linkItem(href, decode(match[3] ?? ""), {
        folder,
        addedAt: Number.isFinite(added) ? added : 0,
      }),
    );
  }

  return uniqueItems(items);
}

function readExport(path: string): string | null {
  if (!existsSync(path) || !/\.html?$/i.test(path)) return null;

  const content = readFileSync(path, "utf8");

  return /<!DOCTYPE NETSCAPE-Bookmark-file-1>/i.test(content.slice(0, 512)) ? content : null;
}

export class BookmarksConnector implements BaseConnector {
  readonly id = "bookmarks";
  readonly label = "Bookmarks";
  readonly badgeColor = "#8fbf8f";

  canImport(path: string): boolean {
    return readExport(path) !== null;
  }

  importFile(path: string): RawItem[] {
    const content = readExport(path);

    return content === null ? [] : parseBookmarks(content);
  }
}
