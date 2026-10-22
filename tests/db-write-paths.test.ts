import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { initDb, mergeUpsert, mergeUpsertMany, patchItem, searchItems } from "../src/db.ts";
import { newItem, type RawItem } from "../src/models.ts";

function open(): Database {
  const db = new Database(":memory:");

  initDb(db);

  return db;
}

function dump(db: Database) {
  return db
    .query(
      "SELECT fullname, title, status, first_seen_utc, metadata, search_text " +
        "FROM items ORDER BY fullname",
    )
    .all();
}

describe("items_au FTS sync trigger", () => {
  test("mirrors changed text and leaves the index correct for metadata-only writes", () => {
    const db = open();

    try {
      mergeUpsert(
        db,
        newItem({ source: "reddit", source_id: "t3_a", title: "needle in haystack" }),
      );

      expect(searchItems(db, "needle").map((item) => item.fullname)).toEqual(["reddit:t3_a"]);

      // Search-irrelevant metadata: the trigger skips the rewrite,
      // and the strict + trigram indexes still match the old text.
      patchItem(db, "reddit:t3_a", { metadata: { score: 7 } });
      expect(searchItems(db, "needle").map((item) => item.fullname)).toEqual(["reddit:t3_a"]);
      expect(searchItems(db, "needle", { fuzzy: true })).toHaveLength(1);

      // Text write: both indexes follow the new value.
      patchItem(db, "reddit:t3_a", { title: "haddock" });
      expect(searchItems(db, "needle")).toHaveLength(0);
      expect(searchItems(db, "haddock").map((item) => item.fullname)).toEqual(["reddit:t3_a"]);
    } finally {
      db.close();
    }
  });

  test("initDb replaces a legacy unguarded trigger exactly once", () => {
    const db = open();

    try {
      db.exec("DROP TRIGGER items_au");
      db.exec(`CREATE TRIGGER items_au AFTER UPDATE ON items BEGIN
        INSERT INTO items_fts(items_fts, rowid, fullname, title, body, author, url, search_text)
          VALUES ('delete', old.rowid, old.fullname, old.title, old.body, old.author, old.url, old.search_text);
        INSERT INTO items_trgm(items_trgm, rowid, search_text) VALUES ('delete', old.rowid, old.search_text);
        INSERT INTO items_fts(rowid, fullname, title, body, author, url, search_text)
          VALUES (new.rowid, new.fullname, new.title, new.body, new.author, new.url, new.search_text);
        INSERT INTO items_trgm(rowid, search_text) VALUES (new.rowid, new.search_text);
      END`);

      initDb(db);
      initDb(db);

      const triggers = z
        .array(z.object({ sql: z.string() }))
        .parse(
          db.query("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='items_au'").all(),
        );

      expect(triggers).toHaveLength(1);
      expect(triggers[0]?.sql).toContain("IS NOT NEW.search_text");

      mergeUpsert(db, newItem({ source: "reddit", source_id: "t3_b", title: "legacy" }));
      patchItem(db, "reddit:t3_b", { title: "replacement" });

      expect(searchItems(db, "legacy")).toHaveLength(0);
      expect(searchItems(db, "replacement")).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});

describe("mergeUpsertMany", () => {
  test("produces the same state as replaying mergeUpsert one row at a time", () => {
    const perRow = open();
    const batched = open();

    try {
      const seed = newItem({ source: "reddit", source_id: "t3_seed", title: "seed item" });

      mergeUpsert(perRow, seed);
      mergeUpsert(batched, seed);

      const batch: RawItem[] = [
        newItem({
          source: "reddit",
          source_id: "t3_seed",
          title: "seed item",
          metadata: { score: 3 },
        }),
        newItem({ source: "hackernews", source_id: "3001", title: "fresh one" }),
        newItem({ source: "hackernews", source_id: "3002", title: "fresh two" }),
        newItem({
          source: "hackernews",
          source_id: "3002",
          title: "fresh two",
          body: "later copy",
        }),
        newItem({ source: "reddit", source_id: "t3_seed", title: "seed renamed" }),
      ];

      for (const item of batch) mergeUpsert(perRow, item);

      const result = mergeUpsertMany(batched, batch);

      expect(result).toEqual({ inserted: 2, updated: 3, errors: [] });
      expect(dump(batched)).toEqual(dump(perRow));
      expect(searchItems(batched, "haddock")).toHaveLength(0);
      expect(
        searchItems(batched, "fresh")
          .map((item) => item.fullname)
          .sort(),
      ).toEqual(["hackernews:3001", "hackernews:3002"]);
    } finally {
      perRow.close();
      batched.close();
    }
  });

  test("reports a failing row without losing its neighbours", () => {
    const db = open();

    try {
      // A NOT NULL column forced to null: the chunk INSERT throws,
      // and the row-by-row replay isolates the offender.
      const broken = newItem({ source: "reddit", source_id: "t3_bad" });

      Object.assign(broken, { first_seen_utc: null });

      const result = mergeUpsertMany(db, [
        newItem({ source: "reddit", source_id: "t3_ok1" }),
        broken,
        newItem({ source: "reddit", source_id: "t3_ok2" }),
      ]);

      expect(result.inserted).toBe(2);
      expect(result.errors.map((error) => error.fullname)).toEqual(["reddit:t3_bad"]);
      expect(result.errors[0]?.message).toContain("NOT NULL");

      const stored = z
        .array(z.object({ fullname: z.string() }))
        .parse(db.query("SELECT fullname FROM items ORDER BY fullname").all());

      expect(stored.map((row) => row.fullname)).toEqual(["reddit:t3_ok1", "reddit:t3_ok2"]);
    } finally {
      db.close();
    }
  });
});
