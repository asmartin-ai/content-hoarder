import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as db from "../src/db.ts";
import { newItem } from "../src/models.ts";
import { serveApp } from "../src/web.ts";

test("public item API returns parsed metadata from a synthetic database", async () => {
  const root = mkdtempSync(join(tmpdir(), "content-hoarder-web-"));
  const databasePath = join(root, "app.db");
  const connection = db.connect(databasePath);

  const item = newItem({
    source: "reddit",
    source_id: "t3_public",
    title: "Public item",
    metadata: { subreddit: "research", extension_fact: { source: "fixture" } },
  });

  db.mergeUpsert(connection, item);
  connection.close();

  const server = await serveApp({ dbPath: databasePath, host: "127.0.0.1", port: 0 });

  try {
    const response = await fetch(
      `http://127.0.0.1:${server.port}/api/items/${encodeURIComponent(item.fullname)}`,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      fullname: item.fullname,
      metadata: { subreddit: "research", extension_fact: { source: "fixture" } },
    });
  } finally {
    await server.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an autosync tick keeps the connection serving requests", async () => {
  // Regression: SyncScheduler was handed the shared request connection and
  // closed it after its first tick, so every later request answered
  // "Cannot use a closed database". A recent last-run debounces the tick, so
  // this exercises the lifecycle without touching the network.
  const root = mkdtempSync(join(tmpdir(), "content-hoarder-autosync-"));
  const databasePath = join(root, "app.db");
  const connection = db.connect(databasePath);

  db.setSetting(connection, "reddit_autosync_enabled", "1");
  db.setSetting(connection, "reddit_autosync_last_run", String(Math.floor(Date.now() / 1000)));
  connection.close();

  const server = await serveApp({ dbPath: databasePath, host: "127.0.0.1", port: 0 });

  try {
    await server.scheduler?.fire();

    const response = await fetch(`http://127.0.0.1:${server.port}/items?limit=1`);

    expect(response.status).toBe(200);
  } finally {
    await server.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
