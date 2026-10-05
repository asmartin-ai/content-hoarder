import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as db from "../src/db.ts";
import { newItem, parseMetadata } from "../src/models.ts";
import { recoverTitles } from "../src/youtube_recover.ts";

test("Wayback title recovery patches the existing row and preserves metadata", async () => {
  const database = new Database(":memory:");
  db.initDb(database);

  const item = newItem({
    source: "youtube",
    source_id: "video123456",
    title: "[deleted video]",
    status: "keep",
    metadata: { channel: "saved channel", tags_manual: ["retain"], local_fact: "preserve" },
  });

  db.mergeUpsert(database, item);

  const get = async (url: string): Promise<string> =>
    url.startsWith("https://archive.org/")
      ? JSON.stringify({
          archived_snapshots: {
            closest: { available: true, url: "https://web.archive.org/snapshot" },
          },
        })
      : "<title>Recovered title - YouTube</title>";

  try {
    const result = await recoverTitles(database, { get, throttle: 0 });
    const fresh = db.getItem(database, item.fullname);
    expect(result).toEqual({ selected: 1, recovered: 1 });
    expect(fresh?.title).toBe("Recovered title");
    expect(fresh?.status).toBe("keep");
    expect(fresh?.search_text).toContain("Recovered title");
    expect(parseMetadata(fresh?.metadata)).toMatchObject({
      channel: "saved channel",
      tags_manual: ["retain"],
      local_fact: "preserve",
      wayback_tried: 1,
      title_source: "wayback",
    });
  } finally {
    database.close();
  }
});
