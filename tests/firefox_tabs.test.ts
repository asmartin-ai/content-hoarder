import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as db from "../src/db.ts";
import { FIREFOX_TABS_SCHEMA } from "../src/connectors/firefox.ts";
import { ingestSnapshot, validatePayload } from "../src/firefox_tabs.ts";

test("Firefox snapshot validation rejects invalid tab entries and reimports backups idempotently", () => {
  expect(validatePayload({ schema: FIREFOX_TABS_SCHEMA, tabs: [null] }).payload).toBeNull();

  const validation = validatePayload({
    schema: FIREFOX_TABS_SCHEMA,
    source: "webextension",
    captured_at: 1700000000,
    snapshot_id: "snapshot-1",
    tabs: [{ url: "https://example.test/path", title: "Example", pinned: true }],
  });

  if (!validation.payload) throw new Error(validation.error ?? "valid fixture rejected");

  const database = new Database(":memory:");

  try {
    db.initDb(database);
    const first = ingestSnapshot(database, validation.payload, 1700000001);
    const second = ingestSnapshot(database, validation.payload, 1700000002);
    expect(first).toMatchObject({ imported: 1, skipped: 0, errors: [], youtube_promoted: 0 });
    expect(first.sample).toHaveLength(1);
    const fullname = first.sample[0];

    if (!fullname) throw new Error("imported Firefox snapshot omitted its sample fullname");
    expect(second).toEqual({
      imported: 1,
      skipped: 0,
      errors: [],
      youtube_promoted: 0,
      sample: [fullname],
    });
    const item = db.getItem(database, fullname);
    expect(item).toMatchObject({
      source: "firefox",
      title: "Example",
      url: "https://example.test/path",
      status: "inbox",
    });
    expect(JSON.parse(item?.metadata ?? "{}")).toEqual({
      domain: "example.test",
      open_in_firefox: true,
      pinned: 1,
      firefox_capture_source: "webextension",
      firefox_captured_at: 1700000000,
      firefox_snapshot_id: "snapshot-1",
    });
  } finally {
    database.close();
  }
});
