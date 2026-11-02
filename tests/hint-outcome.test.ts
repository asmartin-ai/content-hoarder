import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import * as db from "../src/db.ts";
import * as dedup from "../src/dedup.ts";
import { buildSearchText, newItem, parseMetadata } from "../src/models.ts";

const HintOutcomeSchema = z.object({
  verdict: z.enum(["keep", "skip"]),
  by: z.enum(["ai", "history"]),
  decided: z.enum(["keep", "archived", "done"]),
  matched: z.boolean(),
  at: z.number(),
});

type HintOutcome = z.infer<typeof HintOutcomeSchema>;

function open(): Database {
  const database = new Database(":memory:");

  db.initDb(database);

  return database;
}

function seed(database: Database, id: string): string {
  const fullname = `reddit:${id}`;

  db.mergeUpsert(
    database,
    newItem({
      source: "reddit",
      source_id: id,
      title: "Hint target",
      body: "body text",
      metadata: { subreddit: "testing" },
    }),
  );

  return fullname;
}

function hintOutcome(database: Database, fullname: string): HintOutcome | undefined {
  const metadata = parseMetadata(db.getItem(database, fullname)?.metadata);
  const parsed = HintOutcomeSchema.safeParse(metadata.hint_outcome);

  return parsed.success ? parsed.data : undefined;
}

function storedSearchText(database: Database, fullname: string): string {
  const row = database.query("SELECT search_text FROM items WHERE fullname=?").get(fullname) as
    | { search_text: string }
    | undefined;

  return row?.search_text ?? "";
}

function freshSearchText(database: Database, fullname: string): string {
  const row = db.getItem(database, fullname);

  return row ? buildSearchText(row, parseMetadata(row.metadata)) : "";
}

function withDb(body: (database: Database) => void): void {
  const database = open();

  try {
    body(database);
  } finally {
    database.close();
  }
}

describe("hint outcomes", () => {
  test("a keep hint matched by a keep decision records an agreement", () => {
    withDb((database) => {
      const fullname = seed(database, "t3_keep");

      db.setStatus(database, fullname, "keep", { hint: { verdict: "keep", by: "ai" } });

      expect(hintOutcome(database, fullname)).toMatchObject({
        verdict: "keep",
        by: "ai",
        decided: "keep",
        matched: true,
      });
      expect(hintOutcome(database, fullname)?.at).toEqual(expect.any(Number));
    });
  });

  test("a keep hint accepts done as a match", () => {
    withDb((database) => {
      const fullname = seed(database, "t3_done");

      db.setStatus(database, fullname, "done", { hint: { verdict: "keep", by: "history" } });

      expect(hintOutcome(database, fullname)).toMatchObject({
        verdict: "keep",
        by: "history",
        decided: "done",
        matched: true,
      });
    });
  });

  test("a skip hint matched by archived records an agreement", () => {
    withDb((database) => {
      const fullname = seed(database, "t3_archive");

      db.setStatus(database, fullname, "archived", { hint: { verdict: "skip", by: "ai" } });

      expect(hintOutcome(database, fullname)).toMatchObject({
        verdict: "skip",
        by: "ai",
        decided: "archived",
        matched: true,
      });
    });
  });

  test("a skip hint contradicted by keep records a mismatch", () => {
    withDb((database) => {
      const fullname = seed(database, "t3_mismatch");

      db.setStatus(database, fullname, "keep", { hint: { verdict: "skip", by: "ai" } });

      expect(hintOutcome(database, fullname)).toMatchObject({
        verdict: "skip",
        by: "ai",
        decided: "keep",
        matched: false,
      });
    });
  });

  test("a decision without a hint writes no outcome", () => {
    withDb((database) => {
      const fullname = seed(database, "t3_plain");

      db.setStatus(database, fullname, "keep");

      expect(hintOutcome(database, fullname)).toBeUndefined();
    });
  });

  test("undoing to inbox removes the outcome written by that decision", () => {
    withDb((database) => {
      const fullname = seed(database, "t3_undo");

      db.setStatus(database, fullname, "archived", { hint: { verdict: "skip", by: "ai" } });
      expect(hintOutcome(database, fullname)).toBeDefined();

      db.undoStatus(database, fullname);

      expect(db.getItem(database, fullname)?.status).toBe("inbox");
      expect(hintOutcome(database, fullname)).toBeUndefined();
    });
  });

  test("undoing a hinted archived decision back to keep removes the outcome", () => {
    withDb((database) => {
      const fullname = seed(database, "t3_undo_keep");

      db.setStatus(database, fullname, "keep");
      db.setStatus(database, fullname, "archived", { hint: { verdict: "skip", by: "ai" } });
      expect(hintOutcome(database, fullname)).toBeDefined();

      db.undoStatus(database, fullname);

      expect(db.getItem(database, fullname)?.status).toBe("keep");
      expect(hintOutcome(database, fullname)).toBeUndefined();
    });
  });

  test("an unhinted later decision clears an earlier outcome", () => {
    withDb((database) => {
      const fullname = seed(database, "t3_clear");

      db.setStatus(database, fullname, "keep", { hint: { verdict: "keep", by: "ai" } });
      expect(hintOutcome(database, fullname)).toBeDefined();

      db.setStatus(database, fullname, "archived");

      expect(hintOutcome(database, fullname)).toBeUndefined();
      expect(db.hintAgreement(database).shown).toBe(0);
    });
  });

  test("repeating the same status change keeps a single consistent outcome", () => {
    withDb((database) => {
      const fullname = seed(database, "t3_repeat");

      db.setStatus(database, fullname, "keep", { hint: { verdict: "keep", by: "ai" } });
      const first = hintOutcome(database, fullname);

      db.setStatus(database, fullname, "keep", { hint: { verdict: "skip", by: "history" } });

      expect(hintOutcome(database, fullname)).toEqual(first);
    });
  });

  test("a hinted decision leaves search_text equal to a fresh build", () => {
    withDb((database) => {
      const fullname = seed(database, "t3_search");

      db.setStatus(database, fullname, "archived", { hint: { verdict: "skip", by: "history" } });

      expect(storedSearchText(database, fullname)).toBe(freshSearchText(database, fullname));
      expect(db.searchItems(database, "testing").map((item) => item.fullname)).toEqual([fullname]);
    });
  });
});

describe("hintAgreement", () => {
  test("counts current outcomes overall and per source", () => {
    withDb((database) => {
      const matchedKeep = seed(database, "t3_agree_keep");
      const missedKeep = seed(database, "t3_agree_miss");
      const matchedHistory = seed(database, "t3_agree_history");
      const plain = seed(database, "t3_agree_plain");

      db.setStatus(database, matchedKeep, "keep", { hint: { verdict: "keep", by: "ai" } });
      db.setStatus(database, missedKeep, "keep", { hint: { verdict: "skip", by: "ai" } });
      db.setStatus(database, matchedHistory, "archived", {
        hint: { verdict: "skip", by: "history" },
      });
      db.setStatus(database, plain, "done");

      expect(db.hintAgreement(database)).toEqual({
        shown: 3,
        matched: 2,
        rate: 2 / 3,
        by: {
          ai: { shown: 2, matched: 1 },
          history: { shown: 1, matched: 1 },
        },
      });
    });
  });

  test("returns a null rate when no outcome is recorded", () => {
    withDb((database) => {
      expect(db.hintAgreement(database)).toEqual({
        shown: 0,
        matched: 0,
        rate: null,
        by: {
          ai: { shown: 0, matched: 0 },
          history: { shown: 0, matched: 0 },
        },
      });
    });
  });

  test("counts outcomes after a sequence of decisions and undos", () => {
    withDb((database) => {
      const undone = seed(database, "t3_seq_undone");
      const matchedAi = seed(database, "t3_seq_ai");
      const missedHistory = seed(database, "t3_seq_history");
      const cleared = seed(database, "t3_seq_cleared");
      const matchedDone = seed(database, "t3_seq_done");

      db.setStatus(database, undone, "archived", { hint: { verdict: "skip", by: "ai" } });
      expect(db.hintAgreement(database)).toMatchObject({ shown: 1, matched: 1 });

      db.undoStatus(database, undone);
      expect(db.hintAgreement(database)).toMatchObject({ shown: 0, matched: 0 });

      db.setStatus(database, matchedAi, "keep", { hint: { verdict: "keep", by: "ai" } });
      db.setStatus(database, missedHistory, "keep", {
        hint: { verdict: "skip", by: "history" },
      });
      db.setStatus(database, cleared, "archived", { hint: { verdict: "skip", by: "ai" } });
      db.setStatus(database, cleared, "done");

      db.setStatus(database, matchedDone, "done", { hint: { verdict: "keep", by: "ai" } });

      expect(db.hintAgreement(database)).toEqual({
        shown: 3,
        matched: 2,
        rate: 2 / 3,
        by: {
          ai: { shown: 2, matched: 2 },
          history: { shown: 1, matched: 0 },
        },
      });
    });
  });
});

describe("dedup status transitions", () => {
  test("resolving a duplicate group clears the archived item's outcome", () => {
    withDb((database) => {
      const kept = seed(database, "t3_dup_keep");
      const duplicate = seed(database, "t3_dup_drop");

      db.setStatus(database, kept, "keep");
      db.setStatus(database, duplicate, "keep", { hint: { verdict: "keep", by: "ai" } });
      expect(hintOutcome(database, duplicate)).toBeDefined();

      const result = dedup.resolveGroup(database, kept, [duplicate]);

      expect(result.archived).toBe(1);
      expect(db.getItem(database, duplicate)?.status).toBe("archived");
      expect(hintOutcome(database, duplicate)).toBeUndefined();
      expect(db.getItem(database, kept)?.status).toBe("keep");
    });
  });

  test("undoing a duplicate resolution clears the restored item's outcome", () => {
    withDb((database) => {
      const fullname = seed(database, "t3_dup_undo");

      db.setStatus(database, fullname, "keep");
      db.setStatus(database, fullname, "archived", { hint: { verdict: "skip", by: "ai" } });
      expect(hintOutcome(database, fullname)).toBeDefined();

      const result = dedup.undoResolve(database, [fullname]);

      expect(result.restored).toBe(1);
      expect(db.getItem(database, fullname)?.status).toBe("keep");
      expect(hintOutcome(database, fullname)).toBeUndefined();
    });
  });
});
