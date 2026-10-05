import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as db from "../src/db.ts";
import { FAVORITES_URL, sync } from "../src/hn_sync.ts";

test("HN favorites sync follows More pages and records the newest imported IDs", async () => {
  const database = new Database(":memory:");

  try {
    db.initDb(database);

    const pages = [
      '<tr class="athing" id="101"><a href="item?id=101">first</a></tr><a href="?id=reader&p=2">More</a>',
      '<tr class="athing" id="102"><a href="item?id=102">second</a></tr>',
    ];

    const requested: string[] = [];
    let pageIndex = 0;

    const result = await sync(database, {
      user: "reader",
      throttle: 0.3,
      sleep: async () => {},
      getPage: async (url) => {
        requested.push(url);
        const page = pages[pageIndex++] ?? "";

        return [200, new TextEncoder().encode(page)];
      },
    });

    expect(result).toEqual({
      fetched: 2,
      new: 2,
      updated: 0,
      pages: 2,
      stopped: "exhausted",
      network_error: false,
      user: "reader",
    });
    expect(requested).toEqual([`${FAVORITES_URL}?id=reader`, `${FAVORITES_URL}?id=reader&p=2`]);
    expect(db.getItem(database, "hackernews:101")?.url).toBe(
      "https://news.ycombinator.com/item?id=101",
    );
    expect(db.getItem(database, "hackernews:102")?.metadata).toBe(
      JSON.stringify({ hn_url: "https://news.ycombinator.com/item?id=102", hn_list: "saved" }),
    );
    expect(JSON.parse(db.getSetting(database, "hn_sync_newest") ?? "null")).toEqual([
      "hackernews:101",
      "hackernews:102",
    ]);
  } finally {
    database.close();
  }
});
