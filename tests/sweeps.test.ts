import { expect, test } from "bun:test";
import { z } from "zod";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as db from "../src/db.ts";
import { RESURFACE_SUBREDDITS } from "../src/categorize.ts";
import { newItem } from "../src/models.ts";
import { serveApp } from "../src/web.ts";

const DAY = 86_400;

const NOW = Math.floor(Date.now() / 1000);

const KNOWLEDGE_SUB = RESURFACE_SUBREDDITS[0];

const SweepSchema = z.object({
  id: z.string(),
  kind: z.enum(["subreddit", "age"]),
  source: z.string(),
  subreddit: z.string().optional(),
  before_utc: z.number().optional(),
  label: z.string(),
  count: z.number(),
  sample: z.array(z.string()),
});

type SweepJson = z.infer<typeof SweepSchema>;

const SweepListSchema = z.object({ sweeps: z.array(SweepSchema) });

const ApplySchema = z.object({ total: z.number(), wave: z.number().nullable() });

/** Synthetic hoard: one meme pile, one large knowledge pile, one old YouTube pile, noise. */
function seed(path: string): void {
  const connection = db.connect(path);

  for (let index = 0; index < 12; index++) {
    db.mergeUpsert(
      connection,
      newItem({
        source: "reddit",
        source_id: `t3_ncd_${index}`,
        title: `Crayon meme ${index}`,
        created_utc: NOW - 30 * DAY,
        // One odd casing; the label must use the most common one.
        metadata: { subreddit: index === 0 ? "noncredibledefense" : "NonCredibleDefense" },
      }),
    );
  }

  for (let index = 0; index < 20; index++) {
    db.mergeUpsert(
      connection,
      newItem({
        source: "reddit",
        source_id: `t3_know_${index}`,
        title: `Knowledge post ${index}`,
        created_utc: NOW - 30 * DAY,
        metadata: { subreddit: KNOWLEDGE_SUB.toUpperCase() },
      }),
    );
  }

  for (let index = 0; index < 5; index++) {
    db.mergeUpsert(
      connection,
      newItem({
        source: "reddit",
        source_id: `t3_small_${index}`,
        title: `Small pile ${index}`,
        created_utc: NOW - 30 * DAY,
        metadata: { subreddit: "tinysub" },
      }),
    );
  }

  for (let index = 0; index < 12; index++) {
    db.mergeUpsert(
      connection,
      newItem({
        source: "youtube",
        source_id: `old_${index}`,
        title: `Old video ${index}`,
        created_utc: NOW - 5 * 365 * DAY,
      }),
    );
  }

  connection.close();
}

async function withServer(fn: (base: string, path: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "content-hoarder-sweeps-"));
  const databasePath = join(root, "app.db");

  seed(databasePath);
  const server = await serveApp({ dbPath: databasePath, host: "127.0.0.1", port: 0 });

  try {
    await fn(`http://127.0.0.1:${server.port}`, databasePath);
  } finally {
    await server.stop();
    rmSync(root, { recursive: true, force: true });
  }
}

function statusCounts(path: string, like: string) {
  const connection = db.connect(path);

  try {
    const list = connection
      .query<{ status: string; c: number }, [string]>(
        "SELECT status, COUNT(*) AS c FROM items WHERE fullname LIKE ? GROUP BY status",
      )
      .all(like);

    return Object.fromEntries(list.map((row) => [row.status, row.c]));
  } finally {
    connection.close();
  }
}

/** Loose on purpose: the invalid-body test posts malformed shapes. */
type SweepPostBody = {
  kind?: string;
  source?: string;
  subreddit?: string;
  before_utc?: number | undefined;
  wave?: number | string | null;
};

function post(base: string, path: string, body: SweepPostBody): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function sweeps(base: string, query = ""): Promise<SweepJson[]> {
  const response = await fetch(`${base}/sweeps${query}`);

  expect(response.status).toBe(200);

  return SweepListSchema.parse(await response.json()).sweeps;
}

test("GET /sweeps offers meme and age piles, never knowledge subreddits", async () => {
  await withServer(async (base) => {
    const list = await sweeps(base);

    const meme = list.find((sweep) => sweep.id === "subreddit:noncredibledefense");

    expect(meme).toMatchObject({
      kind: "subreddit",
      source: "reddit",
      subreddit: "NonCredibleDefense",
      label: "r/NonCredibleDefense",
      count: 12,
    });
    expect(meme?.sample).toHaveLength(3);

    expect(
      list.some((sweep) => sweep.subreddit?.toLowerCase() === KNOWLEDGE_SUB.toLowerCase()),
    ).toBe(false);
    expect(list.some((sweep) => sweep.subreddit === "tinysub")).toBe(false);

    const age = list.find((sweep) => sweep.id === "age:youtube:4y");

    expect(age).toMatchObject({ kind: "age", source: "youtube", count: 12 });
    expect(age?.label.startsWith("YouTube saves from before")).toBe(true);
    expect(age?.before_utc).toBeGreaterThan(NOW - 4 * 365 * DAY - 120);
    expect(age?.before_utc).toBeLessThanOrEqual(NOW - 4 * 365 * DAY + 120);

    // Largest first, cut to limit.
    expect(list.map((sweep) => sweep.count)).toEqual(
      list.map((sweep) => sweep.count).sort((a, b) => b - a),
    );
    expect(await sweeps(base, "?limit=1")).toHaveLength(1);
  });
});

test("applying a subreddit sweep rests exactly that pile and undo restores it", async () => {
  await withServer(async (base, path) => {
    const applied = await post(base, "/sweeps/apply", {
      kind: "subreddit",
      source: "reddit",
      subreddit: "NonCredibleDefense",
    });

    expect(applied.status).toBe(200);
    const { total, wave } = ApplySchema.parse(await applied.json());

    expect(total).toBe(12);
    expect(Number.isInteger(wave)).toBe(true);
    expect(statusCounts(path, "reddit:t3_ncd_%")).toEqual({ archived: 12 });
    expect(statusCounts(path, "reddit:t3_know_%")).toEqual({ inbox: 20 });
    expect(statusCounts(path, "youtube:%")).toEqual({ inbox: 12 });

    const pulse = await (await fetch(`${base}/pulse`)).json();

    expect(pulse).toMatchObject({ swept_today: 12, cleared_total: 12, cleared_today: 0 });

    expect((await sweeps(base)).some((sweep) => sweep.id === "subreddit:noncredibledefense")).toBe(
      false,
    );

    const undone = await post(base, "/sweeps/undo", { wave });

    expect(undone.status).toBe(200);
    expect(await undone.json()).toEqual({ restored: 12 });
    expect(statusCounts(path, "reddit:t3_ncd_%")).toEqual({ inbox: 12 });

    expect(await (await fetch(`${base}/pulse`)).json()).toMatchObject({
      swept_today: 0,
      cleared_total: 0,
    });
  });
});

test("an age sweep archives exactly the counted items", async () => {
  await withServer(async (base, path) => {
    const age = (await sweeps(base)).find((sweep) => sweep.id === "age:youtube:4y");

    expect(age).toBeDefined();

    const applied = await post(base, "/sweeps/apply", {
      kind: "age",
      source: "youtube",
      before_utc: age?.before_utc,
    });

    expect(applied.status).toBe(200);
    expect(ApplySchema.parse(await applied.json()).total).toBe(age?.count ?? -1);
    expect(statusCounts(path, "youtube:%")).toEqual({ archived: 12 });
    expect(statusCounts(path, "reddit:%")).toEqual({ inbox: 37 });
  });
});

test("an age sweep never rests knowledge subreddits", async () => {
  await withServer(async (base, path) => {
    const connection = db.connect(path);

    for (let index = 0; index < 12; index++) {
      db.mergeUpsert(
        connection,
        newItem({
          source: "reddit",
          source_id: `t3_oldknow_${index}`,
          title: `Old knowledge ${index}`,
          created_utc: NOW - 5 * 365 * DAY,
          metadata: { subreddit: KNOWLEDGE_SUB },
        }),
      );
      db.mergeUpsert(
        connection,
        newItem({
          source: "reddit",
          source_id: `t3_oldmeme_${index}`,
          title: `Old meme ${index}`,
          created_utc: NOW - 5 * 365 * DAY,
          metadata: { subreddit: "memes" },
        }),
      );
    }

    connection.close();

    const age = (await sweeps(base)).find((sweep) => sweep.id === "age:reddit:4y");

    expect(age).toMatchObject({ kind: "age", source: "reddit", count: 12 });

    const applied = await post(base, "/sweeps/apply", {
      kind: "age",
      source: "reddit",
      before_utc: age?.before_utc,
    });

    expect(applied.status).toBe(200);
    expect(ApplySchema.parse(await applied.json()).total).toBe(12);
    expect(statusCounts(path, "reddit:t3_oldmeme_%")).toEqual({ archived: 12 });
    expect(statusCounts(path, "reddit:t3_oldknow_%")).toEqual({ inbox: 12 });
  });
});

test("sweep endpoints reject invalid bodies", async () => {
  await withServer(async (base) => {
    expect(
      (await post(base, "/sweeps/apply", { kind: "subreddit", source: "reddit" })).status,
    ).toBe(400);
    expect((await post(base, "/sweeps/apply", { kind: "tag", source: "reddit" })).status).toBe(400);
    expect((await post(base, "/sweeps/undo", { wave: "soon" })).status).toBe(400);
  });
});

test("room routes: /triage redirects to /clear; / and /library serve framed-proof HTML", async () => {
  await withServer(async (base) => {
    const triage = await fetch(`${base}/triage`, { redirect: "manual" });

    expect(triage.status).toBe(302);
    expect(triage.headers.get("Location")?.endsWith("/clear")).toBe(true);

    const reddit = await fetch(`${base}/reddit`, { redirect: "manual" });

    expect(reddit.headers.get("Location")?.endsWith("/library?source=reddit")).toBe(true);

    for (const route of ["/", "/clear", "/library", "/browse"]) {
      const response = await fetch(`${base}${route}`);

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toContain("text/html");
      expect(response.headers.get("Content-Security-Policy")).toBe("frame-ancestors 'none'");
      expect(response.headers.get("X-Frame-Options")).toBe("DENY");
      await response.text();
    }
  });
});
