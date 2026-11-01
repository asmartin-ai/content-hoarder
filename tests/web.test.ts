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

test("the reader's thread path serves a cached Reddit thread", async () => {
  const root = mkdtempSync(join(tmpdir(), "content-hoarder-thread-"));
  const databasePath = join(root, "app.db");
  const connection = db.connect(databasePath);

  const item = newItem({
    source: "reddit",
    source_id: "t3_cached",
    title: "Cached thread",
    metadata: { subreddit: "test", permalink: "/r/test/comments/cached/x/" },
  });

  db.mergeUpsert(connection, item);
  db.setRedditThread(
    connection,
    item.fullname,
    JSON.stringify([
      { kind: "Listing", data: { children: [{ kind: "t3", data: { title: "Cached thread" } }] } },
      {
        kind: "Listing",
        data: { children: [{ kind: "t1", data: { id: "c1", author: "a", body: "first reply" } }] },
      },
    ]),
  );
  connection.close();

  const server = await serveApp({ dbPath: databasePath, host: "127.0.0.1", port: 0 });

  try {
    const response = await fetch(
      `http://127.0.0.1:${server.port}/reddit/items/${encodeURIComponent(item.fullname)}/thread?sort=best`,
    );

    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).toContain("first reply");
  } finally {
    await server.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("app HTML refuses to be framed by another site", async () => {
  const root = mkdtempSync(join(tmpdir(), "content-hoarder-frame-"));
  const databasePath = join(root, "app.db");
  const connection = db.connect(databasePath);

  connection.close();

  const server = await serveApp({ dbPath: databasePath, host: "127.0.0.1", port: 0 });

  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/`);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Security-Policy")).toBe("frame-ancestors 'none'");
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
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
