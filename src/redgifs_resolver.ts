import * as z from "zod";
import type { Database } from "bun:sqlite";
import { request, safeFetchUrl } from "./_http.ts";
import { patchItem } from "./db.ts";
import type { Metadata } from "./models.ts";

const DEFAULT_API = "https://api.redgifs.com";

const USER_AGENT = "content-hoarder/0.1 (Redgifs resolver)";

const GFYCAT_ID = /^[a-zA-Z0-9-]+$/;

const temporaryTokenSchema = z
  .object({ token: z.string().min(1).optional(), access_token: z.string().min(1).optional() })
  .catchall(z.json());

const gifResponseSchema = z
  .object({
    gif: z
      .object({
        urls: z
          .object({
            hd: z.string().optional(),
            sd: z.string().optional(),
            poster: z.string().optional(),
            thumbnail: z.string().optional(),
          })
          .catchall(z.json())
          .default({}),
      })
      .catchall(z.json()),
  })
  .catchall(z.json());

type ResolvedGif = {
  redgifs_url: string;
  media_url: string;
  media_type: "redgifs_video";
  poster_url: string;
  gfycat_id: string;
};

type ApiTarget = { base: URL; allowLoopback: boolean };

type TokenEntry = { token: string; expiresAt: number };

const tokenCache = new Map<string, TokenEntry>();

export function extractGfycatId(value: string | null | undefined): string | null {
  if (!value) return null;

  try {
    const url = new URL(value);

    if (
      url.hostname.toLowerCase() !== "gfycat.com" &&
      !url.hostname.toLowerCase().endsWith(".gfycat.com")
    )
      return null;
    const parts = url.pathname.split("/").filter(Boolean);

    const id =
      parts[0] === "ifr" || parts[0] === "gallery"
        ? parts[1]
        : parts[0] === "gifs" && parts[1] === "detail"
          ? parts[2]
          : parts[0];

    return id && GFYCAT_ID.test(id) ? id : null;
  } catch {
    return null;
  }
}

export function gfycatToRedgifsId(id: string): string {
  return id ? id[0]!.toUpperCase() + id.slice(1) : id;
}

function apiAllowed(baseUrl: string): ApiTarget {
  const base = new URL(baseUrl);

  const allowLoopback =
    base.hostname === "localhost" || base.hostname === "127.0.0.1" || base.hostname === "[::1]";

  const [safe] = safeFetchUrl(base.toString(), { allowLoopback });

  if (!safe) throw new Error("Redgifs API URL is not allowed");

  return { base, allowLoopback };
}

async function getToken(baseUrl: string, allowLoopback: boolean): Promise<string | null> {
  const cached = tokenCache.get(baseUrl);

  if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;

  try {
    const [, , body] = await request(new URL("/v2/auth/temporary", baseUrl).toString(), {
      headers: { "Content-Type": "application/json" },
      userAgent: USER_AGENT,
      timeout: 15,
      allowLoopback,
      maxResponseBytes: 64_000,
    });

    const payload: unknown = JSON.parse(new TextDecoder().decode(body));
    const parsed = temporaryTokenSchema.safeParse(payload);
    const token = parsed.success ? (parsed.data.token ?? parsed.data.access_token) : undefined;

    if (!token) return null;
    tokenCache.set(baseUrl, { token, expiresAt: Date.now() + 3_600_000 });

    return token;
  } catch {
    return null;
  }
}

export async function resolveGfycat(
  value: string,
  options: { apiBase?: string } = {},
): Promise<ResolvedGif | null> {
  const sourceId = extractGfycatId(value);

  if (!sourceId) return null;
  const apiBase = options.apiBase ?? DEFAULT_API;
  let base: URL;
  let allowLoopback: boolean;

  try {
    ({ base, allowLoopback } = apiAllowed(apiBase));
  } catch {
    return null;
  }

  const token = await getToken(base.toString().replace(/\/$/, ""), allowLoopback);

  if (!token) return null;
  const redgifsId = gfycatToRedgifsId(sourceId);

  try {
    const [, , body] = await request(
      new URL(`/v2/gifs/${encodeURIComponent(redgifsId)}`, base).toString(),
      {
        headers: { Authorization: `Bearer ${token}` },
        userAgent: USER_AGENT,
        timeout: 15,
        allowLoopback,
        maxResponseBytes: 1_000_000,
      },
    );

    const payload: unknown = JSON.parse(new TextDecoder().decode(body));
    const parsed = gifResponseSchema.safeParse(payload);

    if (!parsed.success) return null;
    const urls = parsed.data.gif.urls;
    const mediaUrl = urls.hd || urls.sd;
    const posterUrl = urls.poster || urls.thumbnail || "";

    if (!mediaUrl || !safeFetchUrl(mediaUrl)[0] || (posterUrl && !safeFetchUrl(posterUrl)[0]))
      return null;

    return {
      redgifs_url: `https://redgifs.com/watch/${encodeURIComponent(redgifsId)}`,
      media_url: mediaUrl,
      media_type: "redgifs_video",
      poster_url: posterUrl,
      gfycat_id: sourceId,
    };
  } catch {
    return null;
  }
}

export function rewriteItem(conn: Database, fullname: string, info: ResolvedGif | null): boolean {
  if (!info) return false;
  const metadata: Metadata = {};
  metadata.media_url = info.media_url;
  metadata.media_type = info.media_type;

  if (info.poster_url) metadata.thumbnail = info.poster_url;
  metadata.redgifs_url = info.redgifs_url;
  metadata.gfycat_id = info.gfycat_id;
  metadata.media_resolved_at = Math.floor(Date.now() / 1000);
  metadata.media_resolved_from = "redgifs";

  return patchItem(conn, fullname, { metadata });
}

export type ResolveResult = {
  total: number;
  resolved: number;
  failed: number;
  dry_run: boolean;
  samples: Array<{ fullname: string; gfycat_id: string; redgifs_url: string }>;
  network: boolean;
  requires_opt_in: boolean;
  message: string;
};

export type ResolveOptions = {
  limit?: number;
  allowNetwork: boolean;
  apply: boolean;
  apiBase?: string;
};

export async function resolve(conn: Database, options: ResolveOptions): Promise<ResolveResult> {
  let sql =
    "SELECT fullname, json_extract(metadata, '$.media_url') AS media_url FROM items WHERE json_extract(metadata, '$.media_url') LIKE '%gfycat.com%' AND json_extract(metadata, '$.media_resolved_from') IS NULL ORDER BY last_seen_utc DESC";

  const params: number[] = [];

  if (options.limit !== undefined && options.limit > 0) {
    sql += " LIMIT ?";
    params.push(options.limit);
  }

  const rows = conn.query<{ fullname: string; media_url: string }, number[]>(sql).all(...params);

  const result: ResolveResult = {
    total: rows.length,
    resolved: 0,
    failed: 0,
    dry_run: !options.apply,
    samples: [],
    network: options.allowNetwork,
    requires_opt_in: !options.allowNetwork,
    message: options.allowNetwork
      ? ""
      : "RedGifs network resolution is not enabled. Re-run with --redgifs-ok to activate RedGifs resolution.",
  };

  if (!options.allowNetwork) return result;

  for (const row of rows) {
    const info = await resolveGfycat(row.media_url, { apiBase: options.apiBase });

    if (!info) {
      result.failed++;
      continue;
    }

    result.resolved++;

    if (options.apply) rewriteItem(conn, row.fullname, info);

    if (result.samples.length < 5)
      result.samples.push({
        fullname: row.fullname,
        gfycat_id: info.gfycat_id,
        redgifs_url: info.redgifs_url,
      });
  }

  return result;
}
