import { createHash, randomBytes } from "node:crypto";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import * as config from "./config.ts";

export const SESSION_COOKIE = "ch_session";

export const INVITE_COOKIE = "ch_invite";

export const OAUTH_COOKIE = "ch_oauth";

const SESSION_SECONDS = 30 * 86_400;

const INVITE_COOKIE_SECONDS = 15 * 60;

const PUBLIC_PATHS = new Set([
  "/manifest.webmanifest",
  "/sw.js",
  "/privacy",
  "/auth/login",
  "/oauth/google/start",
  "/oauth/google/callback",
]);

const OWNER_ONLY_PATHS = new Set([
  "/reddit/sync",
  "/reddit/unsave/auth",
  "/reddit/unsave/drain",
  "/reddit/unsave/enable",
  "/reddit/unsave/enqueue-by-tag",
]);

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

let fetcher: Fetcher = (input, init) => fetch(input, init);

export function hostedFetch(): Fetcher {
  return fetcher;
}

export function setHostedFetch(next: Fetcher | null): void {
  fetcher = next ?? ((input, init) => fetch(input, init));
}

export function hostedOrigin(): string {
  return config.get("CONTENT_HOARDER_PUBLIC_ORIGIN").trim().replace(/\/+$/, "");
}

export function hostedHost(): string {
  const origin = hostedOrigin();

  if (!origin) return "";

  try {
    return new URL(origin).host.toLowerCase();
  } catch {
    return "";
  }
}

export function googleConfigured(): boolean {
  return Boolean(
    hostedOrigin() &&
    config.get("GOOGLE_OAUTH_CLIENT_ID").trim() &&
    config.get("GOOGLE_OAUTH_CLIENT_SECRET").trim(),
  );
}

export function twitchConfigured(): boolean {
  return Boolean(
    hostedOrigin() &&
    config.get("TWITCH_OAUTH_CLIENT_ID").trim() &&
    config.get("TWITCH_OAUTH_CLIENT_SECRET").trim(),
  );
}

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

export function cookieValue(request: Request, name: string): string {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const eq = part.indexOf("=");

    if (eq < 1 || part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();

    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  return "";
}

export function cookie(name: string, value: string, maxAge: number): string {
  const secure = hostedOrigin().startsWith("https://") ? "; Secure" : "";

  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

export function clearedCookie(name: string): string {
  return cookie(name, "", 0);
}

export function createInvite(db: Database): string {
  const token = newToken();

  db.query("INSERT INTO hosted_invites (token_hash, created_at) VALUES (?, ?)").run(
    hashToken(token),
    now(),
  );

  return token;
}

const InviteRow = z.object({ used_at: z.number().nullable() });

export function inviteOpen(db: Database, token: string): boolean {
  if (!token) return false;

  const row = InviteRow.safeParse(
    db.query("SELECT used_at FROM hosted_invites WHERE token_hash = ?").get(hashToken(token)),
  );

  return row.success && row.data.used_at === null;
}

export function inviteCookie(token: string): string {
  return cookie(INVITE_COOKIE, token, INVITE_COOKIE_SECONDS);
}

export function userExists(db: Database, sub: string): boolean {
  return db.query("SELECT 1 FROM hosted_users WHERE sub = ?").get(sub) !== null;
}

export function claimInvite(db: Database, token: string, sub: string, email: string): boolean {
  const claimed = db
    .query(
      "UPDATE hosted_invites SET used_at = ?, used_by_sub = ? WHERE token_hash = ? AND used_at IS NULL",
    )
    .run(now(), sub, hashToken(token));

  if (claimed.changes !== 1) return false;

  db.query("INSERT OR IGNORE INTO hosted_users (sub, email, created_at) VALUES (?, ?, ?)").run(
    sub,
    email,
    now(),
  );

  return true;
}

export function createSession(db: Database, sub: string): string {
  const token = newToken();
  const created = now();

  db.query("DELETE FROM hosted_sessions WHERE expires_at <= ?").run(created);

  db.query(
    "INSERT INTO hosted_sessions (token_hash, sub, created_at, expires_at) VALUES (?, ?, ?, ?)",
  ).run(hashToken(token), sub, created, created + SESSION_SECONDS);

  return token;
}

export function sessionCookie(token: string): string {
  return cookie(SESSION_COOKIE, token, SESSION_SECONDS);
}

const SessionRow = z.object({ sub: z.string() });

export function sessionSub(db: Database, request: Request): string | null {
  const token = cookieValue(request, SESSION_COOKIE);

  if (!token) return null;

  const row = SessionRow.safeParse(
    db
      .query(
        "SELECT s.sub FROM hosted_sessions s JOIN hosted_users u ON u.sub = s.sub WHERE s.token_hash = ? AND s.expires_at > ?",
      )
      .get(hashToken(token), now()),
  );

  return row.success ? row.data.sub : null;
}

export function endSession(db: Database, request: Request): void {
  const token = cookieValue(request, SESSION_COOKIE);

  if (token) db.query("DELETE FROM hosted_sessions WHERE token_hash = ?").run(hashToken(token));
}

export function publicPath(path: string): boolean {
  return PUBLIC_PATHS.has(path) || path.startsWith("/static/") || path.startsWith("/invite/");
}

export function ownerOnlyPath(path: string): boolean {
  return (
    OWNER_ONLY_PATHS.has(path) ||
    (path.startsWith("/reddit/items/") && path.endsWith("/unsave")) ||
    (path.startsWith("/items/") && path.endsWith("/promote"))
  );
}

export function gate(db: Database, request: Request): Response | null {
  if (!hostedOrigin()) return null;

  const url = new URL(request.url);

  if (publicPath(url.pathname) || sessionSub(db, request)) return null;

  const wantsPage =
    request.method === "GET" && (request.headers.get("accept") ?? "").includes("text/html");

  if (wantsPage) {
    const query = new URLSearchParams({ return: `${url.pathname}${url.search}` });

    return new Response(null, {
      status: 302,
      headers: { location: `/auth/login?${query}` },
    });
  }

  if (request.headers.get("hx-request")) {
    return Response.json(
      { error: "sign in" },
      { status: 401, headers: { "HX-Redirect": "/auth/login" } },
    );
  }

  return Response.json({ error: "sign in" }, { status: 401 });
}

export function safeReturn(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";

  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);

    if (code < 32 || code === 92 || code === 127) return "/";
  }

  const url = new URL(value, "https://khaos.invalid");

  if (url.origin !== "https://khaos.invalid" || url.pathname.startsWith("//")) return "/";

  return `${url.pathname}${url.search}${url.hash}`;
}
