import { expect, test } from "bun:test";
import { z } from "zod";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { RESURFACE_TAGS } from "../src/categorize.ts";
import * as db from "../src/db.ts";
import { newItem } from "../src/models.ts";
import * as triageScore from "../src/triage_score.ts";
import { serveApp } from "../src/web.ts";

const DAY = 86_400;

const NOW = Math.floor(Date.now() / 1000);

const SUB = "LearnedPileTest";

const KNOWLEDGE_SUB = "adhd";

const ARCHIVED = 10;

const KEPT = 1;

const INBOX = 5;

const PROTECTED = 2;

const PROTECTED_TAG = RESURFACE_TAGS[0];

const REASON = `You let go ${ARCHIVED} of ${ARCHIVED + KEPT} from r/${SUB}`;

const SweepsSchema = z.object({
  sweeps: z.array(
    z.object({
      kind: z.string(),
      subreddit: z.string().optional(),
      count: z.number(),
      reason: z.string().optional(),
    }),
  ),
});

function protectedFullnames(subreddit: string): string[] {
  return Array.from(
    { length: PROTECTED },
    (_, index) => `reddit:t3_${subreddit}_protected_${index}`,
  );
}

function seedSub(connection: Database, subreddit: string, protectedCount: number): void {
  const fullnames: string[] = [];

  for (let index = 0; index < ARCHIVED + KEPT + INBOX; index++) {
    const fullname = `reddit:t3_${subreddit}_${index}`;

    fullnames.push(fullname);
    db.mergeUpsert(
      connection,
      newItem({
        source: "reddit",
        source_id: `t3_${subreddit}_${index}`,
        title: `${subreddit} save ${index}`,
        created_utc: NOW - (index + 1) * 30 * DAY,
        metadata: { subreddit, score: 100 + index },
      }),
    );
  }

  for (let index = 0; index < protectedCount; index++) {
    db.mergeUpsert(
      connection,
      newItem({
        source: "reddit",
        source_id: `t3_${subreddit}_protected_${index}`,
        title: `${subreddit} protected save ${index}`,
        created_utc: NOW - (index + 1) * 30 * DAY,
        metadata: { subreddit, tags: [PROTECTED_TAG], score: 50 + index },
      }),
    );
  }

  fullnames.slice(0, ARCHIVED).forEach((fullname) => {
    db.setStatus(connection, fullname, "archived", { queueUnsave: false });
  });
  fullnames.slice(ARCHIVED, ARCHIVED + KEPT).forEach((fullname) => {
    db.setStatus(connection, fullname, "keep", { queueUnsave: false });
  });
}

function seed(path: string): void {
  const connection = db.connect(path);

  try {
    db.setSetting(connection, "reddit_unsave_on_done", "1");
    seedSub(connection, SUB, PROTECTED);
    seedSub(connection, KNOWLEDGE_SUB, 0);
    triageScore.learn(connection, { apply: true });
  } finally {
    connection.close();
  }
}

async function withServer(fn: (base: string, path: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "content-hoarder-learned-piles-"));
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

function statuses(path: string): Record<string, number> {
  const connection = db.connect(path);

  try {
    const list = connection
      .query<{ status: string; c: number }, []>(
        "SELECT status, COUNT(*) AS c FROM items GROUP BY status",
      )
      .all();

    return Object.fromEntries(list.map((row) => [row.status, row.c]));
  } finally {
    connection.close();
  }
}

function statusesOf(path: string, fullnames: string[]): string[] {
  const connection = db.connect(path);

  try {
    const placeholders = fullnames.map(() => "?").join(",");

    return connection
      .query<{ status: string }, string[]>(
        `SELECT status FROM items WHERE fullname IN (${placeholders}) ORDER BY fullname`,
      )
      .all(...fullnames)
      .map((row) => row.status);
  } finally {
    connection.close();
  }
}

function queueDepth(path: string): number {
  const connection = db.connect(path);

  try {
    const row = connection
      .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM reddit_unsave")
      .get();

    return row?.c ?? 0;
  } finally {
    connection.close();
  }
}

const PostBodySchema = z.union([
  z.object({ kind: z.string(), source: z.string(), subreddit: z.string() }),
  z.object({ wave: z.number() }),
]);

function post(base: string, path: string, body: z.infer<typeof PostBodySchema>): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(PostBodySchema.parse(body)),
  });
}

async function sweeps(base: string): Promise<z.infer<typeof SweepsSchema>["sweeps"]> {
  const response = await fetch(`${base}/sweeps`);

  expect(response.status).toBe(200);

  return SweepsSchema.parse(await response.json()).sweeps;
}

test("Today suggests a learned pile grounded in the user's history", async () => {
  await withServer(async (base) => {
    const page = await fetch(`${base}/`);

    expect(page.status).toBe(200);
    expect(await page.text()).toContain('hx-get="/hx/today/piles"');

    const piles = (await (await fetch(`${base}/hx/today/piles`)).text()).replace(/\s+/g, " ");

    expect(piles).toContain(REASON);
    expect(piles).toContain(`r/${SUB}`);
    expect(piles).toContain(`${INBOX} saves`);
    expect(piles).toContain('class="pile-meta pile-reason"');
    expect(piles).not.toContain(`r/${KNOWLEDGE_SUB}`);
    expect(piles).not.toContain(KNOWLEDGE_SUB);
  });
});

test("/sweeps lists the learned pile with its reason and the count apply will archive", async () => {
  await withServer(async (base) => {
    const list = await sweeps(base);
    const learned = list.find((sweep) => sweep.subreddit?.toLowerCase() === SUB.toLowerCase());

    expect(learned).toBeDefined();
    expect(learned?.kind).toBe("subreddit");
    expect(learned?.count).toBe(INBOX);
    expect(learned?.reason).toBe(REASON);
    expect(list.some((sweep) => sweep.subreddit?.toLowerCase() === KNOWLEDGE_SUB)).toBe(false);
  });
});

test("applying a learned pile archives its inbox and undo restores it", async () => {
  await withServer(async (base, path) => {
    const protectedItems = protectedFullnames(SUB);

    expect(statuses(path)).toEqual({
      archived: ARCHIVED * 2,
      inbox: INBOX * 2 + PROTECTED,
      keep: KEPT * 2,
    });
    expect(statusesOf(path, protectedItems)).toEqual(protectedItems.map(() => "inbox"));

    const applied = await post(base, "/sweeps/apply", {
      kind: "subreddit",
      source: "reddit",
      subreddit: SUB,
    });

    const result = z
      .object({ total: z.number(), wave: z.number().int().positive() })
      .parse(await applied.json());

    expect(result.total).toBe(INBOX);
    expect(statuses(path)).toEqual({
      archived: ARCHIVED * 2 + INBOX,
      inbox: INBOX + PROTECTED,
      keep: KEPT * 2,
    });
    expect(statusesOf(path, protectedItems)).toEqual(protectedItems.map(() => "inbox"));
    expect(queueDepth(path)).toBe(0);
    expect(
      (await sweeps(base)).some((sweep) => sweep.subreddit?.toLowerCase() === SUB.toLowerCase()),
    ).toBe(false);

    const undone = await post(base, "/sweeps/undo", { wave: result.wave });
    const restored = z.object({ restored: z.number() }).parse(await undone.json());

    expect(restored.restored).toBe(INBOX);
    expect(statuses(path)).toEqual({
      archived: ARCHIVED * 2,
      inbox: INBOX * 2 + PROTECTED,
      keep: KEPT * 2,
    });
    expect(statusesOf(path, protectedItems)).toEqual(protectedItems.map(() => "inbox"));
    expect(queueDepth(path)).toBe(0);

    const learned = (await sweeps(base)).find(
      (sweep) => sweep.subreddit?.toLowerCase() === SUB.toLowerCase(),
    );

    expect(learned?.count).toBe(INBOX);
    expect(learned?.reason).toBe(REASON);
  });
});
