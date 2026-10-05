import { test, expect } from "bun:test";
import * as db from "../src/db.ts";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { main } from "../src/cli.ts";
import { sync as syncHn } from "../src/hn_sync.ts";
import { newItem } from "../src/models.ts";

test("permanent delete stays read-only until both confirmation flags are present", async () => {
  const root = mkdtempSync(join(tmpdir(), "content-hoarder-cli-"));
  const databasePath = join(root, "app.db");
  const previousDatabase = process.env.CONTENT_HOARDER_DB;
  process.env.CONTENT_HOARDER_DB = databasePath;

  try {
    const connection = db.connect(databasePath);
    db.mergeUpsert(
      connection,
      newItem({ source: "reddit", source_id: "t3_cli", title: "Synthetic CLI row" }),
    );
    connection.close();

    expect(await main(["delete", "--fullname", "reddit:t3_cli"])).toBe(0);
    expect(await main(["delete", "--fullname", "reddit:t3_cli", "--apply"])).toBe(3);
    expect(await main(["decay", "--tag", "ephemeral", "--tag", "deleted"])).toBe(0);

    const check = db.connect(databasePath);
    expect(db.getItem(check, "reddit:t3_cli")).not.toBeNull();
    check.close();
  } finally {
    if (previousDatabase === undefined) delete process.env.CONTENT_HOARDER_DB;
    else process.env.CONTENT_HOARDER_DB = previousDatabase;
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI waits for filtered JSON export and writes a complete file", async () => {
  const root = mkdtempSync(join(tmpdir(), "content-hoarder-export-"));
  const databasePath = join(root, "app.db");
  const outputPath = join(root, "export.json");
  const previousDatabase = process.env.CONTENT_HOARDER_DB;
  process.env.CONTENT_HOARDER_DB = databasePath;

  try {
    const connection = db.connect(databasePath);
    db.mergeUpsert(
      connection,
      newItem({ source: "reddit", source_id: "t3_export", title: "Exported", status: "keep" }),
    );
    db.mergeUpsert(
      connection,
      newItem({ source: "reddit", source_id: "t3_omitted", title: "Not exported" }),
    );
    connection.close();

    expect(
      await main(["export", "--out", outputPath, "--format", "json", "--status", "keep"]),
    ).toBe(0);
    expect(JSON.parse(readFileSync(outputPath, "utf8"))).toHaveLength(1);
    expect(JSON.parse(readFileSync(outputPath, "utf8"))[0]).toMatchObject({
      fullname: "reddit:t3_export",
      title: "Exported",
    });
  } finally {
    if (previousDatabase === undefined) delete process.env.CONTENT_HOARDER_DB;
    else process.env.CONTENT_HOARDER_DB = previousDatabase;
    rmSync(root, { recursive: true, force: true });
  }
});

test("HN sync throttles paginated requests using its configured delay", async () => {
  const root = mkdtempSync(join(tmpdir(), "content-hoarder-hn-sync-"));
  const connection = db.connect(join(root, "app.db"));
  const delays: number[] = [];
  let page = 0;

  try {
    const result = await syncHn(connection, {
      user: "reader",
      maxPages: 2,
      throttle: 4,
      sleep: async (seconds) => {
        delays.push(seconds);
      },
      getPage: async () => [
        200,
        new TextEncoder().encode(
          page++ === 0
            ? '<a href="item?id=100">Story</a><a href="https://news.ycombinator.com/favorites?id=reader&p=2">More</a>'
            : '<a href="item?id=101">Next story</a>',
        ),
      ],
    });

    expect(result).toMatchObject({ fetched: 2, new: 2, pages: 2, stopped: "exhausted" });
    expect(delays).toHaveLength(1);
    expect(delays[0]).toBeGreaterThanOrEqual(3);
    expect(delays[0]).toBeLessThanOrEqual(7);
  } finally {
    connection.close();
    rmSync(root, { recursive: true, force: true });
  }
});
