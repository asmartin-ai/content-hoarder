import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as db from "../src/db.ts";
import { newItem, parseMetadata } from "../src/models.ts";
import { recover, type RecoveryProvider } from "../src/archival/service.ts";

test("archive recovery patches a complete known row without losing user state", async () => {
  const database = new Database(":memory:");
  db.initDb(database);

  const item = newItem({
    source: "reddit",
    source_id: "t3_recovered",
    title: "[deleted]",
    body: "[removed]",
    status: "keep",
    metadata: { category: "coding", tags_manual: ["keep-me"], local_fact: "preserve" },
  });

  db.mergeUpsert(database, item);

  const provider: RecoveryProvider = {
    name: "fixture",
    async fetchPosts() {
      return {
        recovered: {
          title: "Recovered title",
          body: "Recovered body",
          author: "author",
          subreddit: "example",
          permalink: "/r/example/comments/recovered/",
          url: "https://example.test/post",
          created_utc: 1_700_000_000,
          score: 0,
          over_18: 0,
          media_type: "",
          media_url: "",
          thumbnail: "",
          gallery: [],
          gallery_preview: [],
        },
      };
    },
    async fetchComments() {
      return {};
    },
  };

  try {
    const result = await recover(database, { providers: [provider] });
    const fresh = db.getItem(database, item.fullname);
    expect(result.recovered).toBe(1);
    expect(fresh?.title).toBe("Recovered title");
    expect(fresh?.body).toBe("Recovered body");
    expect(fresh?.status).toBe("keep");
    expect(fresh?.hydrated_at).not.toBeNull();
    expect(parseMetadata(fresh?.metadata)).toMatchObject({
      category: "coding",
      tags_manual: ["keep-me"],
      local_fact: "preserve",
      subreddit: "example",
    });
    expect(fresh?.search_text).toContain("Recovered title");
  } finally {
    database.close();
  }
});
