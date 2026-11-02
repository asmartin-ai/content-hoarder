import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import * as db from "../src/db.ts";
import { parseMetadata, newItem, type NewItemInput } from "../src/models.ts";
import { setAiConsent } from "../src/assist/consent.ts";
import { aiUsage, hintFor, prefetchHints } from "../src/assist/hints.ts";
import { clearHints } from "../src/web/handlers/clear.ts";
import { withLibrary } from "../src/web/state.ts";
import { serveApp } from "../src/web.ts";

const NOW = 1_760_000_000;

const ENV_KEYS = [
  "LLM_API_KEY",
  "LLM_BASE_URL",
  "LLM_DAILY_CAP",
  "LLM_DEAL_WAIT_MS",
  "LLM_MODEL",
] as const;

const GOOD_REPLY = '{"verdict":"keep","reason":"still useful later","tags":["plans"]}';

const StoredLlmSchema = z.object({
  verdict: z.string(),
  reason: z.string(),
  tags: z.array(z.string()),
  model: z.string(),
  at: z.number(),
});

const HintsSchema = z.object({ hints: z.record(z.string(), z.string()) });

type FakeCall = Array<{ role: string; content: string }>;

let snapshot: Record<string, string | undefined> = {};

let database: Database;

function open(): Database {
  const connection = new Database(":memory:");

  db.initDb(connection);

  return connection;
}

function seedInto(connection: Database, id: string, extra: Partial<NewItemInput> = {}): string {
  db.mergeUpsert(
    connection,
    newItem({
      source: "reddit",
      source_id: id,
      kind: "post",
      title: `Note ${id}`,
      body: `Body ${id}`,
      created_utc: NOW,
      now: NOW,
      metadata: {},
      ...extra,
    }),
  );

  return `reddit:${id}`;
}

function seed(id: string, extra: Partial<NewItemInput> = {}): string {
  return seedInto(database, id, extra);
}

function fakeChat(reply: string, calls: FakeCall[] = []) {
  return async (messages: FakeCall): Promise<string> => {
    calls.push(messages);

    return reply;
  };
}

function storedMetadata(fullname: string) {
  const row = db.getItem(database, fullname);

  return row ? parseMetadata(row.metadata) : null;
}

beforeEach(() => {
  snapshot = {};

  for (const key of ENV_KEYS) {
    snapshot[key] = process.env[key];
    delete process.env[key];
  }

  database = open();
});

afterEach(() => {
  database.close();

  for (const key of ENV_KEYS) {
    const value = snapshot[key];

    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("hints without a configured provider", () => {
  test("consent on but no key makes no chat calls and yields no hint", async () => {
    const fullname = seed("nokey");
    const calls: FakeCall[] = [];

    setAiConsent(database, true);
    await prefetchHints(database, [fullname], { waitMs: 200, chat: fakeChat(GOOD_REPLY, calls) });

    expect(calls).toHaveLength(0);
    expect(hintFor(database, db.getPublicItem(database, fullname) ?? { metadata: {} })).toBeNull();
    expect(storedMetadata(fullname)?.llm).toBeUndefined();
    expect(aiUsage(database).calls).toBe(0);
  });

  test("consent unset or off makes no chat calls even when configured", async () => {
    const fullname = seed("consent");
    const calls: FakeCall[] = [];

    process.env.LLM_API_KEY = "test-key";

    await prefetchHints(database, [fullname], { waitMs: 200, chat: fakeChat(GOOD_REPLY, calls) });
    expect(calls).toHaveLength(0);

    setAiConsent(database, false);
    await prefetchHints(database, [fullname], { waitMs: 200, chat: fakeChat(GOOD_REPLY, calls) });

    expect(calls).toHaveLength(0);
    expect(aiUsage(database).calls).toBe(0);
  });
});

describe("hints with consent", () => {
  test("stores metadata.llm with model and at and updates usage", async () => {
    const fullname = seed("stored");
    const calls: FakeCall[] = [];

    process.env.LLM_API_KEY = "test-key";
    setAiConsent(database, true);

    await prefetchHints(database, [fullname], { waitMs: 500, chat: fakeChat(GOOD_REPLY, calls) });

    expect(calls).toHaveLength(1);

    const llm = StoredLlmSchema.safeParse(storedMetadata(fullname)?.llm);

    expect(llm.success).toBe(true);

    if (!llm.success) return;
    expect(llm.data.verdict).toBe("keep");
    expect(llm.data.reason).toBe("still useful later");
    expect(llm.data.tags).toEqual(["plans"]);

    const usage = aiUsage(database);

    expect(usage.calls).toBe(1);
    expect(usage.ok).toBe(1);
    expect(usage.failed).toBe(0);

    const hint = hintFor(database, db.getPublicItem(database, fullname) ?? { metadata: {} });

    expect(hint).toEqual({ verdict: "keep", reason: "still useful later", by: "ai" });
  });

  test("daily cap stops calls at the cap", async () => {
    const first = seed("cap_a");
    const second = seed("cap_b");
    const third = seed("cap_c");
    const calls: FakeCall[] = [];

    process.env.LLM_API_KEY = "test-key";
    process.env.LLM_DAILY_CAP = "1";
    setAiConsent(database, true);

    await prefetchHints(database, [first, second, third], {
      waitMs: 500,
      chat: fakeChat(GOOD_REPLY, calls),
    });

    expect(calls).toHaveLength(1);

    await prefetchHints(database, [second, third], {
      waitMs: 500,
      chat: fakeChat(GOOD_REPLY, calls),
    });

    expect(calls).toHaveLength(1);
    expect(aiUsage(database).calls).toBe(1);
  });

  test("a failing chat yields no hint, counts failed, and does not throw", async () => {
    const fullname = seed("failing");

    process.env.LLM_API_KEY = "test-key";
    setAiConsent(database, true);

    const chat = async (): Promise<string> => {
      throw new Error("provider down");
    };

    await prefetchHints(database, [fullname], { waitMs: 500, chat });

    expect(storedMetadata(fullname)?.llm).toBeUndefined();
    expect(hintFor(database, db.getPublicItem(database, fullname) ?? { metadata: {} })).toBeNull();

    const usage = aiUsage(database);

    expect(usage.calls).toBe(1);
    expect(usage.ok).toBe(0);
    expect(usage.failed).toBe(1);
  });

  test("malformed metadata.llm is ignored and refetched", async () => {
    const fullname = seed("malformed");
    const calls: FakeCall[] = [];

    process.env.LLM_API_KEY = "test-key";
    setAiConsent(database, true);

    db.patchItemMetadata(database, fullname, {
      llm: { verdict: "maybe", reason: "unparseable" },
    });

    expect(hintFor(database, db.getPublicItem(database, fullname) ?? { metadata: {} })).toBeNull();

    await prefetchHints(database, [fullname], { waitMs: 500, chat: fakeChat(GOOD_REPLY, calls) });

    expect(calls).toHaveLength(1);
    expect(hintFor(database, db.getPublicItem(database, fullname) ?? { metadata: {} })).toEqual({
      verdict: "keep",
      reason: "still useful later",
      by: "ai",
    });
  });

  test("history triage_hint surfaces without AI and search text still matches", async () => {
    const fullname = seed("history", {
      title: "needle keepsake",
      metadata: { triage_hint: { verdict: "skip", reason: "old news" } },
    });

    const calls: FakeCall[] = [];

    expect(hintFor(database, db.getPublicItem(database, fullname) ?? { metadata: {} })).toEqual({
      verdict: "skip",
      reason: "old news",
      by: "history",
    });

    await prefetchHints(database, [fullname], { waitMs: 200, chat: fakeChat(GOOD_REPLY, calls) });
    expect(calls).toHaveLength(0);

    process.env.LLM_API_KEY = "test-key";
    setAiConsent(database, true);

    await prefetchHints(database, [fullname], { waitMs: 500, chat: fakeChat(GOOD_REPLY, calls) });

    expect(calls).toHaveLength(1);
    expect(db.searchItems(database, "needle").map((item) => item.fullname)).toContain(fullname);
    expect(db.searchItems(database, "keepsake").map((item) => item.fullname)).toContain(fullname);
  });
});

describe("prefetch scope", () => {
  test("only inbox items are fetched", async () => {
    const fullname = seed("archived", { status: "archived" });
    const calls: FakeCall[] = [];

    process.env.LLM_API_KEY = "test-key";
    setAiConsent(database, true);

    await prefetchHints(database, [fullname], { waitMs: 200, chat: fakeChat(GOOD_REPLY, calls) });

    expect(calls).toHaveLength(0);
    expect(storedMetadata(fullname)?.llm).toBeUndefined();
  });

  test("a fullname already in flight is not fetched twice", async () => {
    const fullname = seed("once");
    const calls: FakeCall[] = [];

    process.env.LLM_API_KEY = "test-key";
    setAiConsent(database, true);

    const chat = fakeChat(GOOD_REPLY, calls);

    await Promise.all([
      prefetchHints(database, [fullname], { waitMs: 500, chat }),
      prefetchHints(database, [fullname], { waitMs: 500, chat }),
    ]);

    expect(calls).toHaveLength(1);
  });
});

describe("daily cap across connections", () => {
  test("two connections reserving against one file never exceed the cap", async () => {
    const root = mkdtempSync(join(tmpdir(), "content-hoarder-cap-"));
    const path = join(root, "app.db");
    const first = db.connect(path);
    const second = db.connect(path);
    const calls: FakeCall[] = [];

    try {
      process.env.LLM_API_KEY = "test-key";
      process.env.LLM_DAILY_CAP = "1";
      setAiConsent(first, true);

      const a = seedInto(first, "cap_file_a");
      const b = seedInto(second, "cap_file_b");
      const chat = fakeChat(GOOD_REPLY, calls);

      await Promise.all([
        prefetchHints(first, [a], { waitMs: 500, chat }),
        prefetchHints(second, [b], { waitMs: 500, chat }),
      ]);

      expect(calls.length).toBeLessThanOrEqual(1);
      expect(aiUsage(first).calls).toBeLessThanOrEqual(1);
    } finally {
      first.close();
      second.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("shared concurrency", () => {
  test("overlapping prefetches never exceed four concurrent chat calls", async () => {
    const ids = Array.from({ length: 10 }, (_, index) => seed(`pool_${index}`));
    const calls: FakeCall[] = [];
    let active = 0;
    let peak = 0;

    process.env.LLM_API_KEY = "test-key";
    setAiConsent(database, true);

    const chat = async (messages: FakeCall): Promise<string> => {
      calls.push(messages);
      active++;
      peak = Math.max(peak, active);
      await Bun.sleep(5);
      active--;

      return GOOD_REPLY;
    };

    await Promise.all([
      prefetchHints(database, ids.slice(0, 5), { waitMs: 2000, chat }),
      prefetchHints(database, ids.slice(5), { waitMs: 2000, chat }),
    ]);

    expect(calls).toHaveLength(10);
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });
});

describe("clear hints endpoint", () => {
  test("an empty entry clears a stale AI hint after consent is revoked", async () => {
    const root = mkdtempSync(join(tmpdir(), "content-hoarder-hints-endpoint-"));
    const path = join(root, "app.db");
    const seeded = db.connect(path);

    process.env.LLM_API_KEY = "test-key";
    setAiConsent(seeded, true);

    const ai = seedInto(seeded, "endpoint_ai", {
      metadata: {
        llm: { verdict: "keep", reason: "AI says keep", tags: [], model: "m", at: NOW },
      },
    });

    const history = seedInto(seeded, "endpoint_history", {
      metadata: { triage_hint: { verdict: "skip", reason: "old news" } },
    });

    const archived = seedInto(seeded, "endpoint_archived", { status: "archived" });

    const server = await serveApp({ dbPath: path, host: "127.0.0.1", port: 0 });

    try {
      const base = `http://127.0.0.1:${server.port}`;
      const listed = [ai, history, archived, "reddit:missing"].join(",");

      const before = HintsSchema.parse(
        await (await fetch(`${base}/clear/hints?ids=${listed}`)).json(),
      );

      expect(before.hints[ai]).toContain("card-hint");
      expect(before.hints[history]).toContain('data-hint-by="history"');
      expect(before.hints[archived]).toBeUndefined();
      expect(before.hints["reddit:missing"]).toBeUndefined();

      await fetch(`${base}/settings/ai`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      });

      const after = HintsSchema.parse(
        await (await fetch(`${base}/clear/hints?ids=${ai},${history}`)).json(),
      );

      expect(after.hints[ai]).toBe("");
      expect(after.hints[history]).toContain('data-hint-by="history"');
    } finally {
      await server.stop();
      seeded.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("consent on prefetches a missing hint without delaying the response", async () => {
    const fullname = seed("late_llm");
    const calls: FakeCall[] = [];
    const { promise: called, resolve: markCalled } = Promise.withResolvers<void>();

    const chat = async (messages: FakeCall): Promise<string> => {
      calls.push(messages);
      markCalled();

      return GOOD_REPLY;
    };

    process.env.LLM_API_KEY = "test-key";
    setAiConsent(database, true);

    const response = withLibrary(database, () =>
      clearHints(new URL(`http://localhost/clear/hints?ids=${encodeURIComponent(fullname)}`), {
        chat,
        waitMs: 0,
      }),
    );

    expect(calls).toHaveLength(0);

    const body = HintsSchema.parse(await response.json());

    expect(body.hints[fullname]).toBe("");

    await called;

    for (let turn = 0; turn < 100 && !storedMetadata(fullname)?.llm; turn += 1)
      await Promise.resolve();

    expect(calls).toHaveLength(1);
    expect(storedMetadata(fullname)?.llm).toBeDefined();
  });
});
