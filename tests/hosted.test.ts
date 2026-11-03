import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createInvite, setHostedFetch } from "../src/hosted.ts";
import { handle } from "../src/web/routes.ts";
import {
  closeConnection,
  connection,
  currentPull,
  libraryConnection,
  setDatabasePath,
} from "../src/web/state.ts";

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

  await currentPull(libraryConnection(sub))?.settled;

  return { response, cookies: setCookies(response) };
}

async function importYoutube(sub: string, session: string, ids: string[]): Promise<Response> {
  const listing = await handle(
    new Request(`${ORIGIN}/youtube/playlists`, {
      headers: { host: HOST, accept: "application/json", cookie: `ch_session=${session}` },
    }),
  );

  const { generation } = z.object({ generation: z.string() }).parse(await listing.json());

  const response = await handle(
    new Request(`${ORIGIN}/youtube/import`, {
      method: "POST",
      headers: {
        host: HOST,
        origin: ORIGIN,
        accept: "application/json",
        "content-type": "application/json",
        cookie: `ch_session=${session}`,
      },
      body: JSON.stringify({ ids, generation }),
    }),
  );

  await currentPull(libraryConnection(sub))?.settled;

  return response;
}

const SourceCount = z.object({ count: z.number() });

function countSource(sub: string, source: string): number {
  return SourceCount.parse(
    libraryConnection(sub)
      .query("SELECT COUNT(*) AS count FROM items WHERE source = ?")
      .get(source),
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

test("a signed-out htmx fragment asks the page to go to sign-in", async () => {
  const fragment = await handle(
    new Request(`${ORIGIN}/hx/today/upnext`, { headers: { host: HOST, "hx-request": "true" } }),
  );

  expect(fragment.status).toBe(401);
  expect(fragment.headers.get("hx-redirect")).toBe("/auth/login");
});

test("a malformed address is not found, not a crash", async () => {
  expect((await handle(request("/invite/%E0%A4%A"))).status).toBe(404);
  delete process.env.CONTENT_HOARDER_PUBLIC_ORIGIN;
  expect((await handle(request("/media/%E0%A4%A", {}, "127.0.0.1:8788"))).status).toBe(404);
});

test("public sign-in pages refuse to be framed", async () => {
  for (const path of ["/auth/login", "/privacy", "/invite/not-a-real-token"]) {
    const response = await handle(request(path));

    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  }
});

test("an invite lets one Google account in once and chooses its YouTube", async () => {
  const invite = createInvite(connection());
  const opened = await handle(request(`/invite/${invite}`));

  expect(opened.headers.get("location")).toBe("/oauth/google/start?return=/add");

  const { response, cookies } = await googleSignIn("friend", setCookies(opened));

  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe("/add?youtube=choose");
  expect(cookies.ch_session).toBeTruthy();
  expect(countSource("friend", "youtube")).toBe(0);

  const session = cookies.ch_session ?? "";

  expect((await importYoutube("friend", session, ["PL1"])).status).toBe(200);
  expect(countSource("friend", "youtube")).toBe(1);

  const add = () => handle(request("/add", { ch_session: session }));

  expect(await (await add()).text()).toContain("YouTube: 1 item added");
  expect(await (await add()).text()).not.toContain("items added");

  const signedIn = await handle(request("/", { ch_session: session }));

  expect(signedIn.status).toBe(200);
  expect((await handle(request(`/invite/${invite}`))).status).toBe(404);

  const stranger = await googleSignIn("stranger", setCookies(opened));

  expect(stranger.response.status).toBe(403);
  expect(stranger.cookies.ch_session).toBeUndefined();

  const returning = await googleSignIn("friend");

  expect(returning.response.status).toBe(302);
  expect(returning.cookies.ch_session).toBeTruthy();
});

test("Google sign-in reads only the playlist list and imports nothing", async () => {
  const opened = await handle(request(`/invite/${createInvite(connection())}`));
  const calls: string[] = [];
  const api = googleApi("lister");

  setHostedFetch(async (input) => {
    calls.push(new URL(input).pathname);

    return api(input);
  });

  const start = await handle(request("/oauth/google/start?return=/add", setCookies(opened)));
  const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? "";

  const response = await handle(
    request(`/oauth/google/callback?state=${state}&code=abc`, {
      ...setCookies(opened),
      ...setCookies(start),
    }),
  );

  const session = { ch_session: setCookies(response).ch_session ?? "" };

  expect(response.headers.get("location")).toBe("/add?youtube=choose");
  expect(calls.filter((path) => path.startsWith("/youtube/"))).toEqual(["/youtube/v3/playlists"]);
  expect(countSource("lister", "youtube")).toBe(0);

  const listed = await handle(
    new Request(`${ORIGIN}/youtube/playlists`, {
      headers: {
        host: HOST,
        accept: "application/json",
        cookie: `ch_session=${session.ch_session}`,
      },
    }),
  );

  expect(await listed.json()).toMatchObject({ state: "choose" });
});

test("a tampered state is refused", async () => {
  setHostedFetch(googleApi("friend"));
  const start = await handle(request("/oauth/google/start"));

  const response = await handle(
    request("/oauth/google/callback?state=forged&code=abc", setCookies(start)),
  );

  expect(response.status).toBe(400);
});

test("an account without a YouTube channel still signs in and can choose its likes", async () => {
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

  const session = setCookies(response).ch_session ?? "";

  expect(response.headers.get("location")).toBe("/add?youtube=choose");
  expect(session).toBeTruthy();
  expect(countSource("viewer", "youtube")).toBe(0);

  expect((await importYoutube("viewer", session, ["LL"])).status).toBe(200);
  expect(countSource("viewer", "youtube")).toBe(1);
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

  expect(done.headers.get("location")).toBe("/add");
  await currentPull(libraryConnection("friend"))?.settled;
  expect(countSource("friend", "twitch")).toBe(1);
});

test("each account has its own library", async () => {
  const sessions: string[] = [];

  for (const sub of ["friend-a", "friend-b"]) {
    const opened = await handle(request(`/invite/${createInvite(connection())}`));
    const { cookies } = await googleSignIn(sub, setCookies(opened));
    const session = cookies.ch_session ?? "";

    await importYoutube(sub, session, ["LL"]);
    sessions.push(session);
  }

  const [first = "", second = ""] = sessions;

  const kept = await handle(
    new Request(`${ORIGIN}/items/${encodeURIComponent("youtube:vid_liked01")}/status`, {
      method: "POST",
      headers: {
        host: HOST,
        origin: ORIGIN,
        "content-type": "application/json",
        cookie: `ch_session=${first}`,
      },
      body: JSON.stringify({ status: "keep" }),
    }),
  );

  expect(kept.status).toBe(200);

  const listings: string[] = [];

  for (const session of sessions) {
    const listed = await handle(
      new Request(`${ORIGIN}/items`, {
        headers: { host: HOST, accept: "application/json", cookie: `ch_session=${session}` },
      }),
    );

    listings.push(await listed.text());
  }

  expect(second).not.toBe(first);
  expect(countSource("friend-a", "youtube")).toBe(1);
  expect(countSource("friend-b", "youtube")).toBe(1);
  expect(listings[0]).toContain('"status":"keep"');
  expect(listings[1]).not.toContain('"status":"keep"');
  expect(connection().query("SELECT COUNT(*) AS n FROM items").get()).toEqual({ n: 0 });

  const post = (path: string, session: string, body: FormData | string, type?: string) => {
    const headers = new Headers({ host: HOST, origin: ORIGIN, cookie: `ch_session=${session}` });

    if (type) headers.set("content-type", type);

    return handle(new Request(`${ORIGIN}${path}`, { method: "POST", headers, body }));
  };

  const form = new FormData();

  form.append("file", new File(["https://example.com/a"], "links.txt"));
  form.append("source", "links");

  const { token } = z
    .object({ token: z.string() })
    .parse(await (await post("/import/prepare", first, form)).json());

  const commit = (session: string) =>
    post("/import/commit", session, JSON.stringify({ token }), "application/json");

  expect((await commit(second)).status).toBe(400);
  expect((await commit(first)).status).toBe(200);
  expect(countSource("friend-a", "bookmarks")).toBe(1);
  expect(countSource("friend-b", "bookmarks")).toBe(0);
});
