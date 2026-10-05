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
