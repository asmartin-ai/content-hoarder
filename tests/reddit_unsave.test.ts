import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as db from "../src/db.ts";
import { newItem } from "../src/models.ts";
import * as unsave from "../src/reddit_unsave.ts";

test("unsave dry-run is read-only and injected success drains the local queue", async () => {
  const root = mkdtempSync(join(tmpdir(), "content-hoarder-unsave-"));
  const connection = db.connect(join(root, "app.db"));

  try {
    db.mergeUpsert(
      connection,
      newItem({
        source: "reddit",
        source_id: "t3_unsave_test",
        title: "Synthetic queue item",
        status: "inbox",
        metadata: { subreddit: "fixture" },
      }),
    );
    db.setSetting(connection, "reddit_unsave_on_done", "1");
    unsave.setAuth(connection, {
      sessionCookie: "synthetic-cookie",
      modhash: "old-modhash",
      username: "fixture",
    });

    db.setStatus(connection, "reddit:t3_unsave_test", "done");
    expect(unsave.countPending(connection)).toBe(1);
    db.undoStatus(connection, "reddit:t3_unsave_test");
    expect(unsave.countPending(connection)).toBe(0);

    db.setStatus(connection, "reddit:t3_unsave_test", "done");
    let contacted = false;

    const preview = await unsave.drain(connection, {
      dryRun: true,
      getf: async () => {
        contacted = true;
        throw new Error("dry-run must not contact the transport");
      },
      post: async () => {
        contacted = true;
        throw new Error("dry-run must not contact the transport");
      },
    });

    expect(preview).toMatchObject({ dry_run: true, selected: 1 });
    expect(contacted).toBe(false);
    expect(unsave.countPending(connection)).toBe(1);
    expect(db.getItem(connection, "reddit:t3_unsave_test")?.is_saved).toBe(1);

    const posted: Array<{ url: string; fields: Record<string, string> }> = [];

    const result = await unsave.drain(connection, {
      throttle: 0,
      sleep: async () => undefined,
      getf: async () => ({ data: { name: "fixture", modhash: "fresh-modhash" } }),
      post: async (url, fields) => {
        posted.push({ url, fields });

        return [200, {}];
      },
    });

    expect(result).toMatchObject({
      selected: 1,
      unsaved: 1,
      failed: 0,
      remaining: 0,
      transport: "cookie",
    });
    expect(posted).toEqual([
      { url: unsave.UNSAVE_URL, fields: { id: "t3_unsave_test", uh: "fresh-modhash" } },
    ]);
    expect(unsave.countPending(connection)).toBe(0);
    expect(
      connection
        .query("SELECT state FROM reddit_unsave WHERE fullname=?")
        .get("reddit:t3_unsave_test"),
    ).toEqual({ state: "done" });
    expect(db.getItem(connection, "reddit:t3_unsave_test")?.is_saved).toBe(0);
  } finally {
    connection.close();
    rmSync(root, { recursive: true, force: true });
  }
});
