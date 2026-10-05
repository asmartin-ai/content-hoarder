import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as db from "../src/db.ts";
import { candidate, letgo, STATE_KEY } from "../src/resurface.ts";
import { newItem } from "../src/models.ts";

const DAY = 86_400;

test("let-go dismissal survives later eligible items in the same cluster", () => {
  const root = mkdtempSync(join(tmpdir(), "content-hoarder-resurface-"));
  const connection = db.connect(join(root, "app.db"));

  try {
    const firstSeen = Math.floor(Date.now() / 1000) - 100 * DAY;
    const laterNow = firstSeen + 100 * DAY;

    for (let index = 0; index < 10; index++) {
      db.mergeUpsert(
        connection,
        newItem({
          source: "reddit",
          source_id: `t3_old_${index}`,
          title: "Old item",
          metadata: { subreddit: "adhd" },
          now: firstSeen,
        }),
      );
    }

    expect(letgo(connection, "subreddit:adhd", { now: laterNow }).total).toBe(10);

    for (let index = 0; index < 10; index++) {
      db.mergeUpsert(
        connection,
        newItem({
          source: "reddit",
          source_id: `t3_later_${index}`,
          title: "Later item",
          metadata: { subreddit: "adhd" },
          now: firstSeen,
        }),
      );
    }

    expect(candidate(connection, { now: laterNow })).toBeNull();

    db.setSetting(
      connection,
      STATE_KEY,
      JSON.stringify({ "subreddit:adhd": { dismissed_until: 0 } }),
    );
    expect(candidate(connection, { now: laterNow + DAY })?.cluster).toBe("subreddit:adhd");
  } finally {
    connection.close();
    rmSync(root, { recursive: true, force: true });
  }
});
