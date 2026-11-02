import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as db from "../src/db.ts";
import { MetadataSchema, newItem, parseMetadata, RawItemSchema } from "../src/models.ts";

test("database rows keep metadata JSON on the wire and parse it for API consumers", () => {
  const root = mkdtempSync(join(tmpdir(), "content-hoarder-models-"));
  const connection = db.connect(join(root, "app.db"));

  try {
    const incoming = newItem({
      source: "reddit",
      source_id: "t3_contract",
      title: "Contract",
      metadata: {
        subreddit: "research",
        tags: ["manual"],
        extension_fact: { version: 2, active: true },
      },
      raw: { provider_flag: "preserved" },
    });

    expect(incoming.is_saved).toBe(1);
    expect(JSON.parse(incoming.metadata)).toMatchObject({
      extension_fact: { version: 2, active: true },
    });
    db.mergeUpsert(connection, incoming);

    const stored = db.getItem(connection, incoming.fullname);
    expect(RawItemSchema.shape.metadata.safeParse(stored?.metadata).success).toBe(true);
    expect(JSON.parse(stored?.metadata ?? "{}")).toMatchObject({
      extension_fact: { version: 2, active: true },
    });
    expect(JSON.parse(stored?.raw_json ?? "{}")).toEqual({ provider_flag: "preserved" });

    const publicItem = db.getPublicItem(connection, incoming.fullname);
    expect(MetadataSchema.safeParse(publicItem?.metadata).success).toBe(true);
    expect(publicItem?.metadata).toMatchObject({
      subreddit: "research",
      extension_fact: { version: 2, active: true },
    });
    expect(parseMetadata(stored?.metadata)).toMatchObject({ tags: ["manual"] });
    expect(newItem({ source: "reddit", source_id: "t3_unsaved", is_saved: false }).is_saved).toBe(
      0,
    );
  } finally {
    connection.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an imported item never keeps a script URL", () => {
  for (const url of [
    "javascript:alert(1)",
    " JavaScript:alert(1)",
    "data:text/html,x",
    "vbscript:x",
  ]) {
    expect(newItem({ source: "reddit", source_id: "t3_x", url }).url).toBe("");
  }

  expect(newItem({ source: "reddit", source_id: "t3_y", url: " https://example.com/a " }).url).toBe(
    "https://example.com/a",
  );
});
