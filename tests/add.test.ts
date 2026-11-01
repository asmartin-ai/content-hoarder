import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { get } from "../src/connectors/registry.ts";
import * as db from "../src/db.ts";
import { parseMetadata } from "../src/models.ts";
import { serveApp } from "../src/web.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "content-hoarder-add-"));

  roots.push(root);

  return root;
}

async function withServer(fn: (base: string) => Promise<void>): Promise<void> {
  const path = join(scratch(), "app.db");

  db.connect(path).close();
  const server = await serveApp({ dbPath: path, host: "127.0.0.1", port: 0 });

  try {
    await fn(`http://127.0.0.1:${server.port}`);
  } finally {
    await server.stop();
  }
}

test("a Chrome bookmarks export keeps folders, maps YouTube and skips scripts", () => {
  const items = get("bookmarks").importFile(
    join(import.meta.dir, "fixtures", "bookmarks-chrome.html"),
  );

  expect(
    items.map((item) => [
      item.source,
      item.title,
      parseMetadata(item.metadata).folder,
      item.created_utc,
    ]),
  ).toEqual([
    ["bookmarks", "Example & Test", "Bookmarks Bar", 1234567891],
    ["youtube", 'Cool Video "Title"', "Tech", 1234567893],
    ["bookmarks", "Blog Post", "Tech", 1234567894],
  ]);
});

test("a Firefox bookmarks export decodes titles and leaves a folder when it closes", () => {
  const items = get("bookmarks").importFile(
    join(import.meta.dir, "fixtures", "bookmarks-firefox.html"),
  );

  expect(items.map((item) => [item.title, parseMetadata(item.metadata).folder])).toEqual([
    ["HN <Story>", "Menu"],
    ["Example", "Other Bookmarks"],
  ]);
});

test("pasted links read every common layout and dedupe", () => {
  const path = join(scratch(), "links.txt");

  writeFileSync(
    path,
    [
      "https://example.com/a",
      "https://example.com/b | Example B",
      "Example C\thttps://example.com/c",
      "[Example D](https://example.com/d)",
      "Title above",
      "https://example.com/e",
      "https://example.com/a#again",
      "https://www.youtube.com/watch?v=abcdefghijk",
    ].join("\n"),
  );

  const items = get("links").importFile(path);

  expect(items.map((item) => [item.source, item.title])).toEqual([
    ["bookmarks", "https://example.com/a"],
    ["bookmarks", "Example B"],
    ["bookmarks", "Example C"],
    ["bookmarks", "Example D"],
    ["bookmarks", "Title above"],
    ["youtube", "https://www.youtube.com/watch?v=abcdefghijk"],
  ]);
});

test("the Firefox Export Tabs URLs format stays with the Firefox connector", () => {
  const path = join(scratch(), "export.txt");

  writeFileSync(path, "Export Tabs URLs\nExample\nhttps://example.com/x\n");

  expect(get("links").canImport(path)).toBe(false);
  expect(get("firefox").canImport(path)).toBe(true);
});

const Prepared = z.object({ token: z.string(), count: z.number(), new: z.number() });

const Committed = z.object({ imported: z.number() });

test("pasted links preview and then land in an empty library", async () => {
  await withServer(async (base) => {
    const page = await (await fetch(`${base}/add`)).text();

    expect(page).toContain('id="add-drop"');
    expect(page).toContain("Get my Reddit saves");
    expect(page).not.toContain("/oauth/google/start");

    const empty = await (await fetch(`${base}/hx/today/upnext?n=10`)).text();

    expect(empty).toContain('href="/add"');
    expect(empty).not.toContain("Clear 10");

    const form = new FormData();

    form.append("file", new File(["https://example.com/a\nhttps://example.com/b"], "links.txt"));
    form.append("source", "links");

    const prepared = Prepared.parse(
      await (await fetch(`${base}/import/prepare`, { method: "POST", body: form })).json(),
    );

    expect([prepared.count, prepared.new]).toEqual([2, 2]);

    const committed = Committed.parse(
      await (
        await fetch(`${base}/import/commit`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: prepared.token }),
        })
      ).json(),
    );

    expect(committed.imported).toBe(2);
    expect(await (await fetch(`${base}/hx/today/upnext?n=10`)).text()).toContain("Clear 10");
  });
});
