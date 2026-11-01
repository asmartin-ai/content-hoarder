import { z } from "zod";
import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import * as config from "./config.ts";
import type { JsonValue } from "./models.ts";
import { HttpError, request } from "./_http.ts";

export const AUTHORIZE_URL = "https://www.reddit.com/api/v1/authorize";

export const ACCESS_TOKEN_URL = "https://www.reddit.com/api/v1/access_token";

export const OAUTH_API_BASE = "https://oauth.reddit.com";

export const ME_URL = `${OAUTH_API_BASE}/api/v1/me`;

export const DEFAULT_REDIRECT_URI = "redreader://rr_oauth_redir";

export const SCOPE = "read history identity save";

const SERVICE = "reddit_oauth";

const ACCESS_TTL = 3600;

const REFRESH_SKEW = 300;

const APP_VERSION = "1.0.0";

export class RedditOAuthError extends Error {}

export class RedditNetworkError extends Error {}

export class RedditNotFoundError extends RedditNetworkError {}

const TokenResponseSchema = z
  .object({
    access_token: z.string(),
    refresh_token: z.string().optional(),
    expires_in: z.number().optional(),
    token_type: z.string().optional(),
  })
  .passthrough();

const IdentityResponseSchema = z.object({ name: z.string() }).passthrough();

type OAuthToken = z.infer<typeof TokenResponseSchema>;

const TokenRowSchema = z
  .object({
    access_token: z.string().nullable(),
    refresh_token: z.string().nullable(),
    token_type: z.string().nullable(),
    username: z.string().nullable(),
    updated_utc: z.number().nullable(),
  })
  .passthrough();

type TokenRow = z.infer<typeof TokenRowSchema>;

function tokenRow(database: Database): TokenRow | null {
  const row: unknown = database
    .query(
      "SELECT access_token,refresh_token,token_type,username,updated_utc FROM auth_tokens WHERE service=?",
    )
    .get(SERVICE);

  if (row === null || row === undefined) return null;
  const parsed = TokenRowSchema.safeParse(row);

  return parsed.success ? parsed.data : null;
}

export type TokenPost = (
  url: string,
  fields: Record<string, string>,
  opts: { clientId: string },
) => Promise<JsonValue>;

export type OAuthGet = (
  url: string,
  opts: { bearer: string; userAgent: string },
) => Promise<JsonValue>;

export function clientId(): string {
  return config.get("REDDIT_OAUTH_CLIENT_ID").trim();
}

export function redirectUri(): string {
  return config.get("REDDIT_OAUTH_REDIRECT_URI").trim() || DEFAULT_REDIRECT_URI;
}

export function oauthUserAgent(database?: Database, username?: string | null): string {
  let user = username;

  if (user === undefined && database) user = tokenRow(database)?.username;

  return `windows:content-hoarder:${APP_VERSION}${user ? ` (by /u/${user})` : ""}`;
}

export function isConfigured(database: Database): boolean {
  return Boolean(tokenRow(database)?.refresh_token);
}

export interface OAuthStatus {
  configured: boolean;
  client_id_set: boolean;
  username: string | null;
  redirect_uri: string;
}

export function status(database: Database): OAuthStatus {
  const row = tokenRow(database);

  return {
    configured: Boolean(row?.refresh_token),
    client_id_set: Boolean(clientId()),
    username: row?.username ?? null,
    redirect_uri: redirectUri(),
  };
}

function store(
  database: Database,
  fields: {
    refreshToken?: string | null;
    accessToken: string;
    username?: string | null;
    now?: number;
  },
): void {
  database
    .query(
      "INSERT INTO auth_tokens(service, access_token, refresh_token, token_type, username, updated_utc) VALUES(?, ?, ?, 'bearer', ?, ?) ON CONFLICT(service) DO UPDATE SET access_token=excluded.access_token, refresh_token=COALESCE(excluded.refresh_token,auth_tokens.refresh_token), username=COALESCE(excluded.username,auth_tokens.username), updated_utc=excluded.updated_utc",
    )
    .run(
      SERVICE,
      fields.accessToken,
      fields.refreshToken ?? null,
      fields.username ?? null,
      fields.now ?? Math.floor(Date.now() / 1000),
    );
}

export function logout(database: Database): void {
  database.query("DELETE FROM auth_tokens WHERE service=?").run(SERVICE);
}

export const clear = logout;

export function newState(): string {
  return randomBytes(16).toString("base64url");
}

export function buildAuthorizeUrl(opts: {
  state: string;
  clientId?: string;
  redirectUri?: string;
  scope?: string;
  duration?: string;
}): string {
  const id = opts.clientId || clientId();

  if (!id) throw new RedditOAuthError("REDDIT_OAUTH_CLIENT_ID is not set (.env or env var).");

  const params = new URLSearchParams({
    client_id: id,
    response_type: "code",
    state: opts.state,
    redirect_uri: opts.redirectUri || redirectUri(),
    duration: opts.duration || "permanent",
    scope: opts.scope || SCOPE,
  });

  return `${AUTHORIZE_URL}?${params}`;
}

export function parseRedirect(redirect: string, expectedState: string): string {
  const value = redirect.trim();
  const query = value.includes("?") ? new URL(value).searchParams : new URLSearchParams(value);
  const error = query.get("error");

  if (error) throw new RedditOAuthError(`Reddit denied authorization: ${error}`);
  const code = query.get("code");

  if (code) {
    if (query.get("state") !== expectedState)
      throw new RedditOAuthError("state mismatch — possible CSRF; restart `reddit-oauth --login`.");

    return code;
  }

  if (/^[A-Za-z0-9_-]+$/.test(value)) return value;
  throw new RedditOAuthError("no authorization code found — paste the full redirected URL.");
}

async function defaultTokenPost(
  url: string,
  fields: Record<string, string>,
  client: string,
): Promise<JsonValue> {
  const body = new URLSearchParams(fields).toString();
  let raw: Uint8Array;

  try {
    [, , raw] = await request(url, {
      method: "POST",
      data: body,
      headers: {
        Authorization: `Basic ${Buffer.from(`${client}:`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": oauthUserAgent(),
        Accept: "application/json",
      },
      timeout: 20,
      retries: 3,
      backoff: 1,
      jitter: true,
    });
  } catch (error) {
    if (error instanceof HttpError && [400, 401, 403].includes(error.status ?? 0))
      throw new RedditOAuthError(
        `token endpoint rejected the request (HTTP ${error.status}) — check the client id, redirect uri, and that the code/refresh token is valid.`,
      );
    throw new RedditNetworkError(
      `token endpoint: ${error instanceof HttpError ? `HTTP ${error.status ?? "network"}` : String(error)}`,
    );
  }

  try {
    return z.json().parse(JSON.parse(new TextDecoder().decode(raw)));
  } catch {
    throw new RedditNetworkError("token endpoint: unparseable response");
  }
}

export async function exchangeCode(
  code: string,
  opts: { clientId?: string; redirectUri?: string; post?: TokenPost } = {},
): Promise<OAuthToken> {
  const id = opts.clientId || clientId();

  const post =
    opts.post ?? ((url, fields, settings) => defaultTokenPost(url, fields, settings.clientId));

  const response = await post(
    ACCESS_TOKEN_URL,
    { grant_type: "authorization_code", code, redirect_uri: opts.redirectUri || redirectUri() },
    { clientId: id },
  );

  return TokenResponseSchema.parse(response);
}

export async function refreshAccessToken(
  refreshToken: string,
  opts: { clientId?: string; post?: TokenPost } = {},
): Promise<OAuthToken> {
  const id = opts.clientId || clientId();

  const post =
    opts.post ?? ((url, fields, settings) => defaultTokenPost(url, fields, settings.clientId));

  const response = await post(
    ACCESS_TOKEN_URL,
    { grant_type: "refresh_token", refresh_token: refreshToken },
    { clientId: id },
  );

  return TokenResponseSchema.parse(response);
}

export async function redditJsonGet(
  url: string,
  opts: { headers: Record<string, string>; sleep?: (ms: number) => Promise<void> | void },
): Promise<JsonValue> {
  let raw: Uint8Array;

  try {
    [, , raw] = await request(url, {
      method: "GET",
      headers: opts.headers,
      timeout: 20,
      retries: 4,
      backoff: 1,
      jitter: true,
      sleep: opts.sleep,
    });
  } catch (error) {
    if (error instanceof HttpError && [401, 403].includes(error.status ?? 0)) return {};

    if (error instanceof HttpError && error.status === 404)
      throw new RedditNotFoundError("HTTP 404");

    if (error instanceof HttpError)
      throw new RedditNetworkError(
        error.status ? `HTTP ${error.status}` : String(error.reason ?? error),
      );

    throw new RedditNetworkError(String(error));
  }

  try {
    return z.json().parse(JSON.parse(new TextDecoder().decode(raw)));
  } catch {
    throw new RedditNetworkError("unparseable response");
  }
}

export async function redditFormPost(
  url: string,
  fields: Record<string, string>,
  headers: Record<string, string>,
): Promise<[number, Record<string, string>]> {
  try {
    const [status, responseHeaders] = await request(url, {
      method: "POST",
      data: new URLSearchParams(fields).toString(),
      headers,
      timeout: 20,
    });

    return [status, responseHeaders];
  } catch (error) {
    if (error instanceof HttpError && error.status !== null) return [error.status, error.headers];

    return [0, {}];
  }
}

export async function oauthGet(
  url: string,
  opts: { bearer: string; userAgent: string; sleep?: (ms: number) => Promise<void> | void },
): Promise<JsonValue> {
  return redditJsonGet(url, {
    headers: {
      Authorization: `bearer ${opts.bearer}`,
      Accept: "application/json",
      "User-Agent": opts.userAgent,
    },
    sleep: opts.sleep,
  });
}

export async function oauthPost(
  url: string,
  fields: Record<string, string>,
  opts: { bearer: string; userAgent: string },
): Promise<[number, Record<string, string>]> {
  return redditFormPost(url, fields, {
    Authorization: `bearer ${opts.bearer}`,
    "Content-Type": "application/x-www-form-urlencoded",
    "User-Agent": opts.userAgent,
  });
}

export async function accessToken(
  database: Database,
  opts: { post?: TokenPost; now?: number } = {},
): Promise<string | null> {
  const row = tokenRow(database);

  if (!row?.refresh_token) return null;
  const now = opts.now ?? Math.floor(Date.now() / 1000);

  if (row.access_token && now - (row.updated_utc ?? 0) < ACCESS_TTL - REFRESH_SKEW)
    return row.access_token;
  let token: OAuthToken;

  try {
    token = await refreshAccessToken(row.refresh_token, { post: opts.post });
  } catch (error) {
    if (error instanceof RedditOAuthError) return null;

    if (error instanceof RedditNetworkError) return row.access_token || null;
    throw error;
  }

  if (!token.access_token) return row.access_token || null;
  store(database, {
    accessToken: token.access_token,
    refreshToken: token.refresh_token ?? null,
    now,
  });

  return token.access_token;
}

export async function fetchUsername(
  token: string,
  getf: OAuthGet = oauthGet,
): Promise<string | null> {
  try {
    const user = IdentityResponseSchema.safeParse(
      await getf(ME_URL, { bearer: token, userAgent: oauthUserAgent() }),
    );

    return user.success && user.data.name ? user.data.name : null;
  } catch (error) {
    if (error instanceof RedditNetworkError) return null;
    throw error;
  }
}

export async function login(
  database: Database,
  opts: {
    redirectResponse: string;
    expectedState: string;
    post?: TokenPost;
    getf?: OAuthGet;
    now?: number;
  },
): Promise<string> {
  const code = parseRedirect(opts.redirectResponse, opts.expectedState);
  const token = await exchangeCode(code, { post: opts.post });

  if (!token.refresh_token)
    throw new RedditOAuthError(
      "token response missing a refresh/access token — request duration=permanent + a non-empty scope.",
    );
  const username = await fetchUsername(token.access_token, opts.getf);
  store(database, {
    refreshToken: token.refresh_token,
    accessToken: token.access_token,
    username,
    now: opts.now,
  });

  return username || "";
}
