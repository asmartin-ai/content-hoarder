import type { Database } from "bun:sqlite";
import { newItem } from "./models.ts";
import * as z from "zod";
import * as config from "./config.ts";
import * as db from "./db.ts";
import { jitteredThrottle, MIN_THROTTLE, request } from "./_http.ts";

export const FAVORITES_URL = "https://news.ycombinator.com/favorites";

const MARK_KEY = "hn_sync_newest";

const MARK_DEPTH = 25;

const ITEM_ID = /item\?id=(\d+)/g;

const ATHING = /class=['"]athing[^'"]*['"][^>]*id=['"](\d+)['"]/g;

function extractIds(html: string): string[] {
  const matches = [...html.matchAll(ITEM_ID)];

  const ids = (matches.length ? matches : [...html.matchAll(ATHING)]).map(
    (match) => match[1] ?? "",
  );

  return [...new Set(ids.filter(Boolean))];
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function extractNext(html: string): string | null {
  for (const anchor of html.matchAll(/<a\b([^>]*)>(.*?)<\/a>/gis)) {
    if (
      (anchor[2] ?? "")
        .replace(/<[^>]+>/g, "")
        .trim()
        .toLowerCase() !== "more"
    )
      continue;
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(anchor[1] ?? "")?.[1];

    if (href) return decodeHtml(href);
  }

  return null;
}

function loadMark(value: string | null): string[] {
  if (!value) return [];
  const text = value.trim();

  if (!text.startsWith("[")) return [text];

  try {
    const parsed = z.array(z.string()).safeParse(JSON.parse(text));

    return parsed.success ? parsed.data.filter(Boolean) : [];
  } catch {
    return [];
  }
}

function hnItem(id: string) {
  const url = `https://news.ycombinator.com/item?id=${id}`;

  return newItem({
    source: "hackernews",
    source_id: id,
    kind: "story",
    url,
    metadata: { hn_url: url, hn_list: "saved" },
  });
}

export interface SyncOptions {
  user: string;
  maxPages?: number;
  full?: boolean;
  stopOnKnown?: boolean;
  throttle?: number;
  getPage?: (url: string) => Promise<[number, Uint8Array]>;
  sleep?: (seconds: number) => Promise<void>;
  progress?: (message: string) => void;
}

export interface SyncResult {
  fetched: number;
  new: number;
  updated: number;
  pages: number;
  stopped: string | null;
  network_error: boolean;
  user: string;
}

export async function sync(
  database: Database,
  options: SyncOptions,
  progress?: (message: string) => void,
): Promise<SyncResult> {
  const user = options.user.trim();

  if (!user) throw new Error("user is required");
  const sleep = options.sleep ?? (async (seconds: number) => Bun.sleep(seconds * 1000));
  const maxPages = Math.max(0, Math.trunc(options.maxPages ?? 5));
  const stopOnKnown = options.stopOnKnown ?? !options.full;
  const throttle = Math.max(options.throttle ?? 1, MIN_THROTTLE);

  const getPage =
    options.getPage ??
    (async (url: string) => {
      const [status, , body] = await request(url, {
        timeout: 20,
        retries: 2,
        backoff: 1,
        jitter: true,
        userAgent: config.get("USER_AGENT"),
      });

      return [status, body];
    });

  const result: SyncResult = {
    fetched: 0,
    new: 0,
    updated: 0,
    pages: 0,
    stopped: null,
    network_error: false,
    user,
  };

  const marks = loadMark(db.getSetting(database, MARK_KEY));
  const markSet = new Set(marks);
  const topNames: string[] = [];
  const seen = new Set<string>();
  let url = `${FAVORITES_URL}?id=${encodeURIComponent(user)}`;
  let hitMark = false;

  for (let page = 0; page < maxPages; page++) {
    if (page) await sleep(jitteredThrottle(throttle));
    let status: number;
    let raw: Uint8Array;

    try {
      [status, raw] = await getPage(url);
    } catch {
      result.network_error = true;
      result.stopped = "network_error";
      break;
    }

    if (status < 200 || status >= 300) {
      result.network_error = true;
      result.stopped = "network_error";
      break;
    }

    const html = new TextDecoder("utf-8", { fatal: false }).decode(raw);
    const ids = extractIds(html);

    if (!ids.length) {
      result.stopped = page === 0 ? "empty" : "exhausted";
      break;
    }

    result.pages++;
    let pageNew = 0;

    for (const id of ids) {
      const fullname = `hackernews:${id}`;

      if (topNames.length < MARK_DEPTH && !topNames.includes(fullname)) topNames.push(fullname);

      if (markSet.has(fullname) && stopOnKnown) {
        hitMark = true;
        break;
      }

      if (seen.has(fullname)) continue;
      seen.add(fullname);
      const outcome = db.mergeUpsert(database, hnItem(id));
      result.fetched++;

      if (outcome === "inserted") {
        result.new++;
        pageNew++;
      } else result.updated++;
    }

    (progress ?? options.progress)?.(`page ${page + 1}: +${pageNew} new (${ids.length} ids)`);

    if (hitMark) {
      result.stopped = "caught_up";
      break;
    }

    const next = extractNext(html);

    if (!next) {
      result.stopped = "exhausted";
      break;
    }

    if (stopOnKnown && !marks.length && pageNew === 0) {
      result.stopped = "all_known";
      break;
    }

    url = new URL(next, url).toString();
  }

  if (result.stopped === null) result.stopped = "max_pages";
  const safeBoundary = ["caught_up", "exhausted", "all_known"].includes(String(result.stopped));

  if (topNames.length && (safeBoundary || (!marks.length && result.stopped === "max_pages")))
    db.setSetting(database, MARK_KEY, JSON.stringify(topNames));

  return result;
}
