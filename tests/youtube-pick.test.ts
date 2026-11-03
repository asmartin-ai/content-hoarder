import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createInvite, setHostedFetch, type Fetcher } from "../src/hosted.ts";
import { listYoutubePlaylists, pullYoutube } from "../src/hosted_pull.ts";
import { parseMetadata } from "../src/models.ts";
import { handle } from "../src/web/routes.ts";
import {
  closeConnection,
  connection,
  currentPull,
  libraryConnection,
  setDatabasePath,
  sweepYoutubeChoices,
  youtubeChoice,
  youtubeChoiceExpired,
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

const PlaylistFixture = z.object({
  title: z.string(),
  videos: z.array(z.tuple([z.string(), z.string()])),
});

const PLAYLISTS = z.record(z.string(), PlaylistFixture).parse({
  PL0: { title: "Empty", videos: [] },
  PL1: {
    title: "Cooking",
    videos: [
      ["vid_knife01", "Knife skills"],
      ["vid_sear01", "Searing"],
    ],
  },
  PL2: { title: "Music", videos: [["vid_bass01", "Bassline"]] },
  PL3: { title: "Mixed", videos: [["vid_knife01", "Knife skills"]] },
});

const PlaylistView = z.object({
  id: z.string(),
  title: z.string(),
  count: z.number().nullable(),
  imported: z.boolean(),
});

const ChoiceView = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("choose"),
    generation: z.string().min(1),
    playlists: z.array(PlaylistView),
    expires_in: z.number(),
  }),
  z.object({ state: z.literal("expired") }),
  z.object({ state: z.literal("none") }),
]);

type Choice = z.infer<typeof ChoiceView>;

let root = "";

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "content-hoarder-pick-"));
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

function request(path: string, cookies: Record<string, string> = {}): Request {
  const headers = new Headers({ host: HOST, accept: "text/html" });

  const cookie = Object.entries(cookies)
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join("; ");

  if (cookie) headers.set("cookie", cookie);

  return new Request(`${ORIGIN}${path}`, { headers });
}

function api(session: string, path: string, body?: { ids: string[]; generation: string }): Request {
  const headers = new Headers({ host: HOST, accept: "application/json", origin: ORIGIN });

  if (session) headers.set("cookie", `ch_session=${session}`);

  if (body === undefined) return new Request(`${ORIGIN}${path}`, { headers });

  headers.set("content-type", "application/json");

  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
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

function googleApi(
  sub: string,
  ids: string[] = ["PL1", "PL2"],
  scope = "openid email https://www.googleapis.com/auth/youtube.readonly",
): Fetcher {
  return async (input) => {
    const url = new URL(input);

    if (url.host === "oauth2.googleapis.com")
      return Response.json({ access_token: "g-token", scope });

    if (url.pathname === "/v1/userinfo")
      return Response.json({ sub, email: `${sub}@example.com`, email_verified: true });

    if (url.pathname === "/youtube/v3/playlists")
      return Response.json({
        items: ids.map((id) => ({
          id,
          snippet: { title: PLAYLISTS[id]?.title ?? id },
          contentDetails: { itemCount: PLAYLISTS[id]?.videos.length ?? 0 },
        })),
      });

    if (url.pathname === "/youtube/v3/playlistItems") {
      const list = PLAYLISTS[url.searchParams.get("playlistId") ?? ""];

      return Response.json({
        items: (list?.videos ?? []).map(([videoId, title]) => ({
          snippet: { title, videoOwnerChannelTitle: "Owner", resourceId: { videoId } },
        })),
      });
    }

    if (url.pathname === "/youtube/v3/videos")
      return Response.json({
        items: [{ id: "vid_liked01", snippet: { title: "A liked video", channelTitle: "Fan" } }],
      });

    return new Response("unexpected", { status: 500 });
  };
}

function stalled(): Fetcher {
  return (_input, init) => {
    const { promise, reject } = Promise.withResolvers<Response>();
    const signal = init?.signal;

    if (!signal) reject(new Error("missing signal"));
    else signal.addEventListener("abort", () => reject(signal.reason));

    return promise;
  };
}

async function inviteCookies(): Promise<Record<string, string>> {
  return setCookies(await handle(request(`/invite/${createInvite(connection())}`)));
}

async function callbackWith(
  cookies: Record<string, string>,
): Promise<{ response: Response; session: string }> {
  const start = await handle(request("/oauth/google/start?return=/add", cookies));
  const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? "";

  const response = await handle(
    request(`/oauth/google/callback?state=${state}&code=abc`, {
      ...cookies,
      ...setCookies(start),
    }),
  );

  return { response, session: setCookies(response).ch_session ?? "" };
}

async function connect(
  sub: string,
  session: string,
  ids: string[] = ["PL1", "PL2"],
  scope?: string,
): Promise<{ response: Response; session: string }> {
  setHostedFetch(googleApi(sub, ids, scope));

  const cookies = { ch_session: session };

  const start = await handle(
    request("/oauth/google/start?connect=youtube&return=%2Fadd%3Fyoutube%3Dchoose", cookies),
  );

  const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? "";

  const response = await handle(
    request(`/oauth/google/callback?state=${state}&code=abc`, {
      ...cookies,
      ...setCookies(start),
    }),
  );

  return { response, session: setCookies(response).ch_session ?? session };
}

async function signIn(
  sub: string,
  ids: string[] = ["PL1", "PL2"],
): Promise<{ response: Response; session: string }> {
  setHostedFetch(googleApi(sub, ids));

  const { response, session } = await callbackWith(await inviteCookies());

  if (!session) return { response, session };

  return connect(sub, session, ids);
}

function countYoutube(sub: string): number {
  const row = z
    .object({ count: z.number() })
    .parse(libraryConnection(sub).query("SELECT COUNT(*) AS count FROM items").get());

  return row.count;
}

function importedPlaylists(sub: string): string[] {
  const rows = z
    .array(z.object({ metadata: z.string() }))
    .parse(
      libraryConnection(sub).query("SELECT metadata FROM items WHERE source = 'youtube'").all(),
    );

  const saved = z
    .array(z.object({ playlist_id: z.string() }))
    .parse(rows.map((row) => parseMetadata(row.metadata)));

  return [...new Set(saved.flatMap((row) => (row.playlist_id ? [row.playlist_id] : [])))].sort();
}

async function listed(session: string): Promise<Choice> {
  return ChoiceView.parse(await (await handle(api(session, "/youtube/playlists"))).json());
}

async function chosen(session: string): Promise<z.infer<typeof ChoiceView> & { state: "choose" }> {
  const view = await listed(session);

  if (view.state !== "choose") throw new Error(`expected a choice, got ${view.state}`);

  return view;
}

async function startImport(session: string, ids: string[], generation?: string): Promise<Response> {
  const value = generation ?? (await chosen(session)).generation;

  return handle(api(session, "/youtube/import", { ids, generation: value }));
}

test("Google sign-in stores a playlist choice and imports nothing", async () => {
  const { response, session } = await signIn("picker");

  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe("/add?youtube=choose");
  expect(session).toBeTruthy();
  expect(countYoutube("picker")).toBe(0);

  const view = await chosen(session);

  expect(view.playlists).toEqual([
    { id: "PL1", title: "Cooking", count: 2, imported: false },
    { id: "PL2", title: "Music", count: 1, imported: false },
    { id: "LL", title: "Liked videos", count: null, imported: false },
  ]);
  expect(view.generation).toHaveLength(24);
  expect(view.expires_in).toBeGreaterThan(590);
  expect(view.expires_in).toBeLessThanOrEqual(600);
});

test("importing imports only the ticked playlists and drops the choice", async () => {
  const { session } = await signIn("chooser");
  const view = await chosen(session);
  const started = await startImport(session, ["PL1"], view.generation);

  expect(started.status).toBe(200);
  expect(await started.json()).toEqual({ started: true });

  await currentPull(libraryConnection("chooser"))?.settled;

  expect(countYoutube("chooser")).toBe(2);
  expect(importedPlaylists("chooser")).toEqual(["PL1"]);

  const again = await startImport(session, ["PL1"], view.generation);

  expect(again.status).toBe(409);
  expect(await again.json()).toEqual({ state: "stale" });
  expect(await listed(session)).toEqual({ state: "none" });
});

test("a later sign-in marks playlists that are already imported", async () => {
  const first = await signIn("marker");

  expect((await startImport(first.session, ["PL1"])).status).toBe(200);
  await currentPull(libraryConnection("marker"))?.settled;

  const again = await signIn("marker");

  expect(again.session).toBeTruthy();

  const view = await chosen(again.session);

  expect(view.playlists).toEqual([
    { id: "PL1", title: "Cooking", count: 2, imported: true },
    { id: "PL2", title: "Music", count: 1, imported: false },
    { id: "LL", title: "Liked videos", count: null, imported: false },
  ]);
});

test("an id outside the pending list is refused and keeps the choice", async () => {
  const { session } = await signIn("wrong-id");
  const view = await chosen(session);

  expect((await startImport(session, ["PL9"], view.generation)).status).toBe(400);
  expect((await startImport(session, [], view.generation)).status).toBe(400);
  expect(countYoutube("wrong-id")).toBe(0);

  const retry = await chosen(session);

  expect(retry.generation).toBe(view.generation);
  expect((await startImport(session, ["PL2"], retry.generation)).status).toBe(200);
  await currentPull(libraryConnection("wrong-id"))?.settled;

  expect(countYoutube("wrong-id")).toBe(1);
  expect(importedPlaylists("wrong-id")).toEqual(["PL2"]);
});

test("a generation from an earlier authorization is refused without consuming the choice", async () => {
  const { session } = await signIn("stale-gen");
  const view = await chosen(session);
  const stale = await startImport(session, ["PL1"], "not-the-generation");

  expect(stale.status).toBe(409);
  expect(await stale.json()).toEqual({ state: "stale" });
  expect((await chosen(session)).generation).toBe(view.generation);
  expect((await startImport(session, ["PL1"], view.generation)).status).toBe(200);

  await currentPull(libraryConnection("stale-gen"))?.settled;
});

test("starting a new authorization invalidates the prior generation", async () => {
  const { session } = await signIn("restart");
  const view = await chosen(session);

  expect(
    (
      await handle(
        request("/oauth/google/start?connect=youtube&return=/add", { ch_session: session }),
      )
    ).headers.get("location"),
  ).toContain("accounts.google.com");
  expect(await listed(session)).toEqual({ state: "none" });
  expect((await startImport(session, ["PL1"], view.generation)).status).toBe(409);
});

test("a choice older than ten minutes is expired", async () => {
  const { session } = await signIn("slowpoke");
  const view = await chosen(session);
  const realNow = Date.now;
  const base = realNow();

  try {
    Date.now = () => base + 11 * 60 * 1000;

    expect(await listed(session)).toEqual({ state: "expired" });
    expect((await startImport(session, ["PL1"], view.generation)).status).toBe(409);
    expect(countYoutube("slowpoke")).toBe(0);
  } finally {
    Date.now = realNow;
  }
});

test("an abandoned choice is swept, and its expired marker expires too", async () => {
  const { session } = await signIn("abandoned");
  const view = await chosen(session);
  const realNow = Date.now;
  const base = realNow();

  try {
    Date.now = () => base + 11 * 60 * 1000;
    sweepYoutubeChoices();

    expect(youtubeChoice("abandoned")).toBeNull();
    expect(youtubeChoiceExpired("abandoned")).toBe(true);
    expect((await startImport(session, ["PL1"], view.generation)).status).toBe(409);

    Date.now = () => base + 21 * 60 * 1000;
    sweepYoutubeChoices();

    expect(youtubeChoiceExpired("abandoned")).toBe(false);
    expect(await listed(session)).toEqual({ state: "none" });
  } finally {
    Date.now = realNow;
  }
});

test("a playlist with no videos is still marked imported", async () => {
  const first = await signIn("empty-list", ["PL0"]);

  expect((await startImport(first.session, ["PL0"])).status).toBe(200);
  await currentPull(libraryConnection("empty-list"))?.settled;

  expect(countYoutube("empty-list")).toBe(0);

  const again = await signIn("empty-list", ["PL0"]);
  const view = await chosen(again.session);

  expect(view.playlists).toEqual([
    { id: "PL0", title: "Empty", count: 0, imported: true },
    { id: "LL", title: "Liked videos", count: null, imported: false },
  ]);
});

test("a video shared by two playlists keeps both marked after separate imports", async () => {
  const ids = ["PL1", "PL3"];
  const first = await signIn("overlap", ids);

  expect((await startImport(first.session, ["PL3"])).status).toBe(200);
  await currentPull(libraryConnection("overlap"))?.settled;

  const second = await signIn("overlap", ids);

  expect((await startImport(second.session, ["PL1"])).status).toBe(200);
  await currentPull(libraryConnection("overlap"))?.settled;

  const view = await chosen((await signIn("overlap", ids)).session);

  expect(view.playlists).toEqual([
    { id: "PL1", title: "Cooking", count: 2, imported: true },
    { id: "PL3", title: "Mixed", count: 1, imported: true },
    { id: "LL", title: "Liked videos", count: null, imported: false },
  ]);
  expect(importedPlaylists("overlap")).toEqual(["PL1"]);
});

test("two accounts' choices stay apart", async () => {
  const alpha = await signIn("alpha", ["PL1"]);
  const beta = await signIn("beta", ["PL2"]);
  const alphaView = await chosen(alpha.session);

  expect((await chosen(beta.session)).playlists).toEqual([
    { id: "PL2", title: "Music", count: 1, imported: false },
    { id: "LL", title: "Liked videos", count: null, imported: false },
  ]);
  expect((await startImport(alpha.session, ["PL2"], alphaView.generation)).status).toBe(400);
  expect((await startImport(beta.session, ["PL2"])).status).toBe(200);

  await currentPull(libraryConnection("beta"))?.settled;

  expect(countYoutube("alpha")).toBe(0);
  expect(countYoutube("beta")).toBe(1);
  expect(importedPlaylists("beta")).toEqual(["PL2"]);
});

test("a running Twitch pull makes the YouTube import wait without losing the choice", async () => {
  const { session } = await signIn("busy");
  const view = await chosen(session);
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();

  setHostedFetch(async (input) => {
    const url = new URL(input);

    if (url.host === "id.twitch.tv") return Response.json({ access_token: "t-token" });

    if (url.pathname === "/helix/users") return Response.json({ data: [{ id: "42" }] });

    if (url.pathname === "/helix/channels/followed") {
      await gate;

      return Response.json({ data: [], pagination: {} });
    }

    return new Response("unexpected", { status: 500 });
  });

  const start = await handle(request("/oauth/twitch/start?return=/add", { ch_session: session }));
  const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? "";

  await handle(
    request(`/oauth/twitch/callback?state=${state}&code=xyz`, {
      ch_session: session,
      ...setCookies(start),
    }),
  );

  expect(currentPull(libraryConnection("busy"))?.state).toBe("running");

  const busy = await startImport(session, ["PL1"], view.generation);

  expect(busy.status).toBe(409);
  expect(await busy.json()).toEqual({ state: "busy" });
  expect((await chosen(session)).generation).toBe(view.generation);

  release();
  await currentPull(libraryConnection("busy"))?.settled;

  setHostedFetch(googleApi("busy"));
  expect((await startImport(session, ["PL1"], view.generation)).status).toBe(200);
  await currentPull(libraryConnection("busy"))?.settled;

  expect(countYoutube("busy")).toBe(2);
});

test("more than 200 offered playlists can be selected at once", async () => {
  const many = Array.from({ length: 201 }, (_, index) => `PLX${index}`);
  const { session } = await signIn("many", many);
  const view = await chosen(session);

  expect(view.playlists).toHaveLength(202);
  expect((await startImport(session, [...many, "LL"], view.generation)).status).toBe(200);
  await currentPull(libraryConnection("many"))?.settled;

  expect(countYoutube("many")).toBe(1);
});

test("a missed deadline refuses the listing before any request", async () => {
  let calls = 0;

  setHostedFetch(async () => {
    calls += 1;

    return Response.json({ items: [] });
  });

  await expect(listYoutubePlaylists("SENTINEL-TOKEN", Date.now() - 1)).rejects.toThrow(
    "youtube deadline reached",
  );
  expect(calls).toBe(0);
});

test("a stalled listing is aborted at its deadline", async () => {
  setHostedFetch(stalled());

  await expect(listYoutubePlaylists("SENTINEL-TOKEN", Date.now() + 50)).rejects.toThrow();
});

test("a stalled import is aborted at its deadline and writes nothing", async () => {
  const library = libraryConnection("stalled");

  setHostedFetch(stalled());

  await expect(pullYoutube(library, "SENTINEL-TOKEN", ["PL1"], Date.now() + 50)).rejects.toThrow();
  expect(countYoutube("stalled")).toBe(0);
});

test("a failed listing never logs the provider body or the token", async () => {
  setHostedFetch(googleApi("sentinel-listing"));

  const { session } = await callbackWith(await inviteCookies());

  expect(session).toBeTruthy();

  const start = await handle(
    request("/oauth/google/start?connect=youtube&return=/add", { ch_session: session }),
  );

  const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? "";
  const errors: string[] = [];

  const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  });

  try {
    setHostedFetch(async (input) => {
      const url = new URL(input);

      if (url.host === "oauth2.googleapis.com")
        return Response.json({
          access_token: "g-token",
          scope: "openid email https://www.googleapis.com/auth/youtube.readonly",
        });

      return new Response("echo SENTINEL-TOKEN", { status: 500 });
    });

    const response = await handle(
      request(`/oauth/google/callback?state=${state}&code=abc`, {
        ch_session: session,
        ...setCookies(start),
      }),
    );

    expect(response.headers.get("location")).toBe("/add?youtube=choose");
    expect(errors.join(" ")).not.toContain("SENTINEL-TOKEN");
    expect(errors.join(" ")).toContain("youtube playlist listing failed: status 500");
  } finally {
    spy.mockRestore();
  }
});

test("a failed import never logs the provider body or the token", async () => {
  const { session } = await signIn("sentinel-import");
  const view = await chosen(session);
  const errors: string[] = [];

  const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  });

  try {
    setHostedFetch(async (input) => {
      const url = new URL(input);

      if (url.pathname === "/youtube/v3/playlists")
        return Response.json({
          items: [{ id: "PL1", snippet: { title: "Cooking" }, contentDetails: { itemCount: 1 } }],
        });

      return new Response("echo SENTINEL-TOKEN", { status: 500 });
    });

    expect((await startImport(session, ["PL1"], view.generation)).status).toBe(200);
    await currentPull(libraryConnection("sentinel-import"))?.settled;

    expect(errors.join(" ")).not.toContain("SENTINEL-TOKEN");
    expect(errors.join(" ")).toContain("youtube pull failed");
  } finally {
    spy.mockRestore();
  }
});

test("a failed playlist listing lands on Add with an error and no choice", async () => {
  setHostedFetch(googleApi("broken"));

  const { session } = await callbackWith(await inviteCookies());

  expect(session).toBeTruthy();

  const start = await handle(
    request("/oauth/google/start?connect=youtube&return=/add", { ch_session: session }),
  );

  const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? "";

  setHostedFetch(async (input) => {
    const url = new URL(input);

    if (url.host === "oauth2.googleapis.com")
      return Response.json({
        access_token: "g-token",
        scope: "openid email https://www.googleapis.com/auth/youtube.readonly",
      });

    return new Response("boom", { status: 500 });
  });

  const response = await handle(
    request(`/oauth/google/callback?state=${state}&code=abc`, {
      ch_session: session,
      ...setCookies(start),
    }),
  );

  expect(response.headers.get("location")).toBe("/add?youtube=choose");

  const add = await handle(request("/add?youtube=choose", { ch_session: session }));

  expect(await add.text()).toContain("didn't share anything");
  expect(await listed(session)).toEqual({ state: "none" });
  expect(countYoutube("broken")).toBe(0);
});

test("a failed reauthorization clears the old choice", async () => {
  const first = await signIn("reauth");
  const view = await chosen(first.session);

  const start = await handle(
    request("/oauth/google/start?connect=youtube&return=/add", { ch_session: first.session }),
  );

  const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? "";

  setHostedFetch(async (input) => {
    const url = new URL(input);

    if (url.host === "oauth2.googleapis.com") return Response.json({ access_token: "g-token" });

    return new Response("boom", { status: 500 });
  });

  await handle(
    request(`/oauth/google/callback?state=${state}&code=abc`, {
      ch_session: first.session,
      ...setCookies(start),
    }),
  );

  expect(await listed(first.session)).toEqual({ state: "none" });
  expect((await startImport(first.session, ["PL1"], view.generation)).status).toBe(409);
});

test("an older callback failing does not erase a newer successful choice", async () => {
  const { session } = await signIn("order");

  const older = await handle(
    request("/oauth/google/start?connect=youtube&return=/add", { ch_session: session }),
  );

  const olderState = new URL(older.headers.get("location") ?? "").searchParams.get("state") ?? "";

  const newer = await handle(
    request("/oauth/google/start?connect=youtube&return=/add", { ch_session: session }),
  );

  const newerState = new URL(newer.headers.get("location") ?? "").searchParams.get("state") ?? "";

  setHostedFetch(googleApi("order"));
  await handle(
    request(`/oauth/google/callback?state=${newerState}&code=abc`, {
      ch_session: session,
      ...setCookies(newer),
    }),
  );

  const fresh = await chosen(session);

  setHostedFetch(async (input) => {
    const url = new URL(input);

    if (url.host === "oauth2.googleapis.com") return Response.json({ access_token: "g-token" });

    return new Response("boom", { status: 500 });
  });
  await handle(
    request(`/oauth/google/callback?state=${olderState}&code=abc`, {
      ch_session: session,
      ...setCookies(older),
    }),
  );

  const after = await chosen(session);

  expect(after.generation).toBe(fresh.generation);
});

test("a signed-out connect behaves as plain sign-in and leaves the choice alone", async () => {
  const { session } = await signIn("unsigned-order");
  const fresh = await chosen(session);

  setHostedFetch(googleApi("unsigned-order"));

  const opened = await inviteCookies();
  const start = await handle(request("/oauth/google/start?connect=youtube&return=/add", opened));
  const params = new URL(start.headers.get("location") ?? "").searchParams;

  expect(params.get("scope")).toBe("openid email");
  expect(params.get("include_granted_scopes")).toBeNull();
  expect(params.get("login_hint")).toBeNull();

  const response = await handle(
    request(`/oauth/google/callback?state=${params.get("state") ?? ""}&code=abc`, {
      ...opened,
      ...setCookies(start),
    }),
  );

  expect(response.headers.get("location")).toBe("/add");
  expect((await chosen(session)).generation).toBe(fresh.generation);
});
