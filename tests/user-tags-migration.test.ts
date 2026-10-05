import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { getItem, getUserTag, initDb, listUserTags, mergeUpsert, searchItems } from "../src/db.ts";

import { newItem } from "../src/models.ts";

describe("user tag timestamp migration", () => {
  test("removes both timestamp columns without losing ids, names, or item references", () => {
    const db = new Database(":memory:");

    try {
      initDb(db);
      db.exec("DROP TABLE user_tags");
      db.exec(`CREATE TABLE user_tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        created_utc INTEGER NOT NULL,
        updated_utc INTEGER
      )`);
      db.query(
        "INSERT INTO user_tags (id, name, created_utc, updated_utc) VALUES (?, ?, ?, ?)",
      ).run(41, "existing", 1_700_000_000, 1_700_000_001);
      mergeUpsert(
        db,
        newItem({
          source: "reddit",
          source_id: "t3_migration",
          metadata: { tags_manual: ["existing"] },
        }),
      );

      initDb(db);

      expect(getUserTag(db, 41)).toEqual({ id: 41, name: "existing" });
      expect(listUserTags(db)).toEqual([{ id: 41, name: "existing", item_count: 1 }]);

      const columns = z
        .array(z.object({ name: z.string() }).passthrough())
        .parse(db.query("PRAGMA table_info(user_tags)").all());

      expect(columns.map(({ name }) => name)).toEqual(["id", "name"]);
    } finally {
      db.close();
    }
  });
});

describe("saved item normalization", () => {
  test("omitted is_saved remains in saved search while explicit false does not", () => {
    const db = new Database(":memory:");

    try {
      initDb(db);

      const saved = newItem({
        source: "reddit",
        source_id: "t3_saved",
        raw: null,
        metadata: { provider_detail: { preserved: true } },
      });

      expect(saved.raw_json).toBe("");
      mergeUpsert(db, saved);
      mergeUpsert(
        db,
        newItem({
          source: "reddit",
          source_id: "t3_unsaved",
          is_saved: false,
        }),
      );

      expect(getItem(db, saved.fullname)?.is_saved).toBe(1);
      expect(JSON.parse(getItem(db, saved.fullname)?.metadata ?? "{}")).toEqual({
        provider_detail: { preserved: true },
      });
      expect(searchItems(db, "", { isSaved: 1 }).map(({ fullname }) => fullname)).toEqual([
        saved.fullname,
      ]);
    } finally {
      db.close();
    }
  });
});
