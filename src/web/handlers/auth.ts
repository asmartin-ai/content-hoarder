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
} from "../../hosted.ts";
import { ApiError, listYoutubePlaylists, pullTwitch } from "../../hosted_pull.ts";
import { AI_FIELDS_SENT, aiProviderIsZai, aiProviderLabel } from "../../assist/consent.ts";
import { demoAnalyticsOn } from "../../demo_analytics.ts";
import { html, raw, type SafeHtml } from "../views/html.ts";
import {
  YOUTUBE_CHOICE_SECONDS,
  beginYoutubeAuth,
  failYoutubeAuth,
  libraryConnection,
  mainConnection,
  notePull,
  setYoutubeChoice,
  startPull,
} from "../state.ts";
import { htmlResponse } from "../static.ts";

type Provider = "google" | "twitch";

interface PendingAuth {
  provider: Provider;
  verifier: string;
  returnPath: string;
  expires: number;
  sub: string | null;
  sequence: number;
  connectYoutube: boolean;
}

const PENDING = new Map<string, PendingAuth>();

let authSequence = 0;

const PENDING_SECONDS = 600;

const PENDING_LIMIT = 10_000;

const GOOGLE_SCOPES = "openid email";

const YOUTUBE_SCOPE = "https://www.googleapis.com/auth/youtube.readonly";

const TokenResponse = z.object({
  access_token: z.string().min(1),
  scope: z.string().default(""),
});

const UserEmail = z.object({ email: z.string().default("") });

const GoogleUser = z.object({
  sub: z.string().min(1),
  email: z.string().default(""),
  email_verified: z.boolean().optional(),
});

function now(): number {
  return Math.floor(Date.now() / 1000);
}

const GOOGLE_MARK = raw(
  '<svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true">' +
    '<path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>' +
    '<path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>' +
    '<path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>' +
    '<path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>' +
    "</svg>",
);

function googleButton(href: string): SafeHtml {
  return html`<a class="auth-google" href="${href}"
    ><span class="auth-google-mark">${GOOGLE_MARK}</span><span>Sign in with Google</span></a
  >`;
}

function page(title: string, body: SafeHtml, status = 200, mainClass = "auth"): Response {
  const document = html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="theme-color" content="#0f1115" />
        <meta
          name="description"
          content="Khaos turns everything you saved for later into a short, finishable list."
        />
        <title>${title} · Khaos</title>
        <link rel="icon" href="/static/icon.svg" type="image/svg+xml" />
        <link rel="stylesheet" href="/static/core/tokens.css" />
        <link rel="stylesheet" href="/static/home/home.css" />
        <link rel="stylesheet" href="/static/core/auth.css" />
        <script src="/static/theme.js"></script>
      </head>
      <body class="auth-page">
        <header class="auth-top">
          <a class="auth-brand" href="/"><span class="auth-led"></span>Khaos</a>
          <button class="auth-theme" type="button" data-theme-toggle aria-label="Switch theme">
            ☾︎
          </button>
        </header>
        <main class="${mainClass}">${body}</main>
        <footer class="auth-foot">
          <span>Invite-only pilot</span>
          <a href="/privacy">Privacy</a>
        </footer>
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
    html`<section class="auth-card" aria-labelledby="auth-title">
      <h1 class="auth-card-title" id="auth-title">${title}</h1>
      <p class="auth-line">${line}</p>
      <a class="auth-secondary" href="/auth/login">Back to sign in</a>
    </section>`,
    status,
  );
}

interface StartedAuth {
  state: string;
  verifier: string;
  sequence: number;
}

function begin(
  provider: Provider,
  returnPath: string,
  sub: string | null = null,
  connectYoutube = false,
): StartedAuth {
  const time = now();

  for (const [key, pending] of PENDING) if (pending.expires <= time) PENDING.delete(key);

  for (const key of PENDING.keys()) {
    if (PENDING.size < PENDING_LIMIT) break;

    PENDING.delete(key);
  }

  const state = randomBytes(24).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const sequence = (authSequence += 1);

  PENDING.set(state, {
    provider,
    verifier,
    returnPath,
    expires: time + PENDING_SECONDS,
    sub,
    sequence,
    connectYoutube,
  });

  return { state, verifier, sequence };
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

interface ExchangedToken {
  token: string;
  scope: string;
}

async function exchange(
  endpoint: string,
  fields: Record<string, string>,
): Promise<ExchangedToken | null> {
  const response = await hostedFetch()(endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(fields).toString(),
  });

  if (!response.ok) return null;

  const token = TokenResponse.safeParse(await response.json().catch(() => null));

  return token.success ? { token: token.data.access_token, scope: token.data.scope } : null;
}

export function sessionEmail(sub: string): string {
  const row = UserEmail.safeParse(
    mainConnection().query("SELECT email FROM hosted_users WHERE sub = ?").get(sub),
  );

  return row.success ? row.data.email : "";
}

export function invitePage(token: string): Response {
  if (!inviteOpen(mainConnection(), token))
    return notice(
      "This invite doesn't work",
      "It was already used or the link is wrong. Ask the person who invited you for a new one.",
      404,
    );

  return redirect("/oauth/google/start?return=/add", [inviteCookie(token)]);
}

export function landingPage(): Response {
  return page(
    "Your saves, finally sorted",
    html`<section class="auth-hero" aria-labelledby="auth-title">
        <h1 class="auth-hero-title" id="auth-title">
          Everything you saved for later, <span>ten at a time.</span>
        </h1>
        <p class="auth-lede">
          Khaos gathers what you saved on YouTube, Twitch and Reddit, plus the tabs you meant to
          read, into one private library. Then it hands you ten cards. Keep what still matters, let
          the rest go, and stop.
        </p>
        <div class="auth-cta">
          ${googleButton("/oauth/google/start?return=%2F")}
          <p class="auth-note">Invite-only. First time? Open the invite link you were sent.</p>
        </div>
      </section>
      <ol class="auth-steps" aria-label="How Khaos works">
        <li>
          <span class="auth-step-n" aria-hidden="true">1</span>
          <div>
            <h2>Bring in your saves</h2>
            <p>Connect YouTube or Twitch, or drop a Reddit export or a bookmarks file.</p>
          </div>
        </li>
        <li>
          <span class="auth-step-n" aria-hidden="true">2</span>
          <div>
            <h2>Clear 10</h2>
            <p>One card at a time, with an Undo button at the top.</p>
          </div>
        </li>
        <li>
          <span class="auth-step-n" aria-hidden="true">3</span>
          <div>
            <h2>Done for today</h2>
            <p>No streaks, no overdue counts. Ten is enough.</p>
          </div>
        </li>
      </ol>
      <section class="auth-trust" aria-labelledby="auth-trust-title">
        <h2 id="auth-trust-title">Yours alone</h2>
        <ul>
          <li>
            Sign-in reads your Google account ID and email. Nothing is imported until you choose.
          </li>
          <li>Your library is separate. Other testers can't see it.</li>
          <li>Letting something go never changes your YouTube, Twitch or Reddit account.</li>
        </ul>
        <a href="/privacy">Read the privacy notes</a>
      </section>`,
    200,
    "auth auth-wide",
  );
}

export function loginPage(request: Request): Response {
  const url = new URL(request.url);
  const returnPath = safeReturn(url.searchParams.get("return"));

  if (sessionSub(mainConnection(), request)) return redirect(returnPath);

  const query = new URLSearchParams({ return: returnPath }).toString();
  const signedOut = url.searchParams.has("signed_out");

  return page(
    "Sign in",
    html`<section class="auth-card" aria-labelledby="auth-title">
      ${
        signedOut
          ? html`<p class="auth-status" role="status">You're signed out.</p>
              <script src="/static/core/signed-out.js"></script>`
          : ""
      }
      <h1 class="auth-card-title" id="auth-title">Sign in to Khaos</h1>
      <p class="auth-line">Use the Google account you were invited with.</p>
      ${googleButton(`/oauth/google/start?${query}`)}
      <p class="auth-note">
        Khaos reads only your account ID and email. No invite yet? Ask the person running your
        pilot.
      </p>
    </section>`,
  );
}

export function privacyPage(): Response {
  return page(
    "Privacy",
    html`<h1 class="auth-title">Privacy</h1>
      <p class="auth-line">Khaos is a small pilot run by asmartin-ai.</p>
      <h2>What it reads</h2>
      <ul>
        <li>Google, when you sign in: your account ID and email, and nothing else.</li>
        <li>
          YouTube, only if you choose Connect YouTube: your playlists and liked videos, read-only.
        </li>
        <li>Twitch, if you connect it: the channels you follow, read-only.</li>
        <li>Files and links you add yourself.</li>
      </ul>
      <h2>What it does with it</h2>
      <ul>
        <li>
          Signing in reads only your account ID and email. If you choose Connect YouTube, Khaos
          reads your playlist list and keeps that access token in server memory for up to 10 minutes
          while you choose playlists; it is used for that one import and never written to disk.
        </li>
        <li>
          Your items are in a library of their own on one server for this pilot. Other testers can't
          see them. Nothing is sold. AI suggestions are off by default. If you turn them on,
          ${AI_FIELDS_SENT} are sent to ${aiProviderLabel()} to get a suggestion.
          ${
            aiProviderIsZai()
              ? html`The provider says it does not use API content to train unless the developer
                  opts in, and it processes data mainly in Singapore — see the
                  <a
                    href="https://docs.z.ai/legal-agreement/terms-of-use"
                    target="_blank"
                    rel="noopener"
                    >Z.ai terms of use</a
                  >
                  (§IV.7) and the API data processing addendum.`
              : "The provider's own terms apply."
          }
        </li>
        <li>Letting something go in Khaos never changes your YouTube, Twitch or Reddit account.</li>
        <li>Ask and your data is deleted, all of it.</li>
      </ul>
      ${
        demoAnalyticsOn()
          ? html`<p class="auth-line">
              During the pilot, Khaos records what you do in the app — screens opened, cards shown,
              decisions and their timing, undos — in your own library file, so I can improve it. It
              isn't shared or sold, and it's deleted with your library when the pilot ends.
            </p>`
          : ""
      }
      <p class="auth-line">
        Questions or deletion requests:
        <a href="https://github.com/asmartin-ai/content-hoarder/issues">open an issue on GitHub</a>
        or message the person who invited you.
      </p>`,
    200,
    "auth auth-prose",
  );
}

export function logout(request: Request): Response {
  endSession(mainConnection(), request);
  PENDING.delete(cookieValue(request, OAUTH_COOKIE));

  const response = redirect("/auth/login?signed_out=1", [
    clearedCookie(SESSION_COOKIE),
    clearedCookie(OAUTH_COOKIE),
    clearedCookie(INVITE_COOKIE),
  ]);

  response.headers.set("Clear-Site-Data", '"cache", "storage"');

  return response;
}

export function googleStart(request: Request): Response {
  const url = new URL(request.url);
  const returnPath = safeReturn(url.searchParams.get("return") ?? "/add");
  const sub = sessionSub(mainConnection(), request);
  const connectYoutube = Boolean(sub) && url.searchParams.get("connect") === "youtube";
  const { state, verifier, sequence } = begin("google", returnPath, sub, connectYoutube);

  if (connectYoutube && sub) beginYoutubeAuth(sub, sequence);

  const params = new URLSearchParams({
    client_id: config.get("GOOGLE_OAUTH_CLIENT_ID").trim(),
    redirect_uri: `${hostedOrigin()}/oauth/google/callback`,
    response_type: "code",
    scope: connectYoutube ? `${GOOGLE_SCOPES} ${YOUTUBE_SCOPE}` : GOOGLE_SCOPES,
    access_type: "online",
    prompt: "select_account",
    state,
    code_challenge: challenge(verifier),
    code_challenge_method: "S256",
  });

  if (connectYoutube && sub) {
    params.set("include_granted_scopes", "true");

    const email = sessionEmail(sub);

    if (email) params.set("login_hint", email);
  }

  return redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`, [
    cookie(OAUTH_COOKIE, state, PENDING_SECONDS),
  ]);
}

export async function googleCallback(request: Request): Promise<Response> {
  const pending = finish(request, "google");

  if (!pending) return notice("Sign-in expired", "Start again from the link.", 400);

  const url = new URL(request.url);
  const attempt = pending.sequence;
  const code = url.searchParams.get("code") ?? "";
  const database = mainConnection();
  const session = sessionSub(database, request);

  if (pending.connectYoutube) {
    if (!session) {
      if (pending.sub) failYoutubeAuth(pending.sub, attempt);

      return redirect("/auth/login", [clearedCookie(OAUTH_COOKIE)]);
    }

    if (session !== pending.sub) {
      if (pending.sub) failYoutubeAuth(pending.sub, attempt);

      return redirect("/add?youtube=denied", [clearedCookie(OAUTH_COOKIE)]);
    }
  }

  if (!code) {
    if (pending.connectYoutube) {
      if (session) failYoutubeAuth(session, attempt);

      return redirect("/add?youtube=denied", [clearedCookie(OAUTH_COOKIE)]);
    }

    return redirect("/auth/login", [clearedCookie(OAUTH_COOKIE)]);
  }

  const token = await exchange("https://oauth2.googleapis.com/token", {
    code,
    client_id: config.get("GOOGLE_OAUTH_CLIENT_ID").trim(),
    client_secret: config.get("GOOGLE_OAUTH_CLIENT_SECRET").trim(),
    redirect_uri: `${hostedOrigin()}/oauth/google/callback`,
    grant_type: "authorization_code",
    code_verifier: pending.verifier,
  });

  if (!token) {
    if (pending.sub && pending.connectYoutube) failYoutubeAuth(pending.sub, attempt);

    return notice("Google didn't sign you in", "Try again in a minute.", 502);
  }

  const deadline = Date.now() + YOUTUBE_CHOICE_SECONDS * 1000;
  const setCookies = [clearedCookie(OAUTH_COOKIE)];
  let sub = session;

  if (!sub) {
    const userResponse = await hostedFetch()("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { authorization: `Bearer ${token.token}` },
    });

    const user = GoogleUser.safeParse(await userResponse.json().catch(() => null));

    if (!userResponse.ok || !user.success) {
      if (pending.sub && pending.connectYoutube) failYoutubeAuth(pending.sub, attempt);

      return notice("Google didn't sign you in", "Try again in a minute.", 502);
    }

    const invite = cookieValue(request, INVITE_COOKIE);

    if (!userExists(database, user.data.sub)) {
      if (!invite || !claimInvite(database, invite, user.data.sub, user.data.email)) {
        if (pending.sub && pending.connectYoutube) failYoutubeAuth(pending.sub, attempt);

        return notice("Khaos is invite-only", "Ask the project owner for an invite link.", 403);
      }
    }

    setCookies.push(
      sessionCookie(createSession(database, user.data.sub)),
      clearedCookie(INVITE_COOKIE),
    );
    sub = user.data.sub;
  }

  if (!pending.connectYoutube) return redirect(pending.returnPath, setCookies);

  const granted = new Set(token.scope.split(/\s+/).filter(Boolean));

  if (!granted.has(YOUTUBE_SCOPE)) {
    failYoutubeAuth(sub, attempt);

    return redirect("/add?youtube=denied", setCookies);
  }

  try {
    const playlists = await listYoutubePlaylists(token.token, deadline);

    setYoutubeChoice(sub, { token: token.token, playlists, expiresAt: deadline }, attempt);
  } catch (error) {
    console.error(
      `youtube playlist listing failed: ${
        error instanceof ApiError ? `status ${error.status}` : "request failed"
      }`,
    );

    if (failYoutubeAuth(sub, attempt)) notePull(libraryConnection(sub), "youtube", "error");
  }

  return redirect("/add?youtube=choose", setCookies);
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

  const sub = sessionSub(mainConnection(), request);
  const library = sub ? libraryConnection(sub) : null;
  const done = (): Response => redirect(pending.returnPath, [clearedCookie(OAUTH_COOKIE)]);

  if (!code) {
    if (library) notePull(library, "twitch", "cancelled");

    return done();
  }

  const token = await exchange("https://id.twitch.tv/oauth2/token", {
    code,
    client_id: config.get("TWITCH_OAUTH_CLIENT_ID").trim(),
    client_secret: config.get("TWITCH_OAUTH_CLIENT_SECRET").trim(),
    redirect_uri: `${hostedOrigin()}/oauth/twitch/callback`,
    grant_type: "authorization_code",
  });

  if (!library) return done();

  if (token) startPull(library, "twitch", () => pullTwitch(library, token.token));
  else notePull(library, "twitch", "error");

  return done();
}
