import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as db from "../src/db.ts";
import { archiveMedia, DEFAULT_THROTTLE_SECONDS } from "../src/media_archive.ts";
import { newItem } from "../src/models.ts";

test("media archiving paces archived URLs even without an injected sleep", async () => {
  const root = mkdtempSync(join(tmpdir(), "content-hoarder-archive-"));
  const previousDatabase = process.env.CONTENT_HOARDER_DB;

  // media blobs land beside the configured database, so point it at the temp dir.
  process.env.CONTENT_HOARDER_DB = join(root, "app.db");
  const connection = db.connect(join(root, "app.db"));

  try {
    db.mergeUpsert(
      connection,
      newItem({
        source: "reddit",
        source_id: "t3_gallery",
        title: "Gallery",
        metadata: { gallery_preview: ["https://i.redd.it/a.jpg", "https://i.redd.it/b.jpg"] },
      }),
    );

    const fetched: string[] = [];
    const started = performance.now();

    const result = await archiveMedia(connection, {
      scopes: ["galleries"],
      apply: true,
      fetch: async (url) => {
        fetched.push(url);

        return [new Uint8Array([1, 2, 3]), "image/png"];
      },
    });

    const elapsed = performance.now() - started;

    expect(fetched).toHaveLength(2);
    expect(result.archived).toBe(2);
    // Without a real sleep between URLs the whole archive runs at network speed,
    // which is what gets remote hosts to throttle us.
    expect(elapsed).toBeGreaterThanOrEqual(2 * DEFAULT_THROTTLE_SECONDS * 1000 - 10);
  } finally {
    connection.close();

    if (previousDatabase === undefined) delete process.env.CONTENT_HOARDER_DB;
    else process.env.CONTENT_HOARDER_DB = previousDatabase;
    rmSync(root, { recursive: true, force: true });
  }
});
