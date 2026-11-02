import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as db from "../src/db.ts";
import { main } from "../src/cli.ts";
import {
  demoEventsSummary,
  mergeDemoEventsSummaries,
  summarizeDemoEvents,
  track,
  type DemoEventsSummary,
  type DemoEventRow,
  type EventData,
} from "../src/demo_analytics.ts";
import { newItem, type JsonValue } from "../src/models.ts";
import { handle } from "../src/web/routes.ts";
import { serveApp } from "../src/web.ts";

interface StoredEvent {
  at: number;
  client_at: number | null;
  sid: string | null;
  kind: string;
  fullname: string | null;
  data: string | null;
}

interface SeedEvent {
  at: number;
  client_at: number | null;
  sid: string | null;
  kind: string;
  data: EventData;
}

const previous: Record<string, string | undefined> = {};

function setEnv(key: string, value: string | undefined): void {
  if (!Object.hasOwn(previous, key)) previous[key] = process.env[key];

  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

afterEach(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  for (const key of Object.keys(previous)) delete previous[key];
});

function eventRows(path: string): StoredEvent[] {
  const connection = db.connect(path);

  try {
    return connection
      .query<StoredEvent, []>(
        "SELECT at, client_at, sid, kind, fullname, data FROM demo_events ORDER BY id",
      )
      .all();
  } finally {
    connection.close();
  }
}

function summaryOf(path: string): DemoEventsSummary {
  const connection = db.connect(path);

  try {
    return demoEventsSummary(connection);
  } finally {
    connection.close();
  }
}

function hasEventTable(path: string): boolean {
  const connection = db.connect(path);

  try {
    return (
      connection
        .query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='demo_events'")
        .get() !== null
    );
  } finally {
    connection.close();
  }
}

function seedItems(path: string): void {
  const connection = db.connect(path);

  try {
    for (const source_id of ["t3_match", "t3_miss"])
      db.mergeUpsert(connection, newItem({ source: "reddit", source_id, title: source_id }));
  } finally {
    connection.close();
  }
}

function seedEvents(path: string, events: SeedEvent[]): void {
  const connection = db.connect(path);

  try {
    track(connection, "page_view", { data: { path: "/" } });
    connection.exec("DELETE FROM demo_events");

    const insert = connection.query(
      "INSERT INTO demo_events (at, client_at, sid, kind, page, fullname, data) VALUES (?, ?, ?, ?, NULL, NULL, ?)",
    );

    for (const event of events)
      insert.run(event.at, event.client_at, event.sid, event.kind, JSON.stringify(event.data));
  } finally {
    connection.close();
  }
}

async function withServer(
  seed: ((path: string) => void) | null,
  fn: (base: string, path: string) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "content-hoarder-demo-events-"));
  const path = join(root, "app.db");

  if (seed) seed(path);
  const server = await serveApp({ dbPath: path, host: "127.0.0.1", port: 0 });

  try {
    await fn(`http://127.0.0.1:${server.port}`, path);
  } finally {
    await server.stop();
    rmSync(root, { recursive: true, force: true });
  }
}

function postEvents(base: string, body: JsonValue): Promise<Response> {
  return fetch(`${base}/events`, {
    method: "POST",
    headers: { "content-type": "text/plain;charset=UTF-8" },
    body: JSON.stringify(body),
  });
}

async function runCli(argv: string[]): Promise<{ code: number; output: string }> {
  const lines: string[] = [];
  const original = console.log;

  console.log = (...values: JsonValue[]) => {
    lines.push(values.map((value) => String(value)).join(" "));
  };

  try {
    const code = await main(argv);

    return { code, output: lines.join("\n") };
  } finally {
    console.log = original;
  }
}

test("event posts are dropped and no table is created when the switch is off", async () => {
  setEnv("CONTENT_HOARDER_DEMO_ANALYTICS", undefined);

  await withServer(null, async (base, path) => {
    const response = await postEvents(base, {
      sid: "tab-off",
      events: [{ kind: "page_view", data: { path: "/clear" } }],
    });

    expect(response.status).toBe(204);
    expect(hasEventTable(path)).toBe(false);
  });
});

test("a valid batch is stored with the server clock and the client clock", async () => {
  setEnv("CONTENT_HOARDER_DEMO_ANALYTICS", "1");
  const before = Date.now();

  await withServer(null, async (base, path) => {
    const response = await postEvents(base, {
      sid: "tab-on",
      events: [
        { kind: "page_view", at: 5_000, data: { path: "/clear" } },
        {
          kind: "decision",
          page: "clear",
          fullname: "reddit:t3_demo",
          data: { act: "keep", method: "swipe", dwell_ms: 1200 },
        },
      ],
    });

    expect(response.status).toBe(204);
    const stored = eventRows(path);

    expect(stored.map((row) => row.kind)).toEqual(["page_view", "decision"]);
    expect(stored[0]?.sid).toBe("tab-on");
    expect(stored[0]?.client_at).toBe(5_000);
    expect(stored[0]?.at).toBeGreaterThanOrEqual(before);
    expect(stored[0]?.at).toBeLessThanOrEqual(Date.now());
    expect(stored[1]?.fullname).toBe("reddit:t3_demo");
    expect(stored[1]?.client_at).toBeNull();
    expect(JSON.parse(stored[1]?.data ?? "{}")).toMatchObject({
      act: "keep",
      method: "swipe",
      dwell_ms: 1200,
    });
  });
});

test("round and hint lifecycle events accept their structured payloads", async () => {
  setEnv("CONTENT_HOARDER_DEMO_ANALYTICS", "1");

  await withServer(null, async (base, path) => {
    const response = await postEvents(base, {
      sid: "tab-round",
      events: [
        { kind: "round_start", data: { size: 10, resumed: false, round_id: "r1" } },
        { kind: "hint_shown", data: { by: "ai", idx: 2 } },
        { kind: "round_suspend", data: { round_id: "r1", decided: 3, ms: 5_000 } },
        { kind: "round_end", data: { completed: true, decided: 3, ms: 6_000, round_id: "r1" } },
      ],
    });

    expect(response.status).toBe(204);
    expect(eventRows(path).map((row) => row.kind)).toEqual([
      "round_start",
      "hint_shown",
      "round_suspend",
      "round_end",
    ]);
  });
});

test("invalid, forged, sensitive and oversized payloads are rejected", async () => {
  setEnv("CONTENT_HOARDER_DEMO_ANALYTICS", "1");

  await withServer(null, async (base, path) => {
    const valid = await postEvents(base, {
      sid: "tab-bad",
      events: [{ kind: "page_view", data: { path: "/" } }],
    });

    expect(valid.status).toBe(204);

    expect(
      (
        await postEvents(base, {
          sid: "tab-bad",
          events: [{ kind: "not_a_kind" }],
        })
      ).status,
    ).toBe(400);

    expect(
      (
        await postEvents(base, {
          sid: "tab-bad",
          events: [{ kind: "srv_status", data: { status: "keep" } }],
        })
      ).status,
    ).toBe(400);

    expect(
      (
        await postEvents(base, {
          sid: "tab-bad",
          events: [
            {
              kind: "decision",
              data: { act: "keep", method: "swipe", dwell_ms: 10, title: "Private title" },
            },
          ],
        })
      ).status,
    ).toBe(400);

    expect(
      (
        await postEvents(base, {
          sid: "tab-big",
          events: [
            { kind: "decision", data: { act: "keep", method: "swipe", blob: "x".repeat(4096) } },
          ],
        })
      ).status,
    ).toBe(400);

    expect(
      (
        await postEvents(base, {
          sid: "tab-huge",
          events: [{ kind: "page_view", data: { path: "/" } }],
          padding: "x".repeat(70_000),
        })
      ).status,
    ).toBe(413);

    expect(eventRows(path)).toHaveLength(1);
  });
});

test("an oversized body without a content-length is rejected while streaming", async () => {
  setEnv("CONTENT_HOARDER_DEMO_ANALYTICS", "1");

  const encoder = new TextEncoder();
  let pulls = 0;

  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      controller.enqueue(encoder.encode(`"${"x".repeat(8191)}`));
    },
  });

  const request = new Request("http://127.0.0.1/events", {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "text/plain" },
    body: stream,
  });

  expect(request.headers.get("content-length")).toBeNull();

  const response = await handle(request);

  expect(response.status).toBe(413);
  expect(pulls).toBeLessThanOrEqual(12);
});

test("the summary counts hinted displays once and unique rounds across resumes", () => {
  const row = (id: number, kind: string, data: EventData): DemoEventRow => ({
    id,
    at: id,
    client_at: id,
    sid: "s1",
    kind,
    page: null,
    fullname: null,
    data,
  });

  const summary = summarizeDemoEvents([
    row(1, "round_start", { size: 4, resumed: false, round_id: "r1" }),
    row(2, "card_view", { idx: 0, hinted: true, hint_by: "ai" }),
    row(3, "hint_shown", { by: "ai", idx: 0 }),
    row(4, "hint_shown", { by: "history", idx: 0 }),
    row(5, "round_start", { size: 4, resumed: true, round_id: "r1" }),
    row(6, "round_end", { completed: true, decided: 4, ms: 1_000, round_id: "r1" }),
    row(7, "round_start", { size: 2, resumed: false, round_id: "r2" }),
    row(8, "round_end", { completed: false, decided: 1, ms: 500, round_id: "r2" }),
  ]);

  expect(summary.hints_shown).toBe(2);
  expect(summary.rounds_started).toBe(2);
  expect(summary.rounds_completed).toBe(1);
});

test("a status change records the stored hint outcome", async () => {
  setEnv("CONTENT_HOARDER_DEMO_ANALYTICS", "1");

  await withServer(seedItems, async (base, path) => {
    const method = {
      method: "POST",
      headers: { "content-type": "application/json" },
    };

    const matched = await fetch(`${base}/items/reddit:t3_match/status`, {
      ...method,
      body: JSON.stringify({ status: "keep", hint: { verdict: "keep", by: "ai" } }),
    });

    const mismatched = await fetch(`${base}/items/reddit:t3_miss/status`, {
      ...method,
      body: JSON.stringify({ status: "archived", hint: { verdict: "keep", by: "ai" } }),
    });

    const repeat = await fetch(`${base}/items/reddit:t3_match/status`, {
      ...method,
      body: JSON.stringify({ status: "keep", hint: { verdict: "keep", by: "ai" } }),
    });

    expect(matched.status).toBe(200);
    expect(mismatched.status).toBe(200);
    expect(repeat.status).toBe(200);

    const stored = eventRows(path).filter((row) => row.kind === "srv_status");

    expect(stored).toHaveLength(3);
    expect(JSON.parse(stored[0]?.data ?? "{}")).toMatchObject({
      status: "keep",
      prior: "inbox",
      hint: "keep",
      matched: true,
    });
    expect(JSON.parse(stored[1]?.data ?? "{}")).toMatchObject({
      status: "archived",
      prior: "inbox",
      hint: "keep",
      matched: false,
    });
    expect("matched" in JSON.parse(stored[2]?.data ?? "{}")).toBe(false);
    expect(summaryOf(path).hints_matched).toBe(1);
  });
});

test("the summary counts decisions, dwell and explicit hint acceptance", () => {
  setEnv("CONTENT_HOARDER_DEMO_ANALYTICS", "1");
  const root = mkdtempSync(join(tmpdir(), "content-hoarder-demo-summary-"));
  const path = join(root, "app.db");
  const connection = db.connect(path);

  try {
    track(connection, "page_view", { data: { path: "/clear" } });
    track(connection, "decision", { data: { act: "keep", method: "swipe", dwell_ms: 100 } });
    track(connection, "decision", { data: { act: "archived", method: "tap", dwell_ms: 300 } });
    track(connection, "decision", {
      data: { act: "archived", method: "swipe", dwell_ms: 200, hint: "skip", hint_by: "ai" },
    });
    track(connection, "decision", {
      data: { act: "skip", method: "key", dwell_ms: 50, hint: "skip", hint_by: "history" },
    });
    track(connection, "decision", {
      data: { act: "keep", method: "hint", dwell_ms: 150, hint: "keep", hint_by: "ai" },
    });
    track(connection, "undo", {});
    track(connection, "srv_ai_call", {
      data: { ok: true, ms: 500, prompt_tokens: 10, completion_tokens: 5 },
    });

    const summary = demoEventsSummary(connection);

    expect(summary.events).toBe(8);
    expect(summary.sessions).toBe(0);
    expect(summary.decisions_by_act).toEqual({ archived: 2, keep: 2, skip: 1 });
    expect(summary.decisions_by_method).toEqual({ swipe: 2, tap: 1, key: 1, hint: 1 });
    expect(summary.median_dwell_ms).toBe(150);
    expect(summary.hints_accepted).toBe(1);
    expect(summary.hints_matched).toBe(0);
    expect(summary.undos).toBe(1);
    expect(summary.page_views).toEqual({ "/clear": 1 });
    expect(summary.ai_calls).toMatchObject({
      ok: 1,
      failed: 0,
      median_ms: 500,
      prompt_tokens: 10,
      completion_tokens: 5,
    });
  } finally {
    connection.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("first-decision timing uses the client clock within a session", async () => {
  setEnv("CONTENT_HOARDER_DEMO_ANALYTICS", "1");

  await withServer(null, async (base, path) => {
    const response = await postEvents(base, {
      sid: "s1",
      events: [
        { kind: "page_view", at: 1_000_000, data: { path: "/clear" } },
        { kind: "decision", at: 1_002_500, data: { act: "keep", method: "hint", dwell_ms: 900 } },
      ],
    });

    expect(response.status).toBe(204);

    const rows = eventRows(path);

    expect(rows.map((row) => row.client_at)).toEqual([1_000_000, 1_002_500]);
    expect(rows[1]?.at).toBe(rows[0]?.at ?? -1);
    expect(summaryOf(path).first_decision_ms).toBe(2_500);
  });
});

test("merged summaries take global extrema and median timing", () => {
  const base = summarizeDemoEvents([]);

  const first: DemoEventsSummary = {
    ...base,
    events: 2,
    first_at: 1_000,
    last_at: 9_000,
    first_decision_ms: 1_000,
    median_dwell_ms: 100,
  };

  const second: DemoEventsSummary = {
    ...base,
    events: 2,
    first_at: 500,
    last_at: 6_000,
    first_decision_ms: 3_000,
    median_dwell_ms: 300,
  };

  const merged = mergeDemoEventsSummaries([first, second]);

  expect(merged.events).toBe(4);
  expect(merged.first_at).toBe(500);
  expect(merged.last_at).toBe(9_000);
  expect(merged.first_decision_ms).toBe(2_000);
  expect(merged.median_dwell_ms).toBe(200);
});

test("demo-events --dir reports per-file counts, global extrema and median timing", async () => {
  setEnv("CONTENT_HOARDER_DEMO_ANALYTICS", "1");
  const root = mkdtempSync(join(tmpdir(), "content-hoarder-demo-cli-"));
  const first = join(root, "aaa.db");
  const second = join(root, "bbb.db");

  try {
    seedEvents(first, [
      { at: 1_000, client_at: 1_000, sid: "a", kind: "page_view", data: { path: "/" } },
      {
        at: 9_000,
        client_at: 2_000,
        sid: "a",
        kind: "decision",
        data: { act: "keep", method: "swipe", dwell_ms: 100 },
      },
    ]);
    seedEvents(second, [
      { at: 500, client_at: 5_000, sid: "b", kind: "page_view", data: { path: "/" } },
      {
        at: 6_000,
        client_at: 8_000,
        sid: "b",
        kind: "decision",
        data: { act: "archived", method: "tap", dwell_ms: 300 },
      },
    ]);

    const { code, output } = await runCli(["demo-events", "--dir", root]);
    const totalBlock = output.slice(output.indexOf("total (2 files):"));

    expect(code).toBe(0);
    expect(output).toContain("aaa.db:");
    expect(output).toContain("bbb.db:");
    expect(totalBlock).toContain("events=4");
    expect(totalBlock).toContain("first_at=1970-01-01T00:00:00.500Z");
    expect(totalBlock).toContain("last_at=1970-01-01T00:00:09.000Z");
    expect(totalBlock).toContain("first_decision_ms=2000");
    expect(totalBlock).toContain("median_dwell_ms=200");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("demo-events reports a database without events as empty", async () => {
  const root = mkdtempSync(join(tmpdir(), "content-hoarder-demo-cli-empty-"));
  const path = join(root, "plain.db");

  try {
    const connection = db.connect(path);

    connection.close();

    const { code, output } = await runCli(["demo-events", "--dir", root]);

    expect(code).toBe(0);
    expect(output).toContain("events=0");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("demo-events surfaces an unreadable database", async () => {
  const root = mkdtempSync(join(tmpdir(), "content-hoarder-demo-cli-broken-"));

  try {
    writeFileSync(join(root, "broken.db"), "not a sqlite database");

    await expect(runCli(["demo-events", "--dir", root])).rejects.toThrow(/broken\.db/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
