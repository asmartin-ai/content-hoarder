import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import * as db from "../src/db.ts";
import { createInvite, safeReturn, setHostedFetch } from "../src/hosted.ts";
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
  "PKMS_CAPTURE_URL",
  "PKMS_CAPTURE_TOKEN",
  "LLM_BASE_URL",
  "LLM_MODEL",
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

function postRequest(path: string, cookies: Record<string, string> = {}): Request {
  const headers = new Headers({ host: HOST, origin: ORIGIN, accept: "text/html" });

  const cookie = Object.entries(cookies)
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join("; ");

  if (cookie) headers.set("cookie", cookie);

  return new Request(`${ORIGIN}${path}`, { method: "POST", headers });
}

function seedItem(
  sub: string,
  id: string,
  opts: { status?: string; metadata?: Record<string, number> } = {},
): void {
  const now = Math.floor(Date.now() / 1000);

  libraryConnection(sub)
    .query(
      "INSERT INTO items(fullname, source, source_id, first_seen_utc, last_seen_utc, status, " +
        "processed_utc, metadata) VALUES (?, 'youtube', ?, ?, ?, ?, ?, ?)",
    )
    .run(
      `youtube:${id}`,
      id,
      now,
      now,
      opts.status ?? "inbox",
      opts.status && opts.status !== "inbox" ? now : null,
      JSON.stringify(opts.metadata ?? {}),
    );
}

function googleApi(
  sub: string,
  hasChannel = true,
  scope = "openid email https://www.googleapis.com/auth/youtube.readonly",
): (input: string) => Promise<Response> {
  return async (input) => {
    const url = new URL(input);

    if (url.host === "oauth2.googleapis.com")
      return Response.json({ access_token: "g-token", scope });

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

async function connectYoutube(
  sub: string,
  session: string,
  opts: { hasChannel?: boolean; scope?: string } = {},
): Promise<{ response: Response; cookies: Record<string, string> }> {
  setHostedFetch(googleApi(sub, opts.hasChannel ?? true, opts.scope));

  const start = await handle(
    request("/oauth/google/start?connect=youtube&return=%2Fadd%3Fyoutube%3Dchoose", {
      ch_session: session,
    }),
  );

  const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? "";

  const response = await handle(
    request(`/oauth/google/callback?state=${state}&code=abc`, {
      ch_session: session,
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

test("hosted mode greets strangers, guards the app and rejects other hosts", async () => {
  const landing = await handle(request("/"));

  expect(landing.status).toBe(200);
  expect(await landing.text()).toContain('href="/oauth/google/start?return=%2F"');

  const home = await handle(request("/home"));

  expect(home.status).toBe(302);
  const login = new URL(home.headers.get("location") ?? "", ORIGIN);

  expect(login.pathname).toBe("/auth/login");
  expect(login.searchParams.get("return")).toBe("/home");
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

test("sign-in resumes the protected page with its query intact", async () => {
  const destination = "/library?source=youtube&status=keep";
  const opened = await handle(request(`/invite/${createInvite(connection())}`));
  const inviteCookies = setCookies(opened);
  const blocked = await handle(request(destination));
  const login = await handle(request(blocked.headers.get("location") ?? "", inviteCookies));

  const startPath = (await login.text())
    .match(/href="(\/oauth\/google\/start[^"]*)"/)?.[1]
    ?.replaceAll("&amp;", "&");

  if (!startPath) throw new Error("Missing sign-in action");

  setHostedFetch(googleApi("returning"));

  const start = await handle(request(startPath, inviteCookies));
  const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? "";

  const signedIn = await handle(
    request(`/oauth/google/callback?state=${state}&code=abc`, {
      ...inviteCookies,
      ...setCookies(start),
    }),
  );

  expect(signedIn.headers.get("location")).toBe(destination);
  expect((await handle(request(destination, setCookies(signedIn)))).status).toBe(200);
});

test("return paths cannot escape the application after browser normalization", () => {
  for (const value of [
    "https://evil.example",
    "//evil.example",
    "/\\evil.example",
    "/\n/evil.example",
    "/\t/evil.example",
    "/path/..//evil.example",
    "/path\u0000",
  ]) {
    expect(safeReturn(value)).toBe("/");
  }

  expect(safeReturn("/library?source=youtube&status=keep#saved")).toBe(
    "/library?source=youtube&status=keep#saved",
  );
});

test("a signed-in visitor to sign-in goes straight to the requested page", async () => {
  const inviteCookies = setCookies(await handle(request(`/invite/${createInvite(connection())}`)));
  const { cookies } = await googleSignIn("already-in", inviteCookies);
  const session = { ch_session: cookies.ch_session ?? "" };

  const login = await handle(request("/auth/login?return=%2Flibrary%3Fsource%3Dyoutube", session));

  expect(login.status).toBe(302);
  expect(login.headers.get("location")).toBe("/library?source=youtube");

  const signedOut = await handle(postRequest("/auth/logout", session));
  const after = await handle(request(signedOut.headers.get("location") ?? "", session));

  expect(after.status).toBe(200);
  expect(await after.text()).toContain('role="status"');
});

test("sign-out revokes this session and cancels its pending sign-in", async () => {
  const inviteCookies = setCookies(await handle(request(`/invite/${createInvite(connection())}`)));
  const { cookies } = await googleSignIn("signing-out", inviteCookies);
  const session = { ch_session: cookies.ch_session ?? "" };
  const start = await handle(request("/oauth/google/start?return=%2Flibrary", session));
  const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? "";
  const staleCookies = { ...inviteCookies, ...session, ...setCookies(start) };
  const signedOut = await handle(postRequest("/auth/logout", staleCookies));

  expect(signedOut.status).toBe(302);
  expect(setCookies(signedOut)).toMatchObject({
    ch_session: "",
    ch_oauth: "",
    ch_invite: "",
  });
  expect((await handle(request("/library", session))).status).toBe(302);

  const replay = await handle(
    request(`/oauth/google/callback?state=${state}&code=abc`, staleCookies),
  );

  expect(replay.status).toBe(400);
  expect(setCookies(replay).ch_session).toBeUndefined();
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
  expect(response.headers.get("location")).toBe("/add");
  expect(cookies.ch_session).toBeTruthy();
  expect(countSource("friend", "youtube")).toBe(0);

  const session = cookies.ch_session ?? "";
  const connected = await connectYoutube("friend", session);

  expect(connected.response.headers.get("location")).toBe("/add?youtube=choose");
  expect(countSource("friend", "youtube")).toBe(0);

  expect((await importYoutube("friend", session, ["PL1"])).status).toBe(200);
  expect(countSource("friend", "youtube")).toBe(1);

  const add = () => handle(request("/add", { ch_session: session }));

  expect(await (await add()).text()).toContain("YouTube: 1 item added");
  expect(await (await add()).text()).not.toContain("items added");

  const signedIn = await handle(request("/home", { ch_session: session }));

  expect(signedIn.status).toBe(200);
  expect((await handle(request(`/invite/${invite}`))).status).toBe(404);

  const stranger = await googleSignIn("stranger", setCookies(opened));

  expect(stranger.response.status).toBe(403);
  expect(stranger.cookies.ch_session).toBeUndefined();

  const returning = await googleSignIn("friend");

  expect(returning.response.status).toBe(302);
  expect(returning.cookies.ch_session).toBeTruthy();
});

test("Google sign-in asks only for the account and email and touches no YouTube data", async () => {
  const opened = await handle(request(`/invite/${createInvite(connection())}`));
  const calls: string[] = [];
  const api = googleApi("lister");

  setHostedFetch(async (input) => {
    calls.push(new URL(input).pathname);

    return api(input);
  });

  const start = await handle(request("/oauth/google/start?return=/add", setCookies(opened)));
  const authorize = new URL(start.headers.get("location") ?? "");
  const state = authorize.searchParams.get("state") ?? "";

  expect(authorize.searchParams.get("scope")).toBe("openid email");
  expect(authorize.searchParams.get("include_granted_scopes")).toBeNull();
  expect(authorize.searchParams.get("login_hint")).toBeNull();

  const response = await handle(
    request(`/oauth/google/callback?state=${state}&code=abc`, {
      ...setCookies(opened),
      ...setCookies(start),
    }),
  );

  expect(response.headers.get("location")).toBe("/add");
  expect(calls.filter((path) => path.startsWith("/youtube/"))).toEqual([]);
  expect(countSource("lister", "youtube")).toBe(0);
});

test("connecting YouTube asks for the YouTube scope and offers the playlist choice", async () => {
  const invite = createInvite(connection());
  const opened = await handle(request(`/invite/${invite}`));
  const { cookies } = await googleSignIn("connector", setCookies(opened));
  const session = { ch_session: cookies.ch_session ?? "" };

  setHostedFetch(googleApi("connector"));

  const start = await handle(
    request("/oauth/google/start?connect=youtube&return=%2Fadd%3Fyoutube%3Dchoose", session),
  );

  const authorize = new URL(start.headers.get("location") ?? "");
  const state = authorize.searchParams.get("state") ?? "";

  expect(authorize.searchParams.get("scope")).toBe(
    "openid email https://www.googleapis.com/auth/youtube.readonly",
  );
  expect(authorize.searchParams.get("include_granted_scopes")).toBe("true");
  expect(authorize.searchParams.get("login_hint")).toBe("connector@example.com");

  const response = await handle(
    request(`/oauth/google/callback?state=${state}&code=abc`, {
      ...session,
      ...setCookies(start),
    }),
  );

  expect(response.headers.get("location")).toBe("/add?youtube=choose");

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
  expect(countSource("connector", "youtube")).toBe(0);
});

test("un-ticking the YouTube box lands on Add without a choice", async () => {
  const invite = createInvite(connection());
  const opened = await handle(request(`/invite/${invite}`));
  const { cookies } = await googleSignIn("decliner", setCookies(opened));
  const session = { ch_session: cookies.ch_session ?? "" };
  const calls: string[] = [];

  setHostedFetch(async (input) => {
    const path = new URL(input).pathname;

    calls.push(path);

    if (path === "/token") return Response.json({ access_token: "g-token", scope: "openid email" });

    return new Response("unexpected", { status: 500 });
  });

  const start = await handle(
    request("/oauth/google/start?connect=youtube&return=%2Fadd%3Fyoutube%3Dchoose", session),
  );

  const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? "";

  const response = await handle(
    request(`/oauth/google/callback?state=${state}&code=abc`, {
      ...session,
      ...setCookies(start),
    }),
  );

  expect(response.headers.get("location")).toBe("/add?youtube=denied");
  expect(calls.filter((path) => path.startsWith("/youtube/"))).toEqual([]);

  const add = await handle(request("/add?youtube=denied", session));

  expect(await add.text()).toContain("YouTube stays off");
});

test("Add walks a new friend from bring-in to done, then collapses", async () => {
  const opened = await handle(request(`/invite/${createInvite(connection())}`));
  const { cookies } = await googleSignIn("walker", setCookies(opened));
  const session = cookies.ch_session ?? "";
  const addPage = async () => (await handle(request("/add", { ch_session: session }))).text();

  expect(await addPage()).toContain('data-onboarding-step="1"');
  expect(db.getSetting(libraryConnection("walker"), "onboarding_done_seen")).toBeNull();

  await connectYoutube("walker", session);
  expect((await importYoutube("walker", session, ["PL1"])).status).toBe(200);
  expect(await addPage()).toContain('data-onboarding-step="2"');

  libraryConnection("walker")
    .query("UPDATE items SET status = 'archived', processed_utc = ? WHERE status = 'inbox'")
    .run(Math.floor(Date.now() / 1000));

  const done = await addPage();

  expect(done).toContain('data-onboarding-step="3"');
  expect(done).not.toContain("is-collapsed");
  expect(await addPage()).not.toContain("is-collapsed");
  expect(db.getSetting(libraryConnection("walker"), "onboarding_done_seen")).toBeNull();

  expect((await handle(postRequest("/onboarding/seen", { ch_session: session }))).status).toBe(204);
  expect(db.getSetting(libraryConnection("walker"), "onboarding_done_seen")).toBe("1");
  expect(await addPage()).toContain("is-collapsed");
});

test("a swept day fills the welcome's Clear 10 even while the inbox still has items", async () => {
  const opened = await handle(request(`/invite/${createInvite(connection())}`));
  const { cookies } = await googleSignIn("sweeper", setCookies(opened));
  const session = cookies.ch_session ?? "";
  const now = Math.floor(Date.now() / 1000);

  seedItem("sweeper", "waiting");

  for (let index = 0; index < 10; index += 1)
    seedItem("sweeper", `swept${index}`, {
      status: "archived",
      metadata: { decayed_at: now },
    });

  const addPage = async () => (await handle(request("/add", { ch_session: session }))).text();

  expect(await addPage()).toContain('data-onboarding-step="3"');
  expect(await addPage()).not.toContain("is-collapsed");
  expect(db.getSetting(libraryConnection("sweeper"), "onboarding_done_seen")).toBeNull();
});

test("cancelling YouTube consent returns to Add with the session intact", async () => {
  const opened = await handle(request(`/invite/${createInvite(connection())}`));
  const { cookies } = await googleSignIn("canceller", setCookies(opened));
  const session = cookies.ch_session ?? "";

  setHostedFetch(googleApi("canceller"));

  const start = await handle(
    request("/oauth/google/start?connect=youtube&return=%2Fadd%3Fyoutube%3Dchoose", {
      ch_session: session,
    }),
  );

  const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? "";

  const response = await handle(
    request(`/oauth/google/callback?state=${state}&error=access_denied`, {
      ch_session: session,
      ...setCookies(start),
    }),
  );

  expect(response.headers.get("location")).toBe("/add?youtube=denied");
  expect(setCookies(response).ch_session).toBeUndefined();

  const add = await handle(request("/add?youtube=denied", { ch_session: session }));

  expect(add.status).toBe(200);
  expect(await add.text()).toContain("YouTube stays off");
});

test("cancelling sign-in still returns to sign-in", async () => {
  const opened = await handle(request(`/invite/${createInvite(connection())}`));
  const start = await handle(request("/oauth/google/start?return=/add", setCookies(opened)));
  const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? "";

  const response = await handle(
    request(`/oauth/google/callback?state=${state}&error=access_denied`, {
      ...setCookies(opened),
      ...setCookies(start),
    }),
  );

  expect(response.headers.get("location")).toBe("/auth/login");
  expect(setCookies(response).ch_session).toBeUndefined();
});

test("a connect callback after logout does not sign the account back in", async () => {
  const opened = await handle(request(`/invite/${createInvite(connection())}`));
  const { cookies } = await googleSignIn("logged-out", setCookies(opened));
  const session = cookies.ch_session ?? "";

  setHostedFetch(googleApi("logged-out"));

  const start = await handle(
    request("/oauth/google/start?connect=youtube&return=%2Fadd%3Fyoutube%3Dchoose", {
      ch_session: session,
    }),
  );

  const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? "";

  expect((await handle(postRequest("/auth/logout", { ch_session: session }))).status).toBe(302);

  const response = await handle(
    request(`/oauth/google/callback?state=${state}&code=abc`, {
      ch_session: session,
      ...setCookies(start),
    }),
  );

  expect(response.headers.get("location")).toBe("/auth/login");
  expect(setCookies(response).ch_session).toBeUndefined();
});

test("a connect callback from another signed-in account is refused", async () => {
  const first = await googleSignIn(
    "first-account",
    setCookies(await handle(request(`/invite/${createInvite(connection())}`))),
  );

  const second = await googleSignIn(
    "second-account",
    setCookies(await handle(request(`/invite/${createInvite(connection())}`))),
  );

  const firstSession = first.cookies.ch_session ?? "";
  const secondSession = second.cookies.ch_session ?? "";

  setHostedFetch(googleApi("first-account"));

  const start = await handle(
    request("/oauth/google/start?connect=youtube&return=%2Fadd%3Fyoutube%3Dchoose", {
      ch_session: firstSession,
    }),
  );

  const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? "";

  const response = await handle(
    request(`/oauth/google/callback?state=${state}&code=abc`, {
      ch_session: secondSession,
      ...setCookies(start),
    }),
  );

  expect(response.headers.get("location")).toBe("/add?youtube=denied");
  expect(setCookies(response).ch_session).toBeUndefined();
  expect((await handle(request("/home", { ch_session: secondSession }))).status).toBe(200);
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

  const { response, cookies } = await googleSignIn("viewer", setCookies(opened));
  const session = cookies.ch_session ?? "";

  expect(response.headers.get("location")).toBe("/add");
  expect(session).toBeTruthy();
  expect(countSource("viewer", "youtube")).toBe(0);

  const connected = await connectYoutube("viewer", session, { hasChannel: false });

  expect(connected.response.headers.get("location")).toBe("/add?youtube=choose");
  expect((await importYoutube("viewer", session, ["LL"])).status).toBe(200);
  expect(countSource("viewer", "youtube")).toBe(1);
});

test("Twitch needs a session and imports followed channels", async () => {
  const blocked = await handle(request("/oauth/twitch/start"));
  const login = new URL(blocked.headers.get("location") ?? "", ORIGIN);

  expect(login.pathname).toBe("/auth/login");
  expect(login.searchParams.get("return")).toBe("/oauth/twitch/start");

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

    await connectYoutube(sub, session);
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

test("a tester's items never reach the owner's PKMS or an AI they haven't turned on", async () => {
  const outbound: string[] = [];

  const recorder = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(incoming) {
      outbound.push(new URL(incoming.url).pathname);

      return Response.json({ choices: [] });
    },
  });

  process.env.PKMS_CAPTURE_URL = `http://127.0.0.1:${recorder.port}`;
  process.env.PKMS_CAPTURE_TOKEN = "owner-vault-token";
  process.env.LLM_BASE_URL = `http://127.0.0.1:${recorder.port}`;
  process.env.LLM_MODEL = "synthetic-model";

  try {
    const opened = await handle(request(`/invite/${createInvite(connection())}`));
    const { cookies } = await googleSignIn("tester", setCookies(opened));
    const session = cookies.ch_session ?? "";

    await connectYoutube("tester", session);
    expect((await importYoutube("tester", session, ["LL"])).status).toBe(200);
    expect(countSource("tester", "youtube")).toBe(1);

    const act = (action: string) =>
      handle(
        new Request(`${ORIGIN}/items/${encodeURIComponent("youtube:vid_liked01")}/${action}`, {
          method: "POST",
          headers: { host: HOST, origin: ORIGIN, cookie: `ch_session=${session}` },
        }),
      );

    expect((await act("promote")).status).toBe(404);
    expect((await act("suggest")).status).toBe(403);

    const cookie = await handle(
      new Request(`${ORIGIN}/reddit/unsave/auth`, {
        method: "POST",
        headers: {
          host: HOST,
          origin: ORIGIN,
          "content-type": "application/json",
          cookie: `ch_session=${session}`,
        },
        body: JSON.stringify({ cookie: "tester-reddit-session" }),
      }),
    );

    expect(cookie.status).toBe(404);
    expect(outbound).toEqual([]);
  } finally {
    await recorder.stop(true);
  }
});
