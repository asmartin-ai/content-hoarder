import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as db from "../src/db.ts";
import { main } from "../src/cli.ts";
import { aiUsage } from "../src/assist/hints.ts";
import { newItem, type Metadata } from "../src/models.ts";
import { formatSurfaceStats, surfaceStats } from "../src/surface_stats.ts";

const DAY = 86_400;

const NOW = Math.floor(Date.now() / 1000);

interface SeedOptions {
  id: string;
  status: "inbox" | "keep" | "done" | "archived";
  processed_utc?: number;
  subreddit?: string;
  category?: string;
  saved_utc?: number;
  created_utc?: number;
  metadata?: Metadata;
}

function seed(database: Database, options: SeedOptions): void {
  const metadata: Metadata = { ...options.metadata };

  if (options.subreddit !== undefined) metadata.subreddit = options.subreddit;

  if (options.category !== undefined) metadata.category = options.category;

  db.mergeUpsert(
    database,
    newItem({
      source: "reddit",
      source_id: options.id,
      kind: "post",
      title: options.id,
      created_utc: options.created_utc ?? NOW - 10 * DAY,
      saved_utc: options.saved_utc ?? NOW - 2 * DAY,
      metadata,
    }),
  );

  database.run("UPDATE items SET status=?, processed_utc=? WHERE fullname=?", [
    options.status,
    options.status === "inbox" ? null : (options.processed_utc ?? NOW - DAY),
    `reddit:${options.id}`,
  ]);
}

test("decision rates exclude decayed sweeps and keep family Wilson bounds sane", () => {
  const database = db.connect(":memory:");

  try {
    for (let index = 0; index < 3; index++)
      seed(database, { id: `keep_${index}`, status: "keep", subreddit: "alpha" });
    seed(database, { id: "done_0", status: "done", subreddit: "alpha" });
    seed(database, { id: "arch_0", status: "archived", subreddit: "beta" });
    seed(database, { id: "arch_1", status: "archived", subreddit: "beta" });
    seed(database, { id: "inbox_0", status: "inbox", subreddit: "beta" });

    for (let index = 0; index < 5; index++)
      seed(database, {
        id: `sweep_${index}`,
        status: "archived",
        subreddit: "beta",
        metadata: { decayed_at: NOW - DAY, decay_label: "sweep" },
      });

    const report = surfaceStats(database);

    expect(report.decisions.by_status).toEqual({ keep: 3, done: 1, archived: 2 });
    expect(report.decisions.decided).toBe(6);
    expect(report.decisions.keep_rate).toBeCloseTo(4 / 6, 6);
    expect(report.decisions.decayed).toEqual({ keep: 0, done: 0, archived: 5 });
    expect(report.decisions.inbox).toBe(1);
    expect(report.decisions.per_day.length).toBe(14);

    const alpha = report.families.find(
      (row) => row.family === "subreddit" && row.value === "alpha",
    );

    const beta = report.families.find((row) => row.family === "subreddit" && row.value === "beta");

    expect(alpha?.decided).toBe(4);
    expect(alpha?.kept).toBe(4);
    expect(alpha?.archived).toBe(0);
    expect(alpha?.keep_rate).toBe(1);
    expect(beta?.decided).toBe(2);
    expect(beta?.kept).toBe(0);
    expect(beta?.archived).toBe(2);
    expect(beta?.keep_rate).toBe(0);

    for (const row of report.families) {
      expect(row.wilson.lo).toBeGreaterThanOrEqual(0);
      expect(row.wilson.lo).toBeLessThanOrEqual(row.keep_rate);
      expect(row.keep_rate).toBeLessThanOrEqual(row.wilson.hi);
      expect(row.wilson.hi).toBeLessThanOrEqual(1);
    }
  } finally {
    database.close();
  }
});

test("since limits decisions but not current inbox size", () => {
  const database = db.connect(":memory:");

  try {
    seed(database, { id: "old_keep", status: "keep", processed_utc: NOW - 40 * DAY });
    seed(database, { id: "new_keep", status: "keep", processed_utc: NOW - 2 * DAY });
    seed(database, { id: "inbox_old", status: "inbox" });

    expect(surfaceStats(database).decisions.decided).toBe(2);

    const recent = surfaceStats(database, { since: NOW - 7 * DAY });

    expect(recent.since).toBe(NOW - 7 * DAY);
    expect(recent.decisions.decided).toBe(1);
    expect(recent.decisions.by_status).toEqual({ keep: 1, done: 0, archived: 0 });
    expect(recent.decisions.inbox).toBe(1);
  } finally {
    database.close();
  }
});

test("hint agreement, per-verdict splits and confusion follow hint_outcome", () => {
  const database = db.connect(":memory:");

  try {
    seed(database, {
      id: "h1",
      status: "keep",
      metadata: {
        hint_outcome: {
          verdict: "keep",
          by: "ai",
          decided: "keep",
          matched: true,
          at: NOW - 2 * DAY,
        },
      },
    });
    seed(database, {
      id: "h2",
      status: "archived",
      metadata: {
        hint_outcome: {
          verdict: "keep",
          by: "ai",
          decided: "archived",
          matched: false,
          at: NOW - 2 * DAY,
        },
      },
    });
    seed(database, {
      id: "h3",
      status: "archived",
      metadata: {
        hint_outcome: {
          verdict: "skip",
          by: "history",
          decided: "archived",
          matched: true,
          at: NOW - 2 * DAY,
        },
      },
    });
    seed(database, {
      id: "h4",
      status: "done",
      metadata: {
        hint_outcome: {
          verdict: "skip",
          by: "ai",
          decided: "done",
          matched: false,
          at: NOW - 2 * DAY,
        },
      },
    });
    seed(database, {
      id: "h5",
      status: "keep",
      metadata: {
        hint_outcome: {
          verdict: "keep",
          by: "ai",
          decided: "keep",
          matched: true,
          at: NOW - 40 * DAY,
        },
      },
    });
    seed(database, {
      id: "h6",
      status: "archived",
      metadata: {
        hint_outcome: {
          verdict: "keep",
          by: "ai",
          decided: "archived",
          matched: true,
          at: NOW - 2 * DAY,
        },
      },
    });

    const report = surfaceStats(database);

    expect(report.hint.shown).toBe(6);
    expect(report.hint.matched).toBe(4);
    expect(report.hint.rate).toBeCloseTo(4 / 6, 6);
    expect(report.hint.by.ai).toEqual({ shown: 5, matched: 3, rate: 0.6 });
    expect(report.hint.by.history).toEqual({ shown: 1, matched: 1, rate: 1 });
    expect(report.hint.verdicts.keep).toEqual({ shown: 4, matched: 3, rate: 0.75 });
    expect(report.hint.verdicts.skip).toEqual({ shown: 2, matched: 1, rate: 0.5 });

    const cell = (verdict: string, decided: string): number | undefined =>
      report.hint.confusion.find((row) => row.verdict === verdict && row.decided === decided)
        ?.count;

    expect(cell("keep", "keep")).toBe(2);
    expect(cell("keep", "archived")).toBe(2);
    expect(cell("keep", "done")).toBe(0);
    expect(cell("skip", "archived")).toBe(1);
    expect(cell("skip", "done")).toBe(1);
    expect(cell("skip", "keep")).toBe(0);

    const agreement = db.hintAgreement(database);

    expect(report.hint.shown).toBe(agreement.shown);
    expect(report.hint.matched).toBe(agreement.matched);
    expect(report.hint.by.ai.shown).toBe(agreement.by.ai.shown);
    expect(report.hint.by.ai.matched).toBe(agreement.by.ai.matched);
    expect(report.hint.by.history.shown).toBe(agreement.by.history.shown);
    expect(report.hint.by.history.matched).toBe(agreement.by.history.matched);

    const recent = surfaceStats(database, { since: NOW - 7 * DAY });

    expect(recent.decisions.decided).toBe(6);
    expect(recent.hint.shown).toBe(report.hint.shown);
    expect(recent.hint.matched).toBe(report.hint.matched);
  } finally {
    database.close();
  }
});

test("triage score calibration buckets observed keep rate and processed share", () => {
  const database = db.connect(":memory:");

  try {
    for (let index = 0; index < 3; index++)
      seed(database, {
        id: `high_keep_${index}`,
        status: "keep",
        metadata: { triage_score: 0.95 },
      });
    seed(database, { id: "high_inbox", status: "inbox", metadata: { triage_score: 0.92 } });
    seed(database, { id: "low_0", status: "archived", metadata: { triage_score: 0.05 } });
    seed(database, { id: "low_1", status: "archived", metadata: { triage_score: 0.08 } });

    const report = surfaceStats(database);

    const high = report.calibration.buckets.find((bucket) => bucket.bin === "0.9-1.0");
    const low = report.calibration.buckets.find((bucket) => bucket.bin === "0.0-0.1");

    expect(high?.items).toBe(4);
    expect(high?.decided).toBe(3);
    expect(high?.kept).toBe(3);
    expect(high?.keep_rate).toBe(1);
    expect(high?.processed_share).toBeCloseTo(0.75, 6);
    expect(low?.items).toBe(2);
    expect(low?.decided).toBe(2);
    expect(low?.kept).toBe(0);
    expect(low?.keep_rate).toBe(0);
    expect(low?.processed_share).toBe(1);
    expect(report.calibration.caveat).toContain("retrospective");
  } finally {
    database.close();
  }
});

test("AI cost uses env prices and the usage totals", () => {
  const database = db.connect(":memory:");
  const previousIn = process.env.LLM_PRICE_IN_PER_M;
  const previousOut = process.env.LLM_PRICE_OUT_PER_M;

  try {
    db.setSetting(
      database,
      "ai_usage",
      JSON.stringify({
        calls: 3,
        ok: 2,
        failed: 1,
        prompt_tokens: 1000,
        completion_tokens: 500,
        since: 1000,
      }),
    );

    process.env.LLM_PRICE_IN_PER_M = "1";
    process.env.LLM_PRICE_OUT_PER_M = "2";

    const priced = surfaceStats(database).ai;

    expect(priced.calls).toBe(3);
    expect(priced.ok).toBe(2);
    expect(priced.failed).toBe(1);
    expect(priced.prompt_tokens).toBe(1000);
    expect(priced.completion_tokens).toBe(500);
    expect(priced.tokens).toBe(1500);
    expect(priced.since).toBe(1000);
    expect(priced.cost_usd).toBeCloseTo(0.002, 9);
    expect(priced.cost_per_1000_ok_usd).toBeCloseTo(1, 9);

    delete process.env.LLM_PRICE_IN_PER_M;
    delete process.env.LLM_PRICE_OUT_PER_M;

    const defaults = surfaceStats(database).ai;

    expect(defaults.prices.in_per_m).toBe(0.15);
    expect(defaults.prices.out_per_m).toBe(0.5);
    expect(defaults.cost_usd).toBeCloseTo(0.0004, 9);
    expect(defaults.cost_per_1000_ok_usd).toBeCloseTo(0.2, 9);
  } finally {
    if (previousIn === undefined) delete process.env.LLM_PRICE_IN_PER_M;
    else process.env.LLM_PRICE_IN_PER_M = previousIn;

    if (previousOut === undefined) delete process.env.LLM_PRICE_OUT_PER_M;
    else process.env.LLM_PRICE_OUT_PER_M = previousOut;
    database.close();
  }
});

test("surface stats delegates AI usage parsing to assist aiUsage", () => {
  const database = db.connect(":memory:");

  try {
    db.setSetting(database, "ai_usage", JSON.stringify({ calls: 3, ok: "bad" }));

    const canonical = aiUsage(database);
    const ai = surfaceStats(database).ai;

    expect(ai.calls).toBe(canonical.calls);
    expect(ai.ok).toBe(canonical.ok);
    expect(ai.failed).toBe(canonical.failed);
    expect(ai.prompt_tokens).toBe(canonical.prompt_tokens);
    expect(ai.completion_tokens).toBe(canonical.completion_tokens);
    expect(ai.since).toBe(canonical.since);
    expect(ai).toMatchObject({
      calls: 3,
      ok: 0,
      failed: 0,
      tokens: 0,
      since: 0,
      cost_usd: 0,
      cost_per_1000_ok_usd: null,
    });
  } finally {
    database.close();
  }
});

test("low-token usage keeps a non-zero cost per 1,000 suggestions", () => {
  const database = db.connect(":memory:");
  const previousIn = process.env.LLM_PRICE_IN_PER_M;
  const previousOut = process.env.LLM_PRICE_OUT_PER_M;

  try {
    delete process.env.LLM_PRICE_IN_PER_M;
    delete process.env.LLM_PRICE_OUT_PER_M;
    db.setSetting(
      database,
      "ai_usage",
      JSON.stringify({
        calls: 1,
        ok: 1,
        failed: 0,
        prompt_tokens: 1,
        completion_tokens: 0,
        since: 1000,
      }),
    );

    const ai = surfaceStats(database).ai;

    expect(ai.cost_usd).toBeGreaterThan(0);
    expect(ai.cost_per_1000_ok_usd).toBeCloseTo(0.00015, 9);
  } finally {
    if (previousIn === undefined) delete process.env.LLM_PRICE_IN_PER_M;
    else process.env.LLM_PRICE_IN_PER_M = previousIn;

    if (previousOut === undefined) delete process.env.LLM_PRICE_OUT_PER_M;
    else process.env.LLM_PRICE_OUT_PER_M = previousOut;
    database.close();
  }
});

test("report reads a single snapshot while another connection writes", () => {
  const root = mkdtempSync(join(tmpdir(), "content-hoarder-surface-snapshot-"));
  const databasePath = join(root, "app.db");
  const writer = db.connect(databasePath);
  const database = db.connect(databasePath);

  try {
    seed(database, { id: "snap_0", status: "keep" });
    seed(database, { id: "snap_1", status: "keep" });
    seed(database, { id: "snap_2", status: "keep" });

    writer.exec("BEGIN IMMEDIATE");
    writer.run("UPDATE items SET status='archived' WHERE fullname='reddit:snap_0'");

    const report = surfaceStats(database);
    let familyTotal = 0;

    for (const row of report.families) if (row.family === "source/kind") familyTotal += row.decided;

    expect(report.decisions.by_status).toEqual({ keep: 3, done: 0, archived: 0 });
    expect(familyTotal).toBe(report.decisions.decided);

    writer.exec("COMMIT");

    const after = surfaceStats(database);

    expect(after.decisions.by_status).toEqual({ keep: 2, done: 0, archived: 1 });
  } finally {
    writer.close();
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("empty database returns zeros without throwing and formats a report", () => {
  const database = db.connect(":memory:");

  try {
    const report = surfaceStats(database);

    expect(report.decisions.decided).toBe(0);
    expect(report.decisions.by_status).toEqual({ keep: 0, done: 0, archived: 0 });
    expect(report.decisions.decayed).toEqual({ keep: 0, done: 0, archived: 0 });
    expect(report.decisions.keep_rate).toBe(0);
    expect(report.decisions.inbox).toBe(0);
    expect(report.decisions.per_day.length).toBe(14);
    expect(report.decisions.per_day.every((day) => day.total === 0)).toBe(true);
    expect(report.families).toEqual([]);
    expect(report.hint.shown).toBe(0);
    expect(report.hint.confusion.length).toBe(6);
    expect(report.calibration.buckets).toEqual([]);
    expect(report.ai).toMatchObject({
      calls: 0,
      ok: 0,
      failed: 0,
      tokens: 0,
      since: 0,
      cost_usd: 0,
      cost_per_1000_ok_usd: null,
    });

    const text = formatSurfaceStats(report);

    expect(text).toContain("Surface stats");
    expect(text).toContain("decisions");
    expect(text).toContain("no decisions");
    expect(text).toContain("no scored items");
  } finally {
    database.close();
  }
});

test("surface-stats CLI prints text by default and JSON with --json", async () => {
  const root = mkdtempSync(join(tmpdir(), "content-hoarder-surface-"));
  const databasePath = join(root, "app.db");
  const previousDatabase = process.env.CONTENT_HOARDER_DB;
  process.env.CONTENT_HOARDER_DB = databasePath;

  const conn = db.connect(databasePath);

  seed(conn, { id: "cli_keep", status: "keep", subreddit: "alpha" });
  seed(conn, { id: "cli_arch", status: "archived", subreddit: "beta" });
  conn.close();

  const logs: string[] = [];
  const originalLog = console.log;

  console.log = (...values: string[]) => {
    logs.push(values.join(" "));
  };

  try {
    expect(await main(["surface-stats"])).toBe(0);
    expect(logs.join("\n")).toContain("Surface stats");

    logs.length = 0;
    expect(await main(["surface-stats", "--json"])).toBe(0);

    const parsed = JSON.parse(logs.join("\n"));

    expect(parsed.decisions.decided).toBe(2);
    expect(parsed.hint.shown).toBe(0);

    logs.length = 0;
    expect(await main(["surface-stats", "--since", "2020-01-01"])).toBe(0);
    expect(logs.join("\n")).toContain("since 2020-01-01");
  } finally {
    console.log = originalLog;

    if (previousDatabase === undefined) delete process.env.CONTENT_HOARDER_DB;
    else process.env.CONTENT_HOARDER_DB = previousDatabase;

    rmSync(root, { recursive: true, force: true });
  }
});
