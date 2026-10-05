import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as db from "../src/db.ts";
import * as folders from "../src/folders.ts";
import { newItem } from "../src/models.ts";

test("folder date filters are presence-based and drop undated items", () => {
  const root = mkdtempSync(join(tmpdir(), "content-hoarder-folders-"));
  const connection = db.connect(join(root, "app.db"));

  try {
    const now = Math.floor(Date.now() / 1000);

    db.mergeUpsert(
      connection,
      newItem({
        source: "reddit",
        source_id: "t3_dated",
        title: "Dated",
        created_utc: now - 3_600,
      }),
    );
    db.mergeUpsert(
      connection,
      newItem({ source: "reddit", source_id: "t3_undated", title: "Undated", created_utc: 0 }),
    );

    const everything = db.createFolder(connection, "everything", {});
    const recent = db.createFolder(connection, "recent", { before: now });
    const epoch = db.createFolder(connection, "epoch", { before: 0 });

    expect(folders.evaluateFolder(connection, everything.id, { dryRun: true }).matched).toBe(2);
    // created_utc = 0 means "unknown date", not "ancient": an undated row must
    // not land in a date-filtered folder.
    expect(folders.evaluateFolder(connection, recent.id, { dryRun: true }).matched).toBe(1);
    // `before: 0` is a real filter (before the epoch), not an absent one.
    expect(folders.evaluateFolder(connection, epoch.id, { dryRun: true }).matched).toBe(0);
  } finally {
    connection.close();
    rmSync(root, { recursive: true, force: true });
  }
});
