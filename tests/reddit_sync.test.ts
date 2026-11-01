import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { initDb } from "../src/db.ts";
import { syncSaved } from "../src/reddit_sync.ts";
import { setAuth, type Get } from "../src/reddit_unsave.ts";

function open(): Database {
  const db = new Database(":memory:");

  initDb(db);
  setAuth(db, { sessionCookie: "bench", username: "tester" });

  return db;
}

function countTransactions(db: Database): () => number {
  const original = db.transaction.bind(db);
  let calls = 0;

  db.transaction = (<A extends unknown[], R>(fn: (...args: A) => R) => {
    calls += 1;

    return original(fn);
  }) as Database["transaction"];

  return () => calls;
}

function savedPage(names: string[], after: string | null = null) {
  return {
    data: {
      children: names.map((name) => ({
        kind: "t3",
        data: { name, title: `title ${name}`, subreddit: "test" },
      })),
      after,
    },
  };
}

function pagesGetf(pages: string[][], after: string | null = null): Get {
  let page = 0;

  return async () => {
    const names = pages[page] ?? [];
    const next = page < pages.length - 1 ? `${after ?? "next"}-${page + 1}` : null;

    page += 1;

    return savedPage(names, next);
  };
}

describe("syncSaved batching", () => {
  test("upserts each listing page in one transaction", async () => {
    const database = open();

    try {
      const transactions = countTransactions(database);

      const result = await syncSaved(database, {
        maxPages: 5,
        getf: pagesGetf([
          ["t3_a", "t3_b", "t3_c"],
          ["t3_d", "t3_e"],
        ]),
        sleep: () => {},
      });

      expect(result).toMatchObject({
        fetched: 5,
        new: 5,
        updated: 0,
        pages: 2,
        stopped: "exhausted",
        errors: [],
      });
      expect(transactions()).toBe(2);
      expect(database.query("SELECT count(*) AS c FROM items WHERE saved_utc > 0").get()).toEqual({
        c: 5,
      });
    } finally {
      database.close();
    }
  });

  test("a malformed stored row reports itself and the rest of the page still lands", async () => {
    const database = open();

    try {
      const now = Math.floor(Date.now() / 1000);

      database
        .query(
          "INSERT INTO items(fullname, source, source_id, kind, status, first_seen_utc, last_seen_utc) VALUES(?,?,?,?,?,?,?)",
        )
        .run("reddit:t3_bad", "reddit", "t3_bad", "post", "not-a-status", now, now);

      const result = await syncSaved(database, {
        maxPages: 1,
        getf: pagesGetf([["t3_ok1", "t3_bad", "t3_ok2"]]),
        sleep: () => {},
      });

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toStartWith("reddit:t3_bad:");
      expect(result).toMatchObject({
        fetched: 3,
        new: 2,
        updated: 0,
        pages: 1,
        stopped: "exhausted",
      });
      expect(
        database
          .query(
            "SELECT fullname FROM items WHERE fullname IN ('reddit:t3_ok1','reddit:t3_ok2') ORDER BY fullname",
          )
          .all(),
      ).toEqual([{ fullname: "reddit:t3_ok1" }, { fullname: "reddit:t3_ok2" }]);
    } finally {
      database.close();
    }
  });
});
