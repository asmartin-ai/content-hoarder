import { z } from "zod";
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Database } from "bun:sqlite";
import type { JsonValue } from "./models.ts";
import * as config from "./config.ts";
import * as db from "./db.ts";
import * as oauth from "./reddit_oauth.ts";
import { jitteredThrottle, MIN_THROTTLE, retryAfterSeconds } from "./_http.ts";

export { RedditNetworkError, RedditNotFoundError } from "./reddit_oauth.ts";

export const UNSAVE_URL = "https://www.reddit.com/api/unsave";

export const SAVE_URL = "https://www.reddit.com/api/save";

export const ME_URL = "https://www.reddit.com/api/me.json";

export const OAUTH_UNSAVE_URL = "https://oauth.reddit.com/api/unsave";

export const OAUTH_SAVE_URL = "https://oauth.reddit.com/api/save";

export const MAX_ATTEMPTS = 5;

export class RedditAuthError extends Error {}

export interface RedditAuth {
  session_cookie: string;
  modhash: string;
  username: string | null;
}

export interface HttpPostOptions {
  session_cookie: string;
  modhash: string;
  user_agent: string;
}

export type Post = (
  url: string,
  fields: Record<string, string>,
  opts: HttpPostOptions,
) => Promise<[number, Record<string, string>]>;

export type Get = (
  url: string,
  opts: {
    session_cookie: string;
    user_agent: string;
    sleep?: (seconds: number) => Promise<void> | void;
  },
) => Promise<JsonValue>;

const AuthRowSchema = z.object({
  access_token: z.string().nullable(),
  refresh_token: z.string().nullable(),
  username: z.string().nullable(),
});

const CountRowSchema = z.object({ count: z.number() });

const DrainPlanRowSchema = z.object({
  fullname: z.string(),
  reddit_id: z.string(),
  title: z.string().nullable(),
  subreddit: z.string().nullable(),
});

const PendingRowSchema = z.object({ fullname: z.string(), reddit_id: z.string() });

const QueueItemSchema = z.object({ reddit_id: z.string() });

const ItemSourceSchema = z.object({ source: z.string(), source_id: z.string() });

export interface UnsaveStatus {
  configured: boolean;
  username: string | null;
  enabled: boolean;
  pending: number;
  failed: number;
}

export interface DrainPlanSample {
  fullname: string;
  subreddit: string | null;
  title: string;
}

export interface DrainResult {
  selected: number;
  unsaved?: number;
  failed?: number;
  auth_error?: boolean;
  network_error?: boolean;
  transport?: "cookie" | "oauth" | null;
  remaining?: number;
  dry_run?: true;
  by_subreddit?: Record<string, number>;
  sample?: DrainPlanSample[];
}

interface DrainLiveResult extends DrainResult {
  unsaved: number;
  failed: number;
  auth_error: boolean;
  network_error: boolean;
  transport: "cookie" | "oauth" | null;
  remaining: number;
}

interface DrainPlanResult extends DrainResult {
  dry_run: true;
  by_subreddit: Record<string, number>;
  sample: DrainPlanSample[];
}

const enabledKey = "reddit_unsave_on_done";

const browserUserAgent = (): string => config.get("REDDIT_BROWSER_USER_AGENT");

export function getAuth(database: Database): RedditAuth | null {
  const raw = database
    .query(
      "SELECT access_token, refresh_token, username FROM auth_tokens WHERE service='reddit_web'",
    )
    .get();

  const row = raw === null ? null : AuthRowSchema.parse(raw);

  return row?.access_token
    ? { session_cookie: row.access_token, modhash: row.refresh_token ?? "", username: row.username }
    : null;
}

export function isConfigured(database: Database): boolean {
  return getAuth(database) !== null;
}

export function setAuth(
  database: Database,
  opts: { sessionCookie: string; modhash?: string | null; username?: string | null },
): void {
  database
    .query(
      "INSERT INTO auth_tokens(service, access_token, refresh_token, token_type, username, updated_utc) VALUES('reddit_web', ?, ?, 'cookie', ?, ?) ON CONFLICT(service) DO UPDATE SET access_token=excluded.access_token, refresh_token=COALESCE(excluded.refresh_token,auth_tokens.refresh_token), username=COALESCE(excluded.username,auth_tokens.username), updated_utc=excluded.updated_utc",
    )
    .run(
      opts.sessionCookie,
      opts.modhash ?? null,
      opts.username ?? null,
      Math.floor(Date.now() / 1000),
    );
}

export function logout(database: Database): void {
  database.query("DELETE FROM auth_tokens WHERE service='reddit_web'").run();
}

export function cookieUserAgent(): string {
  return browserUserAgent();
}

export async function httpGet(
  url: string,
  opts: {
    session_cookie: string;
    user_agent: string;
    sleep?: (seconds: number) => Promise<void> | void;
  },
): Promise<JsonValue> {
  return oauth.redditJsonGet(url, {
    headers: {
      Cookie: `reddit_session=${opts.session_cookie}`,
      Accept: "application/json",
      "User-Agent": opts.user_agent,
    },
    sleep: opts.sleep,
  });
}

export async function httpPost(
  url: string,
  fields: Record<string, string>,
  opts: HttpPostOptions,
): Promise<[number, Record<string, string>]> {
  return oauth.redditFormPost(url, fields, {
    Cookie: `reddit_session=${opts.session_cookie}`,
    "X-Modhash": opts.modhash || "",
    "Content-Type": "application/x-www-form-urlencoded",
    "User-Agent": opts.user_agent,
  });
}

const IdentityResponseSchema = z.object({
  data: z.object({ name: z.string(), modhash: z.string() }),
});

export async function refreshModhash(
  cookie: string,
  opts: { userAgent: string; getf?: Get },
): Promise<[string, string]> {
  const response = await (opts.getf ?? httpGet)(ME_URL, {
    session_cookie: cookie,
    user_agent: opts.userAgent,
  });

  const parsed = IdentityResponseSchema.safeParse(response);

  if (!parsed.success || !parsed.data.data.name || !parsed.data.data.modhash)
    throw new RedditAuthError("not logged in or Reddit returned no modhash");

  return [parsed.data.data.modhash, parsed.data.data.name];
}

export async function login(
  database: Database,
  sessionCookie: string,
  opts: { getf?: Get; userAgent?: string } = {},
): Promise<string> {
  const [modhash, username] = await refreshModhash(sessionCookie, {
    userAgent: opts.userAgent ?? browserUserAgent(),
    getf: opts.getf,
  });

  setAuth(database, { sessionCookie, modhash, username });

  return username;
}

export function countPending(database: Database): number {
  return CountRowSchema.parse(
    database.query("SELECT COUNT(*) AS count FROM reddit_unsave WHERE state='pending'").get(),
  ).count;
}

export function countFailed(database: Database): number {
  return CountRowSchema.parse(
    database.query("SELECT COUNT(*) AS count FROM reddit_unsave WHERE state='failed'").get(),
  ).count;
}

export function status(database: Database): UnsaveStatus {
  const auth = getAuth(database);

  return {
    configured: Boolean(auth),
    username: auth?.username ?? null,
    enabled: db.getSetting(database, enabledKey, "0") === "1",
    pending: countPending(database),
    failed: countFailed(database),
  };
}

export function enable(database: Database): void {
  db.setSetting(database, enabledKey, "1");
}

export function disable(database: Database): void {
  db.setSetting(database, enabledKey, "0");
}

export function enqueueExisting(database: Database): number {
  return db.enqueueExistingDone(database);
}

async function sendWithRetry(
  post: Post,
  url: string,
  redditId: string,
  opts: HttpPostOptions & { sleep: (seconds: number) => Promise<void> | void },
): Promise<[boolean, string | null]> {
  const fields = { id: redditId, uh: opts.modhash };
  let delay = 2;

  for (let attempt = 0; attempt <= 3; attempt++) {
    const [statusCode, headers] = await post(url, fields, opts);

    if (statusCode === 200 || statusCode === 201) return [true, null];

    if (statusCode === 401 || statusCode === 403)
      throw new RedditAuthError(
        `Reddit returned ${statusCode} — auth (cookie/modhash or OAuth token) expired`,
      );

    if (statusCode === 429 && attempt < 3) {
      await opts.sleep(retryAfterSeconds(headers) ?? delay);
      delay *= 2;
      continue;
    }

    return [false, `HTTP ${statusCode}`];
  }

  return [false, "rate limited (max retries)"];
}

interface WriteTransport {
  post: Post;
  url: string;
  sessionCookie: string;
  modhash: string;
  userAgent: string;
  transport: "cookie" | "oauth";
}

async function selectWriteTransport(
  database: Database,
  opts: {
    injected: boolean;
    post?: Post;
    getf?: Get;
    userAgent: string;
    oauthUrl: string;
    cookieUrl: string;
  },
): Promise<WriteTransport | { error: "auth" | "network" }> {
  if (!opts.injected && oauth.isConfigured(database)) {
    const bearer = await oauth.accessToken(database);

    if (bearer)
      return {
        post: async (url, fields, write) =>
          oauth.oauthPost(
            url,
            { id: fields.id! },
            { bearer: (await oauth.accessToken(database)) ?? bearer, userAgent: write.user_agent },
          ),
        url: opts.oauthUrl,
        sessionCookie: "",
        modhash: "",
        userAgent: oauth.oauthUserAgent(database),
        transport: "oauth",
      };
  }

  const auth = getAuth(database);

  if (!auth) return { error: "auth" };
  let modhash: string;
  let username: string;

  try {
    [modhash, username] = await refreshModhash(auth.session_cookie, {
      userAgent: opts.userAgent,
      getf: opts.getf,
    });
  } catch (error) {
    return { error: error instanceof RedditAuthError ? "auth" : "network" };
  }

  setAuth(database, { sessionCookie: auth.session_cookie, modhash, username });

  return {
    post: opts.post ?? httpPost,
    url: opts.cookieUrl,
    sessionCookie: auth.session_cookie,
    modhash,
    userAgent: opts.userAgent,
    transport: "cookie",
  };
}

function drainPlan(database: Database, limit?: number): DrainPlanResult {
  const sql =
    "SELECT u.fullname,u.reddit_id,i.title,json_extract(i.metadata,'$.subreddit') AS subreddit FROM reddit_unsave u LEFT JOIN items i ON i.fullname=u.fullname WHERE u.state='pending' ORDER BY u.enqueued_utc";

  const values =
    limit !== undefined
      ? database.query(`${sql} LIMIT ?`).all(Math.trunc(limit))
      : database.query(sql).all();

  const rows = values.map((row) => DrainPlanRowSchema.parse(row));
  const bySubreddit: Record<string, number> = {};

  for (const row of rows) {
    const sub = row.subreddit || "?";
    bySubreddit[sub] = (bySubreddit[sub] ?? 0) + 1;
  }

  return {
    dry_run: true,
    selected: rows.length,
    by_subreddit: Object.fromEntries(Object.entries(bySubreddit).sort((a, b) => b[1] - a[1])),
    sample: rows.slice(0, 20).map((row) => ({
      fullname: row.fullname,
      subreddit: row.subreddit,
      title: (row.title || "").slice(0, 80),
    })),
  };
}

export interface AuditRecord {
  ts: number;
  fullname: string;
  reddit_id: string;
  transport: "cookie" | "oauth";
}

export type AuditCallback = (record: AuditRecord) => void;

export function auditAppender(databasePath: string): readonly [AuditCallback, string] {
  const path = join(dirname(databasePath), "unsave-audit.jsonl");

  return [(record) => appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8"), path];
}

export interface DrainOptions {
  limit?: number;
  throttle?: number;
  dryRun?: boolean;
  post?: Post;
  getf?: Get;
  userAgent?: string;
  progress?: (message: string) => void;
  audit?: AuditCallback;
  sleep?: (seconds: number) => Promise<void> | void;
}

export async function drain(database: Database, opts: DrainOptions = {}): Promise<DrainResult> {
  const injected = Boolean(opts.post || opts.getf);
  const userAgent = opts.userAgent ?? browserUserAgent();
  const sleep = opts.sleep ?? (async (seconds) => Bun.sleep(seconds * 1000));
  const throttle = Math.max(opts.throttle ?? 1, MIN_THROTTLE);

  const result: DrainLiveResult = {
    selected: 0,
    unsaved: 0,
    failed: 0,
    auth_error: false,
    network_error: false,
    transport: null,
    remaining: countPending(database),
  };

  if (opts.dryRun) return drainPlan(database, opts.limit);

  const transport = await selectWriteTransport(database, {
    injected,
    post: opts.post,
    getf: opts.getf,
    userAgent,
    oauthUrl: OAUTH_UNSAVE_URL,
    cookieUrl: UNSAVE_URL,
  });

  if ("error" in transport) {
    result[transport.error === "auth" ? "auth_error" : "network_error"] = true;

    return result;
  }

  result.transport = transport.transport;

  const sql =
    "SELECT fullname,reddit_id FROM reddit_unsave WHERE state='pending' ORDER BY enqueued_utc";

  const values =
    opts.limit !== undefined
      ? database.query(`${sql} LIMIT ?`).all(Math.trunc(opts.limit))
      : database.query(sql).all();

  const rows = values.map((row) => PendingRowSchema.parse(row));
  result.selected = rows.length;

  for (let i = 0; i < rows.length; i++) {
    if (i) await sleep(jitteredThrottle(throttle));
    const row = rows[i]!;
    let ok: boolean;
    let error: string | null;

    try {
      [ok, error] = await sendWithRetry(transport.post, transport.url, row.reddit_id, {
        session_cookie: transport.sessionCookie,
        modhash: transport.modhash,
        user_agent: transport.userAgent,
        sleep,
      });
    } catch (failure) {
      if (failure instanceof RedditAuthError) {
        result.auth_error = true;
        break;
      }

      throw failure;
    }

    const now = Math.floor(Date.now() / 1000);

    if (ok) {
      database
        .query("UPDATE reddit_unsave SET state='done',updated_utc=? WHERE fullname=?")
        .run(now, row.fullname);
      database.query("UPDATE items SET is_saved=0 WHERE fullname=?").run(row.fullname);
      result.unsaved++;
      await opts.audit?.({
        ts: now,
        fullname: row.fullname,
        reddit_id: row.reddit_id,
        transport: transport.transport,
      });
      opts.progress?.(`unsaved ${row.reddit_id}`);
    } else {
      database
        .query(
          "UPDATE reddit_unsave SET attempts=attempts+1,last_error=?,updated_utc=?,state=CASE WHEN attempts+1>=? THEN 'failed' ELSE state END WHERE fullname=?",
        )
        .run(error, now, MAX_ATTEMPTS, row.fullname);
      result.failed++;
      opts.progress?.(`failed ${row.reddit_id}: ${error}`);
    }
  }

  result.remaining = countPending(database);

  return result;
}

export async function resave(
  database: Database,
  fullname: string,
  opts: {
    post?: Post;
    getf?: Get;
    userAgent?: string;
    sleep?: (seconds: number) => Promise<void> | void;
  } = {},
): Promise<boolean> {
  const queueRaw = database
    .query("SELECT reddit_id FROM reddit_unsave WHERE fullname=?")
    .get(fullname);

  let redditId = queueRaw === null ? undefined : QueueItemSchema.parse(queueRaw).reddit_id;

  if (!redditId) {
    const itemRaw = database
      .query("SELECT source,source_id FROM items WHERE fullname=?")
      .get(fullname);

    if (itemRaw === null) return false;
    const item = ItemSourceSchema.parse(itemRaw);

    if (item.source !== "reddit") return false;
    redditId = item.source_id;
  }

  const userAgent = opts.userAgent ?? browserUserAgent();

  const transport = await selectWriteTransport(database, {
    injected: Boolean(opts.post || opts.getf),
    post: opts.post,
    getf: opts.getf,
    userAgent,
    oauthUrl: OAUTH_SAVE_URL,
    cookieUrl: SAVE_URL,
  });

  if ("error" in transport) return false;

  try {
    const sleep = opts.sleep ?? (async (seconds) => Bun.sleep(seconds * 1000));

    const [ok] = await sendWithRetry(transport.post, transport.url, redditId, {
      session_cookie: transport.sessionCookie,
      modhash: transport.modhash,
      user_agent: transport.userAgent,
      sleep,
    });

    if (!ok) return false;
    database.query("UPDATE items SET is_saved=1 WHERE fullname=?").run(fullname);
    database.query("DELETE FROM reddit_unsave WHERE fullname=?").run(fullname);

    return true;
  } catch (error) {
    if (error instanceof RedditAuthError) return false;
    throw error;
  }
}
