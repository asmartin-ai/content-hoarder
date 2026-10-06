import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as db from "../src/db.ts";
import { newItem, parseMetadata } from "../src/models.ts";

/**
 * FTS is external-content over `items`, so every metadata write that can
 * change the search blob must rewrite `search_text` in the same statement.
 * These cases existed only in the Python suite (tests/test_set_tags.py), so
 * retiring the Python tree would have silently dropped the coverage of the
 * one invariant that keeps search results honest.
 */

const searchNames = (database: Database, query: string): string[] =>
  db.searchItems(database, query).map(({ fullname }) => fullname);

// SAFETY: bun:sqlite `get()` returns `unknown`-shaped rows; every column
// here is written by this file's own INSERT/UPDATE above.
const stored = (database: Database): string =>
  (
    database.query("SELECT search_text FROM items WHERE fullname='reddit:t3_sync'").get() as
      | { search_text: string }
      | undefined
  )?.search_text ?? "";

const withDb = (body: (database: Database) => void): void => {
  const database = new Database(":memory:");

  try {
    db.initDb(database);
    db.mergeUpsert(
      database,
      newItem({
        source: "reddit",
        source_id: "t3_sync",
        title: "Original title",
        body: "body text",
      }),
    );
    body(database);
  } finally {
    database.close();
  }
};

test("a tag added through the human edit path becomes searchable", () => {
  withDb((database) => {
    db.setTags(database, "reddit:t3_sync", { add: ["zzunique"] });

    expect(stored(database)).toContain("zzunique");
    expect(searchNames(database, "zzunique")).toEqual(["reddit:t3_sync"]);
  });
});

test("removing a tag stops matching and is removed from the search blob", () => {
  withDb((database) => {
    db.setTags(database, "reddit:t3_sync", { add: ["temporary"] });
    expect(searchNames(database, "temporary")).toHaveLength(1);

    db.setTags(database, "reddit:t3_sync", { remove: ["temporary"] });

    expect(stored(database)).not.toContain("temporary");
    expect(searchNames(database, "temporary")).toHaveLength(0);
  });
});

test("auto tags land in the search blob and preserve manual tags", () => {
  withDb((database) => {
    db.setTags(database, "reddit:t3_sync", { add: ["kept-manual"] });
    db.setAutoTags(database, "reddit:t3_sync", ["auto-applied"], { preserveTags: [] });

    expect(stored(database)).toContain("auto-applied");
    expect(stored(database)).toContain("kept-manual");
    expect(parseMetadata(db.getItem(database, "reddit:t3_sync")?.metadata)).toMatchObject({
      // Documented order: preserved, then auto, then manual.
      tags: ["auto-applied", "kept-manual"],
      tags_auto: ["auto-applied"],
      tags_manual: ["kept-manual"],
    });
  });
});

test("clearing auto tags leaves the manual vocabulary searchable", () => {
  withDb((database) => {
    db.setTags(database, "reddit:t3_sync", { add: ["kept-manual"] });
    db.setAutoTags(database, "reddit:t3_sync", ["auto-applied"], { preserveTags: [] });
    db.setAutoTags(database, "reddit:t3_sync", [], { preserveTags: [] });

    expect(stored(database)).not.toContain("auto-applied");
    expect(stored(database)).toContain("kept-manual");
  });
});

test("setAutoTags with an explicit last-seen still rewrites the search blob", () => {
  withDb((database) => {
    db.setAutoTags(database, "reddit:t3_sync", ["fresh"], {
      preserveTags: [],
      lastSeenUtc: 1_700_000_000,
    });

    // SAFETY: both columns are written by the setAutoTags call immediately
    // above; last_seen_utc is non-null only because lastSeenUtc was passed.
    const row = database
      .query("SELECT search_text, last_seen_utc FROM items WHERE fullname='reddit:t3_sync'")
      .get() as { search_text: string; last_seen_utc: number };

    expect(row.search_text).toContain("fresh");
    expect(row.last_seen_utc).toBe(1_700_000_000);
  });
});

test("assigning a folder does not need a search_text rewrite but leaves the item findable", () => {
  withDb((database) => {
    const before = stored(database);

    expect(db.setItemFolder(database, "reddit:t3_sync", "Research")).toBe(true);

    // `folder` is deliberately not a search key, so the blob is untouched —
    // but a title edit through the same row must still be searchable after.
    expect(stored(database)).toBe(before);
    expect(searchNames(database, "Original")).toHaveLength(1);
  });
});
