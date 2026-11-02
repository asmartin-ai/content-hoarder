import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import * as config from "../../config.ts";
import {
  INVITE_COOKIE,
  OAUTH_COOKIE,
  SESSION_COOKIE,
  claimInvite,
  clearedCookie,
  cookie,
  cookieValue,
  createSession,
  endSession,
  hostedFetch,
  hostedOrigin,
  inviteCookie,
  inviteOpen,
  safeReturn,
  sessionCookie,
  sessionSub,
  userExists,
  withParam,
} from "../../hosted.ts";
import { pullTwitch, pullYoutube } from "../../hosted_pull.ts";
import { html, type SafeHtml } from "../views/html.ts";
import { connection } from "../state.ts";
import { htmlResponse } from "../static.ts";

type Provider = "google" | "twitch";

interface PendingAuth {
  provider: Provider;
  verifier: string;
  returnPath: string;
  expires: number;
}

const PENDING = new Map<string, PendingAuth>();

const PENDING_SECONDS = 600;

const GOOGLE_SCOPES = "openid email https://www.googleapis.com/auth/youtube.readonly";

const TokenResponse = z.object({ access_token: z.string().min(1) });

const GoogleUser = z.object({
  sub: z.string().min(1),
  email: z.string().default(""),
  email_verified: z.boolean().optional(),
});

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function page(title: string, body: SafeHtml, status = 200): Response {
  const document = html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="theme-color" content="#0f1115" />
        <title>${title} · Khaos</title>
        <link rel="stylesheet" href="/static/core/tokens.css" />
        <link rel="stylesheet" href="/static/home/home.css" />
        <link rel="stylesheet" href="/static/core/auth.css" />
        <script src="/static/theme.js"></script>
      </head>
      <body class="auth-page">
        <main class="auth">${body}</main>
      </body>
    </html>`;

  return htmlResponse(document.value, { status });
}

function redirect(location: string, setCookies: string[] = []): Response {
  const headers = new Headers({ location });

  for (const value of setCookies) headers.append("set-cookie", value);

  return new Response(null, { status: 302, headers });
}

function notice(title: string, line: string, status: number): Response {
  return page(
    title,
    html`<h1 class="auth-title">${title}</h1>
      <p class="auth-line">${line}</p>`,
    status,
  );
}

interface StartedAuth {
  state: string;
  verifier: string;
}

function begin(provider: Provider, returnPath: string): StartedAuth {
  const time = now();

  for (const [key, pending] of PENDING) if (pending.expires <= time) PENDING.delete(key);

  const state = randomBytes(24).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");

  PENDING.set(state, { provider, verifier, returnPath, expires: time + PENDING_SECONDS });

  return { state, verifier };
}

function finish(request: Request, provider: Provider): PendingAuth | null {
  const url = new URL(request.url);
  const state = url.searchParams.get("state") ?? "";
  const pending = PENDING.get(state);

  if (!state || !pending || cookieValue(request, OAUTH_COOKIE) !== state) return null;

  PENDING.delete(state);

  if (pending.provider !== provider || pending.expires <= now()) return null;

  return pending;
}

function challenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

async function exchange(endpoint: string, fields: Record<string, string>): Promise<string | null> {
  const response = await hostedFetch()(endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(fields).toString(),
  });

  if (!response.ok) return null;

  const token = TokenResponse.safeParse(await response.json().catch(() => null));

  return token.success ? token.data.access_token : null;
}

export function invitePage(token: string): Response {
  if (!inviteOpen(connection(), token))
    return notice(
      "This invite doesn't work",
      "It was already used or the link is wrong. Ask the owner for a new one.",
      404,
    );

  return redirect("/oauth/google/start?return=/add", [inviteCookie(token)]);
}

export function loginPage(): Response {
  return page(
    "Sign in",
    html`<h1 class="auth-title">Khaos</h1>
      <p class="auth-line">Khaos is invite-only. Already have an account?</p>
      <a class="auth-button" href="/oauth/google/start">Sign in with Google</a>
      <p class="auth-small"><a href="/privacy">Privacy</a></p>`,
  );
}

export function privacyPage(): Response {
  return page(
    "Privacy",
    html`<h1 class="auth-title">Privacy</h1>
      <p class="auth-line">Khaos is a small pilot run by the owner.</p>
      <h2>What it reads</h2>
      <ul>
        <li>
          Google: your account ID and email, to sign you in. Your YouTube playlists and liked
          videos, read-only.
        </li>
        <li>Twitch, if you connect it: the channels you follow, read-only.</li>
        <li>Files and links you add yourself.</li>
      </ul>
      <h2>What it does with it</h2>
      <ul>
        <li>
          Each sign-in reads your lists once. The access token is used for that one pull and is not
          stored.
        </li>
        <li>
          Your items live on one server for this pilot. Nothing is sold, shared or used to train AI.
        </li>
        <li>Letting something go in Khaos never changes your YouTube, Twitch or Reddit account.</li>
        <li>Ask and your data is deleted, all of it.</li>
      </ul>
      <p class="auth-line">Contact: https://github.com/asmartin-ai/content-hoarder/issues</p>`,
  );
}

export function logout(request: Request): Response {
  endSession(connection(), request);

  return redirect("/auth/login", [clearedCookie(SESSION_COOKIE)]);
}

export function googleStart(request: Request): Response {
  const returnPath = safeReturn(new URL(request.url).searchParams.get("return"));
  const { state, verifier } = begin("google", returnPath);

  const params = new URLSearchParams({
    client_id: config.get("GOOGLE_OAUTH_CLIENT_ID").trim(),
    redirect_uri: `${hostedOrigin()}/oauth/google/callback`,
    response_type: "code",
    scope: GOOGLE_SCOPES,
    access_type: "online",
    include_granted_scopes: "true",
    prompt: "select_account",
    state,
    code_challenge: challenge(verifier),
    code_challenge_method: "S256",
  });

  return redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`, [
    cookie(OAUTH_COOKIE, state, PENDING_SECONDS),
  ]);
}

export async function googleCallback(request: Request): Promise<Response> {
  const pending = finish(request, "google");

  if (!pending) return notice("Sign-in expired", "Start again from the link.", 400);

  const code = new URL(request.url).searchParams.get("code") ?? "";

  if (!code) return redirect("/auth/login", [clearedCookie(OAUTH_COOKIE)]);

  const token = await exchange("https://oauth2.googleapis.com/token", {
    code,
    client_id: config.get("GOOGLE_OAUTH_CLIENT_ID").trim(),
    client_secret: config.get("GOOGLE_OAUTH_CLIENT_SECRET").trim(),
    redirect_uri: `${hostedOrigin()}/oauth/google/callback`,
    grant_type: "authorization_code",
    code_verifier: pending.verifier,
  });

  if (!token) return notice("Google didn't sign you in", "Try again in a minute.", 502);

  const database = connection();
  const setCookies = [clearedCookie(OAUTH_COOKIE)];

  if (!sessionSub(database, request)) {
    const userResponse = await hostedFetch()("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { authorization: `Bearer ${token}` },
    });

    const user = GoogleUser.safeParse(await userResponse.json().catch(() => null));

    if (!userResponse.ok || !user.success)
      return notice("Google didn't sign you in", "Try again in a minute.", 502);

    const invite = cookieValue(request, INVITE_COOKIE);

    if (!userExists(database, user.data.sub)) {
      if (!invite || !claimInvite(database, invite, user.data.sub, user.data.email))
        return notice("Khaos is invite-only", "Ask the owner for an invite link.", 403);
    }

    setCookies.push(
      sessionCookie(createSession(database, user.data.sub)),
      clearedCookie(INVITE_COOKIE),
    );
  }

  let pulled: string;

  try {
    pulled = `youtube:${await pullYoutube(database, token)}`;
  } catch (error) {
    console.error(`youtube pull failed: ${error instanceof Error ? error.message : String(error)}`);
    pulled = "youtube:error";
  }

  return redirect(withParam(pending.returnPath, "pulled", pulled), setCookies);
}

export function twitchStart(request: Request): Response {
  const returnPath = safeReturn(new URL(request.url).searchParams.get("return"));
  const { state } = begin("twitch", returnPath);

  const params = new URLSearchParams({
    client_id: config.get("TWITCH_OAUTH_CLIENT_ID").trim(),
    redirect_uri: `${hostedOrigin()}/oauth/twitch/callback`,
    response_type: "code",
    scope: "user:read:follows",
    state,
  });

  return redirect(`https://id.twitch.tv/oauth2/authorize?${params}`, [
    cookie(OAUTH_COOKIE, state, PENDING_SECONDS),
  ]);
}

export async function twitchCallback(request: Request): Promise<Response> {
  const pending = finish(request, "twitch");

  if (!pending) return notice("Twitch sign-in expired", "Start again from Add.", 400);

  const code = new URL(request.url).searchParams.get("code") ?? "";

  const done = (pulled: string): Response =>
    redirect(withParam(pending.returnPath, "pulled", pulled), [clearedCookie(OAUTH_COOKIE)]);

  if (!code) return done("twitch:cancelled");

  const token = await exchange("https://id.twitch.tv/oauth2/token", {
    code,
    client_id: config.get("TWITCH_OAUTH_CLIENT_ID").trim(),
    client_secret: config.get("TWITCH_OAUTH_CLIENT_SECRET").trim(),
    redirect_uri: `${hostedOrigin()}/oauth/twitch/callback`,
    grant_type: "authorization_code",
  });

  if (!token) return done("twitch:error");

  try {
    return done(`twitch:${await pullTwitch(connection(), token)}`);
  } catch (error) {
    console.error(`twitch pull failed: ${error instanceof Error ? error.message : String(error)}`);

    return done("twitch:error");
  }
}
