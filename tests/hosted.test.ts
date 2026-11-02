import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createInvite, setHostedFetch } from "../src/hosted.ts";
import { handle } from "../src/web/routes.ts";
import { closeConnection, connection, setDatabasePath } from "../src/web/state.ts";

const ORIGIN = "https://demo.khaos.test";

const HOST = "demo.khaos.test";

const ENV_KEYS = [
  "CONTENT_HOARDER_PUBLIC_ORIGIN",
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "TWITCH_OAUTH_CLIENT_ID",
  "TWITCH_OAUTH_CLIENT_SECRET",
] as const;

let root = "";

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "content-hoarder-hosted-"));
  setDatabasePath(join(root, "app.db"));

  for (const key of ENV_KEYS) saved[key] = process.env[key];

  process.env.CONTENT_HOARDER_PUBLIC_ORIGIN = ORIGIN;
  process.env.GOOGLE_OAUTH_CLIENT_ID = "google-client";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "google-secret";
  process.env.TWITCH_OAUTH_CLIENT_ID = "twitch-client";
  process.env.TWITCH_OAUTH_CLIENT_SECRET = "twitch-secret";
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved[key];

    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  setHostedFetch(null);
  closeConnection();
  setDatabasePath(undefined);
  rmSync(root, { recursive: true, force: true });
});

function request(path: string, cookies: Record<string, string> = {}, host = HOST): Request {
  const headers = new Headers({ host, accept: "text/html" });

  const cookie = Object.entries(cookies)
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join("; ");

  if (cookie) headers.set("cookie", cookie);

  return new Request(`${ORIGIN}${path}`, { headers });
}

function setCookies(response: Response) {
  return Object.fromEntries(
    response.headers.getSetCookie().map((line) => {
      const [pair = ""] = line.split(";");
      const eq = pair.indexOf("=");

      return [pair.slice(0, eq), decodeURIComponent(pair.slice(eq + 1))] as const;
    }),
  );
}

function googleApi(sub: string, hasChannel = true): (input: string) => Promise<Response> {
  return async (input) => {
    const url = new URL(input);

    if (url.host === "oauth2.googleapis.com") return Response.json({ access_token: "g-token" });

    if (url.pathname === "/v1/userinfo")
      return Response.json({ sub, email: `${sub}@example.com`, email_verified: true });

    if (url.pathname.endsWith("/playlists"))
      return hasChannel
        ? Response.json({ items: [{ id: "PL1", snippet: { title: "Cooking" } }] })
        : Response.json({ error: { code: 404, message: "Channel not found." } }, { status: 404 });

    if (url.pathname.endsWith("/playlistItems"))
      return Response.json({
        items: [
          {
            snippet: {
              title: "Knife skills",
              videoOwnerChannelTitle: "Chef",
              resourceId: { videoId: "vid_knife01" },
            },
          },
          { snippet: { title: "Private video", resourceId: { videoId: "vid_hidden1" } } },
        ],
      });

    if (url.pathname.endsWith("/videos"))
      return Response.json({
        items: [{ id: "vid_liked01", snippet: { title: "A liked video", channelTitle: "Fan" } }],
      });

    return new Response("unexpected", { status: 500 });
  };
}

async function googleSignIn(
  sub: string,
  extra: Record<string, string> = {},
): Promise<{ response: Response; cookies: Record<string, string> }> {
  setHostedFetch(googleApi(sub));
  const start = await handle(request("/oauth/google/start?return=/add", extra));
  const location = new URL(start.headers.get("location") ?? "");
  const state = location.searchParams.get("state") ?? "";

  const response = await handle(
    request(`/oauth/google/callback?state=${state}&code=abc`, {
      ...extra,
      ...setCookies(start),
    }),
  );

  return { response, cookies: setCookies(response) };
}

const SourceCount = z.object({ count: z.number() });

function countSource(source: string): number {
  return SourceCount.parse(
    connection().query("SELECT COUNT(*) AS count FROM items WHERE source = ?").get(source),
  ).count;
}

test("local mode keeps working without a session", async () => {
  delete process.env.CONTENT_HOARDER_PUBLIC_ORIGIN;
  const response = await handle(request("/privacy", {}, "127.0.0.1:8788"));

  expect(response.status).toBe(404);
  expect((await handle(request("/", {}, "127.0.0.1:8788"))).status).toBe(200);
});

test("hosted mode sends strangers to sign-in and rejects other hosts", async () => {
  const home = await handle(request("/"));

  expect(home.status).toBe(302);
  expect(home.headers.get("location")).toBe("/auth/login");
  expect((await handle(request("/", {}, "evil.example"))).status).toBe(403);
  expect((await handle(request("/privacy"))).status).toBe(200);

  const api = await handle(
    new Request(`${ORIGIN}/items`, { headers: { host: HOST, accept: "application/json" } }),
  );

  expect(api.status).toBe(401);
});

test("public sign-in pages refuse to be framed", async () => {
  for (const path of ["/auth/login", "/privacy", "/invite/not-a-real-token"]) {
    const response = await handle(request(path));

    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  }
});

test("an invite lets one Google account in once and pulls its YouTube", async () => {
  const invite = createInvite(connection());
  const opened = await handle(request(`/invite/${invite}`));

  expect(opened.headers.get("location")).toBe("/oauth/google/start?return=/add");

  const { response, cookies } = await googleSignIn("friend", setCookies(opened));

  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe("/add?pulled=youtube%3A2");
  expect(cookies.ch_session).toBeTruthy();
  expect(countSource("youtube")).toBe(2);

  const signedIn = await handle(request("/", { ch_session: cookies.ch_session ?? "" }));

  expect(signedIn.status).toBe(200);
  expect((await handle(request(`/invite/${invite}`))).status).toBe(404);

  const stranger = await googleSignIn("stranger", setCookies(opened));

  expect(stranger.response.status).toBe(403);
  expect(stranger.cookies.ch_session).toBeUndefined();

  const returning = await googleSignIn("friend");

  expect(returning.response.status).toBe(302);
  expect(returning.cookies.ch_session).toBeTruthy();
});

test("a tampered state is refused", async () => {
  setHostedFetch(googleApi("friend"));
  const start = await handle(request("/oauth/google/start"));

  const response = await handle(
    request("/oauth/google/callback?state=forged&code=abc", setCookies(start)),
  );

  expect(response.status).toBe(400);
});

test("an account without a YouTube channel still signs in and brings its likes", async () => {
  const invite = createInvite(connection());
  const opened = await handle(request(`/invite/${invite}`));

  setHostedFetch(googleApi("viewer", false));
  const start = await handle(request("/oauth/google/start?return=/add", setCookies(opened)));
  const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? "";

  const response = await handle(
    request(`/oauth/google/callback?state=${state}&code=abc`, {
      ...setCookies(opened),
      ...setCookies(start),
    }),
  );

  expect(response.headers.get("location")).toBe("/add?pulled=youtube%3A1");
  expect(setCookies(response).ch_session).toBeTruthy();
});

test("Twitch needs a session and imports followed channels", async () => {
  expect((await handle(request("/oauth/twitch/start"))).headers.get("location")).toBe(
    "/auth/login",
  );

  const invite = createInvite(connection());
  const opened = await handle(request(`/invite/${invite}`));
  const { cookies } = await googleSignIn("friend", setCookies(opened));
  const session = { ch_session: cookies.ch_session ?? "" };

  setHostedFetch(async (input) => {
    const url = new URL(input);

    if (url.host === "id.twitch.tv") return Response.json({ access_token: "t-token" });

    if (url.pathname === "/helix/users") return Response.json({ data: [{ id: "42" }] });

    if (url.pathname === "/helix/channels/followed")
      return Response.json({
        data: [
          {
            broadcaster_id: "7",
            broadcaster_login: "cooking_live",
            broadcaster_name: "Cooking Live",
            followed_at: "2025-01-02T03:04:05Z",
          },
        ],
        pagination: {},
      });

    return new Response("unexpected", { status: 500 });
  });

  const start = await handle(request("/oauth/twitch/start?return=/add", session));
  const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? "";

  const done = await handle(
    request(`/oauth/twitch/callback?state=${state}&code=xyz`, {
      ...session,
      ...setCookies(start),
    }),
  );

  expect(done.headers.get("location")).toBe("/add?pulled=twitch%3A1");
  expect(countSource("twitch")).toBe(1);
});
